import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { packageFunctions } from '../scripts/package-functions.mjs';
const require = createRequire(import.meta.url);
const {
  createDeploymentPlan,
} = require('../node_modules/firebase-tools/lib/deploy/functions/release/planner.js');
const {
  getEndpointFilters,
} = require('../node_modules/firebase-tools/lib/deploy/functions/functionsDeployHelper.js');
for (const target of ['webhook', 'feed', 'service']) {
  const name = {
    feed: 'placesFeed',
    webhook: 'placesWebhook',
    service: 'placesService',
  }[target];
  test(`${target} entrypoint exposes only its own Firebase function/parameters and production package selects it`, async () => {
    const entry = resolve(`apps/functions/dist/${target}-entry.js`);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      const exported = await import(${JSON.stringify(entry)});
      const params = globalThis[Symbol.for('firebase-functions:params:declaredParams')].map(p => p.name).sort();
      console.log(JSON.stringify({ functions: Object.entries(exported).filter(([,v]) => v?.__endpoint).map(([n]) => n), params }));
    `,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(result.functions, [name]);
    assert.deepEqual(
      result.params,
      (target === 'service'
        ? [
            'WORKSPACE_ID',
            'OPENAI_MODEL',
            'OPENAI_REASONING_EFFORT',
            'OPENAI_HOST_ID',
            'PLACES_SERVICE_ENABLED',
          ]
        : target === 'feed'
          ? [
              'WORKSPACE_ID',
              'PLACES_FEED_ENABLED',
              'PLACES_FEED_URL_TOKENS_ENABLED',
            ]
          : [
              'WORKSPACE_ID',
              'TELEGRAM_CHAT_ID',
              'TELEGRAM_BOT_USERNAME',
              'OPENAI_MODEL',
              'OPENAI_REASONING_EFFORT',
              'OPENAI_HOST_ID',
              'NOMINATIM_ENDPOINT',
            ]
      ).sort(),
    );
    const directory = await mkdtemp(join(tmpdir(), 'places-target-package-'));
    try {
      await packageFunctions(process.cwd(), directory, '0'.repeat(40), target);
      const pkg = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      assert.equal(pkg.main, `dist/${target}-entry.js`);
      const release = JSON.parse(
        await readFile(join(directory, 'RELEASE.json'), 'utf8'),
      );
      assert.equal(release.target, target);
      assert.equal(
        (await readFile(join(directory, pkg.main), 'utf8')).includes(
          `export const ${name}`,
        ),
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test(`pinned Firebase deployment planner with ${name}-only filter cannot update/delete sibling or grant secrets/IAM`, async () => {
    const endpoint = (id, env) => ({
      id,
      region: 'europe-west3',
      platform: 'gcfv2',
      project: 'fixture-project',
      codebase: 'places',
      httpsTrigger: {},
      environmentVariables: env,
      labels: { 'deployment-tool': 'cli-firebase' },
    });
    const siblingName = name === 'placesFeed' ? 'placesWebhook' : 'placesFeed';
    const haveSelected = endpoint(name, { PROFILE: 'old' });
    const sibling = endpoint(siblingName, { PLACES_FEED_ENABLED: 'true' });
    const wanted = endpoint(name, { PROFILE: target });
    const backend = (endpoints) => ({
      endpoints: {
        'europe-west3': Object.fromEntries(endpoints.map((e) => [e.id, e])),
      },
      requiredAPIs: {},
      environmentVariables: {},
    });
    const siblings = ['placesWebhook', 'placesFeed', 'placesService']
      .filter((id) => id !== name)
      .map((id) => endpoint(id, { PROFILE: 'untouched' }));
    const plan = await createDeploymentPlan({
      projectId: 'fixture-project',
      codebase: 'places',
      wantBackend: backend([wanted]),
      haveBackend: backend([haveSelected, sibling, ...siblings]),
      filters: getEndpointFilters({ only: `functions:places:${name}` }, [
        { codebase: 'places' },
      ]),
    });
    const changes = Object.values(plan.regionalChangesets);
    assert.deepEqual(
      changes.flatMap((c) => c.endpointsToUpdate.map((e) => e.endpoint.id)),
      [name],
    );
    assert.deepEqual(
      changes.flatMap((c) => c.endpointsToCreate),
      [],
    );
    assert.deepEqual(
      changes.flatMap((c) => c.endpointsToDelete),
      [],
    );
    assert.deepEqual(plan.secretAccessPlan, {});
    assert.equal(plan.rolesToAdd, undefined);
    assert.equal(plan.serviceAccountToDelete, undefined);
    if (target === 'service') {
      const initial = await createDeploymentPlan({
        projectId: 'fixture-project',
        codebase: 'places',
        wantBackend: backend([wanted]),
        haveBackend: backend(siblings),
        filters: getEndpointFilters(
          { only: 'functions:places:placesService' },
          [{ codebase: 'places' }],
        ),
      });
      const sets = Object.values(initial.regionalChangesets);
      assert.deepEqual(
        sets.flatMap((c) => c.endpointsToCreate.map((e) => e.id)),
        ['placesService'],
      );
      assert.deepEqual(
        sets.flatMap((c) => c.endpointsToDelete),
        [],
      );
      assert.deepEqual(
        sets.flatMap((c) => c.endpointsToUpdate),
        [],
      );
    }

    assert.equal(sibling.environmentVariables.PLACES_FEED_ENABLED, 'true');
  });
}
