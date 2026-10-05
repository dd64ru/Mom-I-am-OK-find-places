import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const email = '858592805278-compute@developer.gserviceaccount.com';
const realResponse = {
  name: 'projects/mom-im-ok-places/locations/europe-west3/defaultServiceAccount',
  serviceAccountEmail: `projects/858592805278/serviceAccounts/${email}`,
};
const loadMigration = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('migration', 'infra/migrate-serverless.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

for (const [name, response, expected] of [
  ['exact live response', realResponse, email],
  ['bare email', { serviceAccountEmail: email }, email],
  [
    'project-ID resource name',
    {
      serviceAccountEmail: `projects/mom-im-ok-places/serviceAccounts/${email}`,
    },
    email,
  ],
  [
    'legacy build account',
    { serviceAccountEmail: '858592805278@cloudbuild.gserviceaccount.com' },
    '858592805278@cloudbuild.gserviceaccount.com',
  ],
  [
    'current-project managed account',
    {
      serviceAccountEmail:
        'places-build@mom-im-ok-places.iam.gserviceaccount.com',
    },
    'places-build@mom-im-ok-places.iam.gserviceaccount.com',
  ],
]) {
  test(`migration canonicalizes ${name} consistently`, () => {
    const output = execFileSync(
      'python3',
      [
        '-c',
        `${loadMigration}
response = json.loads(sys.argv[1])
canonical = m.canonical_build_email(response, '858592805278')
assert m.canonical_build_email({'serviceAccountEmail': canonical}, '858592805278') == canonical
print(canonical)
`,
        JSON.stringify(response),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), expected);
  });
}

for (const [name, response] of [
  [
    'wrong project number',
    { serviceAccountEmail: `projects/12345/serviceAccounts/${email}` },
  ],
  [
    'wrong project ID',
    {
      serviceAccountEmail: `projects/another-project/serviceAccounts/${email}`,
    },
  ],
  [
    'foreign email in current-project path',
    {
      serviceAccountEmail:
        'projects/858592805278/serviceAccounts/12345-compute@developer.gserviceaccount.com',
    },
  ],
  [
    'foreign managed account',
    {
      serviceAccountEmail:
        'places-build@another-project.iam.gserviceaccount.com',
    },
  ],
  [
    'malformed resource name',
    { serviceAccountEmail: `projects/858592805278/serviceAccount/${email}` },
  ],
  [
    'extra resource segment',
    {
      serviceAccountEmail: `projects/858592805278/serviceAccounts/${email}/extra`,
    },
  ],
  [
    'arbitrary path ending in email',
    { serviceAccountEmail: `unrelated/path/${email}` },
  ],
  ['unrelated email', { serviceAccountEmail: 'owner@example.com' }],
  [
    'invalid account syntax',
    {
      serviceAccountEmail: 'bad_name@mom-im-ok-places.iam.gserviceaccount.com',
    },
  ],
  ['prefixed principal', { serviceAccountEmail: `serviceAccount:${email}` }],
  ['trailing whitespace', { serviceAccountEmail: `${email}\n` }],
  ['missing field despite name', { name: realResponse.name }],
  [
    'invalid field despite name',
    { name: realResponse.name, serviceAccountEmail: null },
  ],
  ['email in name only', { name: email }],
]) {
  test(`migration rejects ${name} with a fixed diagnostic`, () => {
    const output = execFileSync(
      'python3',
      [
        '-c',
        `${loadMigration}
try:
    m.canonical_build_email(json.loads(sys.argv[1]), '858592805278')
except RuntimeError as error:
    print(str(error))
else:
    raise AssertionError('unsafe identity accepted')
`,
        JSON.stringify(response),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      output.trim(),
      'default_cloud_build_identity_requires_owner_review',
    );
  });
}

for (const role of ['roles/owner', 'roles/editor']) {
  test(`migration still blocks canonical live identity with ${role} before resource changes`, () => {
    const output = execFileSync(
      'python3',
      [
        '-c',
        `${loadMigration}
import contextlib, io, shutil, urllib.request
calls = []
def cloud(*args, **kwargs):
    calls.append(args)
    if args[:3] == ('iam', 'service-accounts', 'describe') and args[3] == m.APP_ENGINE_DEFAULT: return {'email': m.APP_ENGINE_DEFAULT}
    if args[:3] == ('iam', 'service-accounts', 'get-iam-policy') and args[3] == m.APP_ENGINE_DEFAULT: return {'bindings': []}
    if args[:2] == ('projects', 'describe'): return {'projectNumber': '858592805278'}
    if args[:3] == ('firestore', 'databases', 'describe'): return {'locationId': 'europe-west3'}
    if args[:2] == ('projects', 'get-iam-policy'):
        return {'bindings': [{'role': sys.argv[1], 'members': ['serviceAccount:${email}']}]}
    if args[:2] == ('secrets', 'describe'): return {'name': 'metadata-only'}
    if args[:2] == ('secrets', 'get-iam-policy'): return {'bindings': []}
    if args[:2] == ('builds', 'get-default-service-account'): return json.loads(sys.argv[2])
    if args[:2] == ('services', 'enable'): return {}
    if 'list' in args: return []
    if 'describe' in args: return None
    raise AssertionError('unexpected cloud operation')
m.cloud = cloud
shutil.which = lambda _: '/fixture/gcloud'
urllib.request.urlopen = lambda *a, **k: io.BytesIO(json.dumps({'id': 1404706412, 'owner': {'id': 26544806}}).encode())
with contextlib.redirect_stdout(io.StringIO()):
    try:
        m.main('--apply')
    except RuntimeError as error:
        assert str(error) == 'broad_default_build_identity_requires_owner_review'
    else:
        raise AssertionError('broad build identity accepted')
assert calls[-1][:2] == ('builds', 'get-default-service-account')
assert not any(set(args) & {'create', 'delete', 'add-iam-policy-binding', 'remove-iam-policy-binding', 'set-cleanup-policies'} for args in calls)
print('broad_identity_guard_preserved')
`,
        role,
        JSON.stringify(realResponse),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'broad_identity_guard_preserved');
  });
}
