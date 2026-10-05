import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const harness = `
import importlib.util, json, sys, contextlib, io, copy, re, shutil, urllib.request
spec = importlib.util.spec_from_file_location('migration', 'infra/migrate-serverless.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
repo = {'id': 1404706412, 'owner': {'id': 26544806}, 'created_at': '2026-10-04T00:00:00Z'}
mapping, trust, legacy_mapping, legacy_trust = m.wif_configuration(repo)
assert mapping == {
    'google.subject': 'assertion.sub',
    'attribute.repository_id': 'assertion.repository_id',
    'attribute.repository_owner_id': 'assertion.repository_owner_id',
    'attribute.ref': 'assertion.ref',
    'attribute.environment': 'assertion.environment',
    'attribute.event_name': 'assertion.event_name',
}
assert trust == "attribute.repository_id == '1404706412' && attribute.repository_owner_id == '26544806' && attribute.ref == 'refs/heads/main' && attribute.environment == 'production' && attribute.event_name == 'workflow_dispatch'"
assert legacy_mapping == {'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id'}
assert legacy_trust == "assertion.repository_id == '1404706412' && assertion.repository_owner_id == '26544806' && assertion.repository == 'dd64ru/Mom-I-am-OK-find-places' && assertion.ref == 'refs/heads/main' && assertion.sub == 'repo:dd64ru/Mom-I-am-OK-find-places:environment:production'"
assert 'assertion.sub ==' not in trust and 'attribute.repository ==' not in trust
provider = {'attributeMapping': mapping, 'attributeCondition': trust, 'oidc': {'issuerUri': 'https://token.actions.githubusercontent.com'}}
legacy = {**provider, 'attributeMapping': legacy_mapping, 'attributeCondition': legacy_trust}
scenario = sys.argv[1]
if scenario.startswith('claim:'):
    claims = {'sub': 'repo:dd64ru@26544806/Mom-I-am-OK-find-places@1404706412:environment:production', 'repository_id': '1404706412', 'repository_owner_id': '26544806', 'repository': m.REPOSITORY, 'ref': 'refs/heads/main', 'environment': 'production', 'event_name': 'workflow_dispatch'}
    case = scenario.split(':', 1)[1]
    changes = {'wrong_repository': {'repository_id': '999'}, 'wrong_owner': {'repository_owner_id': '999'}, 'branch': {'ref': 'refs/heads/other'}, 'tag': {'ref': 'refs/tags/main'}, 'environment': {'environment': 'staging'}, 'missing_environment': {'environment': None}, 'pull_request': {'event_name': 'pull_request', 'ref': 'refs/pull/1/merge'}, 'pull_request_target': {'event_name': 'pull_request_target'}, 'name_only': {'repository_id': None, 'repository_owner_id': None}, 'legacy_subject': {'sub': 'repo:dd64ru/Mom-I-am-OK-find-places:environment:production'}}
    claims.update(changes.get(case, {}))
    # Evaluate the deliberately limited conjunction of mapped string equalities, no token needed.
    terms = trust.split(' && ')
    pairs = [re.fullmatch(r"(attribute\\.[a-z_]+) == '([^']+)'", term).groups() for term in terms]
    accepted = all(claims.get(mapping[key].removeprefix('assertion.')) == value for key, value in pairs)
    assert accepted == (case in ['immutable_subject', 'legacy_subject'])
elif scenario == 'metadata_changed':
    for foreign in [{'id': 999, 'owner': repo['owner']}, {**repo, 'owner': {'id': 999}}]:
        try: m.wif_configuration(foreign)
        except RuntimeError as error: assert str(error) == 'github_repository_identity_requires_owner_review'
        else: raise AssertionError('foreign immutable identity accepted')
elif scenario == 'absent_provider':
    assert m.wif_provider_state(None, mapping, trust, legacy_mapping, legacy_trust) == 'create'
else:
    state = copy.deepcopy(legacy if scenario in ['plan', 'apply'] else provider)
    if scenario == 'foreign_provider': state['attributeMapping'] = legacy_mapping
    if scenario == 'empty_provider': state = {}
    if scenario == 'weakened_provider': state['attributeCondition'] = "assertion.repository == '" + m.REPOSITORY + "'"
    if scenario == 'wrong_issuer': state['oidc']['issuerUri'] = 'https://example.com'
    if scenario == 'disabled_provider': state['disabled'] = True
    if scenario == 'foreign_audience': state['oidc']['allowedAudiences'] = ['foreign-audience']
    replacements = {'provider_repository': ('1404706412', '999'), 'provider_owner': ('26544806', '999'), 'provider_branch': ('refs/heads/main', 'refs/heads/other'), 'provider_environment': ('production', 'staging')}
    if scenario in replacements: state['attributeCondition'] = trust.replace(*replacements[scenario])
    calls = []
    def cloud(*args, **kwargs):
        calls.append(args)
        if args[:2] == ('projects', 'describe'): return {'projectNumber': '123456789012'}
        if args[:3] == ('firestore', 'databases', 'describe'): return {'locationId': m.REGION}
        if args[:2] in [('projects', 'get-iam-policy'), ('secrets', 'get-iam-policy')]: return {'bindings': []}
        if args[:2] == ('secrets', 'describe'): return {'name': 'fixture-metadata'}
        if args[:3] == ('iam', 'service-accounts', 'get-iam-policy'):
            principal = 'principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/places-github/attribute.repository_id/1404706412'
            return {'bindings': [{'role': 'roles/iam.workloadIdentityUser', 'members': [principal]}]} if args[3] == m.DEPLOY else {'bindings': []}
        if args[:3] == ('iam', 'service-accounts', 'describe'): return {'email': args[3]}
        if args[:3] == ('iam', 'workload-identity-pools', 'describe'): return {'state': 'ACTIVE'}
        if args[:3] == ('iam', 'workload-identity-pools', 'providers'):
            if args[3] == 'describe': return copy.deepcopy(state)
            if args[3] == 'list': return [{'name': 'projects/123456789012/locations/global/workloadIdentityPools/places-github/providers/github-main'}]
            assert args[3] == 'update-oidc' and args[4] == m.PROVIDER
            state['attributeMapping'] = dict(x.split('=', 1) for x in next(a.split('=', 1)[1] for a in args if a.startswith('--attribute-mapping=')).split(','))
            state['attributeCondition'] = next(a.split('=', 1)[1] for a in args if a.startswith('--attribute-condition='))
            return {}
        if args[:2] == ('builds', 'get-default-service-account'): return {'serviceAccountEmail': '123456789012@cloudbuild.gserviceaccount.com'}
        if args[:3] == ('artifacts', 'repositories', 'describe'): return {'format': 'DOCKER', 'cleanupPolicies': {'fixture': {}}}
        if 'list' in args: return []
        if 'describe' in args: return None
        assert set(args) & {'enable', 'create', 'add-iam-policy-binding'}, 'unexpected operation'
        return {}
    m.cloud = cloud
    shutil.which = lambda _: '/fixture/gcloud'
    urllib.request.urlopen = lambda *a, **k: io.BytesIO(json.dumps(repo).encode())
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        if scenario in ['empty_provider', 'foreign_provider', 'weakened_provider', 'wrong_issuer', 'disabled_provider', 'foreign_audience'] or scenario in replacements:
            try: m.main('--apply')
            except RuntimeError as error: assert str(error) == 'existing_wif_provider_mismatch'
            else: raise AssertionError('provider mismatch accepted')
            assert all(set(args) & {'describe', 'list', 'get-iam-policy'} for args in calls)
        else:
            m.main('--plan' if scenario == 'plan' else '--apply')
            summary = json.loads(captured.getvalue().splitlines()[0])
            assert summary['wifProviderAction'] == ('reuse' if scenario == 'reuse' else 'upgrade')
            updates = [args for args in calls if 'update-oidc' in args]
            assert len(updates) == (1 if scenario == 'apply' else 0)
            if scenario == 'plan':
                assert state == legacy and not summary['reuseWIF']
                assert all(set(args) & {'describe', 'list', 'get-iam-policy'} for args in calls)
            else:
                assert state == provider
                assert not any(set(args) & {'create-oidc', 'delete'} for args in calls)
                m.main('--apply')
                assert len([args for args in calls if 'update-oidc' in args]) == len(updates)
print('wif_fixture_ok')
`;

for (const scenario of [
  'claim:immutable_subject',
  'claim:legacy_subject',
  'claim:wrong_repository',
  'claim:wrong_owner',
  'claim:branch',
  'claim:tag',
  'claim:environment',
  'claim:missing_environment',
  'claim:pull_request',
  'claim:pull_request_target',
  'claim:name_only',
  'metadata_changed',
  'absent_provider',
  'empty_provider',
  'plan',
  'apply',
  'reuse',
  'foreign_provider',
  'weakened_provider',
  'wrong_issuer',
  'disabled_provider',
  'foreign_audience',
  'provider_repository',
  'provider_owner',
  'provider_branch',
  'provider_environment',
]) {
  test(`WIF immutable claims and fail-closed migration: ${scenario}`, () => {
    assert.equal(
      execFileSync('python3', ['-c', harness, scenario], {
        encoding: 'utf8',
      }).trim(),
      'wif_fixture_ok',
    );
  });
}
