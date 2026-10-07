import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateCaller,
  verifyPolicy,
  reconcileServiceIam,
  safeReason,
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
      if (args[0] === 'projects') return { projectNumber: '123456' };
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
      'mom-im-ok-places',
      'placesService',
      'describe',
      'get-iam-policy',
      'add-iam-policy-binding',
      'get-iam-policy',
    ],
  );
  const write = f.calls[4];
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

for (const member of [
  'serviceAccount:places-runtime@mom-im-ok-places.iam.gserviceaccount.com',
  'serviceAccount:another@other-project.iam.gserviceaccount.com',
  'user:person@example.com',
  'group:group@example.com',
  'domain:example.com',
]) {
  test(`unexpected invoker ${member} rejected before and after reconciliation`, () => {
    const p = {
      bindings: [
        ...policy.bindings,
        { role: 'roles/run.invoker', members: [member] },
      ],
    };
    assert.throws(() => verifyPolicy(p, caller, false));
    assert.throws(() => verifyPolicy(p, caller));
    const f = fake();
    assert.throws(() =>
      reconcileServiceIam(caller, (args) =>
        args[2] === 'get-iam-policy' ? p : f.run(args),
      ),
    );
    assert.equal(
      f.calls.some((a) => a[2] === 'add-iam-policy-binding'),
      false,
    );
  });
}
test('conditional and unrelated service-level bindings rejected without altering policy', () => {
  assert.throws(() =>
    verifyPolicy(
      {
        bindings: [
          { ...policy.bindings[0], condition: { expression: 'true' } },
        ],
      },
      caller,
      false,
    ),
  );
  const p = {
    bindings: [
      ...policy.bindings,
      { role: 'roles/run.viewer', members: ['group:auditors@example.com'] },
    ],
  };
  assert.throws(() => verifyPolicy(p, caller), /unexpected_service_policy/);
  assert.equal(p.bindings.length, 2);
});

test('failed deploy still reconciles after successful auth without continue-on-error', async () => {
  const s = await readFile('.github/workflows/deploy-service.yml', 'utf8');
  assert.match(s, /id: auth/);
  assert.match(s, /id: deploy/);
  assert.match(
    s,
    /if: \$\{\{ !cancelled\(\) && steps.auth.outcome == 'success' && steps.deploy.outcome != 'skipped' \}\}/,
  );
  assert.doesNotMatch(s, /continue-on-error/);
  const shouldRun = (cancelled, auth, deploy) =>
    !cancelled && auth === 'success' && deploy !== 'skipped';
  assert.equal(shouldRun(false, 'success', 'failure'), true);
  assert.equal(shouldRun(false, 'failure', 'skipped'), false);
  assert.equal(shouldRun(true, 'success', 'failure'), false);
});
test('Places project default compute caller rejected after auth before service writes', () => {
  const f = fake();
  assert.throws(
    () =>
      reconcileServiceIam(
        '123456-compute@developer.gserviceaccount.com',
        f.run,
      ),
    /caller_is_places_identity/,
  );
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ['projects'],
  );
});
for (const role of ['roles/run.admin', 'roles/editor', 'roles/run.viewer'])
  test(`alternate service binding ${role} fails before writes`, () => {
    const p = {
      bindings: [
        ...policy.bindings,
        {
          role,
          members: [
            'serviceAccount:other@another-project.iam.gserviceaccount.com',
          ],
        },
      ],
    };
    const f = fake();
    assert.throws(
      () =>
        reconcileServiceIam(caller, (a) =>
          a[2] === 'get-iam-policy' ? p : f.run(a),
        ),
      /unexpected_service_policy/,
    );
    assert.equal(
      f.calls.some((a) => a[2] === 'add-iam-policy-binding'),
      false,
    );
    assert.equal(p.bindings.length, 2);
  });
test('safe diagnostic codes never include captured credentials', () => {
  for (const code of [
    'unexpected_service_policy',
    'expected_app_invoker_missing',
    'caller_is_places_identity',
    'unexpected_service_resource',
  ])
    assert.equal(safeReason(Error(code)), code);
  const e = Object.assign(Error('secret-token'), {
    stderr: 'PERMISSION_DENIED secret-token',
  });
  assert.equal(safeReason(e), 'gcloud_permission_denied');
  assert.equal(safeReason(Error('secret-token')), 'gcloud_operation_failed');
});
