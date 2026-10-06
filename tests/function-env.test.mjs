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

test('feed production profile enables only feed with URL mode disabled and no bot settings or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-feed-env-'));
  try {
    await mkdir(join(directory, '.deploy/functions'), { recursive: true });
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../scripts/write-function-env.mjs', import.meta.url),
        ),
        '--target',
        'feed',
      ],
      {
        cwd: directory,
        env: {
          WORKSPACE_ID: 'fixture',
          PLACES_FEED_ENABLED: 'false',
          PLACES_FEED_URL_TOKENS_ENABLED: 'true',
          PLACES_FEED_TOKEN: 'must_not_be_written',
          PLACES_FEED_TOKEN_SHA256: 'must_not_be_written',
        },
      },
    );
    assert.equal(
      await readFile(
        join(directory, '.deploy/functions/.env.mom-im-ok-places'),
        'utf8',
      ),
      'WORKSPACE_ID=fixture\nPLACES_FEED_ENABLED=true\nPLACES_FEED_URL_TOKENS_ENABLED=false\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent production workflows retain pinned toolchain and exclusive function-only scope', async () => {
  const webhook = await readFile(
    new URL('../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );
  const feed = await readFile(
    new URL('../.github/workflows/deploy-feed.yml', import.meta.url),
    'utf8',
  );
  for (const [source, target] of [
    [webhook, 'placesWebhook'],
    [feed, 'placesFeed'],
  ]) {
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /github.ref == 'refs\/heads\/main'/);
    assert.match(source, /environment: production/);
    assert.match(source, /node-version: '22.23.3'/);
    assert.match(source, /bash scripts\/check-secrets.sh/);
    assert.match(source, /run: npm ci/);
    assert.match(source, /run: npm run check/);
    assert.equal((source.match(/firebase deploy/g) ?? []).length, 1);
    assert.match(
      source,
      new RegExp(`--only functions:places:${target} --non-interactive`),
    );
    assert.doesNotMatch(
      source,
      /--only.*(?:firestore|indexes|rules)|secrets (?:create|versions add)|add-iam-policy-binding|migrate.*--apply/,
    );
    assert.deepEqual(
      source.match(/uses: \S+@[a-f0-9]{40}/g),
      webhook.match(/uses: \S+@[a-f0-9]{40}/g),
    );
  }
  assert.doesNotMatch(webhook, /--target feed|functions:places:placesFeed/);
  assert.doesNotMatch(
    feed,
    /functions:places:placesWebhook|TELEGRAM_|OPENAI_|vars\.PLACES_FEED_/,
  );
  assert.match(feed, /npm run test:rules/);
  assert.match(
    feed,
    /deploy:package -- --output .deploy\/functions --target feed/,
  );
  assert.match(feed, /write-function-env.mjs --target feed/);
  assert.match(feed, /smoke-function-package.mjs .deploy\/functions feed/);
});
