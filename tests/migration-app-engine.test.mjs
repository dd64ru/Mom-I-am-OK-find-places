import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const harness = `
import importlib.util, json, sys, copy, io, contextlib, shutil, urllib.request
spec = importlib.util.spec_from_file_location('migration', 'infra/migrate-serverless.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
scenario = sys.argv[1]
app = 'serviceAccount:' + m.APP_ENGINE_DEFAULT
deploy = 'serviceAccount:' + m.DEPLOY
runtime = 'serviceAccount:' + m.RUNTIME
build_email = '123456789012-compute@developer.gserviceaccount.com'
unrelated = 'serviceAccount:unrelated-fixture@mom-im-ok-places.iam.gserviceaccount.com'
act_as = {'role': 'roles/iam.serviceAccountUser', 'members': [deploy]}
project = {'bindings': [
    {'role': 'roles/editor', 'members': [app, unrelated]},
    {'role': 'roles/datastore.user', 'members': [runtime]},
    {'role': 'projects/' + m.PROJECT + '/roles/placesApiConsumer', 'members': [runtime]},
    *[{'role': role, 'members': [deploy]} for role in ['roles/cloudfunctions.developer', 'roles/serviceusage.serviceUsageConsumer', 'projects/' + m.PROJECT + '/roles/placesFunctionsDeploy']],
    {'role': 'roles/cloudbuild.builds.builder', 'members': ['serviceAccount:' + build_email]},
]}
policies = {
    m.APP_ENGINE_DEFAULT: {'etag': 'ACAB'},
    m.RUNTIME: {'bindings': [copy.deepcopy(act_as)]},
    build_email: {'bindings': [copy.deepcopy(act_as)]},
    m.DEPLOY: {'bindings': [{'role': 'roles/iam.workloadIdentityUser', 'members': ['principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/places-github/attribute.repository_id/1404706412']}]},
}
if scenario in ['reuse', 'resume']:
    project['bindings'][0]['members'].remove(app)
if scenario in ['reuse', 'editor_with_actas']:
    policies[m.APP_ENGINE_DEFAULT]['bindings'] = [copy.deepcopy(act_as)]
if scenario in ['owner', 'other_role', 'conditional_editor']:
    if scenario == 'owner': project['bindings'][0]['role'] = 'roles/owner'
    if scenario == 'other_role': project['bindings'].append({'role': 'roles/viewer', 'members': [app]})
    if scenario == 'conditional_editor': project['bindings'][0]['condition'] = {'title': 'fixture', 'expression': 'true'}
if scenario in ['unexpected_member', 'token_creator', 'conditional_actas', 'other_policy_role']:
    entry = copy.deepcopy(act_as)
    if scenario == 'unexpected_member': entry['members'].append(unrelated)
    if scenario == 'token_creator': entry['role'] = 'roles/iam.serviceAccountTokenCreator'
    if scenario == 'conditional_actas': entry['condition'] = {'title': 'fixture', 'expression': 'true'}
    if scenario == 'other_policy_role': entry['role'] = 'roles/viewer'
    policies[m.APP_ENGINE_DEFAULT]['bindings'] = [entry]
if scenario == 'project_actas': project['bindings'].append(copy.deepcopy(act_as))
if scenario == 'places_runtime_broad': project['bindings'].append({'role': 'roles/serviceusage.serviceUsageConsumer', 'members': [runtime]})
if scenario == 'places_runtime_conditional': project['bindings'][2]['condition'] = {'title': 'fixture', 'expression': 'true'}
if scenario == 'places_runtime_foreignrole': project['bindings'][2]['role'] = 'projects/' + m.PROJECT + '/roles/otherRole'
if scenario == 'places_role_missing': project['bindings'].pop(2)
initial_project = copy.deepcopy(project)
initial_policies = copy.deepcopy(policies)
calls = []
repo = {'id': 1404706412, 'owner': {'id': 26544806}}
mapping, trust, _, _ = m.wif_configuration(repo)
provider = {'attributeMapping': mapping, 'attributeCondition': trust, 'oidc': {'issuerUri': 'https://token.actions.githubusercontent.com'}}
roles = {'placesSessionVersionAdder': ['secretmanager.versions.add'], 'placesFunctionsDeploy': m.DEPLOY_PERMISSIONS, 'placesApiConsumer': ['serviceusage.services.use']}
if scenario == 'places_role_missing': roles.pop('placesApiConsumer')
if scenario == 'places_role_mismatch': roles['placesApiConsumer'].append('serviceusage.services.enable')
required_apis = {
    'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
    'run.googleapis.com', 'eventarc.googleapis.com', 'pubsub.googleapis.com', 'storage.googleapis.com',
    'firebaseextensions.googleapis.com', 'cloudbilling.googleapis.com', 'places.googleapis.com', 'secretmanager.googleapis.com', 'firestore.googleapis.com',
    'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com',
    'firebase.googleapis.com', 'cloudresourcemanager.googleapis.com',
}
assert m.DEPLOY_PERMISSIONS == sorted(['firebase.projects.get', 'resourcemanager.projects.get', 'cloudfunctions.functions.getIamPolicy', 'cloudfunctions.functions.setIamPolicy', 'run.services.get', 'run.services.getIamPolicy', 'run.services.setIamPolicy'])
def assert_api_enable():
    enables = [args for args in calls if args[:2] == ('services', 'enable')]
    assert len(enables) == 1 and set(enables[0][2:]) == required_apis
    assert len(enables[0][2:]) == len(required_apis)
    if scenario == 'cloud_billing':
        assert 'cloudbilling.googleapis.com' in enables[0][2:], 'Firebase CLI billing prerequisite missing'
        assert not set(enables[0][2:]) & {'cloudscheduler.googleapis.com', 'cloudtasks.googleapis.com'}
def cloud(*args, **kwargs):
    calls.append(args)
    if args[:2] == ('projects', 'describe'): return {'projectNumber': '123456789012'}
    if args[:3] == ('firestore', 'databases', 'describe'): return {'locationId': m.REGION}
    if args[:2] == ('projects', 'get-iam-policy'): return copy.deepcopy(project)
    if args[:3] == ('iam', 'service-accounts', 'describe'):
        if args[3] == m.APP_ENGINE_DEFAULT and scenario == 'absent': return None
        return {'email': 'foreign@example.com' if args[3] == m.APP_ENGINE_DEFAULT and scenario == 'wrong_identity' else args[3], 'disabled': args[3] == m.APP_ENGINE_DEFAULT and scenario == 'disabled'}
    if args[:3] == ('iam', 'service-accounts', 'get-iam-policy'): return copy.deepcopy(policies[args[3]])
    if args[:3] == ('iam', 'roles', 'describe'):
        return {'includedPermissions': roles[args[3]], 'deleted': args[3] == 'placesApiConsumer' and scenario == 'places_role_deleted'} if args[3] in roles else None
    if args[:2] == ('secrets', 'describe'): return {'name': args[2]}
    if args[:2] == ('secrets', 'get-iam-policy'):
        return {'bindings': [] if args[2] == 'GEMINI_API_KEY' else [{'role': 'roles/secretmanager.secretAccessor', 'members': [runtime]}]}
    if args[:3] == ('artifacts', 'repositories', 'describe'): return {'format': 'DOCKER', 'cleanupPolicies': {'fixture': {}}}
    if args[:3] == ('iam', 'workload-identity-pools', 'describe'): return {'state': 'ACTIVE'}
    if args[:3] == ('iam', 'workload-identity-pools', 'providers'):
        if args[3] == 'describe': return copy.deepcopy(provider)
        if args[3] == 'list': return [{'name': 'projects/123456789012/locations/global/workloadIdentityPools/places-github/providers/github-main'}]
        raise AssertionError('WIF mutation forbidden in this fixture')
    if args[:2] == ('builds', 'get-default-service-account'): return {'serviceAccountEmail': build_email}
    if args[:3] == ('iam', 'roles', 'create'):
        assert args[3] == 'placesApiConsumer' and '--permissions=serviceusage.services.use' in args
        roles['placesApiConsumer'] = ['serviceusage.services.use']
        return {}
    if 'list' in args: return []
    if 'describe' in args: return None
    if args[:2] == ('services', 'enable'): return {}
    operation = next((a for a in args if a in ['add-iam-policy-binding', 'remove-iam-policy-binding']), None)
    assert operation, 'unexpected mutation'
    member = next(a.split('=', 1)[1] for a in args if a.startswith('--member='))
    role = next(a.split('=', 1)[1] for a in args if a.startswith('--role='))
    if args[0] == 'projects':
        if operation == 'remove-iam-policy-binding':
            assert args[1:3] == ('remove-iam-policy-binding', m.PROJECT) and member == app and role == 'roles/editor'
            assert '--condition=None' in args
            project['bindings'][0]['members'].remove(member)
        else:
            if scenario == 'places_role_missing' and role == m.PLACES_USE_ROLE and member == runtime and not any(b['role'] == role for b in project['bindings']):
                assert '--condition=None' in args
                project['bindings'].append({'role': role, 'members': [member]})
            assert any(b['role'] == role and member in b['members'] for b in project['bindings']), 'project grant widened'
    elif args[:2] == ('iam', 'service-accounts'):
        assert operation == 'add-iam-policy-binding'
        target = args[3]
        if target == m.DEPLOY:
            assert {'role': role, 'members': [member]} in policies[target]['bindings'], 'WIF binding changed'
            return {}
        assert role == 'roles/iam.serviceAccountUser' and member == deploy
        if target == m.APP_ENGINE_DEFAULT:
            assert not any(app in b['members'] for b in project['bindings']), 'actAs granted before hardening'
            policies[target]['bindings'] = [copy.deepcopy(act_as)]
        else:
            assert target in [m.RUNTIME, build_email] and act_as in policies[target]['bindings'], 'other SA grant widened'
    else:
        assert args[0] == 'secrets' and member == runtime and args[2] in ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'OPENAI_SIWC_SESSION']
        assert role == 'roles/secretmanager.secretAccessor' or (args[2] == 'OPENAI_SIWC_SESSION' and role == 'projects/' + m.PROJECT + '/roles/placesSessionVersionAdder')
    return {}
m.cloud = cloud
shutil.which = lambda _: '/fixture/gcloud'
urllib.request.urlopen = lambda *a, **k: io.BytesIO(json.dumps(repo).encode())
bad = ['owner', 'other_role', 'conditional_editor', 'unexpected_member', 'token_creator', 'conditional_actas', 'other_policy_role', 'project_actas', 'absent', 'disabled', 'wrong_identity', 'places_runtime_broad', 'places_runtime_conditional', 'places_runtime_foreignrole', 'places_role_mismatch', 'places_role_deleted']
output = io.StringIO()
with contextlib.redirect_stdout(output):
    if scenario in bad:
        try: m.main('--apply')
        except RuntimeError as error: assert str(error) in ['app_engine_default_identity_requires_owner_review', 'app_engine_default_project_grants_require_owner_review', 'app_engine_default_policy_requires_owner_review', 'unexpected_deploy_project_grant', 'unexpected_runtime_project_grant', 'existing_serverless_custom_role_mismatch']
        else: raise AssertionError('unsafe IAM accepted')
        assert all(set(args) & {'describe', 'list', 'get-iam-policy'} for args in calls)
        assert project == initial_project and policies == initial_policies
    else:
        m.main('--plan')
        summary = json.loads(output.getvalue().splitlines()[0])
        assert summary['appEngineDefaultAction'] == ('reuse' if scenario == 'reuse' else 'harden')
        assert summary['wifProviderAction'] == 'reuse'
        assert project == initial_project and policies == initial_policies
        assert all(set(args) & {'describe', 'list', 'get-iam-policy'} for args in calls)
        assert not any(args[:2] == ('services', 'enable') for args in calls)
        if scenario != 'plan':
            calls.clear()
            m.main('--apply')
            assert_api_enable()
            expected_project = copy.deepcopy(initial_project)
            if app in expected_project['bindings'][0]['members']: expected_project['bindings'][0]['members'].remove(app)
            if scenario == 'places_role_missing': expected_project['bindings'].append({'role': m.PLACES_USE_ROLE, 'members': [runtime]})
            expected_policies = copy.deepcopy(initial_policies)
            expected_policies[m.APP_ENGINE_DEFAULT]['bindings'] = [copy.deepcopy(act_as)]
            assert project == expected_project and policies == expected_policies
            mutations = [args for args in calls if 'remove-iam-policy-binding' in args or (m.APP_ENGINE_DEFAULT in args and 'add-iam-policy-binding' in args)]
            assert len(mutations) == (0 if scenario == 'reuse' else 1 if scenario in ['resume', 'editor_with_actas'] else 2)
            calls.clear()
            m.main('--apply')
            assert_api_enable()
            assert not any('remove-iam-policy-binding' in args or (m.APP_ENGINE_DEFAULT in args and 'add-iam-policy-binding' in args) for args in calls)
            assert project == expected_project and policies == expected_policies
            output.seek(0); output.truncate(0)
            calls.clear()
            m.main('--plan')
            assert json.loads(output.getvalue())['appEngineDefaultAction'] == 'reuse'
            assert not any(args[:2] == ('services', 'enable') for args in calls)
print('app_engine_fixture_ok')
`;

test('Firebase CLI 15.32.1 Cloud Billing prerequisite is owner-preenabled without optional trigger APIs or CI IAM widening', () => {
  assert.equal(
    execFileSync('python3', ['-c', harness, 'cloud_billing'], {
      encoding: 'utf8',
    }).trim(),
    'app_engine_fixture_ok',
  );
});

for (const scenario of [
  'plan',
  'apply',
  'reuse',
  'resume',
  'editor_with_actas',
  'owner',
  'other_role',
  'conditional_editor',
  'unexpected_member',
  'token_creator',
  'conditional_actas',
  'other_policy_role',
  'project_actas',
  'absent',
  'disabled',
  'wrong_identity',
  'places_role_missing',
  'places_role_mismatch',
  'places_role_deleted',
  'places_runtime_broad',
  'places_runtime_conditional',
  'places_runtime_foreignrole',
]) {
  test(`App Engine preflight hardening with mocked IAM: ${scenario}`, () => {
    assert.equal(
      execFileSync('python3', ['-c', harness, scenario], {
        encoding: 'utf8',
      }).trim(),
      'app_engine_fixture_ok',
    );
  });
}
