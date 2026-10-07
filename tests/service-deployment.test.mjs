import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageFunctions } from '../scripts/package-functions.mjs';
const settings = {
  WORKSPACE_ID: 'fixture',
  OPENAI_MODEL: 'fixture-model',
  OPENAI_REASONING_EFFORT: 'low',
  OPENAI_HOST_ID: 'urn:uuid:11111111-1111-4111-8111-111111111111',
};
for (const enabled of [
  'false',
  'true',
  undefined,
  'TRUE',
  'false\nEVIL=true',
]) {
  test(`service env accepts only explicit boolean: ${JSON.stringify(enabled)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-env-'));
    try {
      await mkdir(join(directory, '.deploy/functions'), { recursive: true });
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/write-function-env.mjs'), '--target', 'service'],
        {
          cwd: directory,
          env: {
            ...settings,
            ...(enabled === undefined
              ? {}
              : { PLACES_SERVICE_ENABLED: enabled }),
            TELEGRAM_CHAT_ID: 'unrelated',
            PLACES_FEED_TOKEN: 'must_not_be_written',
          },
          encoding: 'utf8',
        },
      );
      if (!['true', 'false'].includes(enabled)) {
        assert.equal(result.status, 1);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        await readFile(
          join(directory, '.deploy/functions/.env.mom-im-ok-places'),
          'utf8',
        ),
        Object.entries(settings)
          .map(([k, v]) => `${k}=${v}\n`)
          .join('') +
          `NOMINATIM_ENDPOINT=https://nominatim.openstreetmap.org\nPLACES_SERVICE_ENABLED=${enabled}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test('standalone service production dependencies import/discover without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-smoke-'));
  try {
    await packageFunctions(process.cwd(), directory, '0'.repeat(40), 'service');
    execFileSync(
      'npm',
      [
        'ci',
        '--prefix',
        directory,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { stdio: 'pipe' },
    );
    const result = execFileSync(
      process.execPath,
      [resolve('scripts/smoke-function-package.mjs'), directory, 'service'],
      {
        env: { PATH: process.env.PATH, METADATA_SERVER_DETECTION: 'none' },
        encoding: 'utf8',
      },
    );
    assert.match(result, /production_package_ok:service/);
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {placesService}=await import(${JSON.stringify(join(directory, 'dist/service-entry.js'))}); const assert=(await import('node:assert/strict')).default; assert.deepEqual(placesService.__endpoint.httpsTrigger.invoker,['private']); assert.equal(placesService.__endpoint.serviceAccountEmail,'places-runtime@mom-im-ok-places.iam.gserviceaccount.com');`,
      ],
      {
        env: { PATH: process.env.PATH, METADATA_SERVER_DETECTION: 'none' },
        stdio: 'pipe',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('service workflow is manual main-only dormant-first with exact selector and existing identity/lock', async () => {
  const source = await readFile('.github/workflows/deploy-service.yml', 'utf8');
  const feed = await readFile('.github/workflows/deploy-feed.yml', 'utf8');
  assert.match(source, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(
    source,
    /\n  (push|pull_request|schedule|workflow_call):/,
  );
  for (const fragment of [
    "github.ref == 'refs/heads/main'",
    'environment: production',
    'group: places-production-deploy',
    'cancel-in-progress: false',
    'default: false',
    'type: boolean',
    'bash scripts/check-secrets.sh',
    'run: npm ci',
    'run: npm run check',
    'npm run test:rules',
    '--target service',
    'smoke-function-package.mjs .deploy/functions service',
    'PLACES_SERVICE_ENABLED: ${{ inputs.service_enabled }}',
    'workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}',
    'service_account: ${{ vars.GCP_DEPLOY_SERVICE_ACCOUNT }}',
  ])
    assert.ok(source.includes(fragment), fragment);
  assert.deepEqual(
    source.match(/uses: \S+@[a-f0-9]{40}/g),
    feed.match(/uses: \S+@[a-f0-9]{40}/g),
  );
  assert.equal((source.match(/firebase deploy/g) ?? []).length, 1);
  assert.match(
    source,
    /--only functions:places:placesService --non-interactive/,
  );
  assert.doesNotMatch(
    source,
    /placesWebhook|placesFeed|TELEGRAM_|secrets:|add-iam-policy-binding|--force|migrate|--only.*(?:firestore|hosting)/,
  );
  assert.equal((source.match(/id-token: write/g) ?? []).length, 1);
  assert.ok(
    source.indexOf('smoke-function-package.mjs') <
      source.indexOf('google-github-actions/auth@'),
  );
});

for (const [name, value] of [
  ['WORKSPACE_ID', '../bad'],
  ['OPENAI_MODEL', 'model\nEVIL=true'],
  ['OPENAI_REASONING_EFFORT', 'invalid'],
  ['OPENAI_HOST_ID', 'not-a-host'],
  ['NOMINATIM_ENDPOINT', 'https://user:password@example.com'],
]) {
  test(`service env rejects invalid ${name} without writing configuration`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-invalid-env-'));
    try {
      await mkdir(join(directory, '.deploy/functions'), { recursive: true });
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/write-function-env.mjs'), '--target', 'service'],
        {
          cwd: directory,
          env: { ...settings, PLACES_SERVICE_ENABLED: 'false', [name]: value },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr.trim(),
        'function_settings_invalid:configure_nonsecret_production_variables',
      );
      await assert.rejects(
        readFile(join(directory, '.deploy/functions/.env.mom-im-ok-places')),
        { code: 'ENOENT' },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
