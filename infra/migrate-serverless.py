#!/usr/bin/env python3
"""Owner-run metadata-only plan / reviewed migration. Never reads secret payloads."""
import json
import os
import re
import shutil
import subprocess
import sys

PROJECT = 'mom-im-ok-places'
REGION = 'europe-west3'
REPOSITORY = 'dd64ru/Mom-I-am-OK-find-places'
REPOSITORY_ID, REPOSITORY_OWNER_ID = '1404706412', '26544806'
RUNTIME = f'places-runtime@{PROJECT}.iam.gserviceaccount.com'
DEPLOY = f'places-deploy@{PROJECT}.iam.gserviceaccount.com'
APP_ENGINE_DEFAULT = f'{PROJECT}@appspot.gserviceaccount.com'
POOL, PROVIDER = 'places-github', 'github-main'
DEPLOY_PERMISSIONS = sorted(['firebase.projects.get', 'resourcemanager.projects.get', 'cloudfunctions.functions.getIamPolicy', 'cloudfunctions.functions.setIamPolicy', 'run.services.get', 'run.services.getIamPolicy', 'run.services.setIamPolicy'])
SECRETS = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'TELEGRAM_WEBHOOK_SECRET', 'OPENAI_SIWC_SESSION']


def fail(code):
    raise RuntimeError(code)


def app_engine_default_state(account, project_policy, account_policy):
    if not account or account.get('email') != APP_ENGINE_DEFAULT or account.get('disabled'):
        fail('app_engine_default_identity_requires_owner_review')
    direct = [entry for entry in project_policy.get('bindings', []) if 'serviceAccount:' + APP_ENGINE_DEFAULT in entry.get('members', [])]
    if len(direct) > 1 or any(entry.get('role') != 'roles/editor' or 'condition' in entry for entry in direct):
        fail('app_engine_default_project_grants_require_owner_review')
    bindings = account_policy.get('bindings', [])
    expected = {'role': 'roles/iam.serviceAccountUser', 'members': ['serviceAccount:' + DEPLOY]}
    if bindings not in [[], [expected]]:
        fail('app_engine_default_policy_requires_owner_review')
    # No roles + no actAs is the safe intermediate state after removing Editor, before adding actAs.
    return {'action': 'harden' if direct or not bindings else 'reuse', 'removeEditor': bool(direct), 'grantPreflightActAs': not bindings}


def wif_configuration(repo):
    # Pin public immutable identities: a renamed/recreated/transferred repository needs review.
    if str(repo.get('id')) != REPOSITORY_ID or str(repo.get('owner', {}).get('id')) != REPOSITORY_OWNER_ID:
        fail('github_repository_identity_requires_owner_review')
    mapping = {'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id', 'attribute.repository_owner_id': 'assertion.repository_owner_id', 'attribute.ref': 'assertion.ref', 'attribute.environment': 'assertion.environment', 'attribute.event_name': 'assertion.event_name'}
    trust = f"attribute.repository_id == '{REPOSITORY_ID}' && attribute.repository_owner_id == '{REPOSITORY_OWNER_ID}' && attribute.ref == 'refs/heads/main' && attribute.environment == 'production' && attribute.event_name == 'workflow_dispatch'"
    legacy_mapping = {'google.subject': 'assertion.sub', 'attribute.repository_id': 'assertion.repository_id'}
    legacy_trust = f"assertion.repository_id == '{REPOSITORY_ID}' && assertion.repository_owner_id == '{REPOSITORY_OWNER_ID}' && assertion.repository == '{REPOSITORY}' && assertion.ref == 'refs/heads/main' && assertion.sub == 'repo:{REPOSITORY}:environment:production'"
    return mapping, trust, legacy_mapping, legacy_trust


def wif_provider_state(provider, mapping, trust, legacy_mapping, legacy_trust):
    if provider is None:
        return 'create'
    if provider.get('disabled') or provider.get('oidc') != {'issuerUri': 'https://token.actions.githubusercontent.com'} or any(key in provider for key in ['aws', 'saml']):
        fail('existing_wif_provider_mismatch')
    if provider.get('attributeMapping') == mapping and provider.get('attributeCondition') == trust:
        return 'reuse'
    if provider.get('attributeMapping') == legacy_mapping and provider.get('attributeCondition') == legacy_trust:
        return 'upgrade'
    fail('existing_wif_provider_mismatch')


