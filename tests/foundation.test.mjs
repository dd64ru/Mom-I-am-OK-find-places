import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  classify,
  AlbumBuffer,
  loadConfig,
} from '../apps/worker/dist/index.js';
import { DiscoveryService } from '@places/core';
import { CoordinatesSchema, PlaceSchema } from '@places/schemas';
import {
  FileSessions,
  OpenAiOAuth,
  readResponseStream,
  FallbackVision,
  OpenAiFailure,
  OpenAiVision,
} from '@places/providers';
const policy = { chatId: -100123, userIds: new Set([11, 22]) };
const base = {
  message_id: 1,
  date: 0,
  chat: { id: policy.chatId, type: 'supergroup' },
  from: { id: 11, is_bot: false, first_name: 'A' },
};
test('privacy gate ignores ordinary text, unknown commands, outsiders and commands for other bots', () => {
  for (const message of [
    { ...base, text: 'private conversation' },
    {
      ...base,
      text: '/find Shanghai noodles',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
    {
      ...base,
      text: '/area@other Shanghai',
      entities: [{ type: 'bot_command', offset: 0, length: 11 }],
    },
    {
      ...base,
      from: { ...base.from, id: 99 },
      photo: [{ file_id: 'outside' }],
    },
    {
      ...base,
      chat: { ...base.chat, id: -999 },
      photo: [{ file_id: 'outside' }],
    },
  ])
    assert.equal(classify(message, policy, 'places_bot'), undefined);
  assert.deepEqual(
    classify(
      {
        ...base,
        photo: [{ file_id: 'small' }, { file_id: 'large' }],
        caption: 'private caption',
      },
      policy,
      'places_bot',
    ),
    { kind: 'image', fileId: 'large', messageId: 1, albumId: undefined },
  );
  assert.equal(
    classify(
      {
        ...base,
        text: '/area@places_bot Shanghai',
        entities: [{ type: 'bot_command', offset: 0, length: 16 }],
      },
      policy,
      'places_bot',
    ).argument,
    'Shanghai',
  );
});
test('an album produces one batch, deduplicates file IDs and separates chats', async () => {
  const emitted = [];
  const albums = new AlbumBuffer(
    5000,
    async (batch) => {
      emitted.push(batch);
    },
    () => assert.fail('album error'),
  );
  for (const [chatId, fileId, messageId] of [
    [-1, 'a', 1],
    [-1, 'b', 2],
    [-1, 'a', 1],
    [-2, 'c', 3],
  ]) {
    await albums.add(chatId, {
      kind: 'image',
      fileId,
      messageId,
      albumId: 'album',
    });
  }
  await albums.flush();
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[0].fileIds, ['a', 'b']);
  assert.notEqual(emitted[0].id, emitted[1].id);
});
test('vision-only ingestion saves a pending discovery and never creates a geographic place', async () => {
  const discoveries = new Map();
  let calls = 0;
  const repository = {
    getWorkspace: async () => ({ areaHint: 'Shanghai' }),
    getDiscovery: async (_workspace, id) => discoveries.get(id),
    createDiscovery: async (d) => {
      discoveries.set(d.id, d);
      return d;
    },
    savePlace: async () => assert.fail('vision must not write a Place'),
  };
  const vision = {
    name: 'fixture',
    recognize: async (_images, area) => {
      calls++;
      assert.equal(area, 'Shanghai');
      return {
        provider: 'fixture',
        recognition: {
          visibleText: ['Cafe'],
          clues: [
            { name: 'Cafe', aliases: [], category: 'cafe', confidence: 0.9 },
          ],
        },
      };
    },
  };
  const service = new DiscoveryService(repository, vision);
  const input = {
    id: 'image_1',
    workspaceId: 'shared',
    images: [{ mimeType: 'image/png', bytes: new Uint8Array([1]) }],
    source: { provider: 'fixture', observedAt: new Date().toISOString() },
  };
  const discovery = await service.ingest(input);
  assert.equal(discovery.status, 'needs_confirmation');
  assert.deepEqual(discovery.candidates, []);
  assert.equal(discovery.visionProvider, 'fixture');
  assert.equal('coordinates' in discovery.recognition.clues[0], false);
  assert.deepEqual(await service.ingest(input), discovery);
  assert.equal(calls, 1);
  assert.equal(PlaceSchema.safeParse(discovery).success, false);
  assert.equal(
    CoordinatesSchema.safeParse({ latitude: 0, longitude: 0, crs: 'GCJ02' })
      .success,
    false,
  );
});
test('fallback preserves actual provider attribution', async () => {
  const vision = new FallbackVision(
    {
      name: 'primary',
      recognize: async () => {
        throw new OpenAiFailure('openai_service_unavailable');
      },
    },
    {
      name: 'fallback',
      recognize: async () => ({
        provider: 'fallback',
        recognition: { visibleText: [], clues: [] },
      }),
    },
  );
  assert.equal((await vision.recognize([])).provider, 'fallback');
});
test('configuration fails closed and blank optional example values are accepted', () => {
  assert.throws(() => loadConfig({}), /invalid_configuration/);
  const c = loadConfig({
    WORKSPACE_ID: 'shared',
    TELEGRAM_CHAT_ID: '-100123',
    TELEGRAM_USER_IDS: '11,22',
    OPENAI_MODEL: 'chosen-model',
    GEMINI_MODEL: '',
  });
  assert.equal(c.GEMINI_FALLBACK_ENABLED, 'false');
  assert.equal(c.userIds.size, 2);
});
test('OAuth uses stable host, PKCE and dynamic registration; rejects bad state without network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-session-'));
  try {
    const sessions = new FileSessions(directory);
    const host = await sessions.hostId();
    assert.equal(await sessions.hostId(), host);
    const oauth = new OpenAiOAuth(sessions, 'owner');
    const { url, pending } = await oauth.begin(
      'http://127.0.0.1:12345/auth/callback',
    );
    const params = new URL(url).searchParams;
    assert.equal(params.get('client_id'), 'dynamic_agent_client');
    assert.equal(params.get('ext_agent_host_id'), host);
    assert.equal(
      params.get('code_challenge'),
      createHash('sha256').update(pending.verifier).digest('base64url'),
    );
    assert.match(params.get('scope'), /offline_access/);
    await assert.rejects(
      oauth.complete(
        pending,
        new URLSearchParams({ state: 'invalid', code: 'unused' }),
      ),
      /invalid_oauth_state/,
    );
    assert.equal(pending.consumed, false);
    await assert.rejects(
      oauth.complete(
        pending,
        new URLSearchParams({ state: pending.state, code: 'unused' }),
      ),
      /invalid_issued_client/,
    );
    await sessions.save('owner', {
      clientId: 'issued',
      subject: 'subject',
      issuer: 'https://auth.openai.com',
      idToken: 'fixture-id',
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
      expiresAt: Date.now() + 3600000,
    });
    assert.equal(
      (await stat(join(directory, 'owner.json'))).mode & 0o777,
      0o600,
    );
    const returning = await oauth.begin('http://127.0.0.1:12345/auth/callback');
    assert.equal(
      new URL(returning.url).searchParams.get('client_id'),
      'issued',
    );
    assert.equal(
      new URL(returning.url).searchParams.has('agent_name_hint'),
      false,
    );
    assert.equal(
      JSON.parse(await readFile(join(directory, 'host.json'), 'utf8')).id,
      host,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('Responses stream requires completion and rejects a failure arriving after deltas', async () => {
  const delta =
    'data: ' +
    JSON.stringify({
      type: 'response.output_text.delta',
      delta: '{"visibleText":[],"clues":[]}',
    }) +
    '\n\n';
  const end =
    'data: ' + JSON.stringify({ type: 'response.completed' }) + '\n\n';
  assert.equal(
    await readResponseStream(new Response(delta + end)),
    '{"visibleText":[],"clues":[]}',
  );
  await assert.rejects(
    readResponseStream(new Response(delta)),
    /openai_stream_incomplete/,
  );
  await assert.rejects(
    readResponseStream(
      new Response(delta + 'data: {"type":"response.failed"}\n\n'),
    ),
    /openai_inference_failed/,
  );
});

test('OpenAI adapter discovers the account catalog and emits only supported plan request fields', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  let catalogRequests = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) {
      catalogRequests++;
      return Response.json({
        models: [
          {
            slug: 'account-image-model',
            display_name: 'Account image model',
            visibility: 'list',
          },
        ],
      });
    }
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer fixture-access');
    request = JSON.parse(init.body);
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"{\\"visibleText\\":[],\\"clues\\":[]}"}\n\ndata: {"type":"response.completed"}\n\n',
    );
  };
  try {
    const vision = new OpenAiVision(
      { accessToken: async () => 'fixture-access' },
      'account-image-model',
      'medium',
    );
    await vision.validateModel();
    const result = await vision.recognize(
      [{ mimeType: 'image/png', bytes: new Uint8Array([1, 2]) }],
      'Shanghai',
    );
    assert.equal(result.provider, 'openai-siwc');
    await vision.recognize([
      { mimeType: 'image/png', bytes: new Uint8Array([1, 2]) },
    ]);
    assert.equal(catalogRequests, 1);
    assert.deepEqual(Object.keys(request).sort(), [
      'input',
      'instructions',
      'model',
      'reasoning',
      'store',
      'stream',
    ]);
    assert.deepEqual(request.reasoning, { effort: 'medium' });
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.equal(request.input[0].role, 'user');
    assert.match(
      request.input[0].content[1].image_url,
      /^data:image\/png;base64,/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OAuth refreshes serialize and atomically replace the rotating token set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-refresh-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const sessions = new FileSessions(directory);
    await sessions.save('owner', {
      clientId: 'issued',
      subject: 'subject',
      issuer: 'https://auth.openai.com',
      idToken: 'fixture-id',
      accessToken: 'fixture-old',
      refreshToken: 'fixture-refresh',
      scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
      expiresAt: 0,
    });
    let releaseResponse;
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve;
    });
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        'https://auth.openai.com/api/accounts/oauth/token',
      );
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      assert.equal(init.body.get('client_id'), 'issued');
      assert.equal(init.body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(init.body.has('scope'), false);
      await responseGate;
      return Response.json({
        access_token: 'fixture-new',
        refresh_token: 'fixture-rotated',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    };
    const oauth = new OpenAiOAuth(sessions, 'owner');
    const first = oauth.accessToken();
    const second = oauth.accessToken();
    // Yield file reads while the mock token response remains pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseResponse();
    assert.deepEqual(await Promise.all([first, second]), [
      'fixture-new',
      'fixture-new',
    ]);
    assert.equal(calls, 1);
    const saved = await sessions.load('owner');
    assert.equal(saved.refreshToken, 'fixture-rotated');
    assert.equal(saved.accessToken, 'fixture-new');
    assert.ok(saved.expiresAt > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('unavailable startup models and invalid catalogs fail closed with safe diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ models: [] });
    };
    const vision = new OpenAiVision(
      { accessToken: async () => 'fixture-access' },
      'missing-model',
      'low',
    );
    await assert.rejects(vision.validateModel(), {
      message: 'openai_model_unavailable',
    });
    await assert.rejects(vision.recognize([]), {
      message: 'openai_model_not_validated',
    });
    assert.equal(requests, 1);
    globalThis.fetch = async () => new Response('private upstream body');
    await assert.rejects(vision.validateModel(), {
      message: 'openai_catalog_invalid',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback preserves non-eligible errors without invoking Gemini or fallback logging', async () => {
  let fallbackCalls = 0;
  let notifications = 0;
  for (const error of [
    new Error('openai_authorization_required'),
    new Error('chatgpt_plan_permission_missing'),
    new OpenAiFailure('openai_model_unavailable'),
    new OpenAiFailure('openai_model_not_validated'),
    new OpenAiFailure('openai_catalog_invalid'),
    new OpenAiFailure('openai_output_invalid'),
    new OpenAiFailure('openai_request_rejected'),
    new OpenAiFailure('openai_request_failed'),
    new SyntaxError('invalid JSON'),
    new TypeError('programming failure'),
    // A message resembling an eligible error is insufficient; the typed classification is required.
    new Error('openai_service_unavailable'),
  ]) {
    const vision = new FallbackVision(
      {
        name: 'primary',
        recognize: async () => {
          throw error;
        },
      },
      {
        name: 'gemini',
        recognize: async () => {
          fallbackCalls++;
        },
      },
      () => {
        notifications++;
      },
    );
    await assert.rejects(
      vision.recognize([]),
      (received) => received === error,
    );
  }
  assert.equal(fallbackCalls, 0);
  assert.equal(notifications, 0);
});

test('real primary HTTP classification falls back only for gateway/service outages', async () => {
  const originalFetch = globalThis.fetch;
  let status = 200;
  let mode = 'http';
  let authError;
  let fallbackCalls = 0;
  let notifications = 0;
  const fallbackResult = {
    provider: 'gemini',
    recognition: { visibleText: [], clues: [] },
  };
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [
            { slug: 'selected', display_name: 'Selected', visibility: 'list' },
          ],
        });
      if (mode === 'transport')
        throw new TypeError('private transport details');
      if (['schema', 'malformed', 'incomplete', 'failed'].includes(mode)) {
        const delta = JSON.stringify({
          type: 'response.output_text.delta',
          delta:
            mode === 'schema'
              ? JSON.stringify({
                  visibleText: 'private model content',
                  clues: [],
                })
              : 'private invalid model output',
        });
        const terminal =
          mode === 'incomplete'
            ? ''
            : `data: ${JSON.stringify({ type: mode === 'failed' ? 'response.failed' : 'response.completed' })}\n\n`;
        return new Response(`data: ${delta}\n\n${terminal}`);
      }
      return new Response('private upstream body', { status });
    };
    const primary = new OpenAiVision(
      {
        accessToken: async () => {
          if (authError) throw authError;
          return 'fixture-access';
        },
      },
      'selected',
      'low',
    );
    await primary.validateModel();
    const vision = new FallbackVision(
      primary,
      {
        name: 'gemini',
        recognize: async () => {
          fallbackCalls++;
          return fallbackResult;
        },
      },
      () => {
        notifications++;
      },
    );
    for (status of [400, 401, 403, 404, 429, 500]) {
      await assert.rejects(vision.recognize([]), {
        message:
          status === 400
            ? 'openai_request_options_rejected'
            : 'openai_request_rejected',
      });
    }
    for (mode of ['schema', 'malformed', 'incomplete', 'failed']) {
      await assert.rejects(vision.recognize([]), {
        message: 'openai_output_invalid',
      });
    }
    mode = 'transport';
    await assert.rejects(vision.recognize([]), {
      message: 'openai_request_failed',
    });
    authError = new Error('openai_authorization_required');
    await assert.rejects(
      vision.recognize([]),
      (received) => received === authError,
    );
    assert.equal(fallbackCalls, 0);
    assert.equal(notifications, 0);
    authError = undefined;
    mode = 'http';
    for (status of [502, 503, 504])
      assert.deepEqual(await vision.recognize([]), fallbackResult);
    assert.equal(fallbackCalls, 3);
    assert.equal(notifications, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
