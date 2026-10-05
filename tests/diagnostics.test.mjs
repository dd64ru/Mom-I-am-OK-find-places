import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  loadVisionConfig,
  loadTelegramIdsConfig,
  loadSmokeImage,
  MAX_IMAGE_BYTES,
  runVisionSmoke,
  extractTelegramIdMetadata,
  pollTelegramIds,
  TelegramIdsApi,
  diagnosticCode,
} from '../apps/worker/dist/index.js';
import {
  FileSessions,
  OpenAiVision,
  OpenAiReasoningEffortSchema,
} from '@places/providers';
const validVisionEnv = {
  OPENAI_MODEL: 'account-selected-model',
  OPENAI_REASONING_EFFORT: 'low',
};
const validWorkerEnv = {
  ...validVisionEnv,
  WORKSPACE_ID: 'shared',
  TELEGRAM_CHAT_ID: '-100123',
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = Buffer.from([255, 216, 255, 0]);
const webp = Buffer.from('RIFF1234WEBPfixture');

test('reasoning effort is independent, defaults only when absent and rejects invalid values', () => {
  for (const effort of [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]) {
    assert.equal(OpenAiReasoningEffortSchema.parse(effort), effort);
    assert.equal(
      loadVisionConfig({ ...validVisionEnv, OPENAI_REASONING_EFFORT: effort })
        .OPENAI_REASONING_EFFORT,
      effort,
    );
    assert.equal(
      loadConfig({ ...validWorkerEnv, OPENAI_REASONING_EFFORT: effort })
        .OPENAI_REASONING_EFFORT,
      effort,
    );
  }
  assert.equal(
    loadVisionConfig({ OPENAI_MODEL: 'selected' }).OPENAI_REASONING_EFFORT,
    'low',
  );
  for (const effort of ['', 'ultra', 'LOW', 'bogus']) {
    assert.throws(
      () =>
        loadVisionConfig({
          ...validVisionEnv,
          OPENAI_REASONING_EFFORT: effort,
        }),
      /invalid_vision_configuration/,
    );
    assert.throws(
      () => loadConfig({ ...validWorkerEnv, OPENAI_REASONING_EFFORT: effort }),
      /invalid_configuration:OPENAI_REASONING_EFFORT/,
    );
    assert.throws(() => new OpenAiVision({}, 'selected', effort), {
      message: 'openai_reasoning_effort_invalid',
    });
  }
  assert.equal(
    loadVisionConfig({ ...validVisionEnv, OPENAI_MODEL: 'another-model' })
      .OPENAI_REASONING_EFFORT,
    'low',
  );
  assert.equal(
    loadTelegramIdsConfig({
      SECRET_SOURCE: 'env',
      TELEGRAM_BOT_TOKEN: '123:fixture',
    }).TELEGRAM_BOT_TOKEN,
    '123:fixture',
  );
  assert.throws(
    () => loadTelegramIdsConfig({ SECRET_SOURCE: 'env' }),
    /invalid_telegram_ids_configuration/,
  );
});

test('smoke validates exactly one bounded JPEG/PNG/WebP before any live request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-image-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    assert.fail('file validation must not contact live services');
  try {
    for (const [filename, bytes, mimeType] of [
      ['photo.jpeg', jpeg, 'image/jpeg'],
      ['photo.PNG', png, 'image/png'],
      ['photo.webp', webp, 'image/webp'],
    ]) {
      const path = join(directory, filename);
      await writeFile(path, bytes);
      assert.equal((await loadSmokeImage([path])).mimeType, mimeType);
    }
    for (const args of [[], ['one.png', 'two.png']])
      await assert.rejects(loadSmokeImage(args), {
        message: 'vision_smoke_usage:expected_one_image',
      });
    const invalid = join(directory, 'invalid.png');
    await writeFile(invalid, 'private file contents');
    await assert.rejects(loadSmokeImage([invalid]), {
      message: 'vision_smoke_unsupported_image',
    });
    const disguised = join(directory, 'disguised.jpg');
    await writeFile(disguised, png);
    await assert.rejects(loadSmokeImage([disguised]), {
      message: 'vision_smoke_unsupported_image',
    });
    const unsupported = join(directory, 'photo.gif');
    await writeFile(unsupported, png);
    await assert.rejects(loadSmokeImage([unsupported]), {
      message: 'vision_smoke_unsupported_image',
    });
    await assert.rejects(loadSmokeImage([join(directory, 'missing.png')]), {
      message: 'vision_smoke_image_unreadable',
    });
    const oversized = join(directory, 'big.png');
    const file = await open(oversized, 'w');
    await file.truncate(MAX_IMAGE_BYTES + 1);
    await file.close();
    await assert.rejects(loadSmokeImage([oversized]), {
      message: 'vision_smoke_image_too_large',
    });
    const sessions = join(directory, 'must-not-be-created');
    await assert.rejects(
      runVisionSmoke([unsupported], {
        ...validVisionEnv,
        OPENAI_SESSION_DIR: sessions,
      }),
      { message: 'vision_smoke_unsupported_image' },
    );
    await assert.rejects(stat(sessions), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('smoke reuses SIWC, validates the catalog and sends configured effort with no fallback or cloud calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-smoke-'));
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    const sessions = new FileSessions(join(directory, 'sessions'));
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
    const imagePath = join(directory, 'image.png');
    await writeFile(imagePath, png);
    const recognition = { visibleText: ['Cafe'], clues: [] };
    globalThis.fetch = async (url, init) => {
      requests.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/models')
        return Response.json({
          models: [
            {
              slug: validVisionEnv.OPENAI_MODEL,
              display_name: 'Available',
              visibility: 'list',
            },
          ],
        });
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.reasoning, { effort: 'max' });
      assert.equal(
        body.input[0].content.filter((part) => part.type === 'input_image')
          .length,
        1,
      );
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(recognition) })}\n\ndata: {"type":"response.completed"}\n\n`,
      );
    };
    const result = await runVisionSmoke([imagePath], {
      ...validVisionEnv,
      OPENAI_SESSION_DIR: sessions.directory,
      OPENAI_REASONING_EFFORT: 'max',
    });
    assert.deepEqual(result, recognition);
    assert.deepEqual(requests, [
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/responses',
    ]);
    assert.equal(JSON.stringify(result).includes('fixture-access'), false);
    await assert.rejects(stat(join(sessions.directory, 'owner.lock')), {
      code: 'ENOENT',
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

const groupMessage = {
  chat: { id: -100123, type: 'supergroup', title: 'Shared group' },
  from: {
    id: 11,
    is_bot: false,
    first_name: 'First',
    last_name: 'Member',
    username: 'member',
  },
  text: 'PRIVATE_CONVERSATION',
  caption: 'PRIVATE_CAPTION',
  photo: [{ file_id: 'PRIVATE_FILE_ID', bytes: 'PRIVATE_IMAGE_BYTES' }],
  document: {
    file_id: 'PRIVATE_DOCUMENT',
    contents: 'PRIVATE_DOCUMENT_CONTENTS',
  },
  token: '123:fixture',
  apiUrl: 'https://api.telegram.org/bot123:fixture/getUpdates',
};
test('Telegram projection/poll output contains only allowed metadata, never text, captions, media or raw updates', async () => {
  const expected = {
    chatId: -100123,
    chatType: 'supergroup',
    chatTitle: 'Shared group',
    userId: 11,
    username: 'member',
    displayName: 'First Member',
    eventKind: 'image',
  };
  assert.deepEqual(extractTelegramIdMetadata(groupMessage), expected);
  const redacted = extractTelegramIdMetadata(
    {
      ...groupMessage,
      chat: { ...groupMessage.chat, title: groupMessage.apiUrl },
      from: { ...groupMessage.from, first_name: '123:fixture' },
    },
    '123:fixture',
  );
  assert.equal(JSON.stringify(redacted).includes('123:fixture'), false);
  assert.equal(JSON.stringify(redacted).includes('api.telegram.org'), false);

  assert.equal(
    extractTelegramIdMetadata({
      ...groupMessage,
      chat: { id: 11, type: 'private' },
    }),
    undefined,
  );
  assert.equal(
    extractTelegramIdMetadata({
      ...groupMessage,
      from: { ...groupMessage.from, is_bot: true },
    }),
    undefined,
  );
  const controller = new AbortController();
  const outputs = [];
  const offsets = [];
  const api = {
    getUpdates: async (offset) => {
      offsets.push(offset);
      return [
        {
          update_id: offset ?? 1,
          message: offset
            ? {
                ...groupMessage,
                from: { ...groupMessage.from, id: 22 },
                photo: undefined,
                document: undefined,
              }
            : groupMessage,
        },
      ];
    },
  };
  await pollTelegramIds(
    api,
    (metadata) => {
      outputs.push(JSON.stringify(metadata));
      if (outputs.length === 2) controller.abort();
    },
    controller.signal,
  );
  assert.deepEqual(offsets, [undefined, 2]);
  assert.equal(JSON.parse(outputs[1]).eventKind, 'text');
  assert.equal(JSON.parse(outputs[1]).userId, 22);
  const representation = outputs.join('\n');
  for (const forbidden of [
    'PRIVATE_',
    '123:fixture',
    'api.telegram.org',
    'file_id',
    'update_id',
    'caption',
    'contents',
  ])
    assert.equal(representation.includes(forbidden), false);
  const command = {
    ...groupMessage,
    photo: undefined,
    document: undefined,
    entities: [{ type: 'bot_command', offset: 0, length: 5 }],
  };
  assert.equal(extractTelegramIdMetadata(command).eventKind, 'command');
});

test('Telegram network/HTTP/JSON errors and CLI diagnostics expose no tokens, URLs, raw bodies or causes', async () => {
  const token = '123:fixture';
  const privateDetails = `https://api.telegram.org/bot${token}/getUpdates PRIVATE_BODY`;
  const controller = new AbortController();
  for (const [fetcher, code] of [
    [
      async () => {
        throw new Error(privateDetails);
      },
      'telegram_ids_polling_failed',
    ],
    [
      async () => new Response(privateDetails, { status: 401 }),
      'telegram_ids_unauthorized',
    ],
    [
      async () => new Response(privateDetails, { status: 409 }),
      'telegram_ids_conflict:stop_other_poller',
    ],
    [
      async () => new Response(privateDetails, { status: 500 }),
      'telegram_ids_polling_failed',
    ],
    [async () => new Response(privateDetails), 'telegram_ids_polling_failed'],
    [
      async () => Response.json({ ok: false, description: privateDetails }),
      'telegram_ids_polling_failed',
    ],
  ]) {
    const api = new TelegramIdsApi(token, fetcher);
    await assert.rejects(
      api.getUpdates(undefined, controller.signal),
      (error) => {
        assert.equal(error.message, code);
        assert.equal(diagnosticCode(error, 'telegram:ids'), code);
        assert.equal(JSON.stringify(error).includes(token), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  for (const command of ['vision:smoke', 'telegram:ids']) {
    const output = diagnosticCode(
      new Error(privateDetails, { cause: new Error(token) }),
      command,
    );
    assert.equal(output.includes(token), false);
    assert.equal(output.includes('api.telegram.org'), false);
    assert.equal(output.includes('PRIVATE_BODY'), false);
  }
  assert.throws(() => new TelegramIdsApi(privateDetails), {
    message: 'telegram_ids_invalid_token',
  });
  let request;
  const api = new TelegramIdsApi(token, async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json({ ok: true, result: [] });
  });
  assert.deepEqual(await api.getUpdates(3, controller.signal), []);
  assert.deepEqual(request, {
    offset: 3,
    timeout: 20,
    limit: 100,
    allowed_updates: ['message'],
  });
  const stopped = new AbortController();
  stopped.abort();
  await pollTelegramIds(
    {
      getUpdates: async () =>
        assert.fail('stopped poller must not contact Telegram'),
    },
    () => assert.fail('no output'),
    stopped.signal,
  );
});
