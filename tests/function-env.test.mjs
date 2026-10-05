import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const settings = {
  WORKSPACE_ID: 'fixture',
  TELEGRAM_CHAT_ID: '-100',
  TELEGRAM_BOT_USERNAME: 'fixture_bot',
  OPENAI_MODEL: 'fixture-model',
  OPENAI_REASONING_EFFORT: 'low',
  OPENAI_HOST_ID: 'urn:uuid:11111111-1111-4111-8111-111111111111',
};
for (const ambientFlags of [
  {},
  { PLACES_FEED_ENABLED: 'true', PLACES_FEED_URL_TOKENS_ENABLED: 'true' },
])
  test(`webhook-only production env explicitly disables both feed params with ${Object.keys(ambientFlags).length ? 'hostile' : 'absent'} ambient flags`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'places-function-env-'));
    try {
      await mkdir(join(directory, '.deploy/functions'), { recursive: true });
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../scripts/write-function-env.mjs', import.meta.url),
          ),
        ],
        {
          cwd: directory,
          env: { ...settings, ...ambientFlags },
          encoding: 'utf8',
        },
      );
      const generated = await readFile(
        join(directory, '.deploy/functions/.env.mom-im-ok-places'),
        'utf8',
      );
      const lines = generated.trim().split('\n');
      const values = Object.fromEntries(
        lines.map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      assert.deepEqual(values, {
        ...settings,
        NOMINATIM_ENDPOINT: 'https://nominatim.openstreetmap.org',
        GEMINI_FALLBACK_ENABLED: 'false',
        PLACES_FEED_ENABLED: 'false',
        PLACES_FEED_URL_TOKENS_ENABLED: 'false',
      });
      assert.equal(
        lines.length,
        Object.keys(values).length,
        'each setting must be written exactly once',
      );
      const workflow = await readFile(
        new URL('../.github/workflows/deploy.yml', import.meta.url),
        'utf8',
      );
      assert.match(workflow, /run: node scripts\/write-function-env\.mjs/u);
      assert.match(
        workflow,
        /--only functions:places:placesWebhook --non-interactive/u,
      );
      assert.doesNotMatch(
        workflow,
        /vars\.PLACES_FEED_(?:ENABLED|URL_TOKENS_ENABLED)/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
