import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  handleWebhook,
  projectUpdate,
  safeDiagnostic,
} from '../apps/functions/dist/webhook.js';
import { Ingress } from '../apps/functions/dist/ingress.js';
import {
  SecretSessions,
  RefreshLease,
  OpenAiOAuth,
  encodeSession,
  decodeSession,
  imageSlot,
} from '@places/providers';
class MemoryDocuments {
  values = new Map();
  async change(path, fn) {
    const next = fn(structuredClone(this.values.get(path)));
    if (next.value) this.values.set(path, structuredClone(next.value));
    return next.result;
  }
}
const policy = { chatId: -100, userIds: new Set([11, 22]) };
const message = {
  message_id: 1,
  chat: { id: -100, type: 'supergroup' },
  from: { id: 11, is_bot: false },
};
const update = (m) => ({ update_id: 7, message: { ...message, ...m } });
const delivery = (m) => ({
  method: 'POST',
  contentType: 'application/json',
  secret: 'fixture-header',
  rawBody: Buffer.from(JSON.stringify(update(m))),
});
const dependencies = {
  policy,
  username: 'places_bot',
  secret: async () => 'fixture-header',
  accept: async () => 'done',
};
const fixture = {
  clientId: 'fixture-issued',
  subject: 'fixture-subject',
  issuer: 'https://auth.openai.com',
  idToken: 'fixture-id',
  accessToken: 'fixture-old-access',
  refreshToken: 'fixture-old-refresh',
  scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'],
  expiresAt: 0,
};
const host = 'urn:uuid:11111111-1111-4111-8111-111111111111';

