import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateCaller,
  verifyPolicy,
  reconcileServiceIam,
} from '../scripts/reconcile-service-iam.mjs';
const caller = '123456789-compute@developer.gserviceaccount.com';
const policy = {
  bindings: [
    { role: 'roles/run.invoker', members: [`serviceAccount:${caller}`] },
  ],
};
for (const value of [
  undefined,
  '',
  'allUsers',
  'allAuthenticatedUsers',
  'bad\naccount',
  'places-runtime@mom-im-ok-places.iam.gserviceaccount.com',
])
  test(`invalid caller ${JSON.stringify(value)} fails before any gcloud call`, () => {
    let calls = 0;
    assert.throws(() => reconcileServiceIam(value, () => calls++));
    assert.equal(calls, 0);
  });
test('actual configured caller accepted; public or missing/conditional final grants rejected', () => {
  assert.equal(validateCaller(caller), caller);
  verifyPolicy(policy, caller);
  for (const p of [
    { bindings: [] },
    {
      bindings: [{ ...policy.bindings[0], condition: { expression: 'true' } }],
    },
    ...['allUsers', 'allAuthenticatedUsers'].map((m) => ({
      bindings: [
        ...policy.bindings,
        { role: 'roles/run.invoker', members: [m] },
      ],
    })),
  ])
    assert.throws(() => verifyPolicy(p, caller));
});
function fake({
  publicPolicy = false,
  missing = false,
  fail = false,
  resource = 'projects/mom-im-ok-places/locations/europe-west3/services/placesservice',
  disabled = false,
} = {}) {
  const calls = [];
  let added = false;
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[0] === 'functions')
        return { serviceConfig: { service: resource } };
      if (args[2] === 'describe')
        return {
          metadata: {
            name: 'placesservice',
            annotations: {
              'run.googleapis.com/invoker-iam-disabled': String(disabled),
            },
          },
        };
      if (args[2] === 'add-iam-policy-binding') {
        if (fail) throw Error('denied');
        added = true;
        return policy;
      }
      return publicPolicy
        ? { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }
        : added && !missing
          ? policy
          : { bindings: [] };
    },
  };
}
test('Firebase-erased binding restored and read after write on only underlying service', () => {
  const f = fake();
  reconcileServiceIam(caller, f.run);
  assert.deepEqual(
    f.calls.map((a) => a[2]),
    [
      'placesService',
      'describe',
      'get-iam-policy',
      'add-iam-policy-binding',
      'get-iam-policy',
    ],
  );
  const write = f.calls[3];
  assert.ok(write.includes('placesservice'));
  assert.ok(write.includes(`--member=serviceAccount:${caller}`));
  assert.ok(write.includes('--role=roles/run.invoker'));
  assert.ok(!write.includes('projects'));
});
for (const opts of [
  { publicPolicy: true },
  { missing: true },
  { fail: true },
  { resource: 'projects/other/locations/europe-west3/services/placesservice' },
  { disabled: true },
])
  test(`reconciliation fails closed ${JSON.stringify(opts)}`, () => {
    const f = fake(opts);
    assert.throws(() => reconcileServiceIam(caller, f.run));
  });
test('workflow validates caller before deployment and always reconciles disabled/enabled deployment afterwards', async () => {
  const s = await readFile('.github/workflows/deploy-service.yml', 'utf8');
  assert.match(
    s,
    /PLACES_EXPECTED_APP_CALLER_SA: \$\{\{ vars.PLACES_EXPECTED_APP_CALLER_SA \}\}/,
  );
  const deploy = s.indexOf('firebase deploy');
  assert.ok(s.indexOf('reconcile-service-iam.mjs --validate-only') < deploy);
  assert.ok(
    s.lastIndexOf('run: node scripts/reconcile-service-iam.mjs') > deploy,
  );
  assert.equal((s.match(/firebase deploy/g) ?? []).length, 1);
  assert.match(s, /--only functions:places:placesService --non-interactive/);
  assert.doesNotMatch(s, /placesWebhook|placesFeed|service_enabled.*==.*true/);
});

test('numeric project resource must be independently proven as the Places project', () => {
  const f = fake({
    resource: 'projects/123456/locations/europe-west3/services/placesservice',
  });
  const run = (args) =>
    args[0] === 'projects' ? { projectNumber: '123456' } : f.run(args);
  reconcileServiceIam(caller, run);
  assert.ok(f.calls.some((args) => args[2] === 'add-iam-policy-binding'));
  const wrong = fake({
    resource: 'projects/999999/locations/europe-west3/services/placesservice',
  });
  assert.throws(() =>
    reconcileServiceIam(caller, (args) =>
      args[0] === 'projects' ? { projectNumber: '123456' } : wrong.run(args),
    ),
  );
  assert.equal(
    wrong.calls.some((args) => args[2] === 'add-iam-policy-binding'),
    false,
  );
});