def canonical_build_email(build, project_number):
    identity = build.get('serviceAccountEmail') if isinstance(build, dict) else None
    if not isinstance(identity, str):
        fail('default_cloud_build_identity_requires_owner_review')
    if '/' in identity:
        resource = re.fullmatch(r'projects/([a-z0-9-]+)/serviceAccounts/([^/]+)', identity)
        if not resource or resource[1] not in {PROJECT, project_number}:
            fail('default_cloud_build_identity_requires_owner_review')
        identity = resource[2]
    # Recognize current-project user-managed accounts and Google's two default build identities.
    # Checking the email's project as well prevents a current-project path wrapping a foreign account.
    user_managed = re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(PROJECT) + r'\.iam\.gserviceaccount\.com', identity)
    defaults = {f'{project_number}-compute@developer.gserviceaccount.com', f'{project_number}@cloudbuild.gserviceaccount.com'}
    if not user_managed and identity not in defaults:
        fail('default_cloud_build_identity_requires_owner_review')
    return identity


def cloud(*args, missing=False, disabled=False):
    result = subprocess.run(['gcloud', '--project=' + PROJECT, '--quiet', *args, '--format=json'], capture_output=True, text=True)
    if result.returncode:
        if disabled and re.search(r'SERVICE_DISABLED|has not been used|is disabled',result.stderr):
            return {'inspectionDeferred':True}
        if missing and re.search(r'NOT_FOUND|was not found|does not exist|notFound', result.stderr):
            return None
        fail('cloud_metadata_or_mutation_failed_check_owner_access')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def binding(scope, member, role, condition=None, remove=False):
    command = 'remove-iam-policy-binding' if remove else 'add-iam-policy-binding'
    group, resource = scope
    args = [*group, command, resource, '--member=' + member, '--role=' + role]
    if group == ['projects']:
        args.append('--condition=' + (f"expression={condition['expression']},title={condition['title']}" if condition else 'None'))
    cloud(*args)


def custom_role(name, permissions):
    current = cloud('iam', 'roles', 'describe', name, missing=True)
    if current:
        if current.get('deleted') or sorted(current.get('includedPermissions', [])) != sorted(permissions):
            fail('custom_role_mismatch_' + name)
    else:
        cloud('iam', 'roles', 'create', name, '--title=' + name, '--stage=GA', '--permissions=' + ','.join(permissions))