test('webhook rejects unauthenticated delivery before reading content and validates envelope limits', async () => {
  const guarded = {
    ...delivery({}),
    secret: 'wrong',
    get rawBody() {
      assert.fail('content accessed before authentication');
    },
  };
  assert.equal((await handleWebhook(guarded, dependencies)).status, 403);
  assert.equal(
    (await handleWebhook({ ...delivery({}), secret: undefined }, dependencies))
      .status,
    403,
  );
  assert.equal(
    (await handleWebhook({ ...delivery({}), method: 'GET' }, dependencies))
      .status,
    405,
  );
  assert.equal(
    (
      await handleWebhook(
        { ...delivery({}), contentType: 'text/plain' },
        dependencies,
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await handleWebhook(
        { ...delivery({}), rawBody: Buffer.alloc(256 * 1024 + 1) },
        dependencies,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await handleWebhook(
        { ...delivery({}), rawBody: Buffer.from('{') },
        dependencies,
      )
    ).status,
    400,
  );
});
test('webhook ignores ordinary text/captions/outsiders and projects only allowlisted image fields', async () => {
  let calls = 0;
  const deps = {
    ...dependencies,
    accept: async (accepted) => {
      calls++;
      assert.deepEqual(accepted, {
        kind: 'image',
        fileId: 'image',
        messageId: 1,
        albumId: undefined,
      });
      return 'done';
    },
  };
  for (const m of [
    { text: 'PRIVATE_CONVERSATION' },
    { caption: 'PRIVATE_CAPTION' },
    { photo: [{ file_id: 'image' }], chat: { id: -999, type: 'supergroup' } },
    { photo: [{ file_id: 'image' }], from: { id: 99, is_bot: false } },
    {
      text: '/find place',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  ])
    assert.equal((await handleWebhook(delivery(m), deps)).body, 'ignored');
  assert.equal(calls, 0);
  assert.equal(
    (
      await handleWebhook(
        delivery({ photo: [{ file_id: 'image' }], caption: 'PRIVATE_CAPTION' }),
        deps,
      )
    ).status,
    200,
  );
  assert.equal(calls, 1);
  assert.equal(
    projectUpdate(
      update({
        text: '/area@other_bot Berlin',
        entities: [{ type: 'bot_command', offset: 0, length: 15 }],
      }),
      policy,
      'places_bot',
    ),
    undefined,
  );
});
test('handler errors and diagnostics never print upstream bodies, tokens or user content', async () => {
  const original = console.error;
  const logs = [];
  console.error = (value) => logs.push(value);
  try {
    const response = await handleWebhook(
      delivery({ photo: [{ file_id: 'image' }] }),
      {
        ...dependencies,
        accept: async () => {
          throw new Error('PRIVATE_TOKEN_BODY_CONTENT');
        },
      },
    );
    assert.equal(response.status, 503);
    assert.equal(response.body, 'processing_unavailable');
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
    assert.equal(
      safeDiagnostic(new Error('openai_reauthorization_required')),
      'openai_reauthorization_required',
    );
  } finally {
    console.error = original;
  }
});
test('durable albums debounce once, deduplicate deliveries, preserve late files and isolate workspaces', async () => {
  const docs = new MemoryDocuments();
  let clock = 0,
    calls = 0;
  const ingress = new Ingress(
    docs,
    'shared',
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );
  const a = { kind: 'image', fileId: 'a', messageId: 1, albumId: 'album' };
  const id = await ingress.receive(-100, a);
  await ingress.receive(-100, { ...a, fileId: 'b', messageId: 2 });
  await ingress.receive(-100, a);
  await ingress.run(id, async (record) => {
    calls++;
    assert.deepEqual(record.fileIds, ['a', 'b']);
    assert.ok(clock >= 1500);
  });
  assert.equal(
    await ingress.run(id, async () => assert.fail('duplicate processed')),
    'done',
  );
  assert.equal(calls, 1);
  const late = await ingress.receive(-100, { ...a, fileId: 'c', messageId: 3 });
  assert.notEqual(late, id);
  assert.notEqual(await new Ingress(docs, 'other').receive(-100, a), id);
  assert.doesNotMatch(
    JSON.stringify([...docs.values]),
    /caption|text|bytes|argument/,
  );
});
test('active ingress owners cause retry; expired owners are fenced and recoverable', async () => {
  const docs = new MemoryDocuments();
  let clock = 0;
  const ingress = new Ingress(
    docs,
    'shared',
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );
  const id = await ingress.receive(-100, {
    kind: 'image',
    fileId: 'a',
    messageId: 1,
  });
  let complete, assertOld;
  const gate = new Promise((r) => (complete = r));
  const first = ingress.run(id, async (_record, assertOwned) => {
    assertOld = assertOwned;
    await gate;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    await ingress.run(id, async () => assert.fail('racing owner')),
    'retry',
  );
  clock = 400_000;
  assert.equal(await ingress.run(id, async () => {}), 'done');
  await assert.rejects(assertOld(), /lease_lost/);
  complete();
  await assert.rejects(first, /lease_lost/);
});
test('Secret Manager session format is strict and hides malformed sensitive payloads', () => {
  assert.deepEqual(decodeSession(encodeSession(fixture)), fixture);
  for (const bytes of [
    Buffer.from('PRIVATE_MALFORMED'),
    Buffer.from(JSON.stringify({ ...fixture, unexpected: 'PRIVATE' })),
    Buffer.alloc(65537),
  ])
    assert.throws(() => decodeSession(bytes), {
      message: 'openai_session_invalid',
    });
});
function sessionSetup(docs = new MemoryDocuments()) {
  const versions = [encodeSession(fixture)];
  const secrets = {
    read: async (version) =>
      version
        ? versions[Number(version.split('/').at(-1)) - 1]
        : versions.at(-1),
    add: async (bytes) => {
      versions.push(bytes);
      return `projects/12345/secrets/OPENAI_SIWC_SESSION/versions/${versions.length}`;
    },
  };
  const store = () =>
    new SecretSessions(
      secrets,
      host,
      new RefreshLease(
        docs,
        undefined,
        Date.now,
        async () => new Promise((r) => setTimeout(r, 1)),
      ),
    );
  return { docs, versions, secrets, store };
}
test('independent serverless instances serialize rotating refresh and reread latest after acquisition', async () => {
  const { docs, versions, store } = sessionSetup();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return Response.json({
      access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  };
  try {
    const first = new OpenAiOAuth(store(), 'owner'),
      second = new OpenAiOAuth(store(), 'owner');
    assert.deepEqual(
      await Promise.all([first.accessToken(), second.accessToken()]),
      ['fixture-new-access', 'fixture-new-access'],
    );
    assert.equal(calls, 1);
    assert.equal(versions.length, 2);
    assert.match(
      docs.values.get('_runtime/openai-refresh').sessionVersion,
      /\/2$/,
    );
    const latest = decodeSession(versions.at(-1));
    assert.equal(latest.refreshToken, 'fixture-new-refresh');
    assert.equal(latest.idToken, fixture.idToken);
    assert.doesNotMatch(
      JSON.stringify([...docs.values]),
      /fixture-(?:old|new|id)/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('known temporary refresh rejection preserves prior credentials and permits a later retry', async () => {
  const { docs, versions, store } = sessionSetup();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: 'PRIVATE_UPSTREAM_BODY' }, { status: 503 });
  try {
    await assert.rejects(new OpenAiOAuth(store(), 'owner').accessToken(), {
      message: 'openai_refresh_failed',
    });
    assert.equal(versions.length, 1);
    assert.deepEqual(decodeSession(versions[0]), fixture);
    assert.equal(docs.values.get('_runtime/openai-refresh').blocked, false);
  } finally {
    globalThis.fetch = original;
  }
});
test('terminal or ambiguous refreshes fail closed without deleting the prior secret', async () => {
  const original = globalThis.fetch;
  try {
    for (const fetcher of [
      async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
      async () => {
        throw new Error('PRIVATE_NETWORK_CAUSE');
      },
      async () =>
        Response.json({
          access_token: 'fixture-new',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
    ]) {
      const { docs, versions, store } = sessionSetup();
      globalThis.fetch = fetcher;
      await assert.rejects(
        new OpenAiOAuth(store(), 'owner').accessToken(),
        /reauthorization_required/,
      );
      assert.equal(versions.length, 1);
      assert.equal(docs.values.get('_runtime/openai-refresh').blocked, true);
      await assert.rejects(new OpenAiOAuth(store(), 'owner').accessToken(), {
        message: 'openai_reauthorization_required',
      });
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('crashed refresh owner and failed replacement writes cannot replay a consumed token', async () => {
  const { docs, secrets, versions, store } = sessionSetup();
  docs.values.set('_runtime/openai-refresh', {
    owner: 'old',
    phase: 'refreshing',
    expiresAt: 0,
  });
  await assert.rejects(new OpenAiOAuth(store(), 'owner').accessToken(), {
    message: 'openai_reauthorization_required',
  });
  docs.values.set('_runtime/openai-refresh', { expiresAt: 0 });
  secrets.add = async () => {
    throw new Error('PRIVATE_STORAGE_BODY');
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  try {
    await assert.rejects(new OpenAiOAuth(store(), 'owner').accessToken());
    assert.equal(versions.length, 1);
    assert.equal(docs.values.get('_runtime/openai-refresh').blocked, true);
  } finally {
    globalThis.fetch = original;
  }
});
test('global image slot bounds concurrent memory and releases on failure', async () => {
  const docs = new MemoryDocuments();
  let release;
  const gate = new Promise((r) => (release = r));
  const active = imageSlot(docs, async () => gate);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    imageSlot(docs, async () => {}),
    /image_runtime_busy/,
  );
  release();
  await active;
  await assert.rejects(
    imageSlot(docs, async () => {
      throw new Error('fixture');
    }),
  );
  await imageSlot(docs, async (assertOwned) => assertOwned());
});
test('production is explicitly scale-to-zero in europe-west3 with conservative bounds', async () => {
  const source = await readFile('apps/functions/src/index.ts', 'utf8');
  assert.match(source, /region:\s*'europe-west3'/);
  assert.match(source, /minInstances:\s*0/);
  assert.match(source, /maxInstances:\s*2/);
  assert.match(source, /concurrency:\s*16/);
  assert.match(source, /memory:\s*'512MiB'/);
  assert.doesNotMatch(source, /vpcConnector|onSchedule|\.start\(/);
});

test('migration plan makes metadata reads only; unexpected legacy firewall blocks apply before mutations', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(
    'python3',
    [
      '-c',
      `import importlib.util,io,json,urllib.request,contextlib,shutil
spec=importlib.util.spec_from_file_location('migration','infra/migrate-serverless.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
def cloud(*args,**kwargs):
 calls.append(args)
 if args[:2]==('projects','describe'):return {'projectNumber':'12345'}
 if args[:3]==('firestore','databases','describe'):return {'locationId':'europe-west3'}
 if args[:2]==('projects','get-iam-policy'):return {'bindings':[]}
 if args[:2]==('secrets','describe'):return {'name':'metadata-only'}
 if args[:2]==('secrets','get-iam-policy'):return {'bindings':[]}
 if 'list' in args:return []
 return None
m.cloud=cloud;shutil.which=lambda _: '/fixture/gcloud'
urllib.request.urlopen=lambda *a,**k:io.BytesIO(json.dumps({'id':123,'owner':{'id':456}}).encode())
with contextlib.redirect_stdout(io.StringIO()):m.main('--plan')
assert calls and all(not any(verb in a for verb in ['create','delete','add-iam-policy-binding','remove-iam-policy-binding','enable','access']) for a in calls)
calls.clear()
original=m.cloud
def bad(*args,**kwargs):
 if args[:3]==('compute','firewall-rules','describe'):return {'network':'wrong'}
 return original(*args,**kwargs)
m.cloud=bad
try:m.main('--apply');raise AssertionError('unsafe apply accepted')
except RuntimeError as e:assert str(e)=='abandoned_firewall_configuration_mismatch'
assert all('delete' not in a and 'enable' not in a for a in calls)
print('migration_mock_checks_ok')`,
    ],
    { encoding: 'utf8' },
  );
  assert.match(output, /migration_mock_checks_ok/);
});

test('serverless host identity can be used for owner reauthorization without replacing a local host', async () => {
  const { FileSessions } = await import('@places/providers');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'places-host-test-'));
  try {
    const files = new FileSessions(directory);
    const localHost = await files.hostId();
    const configured = new FileSessions(directory, host);
    assert.equal(await configured.hostId(), host);
    const { url } = await new OpenAiOAuth(configured, 'owner').begin(
      'http://127.0.0.1:8000/auth/callback',
    );
    assert.equal(new URL(url).searchParams.get('ext_agent_host_id'), host);
    assert.equal(await files.hostId(), localHost);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable version pointer survives leases and avoids a stale latest alias on subsequent refresh', async () => {
  const docs = new MemoryDocuments();
  const versions = [encodeSession(fixture)];
  let numberedReads = 0;
  const secrets = {
    read: async (version) => {
      if (version) {
        numberedReads++;
        return versions[Number(version.split('/').at(-1)) - 1];
      }
      return versions[0];
    },
    add: async (payload) => {
      versions.push(payload);
      return `projects/12345/secrets/OPENAI_SIWC_SESSION/versions/${versions.length}`;
    },
  };
  const store = () => new SecretSessions(secrets, host, new RefreshLease(docs));
  const original = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async (_url, init) => {
    refreshes++;
    assert.equal(
      init.body.get('refresh_token'),
      refreshes === 1 ? 'fixture-old-refresh' : 'fixture-new-refresh',
    );
    return Response.json({
      access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  };
  try {
    await new OpenAiOAuth(store(), 'owner').accessToken();
    assert.equal(
      await new OpenAiOAuth(store(), 'owner').accessToken(),
      'fixture-new-access',
    );
    assert.equal(refreshes, 1);
    versions[1] = encodeSession({
      ...decodeSession(versions[1]),
      expiresAt: 0,
    });
    await new OpenAiOAuth(store(), 'owner').accessToken();
    assert.equal(refreshes, 2);
    assert.ok(numberedReads >= 3);
    assert.match(
      docs.values.get('_runtime/openai-refresh').sessionVersion,
      /\/3$/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('Secret Manager version-number handoff tolerates canonical project numbers without crossing secret scope', async () => {
  const { googleSessionSecrets } = await import('@places/providers');
  let requested;
  const api = googleSessionSecrets('mom-im-ok-places', {
    accessSecretVersion: async (args) => {
      requested = args.name;
      return [{ payload: { data: encodeSession(fixture) } }];
    },
    addSecretVersion: async () => [
      { name: 'projects/12345/secrets/OPENAI_SIWC_SESSION/versions/3' },
    ],
  });
  assert.deepEqual(
    decodeSession(
      await api.read('projects/12345/secrets/OPENAI_SIWC_SESSION/versions/3'),
    ),
    fixture,
  );
  assert.equal(
    requested,
    'projects/mom-im-ok-places/secrets/OPENAI_SIWC_SESSION/versions/3',
  );
  assert.equal(
    await api.add(encodeSession(fixture)),
    'projects/12345/secrets/OPENAI_SIWC_SESSION/versions/3',
  );
  await assert.rejects(
    api.read('projects/12345/secrets/OTHER_SECRET/versions/3'),
    { message: 'openai_session_unavailable' },
  );
});