def main(mode):
    if mode == '--validate':
        assert REGION == 'europe-west3' and len(set(SECRETS)) == 4
        print('serverless_migration_static_validation_ok')
        return
    if not shutil.which('gcloud'):
        fail('gcloud_required_use_authenticated_cloud_shell')
    number = str(cloud('projects', 'describe', PROJECT)['projectNumber'])
    database = cloud('firestore', 'databases', 'describe', '--database=(default)')
    if database.get('locationId') != REGION:
        fail('existing_firestore_location_mismatch')
    if cloud('compute', 'instances', 'list', '--filter=name=places-worker') or cloud('compute', 'disks', 'list', '--filter=name=places-worker'):
        fail('owner_reported_VM_or_disk_still_exists_no_automatic_deletion')
    network = cloud('compute', 'networks', 'describe', 'places-network', missing=True)
    subnets = cloud('compute', 'networks', 'subnets', 'list', '--filter=name=places-subnet')
    firewall = cloud('compute', 'firewall-rules', 'describe', 'places-iap-ssh', missing=True)
    if network and (network.get('autoCreateSubnetworks') or network.get('peerings')):
        fail('abandoned_network_configuration_mismatch')
    if len(subnets) > 1:
        fail('ambiguous_abandoned_subnet')
    subnet = subnets[0] if subnets else None
    if subnet and (not subnet.get('network', '').endswith('/networks/places-network') or subnet.get('ipCidrRange') != '10.64.0.0/28' or subnet.get('secondaryIpRanges')):
        fail('abandoned_subnet_configuration_mismatch')
    if network and set(network.get('subnetworks', [])) != ({subnet['selfLink']} if subnet else set()):
        fail('abandoned_network_has_unrelated_subnets')
    if firewall and (not firewall.get('network', '').endswith('/networks/places-network') or firewall.get('direction') != 'INGRESS' or firewall.get('sourceRanges') != ['35.235.240.0/20'] or firewall.get('targetServiceAccounts') != [RUNTIME] or firewall.get('allowed') != [{'IPProtocol': 'tcp', 'ports': ['22']}]):
        fail('abandoned_firewall_configuration_mismatch')
    if network:
        rules = cloud('compute', 'firewall-rules', 'list', '--filter=network:places-network')
        if any(rule['name'] != 'places-iap-ssh' for rule in rules):
            fail('abandoned_network_has_unrelated_firewalls')
    if network and cloud('compute', 'instances', 'list', '--filter=networkInterfaces.network:places-network'):
        fail('abandoned_network_has_other_instances')
    artifact = cloud('artifacts', 'repositories', 'describe', 'gcf-artifacts', '--location=' + REGION, missing=True, disabled=True)
    if artifact and not artifact.get('inspectionDeferred') and artifact.get('format') != 'DOCKER':
        fail('existing_functions_artifact_repository_mismatch')
    if artifact and not artifact.get('inspectionDeferred') and not artifact.get('cleanupPolicies'):
        fail('existing_artifact_repository_without_cleanup_policy_requires_owner_review')
    old_role = cloud('iam', 'roles', 'describe', 'placesDeployRead', missing=True)
    if old_role and not old_role.get('deleted') and sorted(old_role.get('includedPermissions', [])) != ['compute.instances.get', 'compute.instances.list', 'compute.projects.get']:
        fail('old_compute_role_mismatch')
    policy = cloud('projects', 'get-iam-policy', PROJECT)
    app_engine_account = cloud('iam', 'service-accounts', 'describe', APP_ENGINE_DEFAULT, missing=True)
    app_engine_policy = cloud('iam', 'service-accounts', 'get-iam-policy', APP_ENGINE_DEFAULT) if app_engine_account else {}
    app_engine = app_engine_default_state(app_engine_account, policy, app_engine_policy)
    old_bindings = []
    runtime_member, deploy_member = 'serviceAccount:' + RUNTIME, 'serviceAccount:' + DEPLOY
    allowed_deploy = {'roles/cloudfunctions.developer', 'roles/serviceusage.serviceUsageConsumer', f'projects/{PROJECT}/roles/placesFunctionsDeploy', f'projects/{PROJECT}/roles/placesDeployRead', 'roles/iap.tunnelResourceAccessor'}
    for entry in policy.get('bindings', []):
        members, role = entry.get('members', []), entry['role']
        if runtime_member in members and role != 'roles/datastore.user':
            fail('unexpected_runtime_project_grant')
        if deploy_member in members and role not in allowed_deploy:
            fail('unexpected_deploy_project_grant')
        if role == f'projects/{PROJECT}/roles/placesDeployRead':
            if members != [deploy_member] or entry.get('condition'):
                fail('old_compute_role_binding_mismatch')
            old_bindings.append(entry)
        if role == 'roles/iap.tunnelResourceAccessor' and (deploy_member in members or entry.get('condition', {}).get('title') == 'places-iap-ssh'):
            condition = entry.get('condition', {})
            if condition.get('title') != 'places-iap-ssh' or not re.fullmatch(r"destination.port == 22 && destination.ip == '[0-9.]+\'", condition.get('expression', '')):
                fail('old_iap_condition_mismatch')
            if any(m != deploy_member and not m.startswith('user:') for m in members):
                fail('old_iap_member_mismatch')
            old_bindings.append(entry)
    for name, permissions in [('placesSessionVersionAdder', ['secretmanager.versions.add']), ('placesFunctionsDeploy', DEPLOY_PERMISSIONS)]:
        existing = cloud('iam', 'roles', 'describe', name, missing=True)
        if existing and (existing.get('deleted') or sorted(existing.get('includedPermissions', [])) != sorted(permissions)):
            fail('existing_serverless_custom_role_mismatch')
    accounts = {name: cloud('iam', 'service-accounts', 'describe', email, missing=True) for name, email in [('runtime', RUNTIME), ('deploy', DEPLOY)]}
    old_admins = {m for entry in old_bindings if entry['role'] == 'roles/iap.tunnelResourceAccessor' for m in entry['members'] if m.startswith('user:')}
    runtime_policy = cloud('iam', 'service-accounts', 'get-iam-policy', RUNTIME) if accounts['runtime'] else {'bindings': []}
    for entry in runtime_policy.get('bindings', []):
        if entry['role'] != 'roles/iam.serviceAccountUser' or entry.get('condition') or any(m != deploy_member and m not in old_admins for m in entry.get('members', [])):
            fail('existing_runtime_service_account_policy_mismatch')
    for secret in SECRETS:
        metadata = cloud('secrets', 'describe', secret, missing=True)
        if not metadata and secret in SECRETS[:2]:
            fail('existing_secret_required')
        if metadata:
            secret_policy = cloud('secrets', 'get-iam-policy', secret)
            for entry in secret_policy.get('bindings', []):
                if deploy_member in entry.get('members', []):
                    fail('deploy_has_existing_secret_grant')
                if runtime_member in entry.get('members', []) and (entry.get('condition') or entry['role'] not in (['roles/secretmanager.secretAccessor', f'projects/{PROJECT}/roles/placesSessionVersionAdder'] if secret == 'OPENAI_SIWC_SESSION' else ['roles/secretmanager.secretAccessor'])):
                    fail('unexpected_runtime_secret_grant')
                if secret == 'GEMINI_API_KEY' and runtime_member in entry.get('members', []):
                    fail('fallback_disabled_runtime_has_Gemini_grant')
    pool = cloud('iam', 'workload-identity-pools', 'describe', POOL, '--location=global', missing=True)
    provider = cloud('iam', 'workload-identity-pools', 'providers', 'describe', PROVIDER, '--location=global', '--workload-identity-pool=' + POOL, missing=True)
    # Verify numeric identity from public GitHub metadata, not a name-only trust.
    import urllib.request
    repo = json.load(urllib.request.urlopen('https://api.github.com/repos/' + REPOSITORY, timeout=20))
    mapping, trust, legacy_mapping, legacy_trust = wif_configuration(repo)
    if pool and (pool.get('state') != 'ACTIVE' or pool.get('disabled')):
        fail('existing_wif_pool_inactive')
    provider_state = wif_provider_state(provider, mapping, trust, legacy_mapping, legacy_trust)
    if pool and any(not p['name'].endswith('/providers/' + PROVIDER) for p in cloud('iam', 'workload-identity-pools', 'providers', 'list', '--location=global', '--workload-identity-pool=' + POOL)):
        fail('unexpected_provider_in_dedicated_pool')
    principal = f'principalSet://iam.googleapis.com/projects/{number}/locations/global/workloadIdentityPools/{POOL}/attribute.repository_id/{repo["id"]}'
    if accounts['deploy']:
        sa_policy = cloud('iam', 'service-accounts', 'get-iam-policy', DEPLOY)
        if any(b['role'] == 'roles/iam.workloadIdentityUser' and (b['members'] != [principal] or b.get('condition')) for b in sa_policy.get('bindings', [])):
            fail('existing_federation_binding_mismatch')
    print(json.dumps({'project': PROJECT, 'region': REGION, 'VMAndDiskAbsent': True, 'removeNetwork': bool(network), 'removeSubnet': bool(subnet), 'removeFirewall': bool(firewall), 'removeComputeRole': bool(old_role and not old_role.get('deleted')), 'oldIAMBindings': len(old_bindings), 'reuseRuntime': bool(accounts['runtime']), 'reuseDeploy': bool(accounts['deploy']), 'reuseWIF': provider_state == 'reuse', 'wifProviderAction': provider_state, 'appEngineDefaultAction': app_engine['action'], 'removeAppEngineEditor': app_engine['removeEditor'], 'grantAppEnginePreflightActAs': app_engine['grantPreflightActAs'], 'mode': mode}))
    if mode == '--plan':
        return
    # All legacy preflight checks above are read-only; only apply mutates resources.
    cloud('services', 'enable', 'cloudfunctions.googleapis.com', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'firestore.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', 'firebase.googleapis.com', 'cloudresourcemanager.googleapis.com')
    if artifact and artifact.get('inspectionDeferred'):
        artifact = cloud('artifacts', 'repositories', 'describe', 'gcf-artifacts', '--location=' + REGION, missing=True)
        if artifact and (artifact.get('format') != 'DOCKER' or not artifact.get('cleanupPolicies')):
            fail('existing_artifact_repository_requires_owner_review')
    # Inspect effective build identity before any legacy deletions.
    build = cloud('builds', 'get-default-service-account', '--region=' + REGION)
    build_email = canonical_build_email(build, number)
    if build_email in [RUNTIME, DEPLOY, APP_ENGINE_DEFAULT]:
        fail('default_cloud_build_identity_requires_owner_review')
    build_roles = [b['role'] for b in policy.get('bindings', []) if 'serviceAccount:' + build_email in b.get('members', [])]
    if any(role in ['roles/owner', 'roles/editor'] for role in build_roles):
        fail('broad_default_build_identity_requires_owner_review')
    # Targeted removal preserves other Editor members. Never grant actAs while this SA is Editor.
    if app_engine['removeEditor']:
        binding((['projects'], PROJECT), 'serviceAccount:' + APP_ENGINE_DEFAULT, 'roles/editor', remove=True)
    if not artifact:
        cloud('artifacts', 'repositories', 'create', 'gcf-artifacts', '--location=' + REGION, '--repository-format=docker')
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as policy_file:
            json.dump([{'name': 'places-7-days', 'action': {'type': 'Delete'}, 'condition': {'tagState': 'any', 'olderThan': '604800s'}}], policy_file)
            policy_file.flush()
            cloud('artifacts', 'repositories', 'set-cleanup-policies', 'gcf-artifacts', '--location=' + REGION, '--policy=' + policy_file.name, '--no-dry-run')
    for name, email in [('runtime', RUNTIME), ('deploy', DEPLOY)]:
        if not accounts[name]:
            cloud('iam', 'service-accounts', 'create', 'places-' + name)
    for entry in runtime_policy.get('bindings', []):
        for member in entry.get('members', []):
            if member in old_admins:
                binding((['iam', 'service-accounts'], RUNTIME), member, entry['role'], remove=True)
    for entry in old_bindings:
        for member in entry['members']:
            binding((['projects'], PROJECT), member, entry['role'], entry.get('condition'), remove=True)
    if old_role and not old_role.get('deleted'):
        cloud('iam', 'roles', 'delete', 'placesDeployRead')
    if firewall:
        cloud('compute', 'firewall-rules', 'delete', 'places-iap-ssh')
    if subnet:
        cloud('compute', 'networks', 'subnets', 'delete', 'places-subnet', '--region=' + subnet['region'].split('/')[-1])
    if network:
        cloud('compute', 'networks', 'delete', 'places-network')
    custom_role('placesSessionVersionAdder', ['secretmanager.versions.add'])
    custom_role('placesFunctionsDeploy', DEPLOY_PERMISSIONS)
    binding((['projects'], PROJECT), runtime_member, 'roles/datastore.user')
    for secret in SECRETS[2:]:
        if not cloud('secrets', 'describe', secret, missing=True):
            cloud('secrets', 'create', secret, '--replication-policy=automatic')
    for secret in ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'OPENAI_SIWC_SESSION']:
        binding((['secrets'], secret), runtime_member, 'roles/secretmanager.secretAccessor')
    binding((['secrets'], 'OPENAI_SIWC_SESSION'), runtime_member, f'projects/{PROJECT}/roles/placesSessionVersionAdder')
    for role in ['roles/cloudfunctions.developer', 'roles/serviceusage.serviceUsageConsumer', f'projects/{PROJECT}/roles/placesFunctionsDeploy']:
        binding((['projects'], PROJECT), deploy_member, role)
    binding((['iam', 'service-accounts'], RUNTIME), deploy_member, 'roles/iam.serviceAccountUser')
    if app_engine['grantPreflightActAs']:
        binding((['iam', 'service-accounts'], APP_ENGINE_DEFAULT), deploy_member, 'roles/iam.serviceAccountUser')
    binding((['projects'], PROJECT), 'serviceAccount:' + build_email, 'roles/cloudbuild.builds.builder')
    if build_email != number + '@cloudbuild.gserviceaccount.com':
        binding((['iam', 'service-accounts'], build_email), deploy_member, 'roles/iam.serviceAccountUser')
    if not pool:
        cloud('iam', 'workload-identity-pools', 'create', POOL, '--location=global')
    if provider_state != 'reuse':
        operation = 'update-oidc' if provider_state == 'upgrade' else 'create-oidc'
        cloud('iam', 'workload-identity-pools', 'providers', operation, PROVIDER, '--location=global', '--workload-identity-pool=' + POOL, '--issuer-uri=https://token.actions.githubusercontent.com', '--attribute-mapping=' + ','.join(key + '=' + value for key, value in mapping.items()), '--attribute-condition=' + trust)
    binding((['iam', 'service-accounts'], DEPLOY), principal, 'roles/iam.workloadIdentityUser')
    print(json.dumps({'GCP_PROJECT_ID': PROJECT, 'GCP_WIF_PROVIDER': f'projects/{number}/locations/global/workloadIdentityPools/{POOL}/providers/{PROVIDER}', 'GCP_DEPLOY_SERVICE_ACCOUNT': DEPLOY, 'region': REGION, 'buildAccount': build_email, 'functionNotDeployed': True, 'secretsHaveNoNewPayloads': True}))


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) == 2 else '--plan' if len(sys.argv) == 1 else None
    try:
        if mode not in ['--plan', '--apply', '--validate']:
            fail('invalid_mode')
        main(mode)
    except Exception as error:
        code = str(error) if type(error) is RuntimeError else 'unexpected_failure_check_owner_access_and_configuration'
        print('serverless_migration_failed:' + code, file=sys.stderr)
        sys.exit(1)
