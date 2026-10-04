#!/usr/bin/env bash
# Owner-run Cloud Shell bootstrap: --plan reads metadata; --apply creates chargeable resources.
set -euo pipefail
PROJECT_ID=${PROJECT_ID:-mom-im-ok-places}
REGION=${REGION:-}
ZONE=${ZONE:-}
VM_NAME=${VM_NAME:-places-worker}
PLACES_NETWORK=${PLACES_NETWORK:-places-network}
PLACES_SUBNET=${PLACES_SUBNET:-places-subnet}
PLACES_SUBNET_CIDR=${PLACES_SUBNET_CIDR:-10.64.0.0/28}
RUNTIME_SA_NAME=${RUNTIME_SA_NAME:-places-runtime}
DEPLOY_SA_NAME=${DEPLOY_SA_NAME:-places-deploy}
WIF_POOL=${WIF_POOL:-places-github}
WIF_PROVIDER=${WIF_PROVIDER:-github-main}
READ_ROLE=placesDeployRead
NODE_VERSION=${NODE_VERSION:-22.23.3}
GRANT_GEMINI_ACCESS=${GRANT_GEMINI_ACCESS:-false}
ADMIN_MEMBER=${ADMIN_MEMBER:-}
REPOSITORY=dd64ru/Mom-I-am-OK-find-places
mode=${1:---plan}
fail() { echo "bootstrap_failed:$1" >&2; exit 1; }
[[ $# -le 1 && $mode =~ ^--(plan|apply|validate)$ ]] || fail invalid_mode
[[ $PROJECT_ID =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ && $NODE_VERSION =~ ^22\.[0-9]+\.[0-9]+$ ]] || fail invalid_project_or_node_version
for name in "$VM_NAME" "$PLACES_NETWORK" "$PLACES_SUBNET" "$RUNTIME_SA_NAME" "$DEPLOY_SA_NAME" "$WIF_POOL" "$WIF_PROVIDER"; do
  [[ $name =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail invalid_resource_name
done
[[ $GRANT_GEMINI_ACCESS == true || $GRANT_GEMINI_ACCESS == false ]] || fail invalid_gemini_access
if [[ $mode == --validate ]]; then echo bootstrap_static_validation_ok; exit 0; fi
command -v gcloud >/dev/null || fail gcloud_required_use_authenticated_cloud_shell
command -v jq >/dev/null || fail jq_required
command -v curl >/dev/null || fail curl_required
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
trap 'echo bootstrap_command_failed_check_owner_access_or_existing_resource_configuration >&2' ERR
cloud() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
# Detect NOT_FOUND distinctly; permission/network failures are never treated as missing resources.
read_resource() {
  if cloud "$@" --format=json >"$work/resource.json" 2>"$work/error"; then cat "$work/resource.json"; return 0; fi
  if grep -Eq 'NOT_FOUND|was not found|does not exist|notFound' "$work/error"; then echo null; return 0; fi
  fail resource_inspection_denied_or_failed
}
project=$(read_resource projects describe "$PROJECT_ID")
[[ $project != null ]] || fail existing_project_required
number=$(jq -r .projectNumber <<<"$project")
[[ $number =~ ^[0-9]+$ ]] || fail invalid_project_number
location=$(cloud firestore databases describe --database='(default)' --format='value(locationId)')
[[ -n $location ]] || fail existing_firestore_database_required
for secret in TELEGRAM_BOT_TOKEN GEMINI_API_KEY; do
  data=$(read_resource secrets describe "$secret")
  [[ $data != null ]] || fail existing_secret_metadata_required
 done
printf 'PROJECT_ID=%s\nFIRESTORE_LOCATION=%s\n' "$PROJECT_ID" "$location"
if [[ $mode == --plan ]]; then
  printf 'REGION=%s\nZONE=%s\nVM_NAME=%s\n' "${REGION:-CHOOSE_AFTER_LOCATION_REVIEW}" "${ZONE:-CHOOSE_AFTER_LOCATION_REVIEW}" "$VM_NAME"
  echo 'PLAN_ONLY:one_e2_small_Debian12_VM_20GB_disk_external_IP_for_egress_IAP_only_ingress'
  echo 'APPLY_REQUIRES:explicit_REGION_ZONE_owner_ADMIN_MEMBER_and_chargeable_resource_review'
  exit 0
fi
[[ $REGION =~ ^[a-z]+-[a-z]+[0-9]+$ && $ZONE =~ ^${REGION}-[a-z]$ ]] || fail explicit_matching_region_zone_required
[[ $ADMIN_MEMBER =~ ^user:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || fail explicit_owner_admin_member_required
cloud services enable compute.googleapis.com firestore.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iap.googleapis.com oslogin.googleapis.com cloudresourcemanager.googleapis.com --format=none
[[ $(cloud compute zones describe "$ZONE" --format='value(region)') == */"$REGION" ]] || fail zone_region_mismatch
runtime="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
deploy="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
for account in "$RUNTIME_SA_NAME" "$DEPLOY_SA_NAME"; do
  email="${account}@${PROJECT_ID}.iam.gserviceaccount.com"
  data=$(read_resource iam service-accounts describe "$email")
  if [[ $data == null ]]; then cloud iam service-accounts create "$account" --display-name="$account" --format=none; fi
done
policy=$(cloud projects get-iam-policy "$PROJECT_ID" --format=json)
# Reuse does not justify inherited broad roles; an owner must review unexpected existing grants.
jq -e --arg r "serviceAccount:$runtime" --arg d "serviceAccount:$deploy" --arg role "projects/$PROJECT_ID/roles/$READ_ROLE" '
  all(.bindings[]; if ((.members // []) | index($r)) then .role == "roles/datastore.user"
  elif ((.members // []) | index($d)) then (.role == $role or .role == "roles/iap.tunnelResourceAccessor") else true end)' <<<"$policy" >/dev/null || fail unexpected_existing_service_account_project_grant
# Inspect IAM metadata only, never secret versions/payloads.
for secret in TELEGRAM_BOT_TOKEN GEMINI_API_KEY; do
  secret_policy=$(cloud secrets get-iam-policy "$secret" --format=json)
  jq -e --arg d "serviceAccount:$deploy" 'all(.bindings[]?; ((.members // []) | index($d)) == null)' <<<"$secret_policy" >/dev/null || fail deploy_identity_has_existing_secret_grant
  if [[ $secret == GEMINI_API_KEY && $GRANT_GEMINI_ACCESS == false ]]; then
    jq -e --arg r "serviceAccount:$runtime" 'all(.bindings[]?; ((.members // []) | index($r)) == null)' <<<"$secret_policy" >/dev/null || fail disabled_gemini_has_existing_runtime_grant
  fi
done
cloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$runtime" --role=roles/datastore.user --condition=None --format=none
cloud secrets add-iam-policy-binding TELEGRAM_BOT_TOKEN --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --format=none
if [[ $GRANT_GEMINI_ACCESS == true ]]; then
  cloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --format=none
fi
permissions=compute.instances.get,compute.instances.list,compute.projects.get
role=$(read_resource iam roles describe "$READ_ROLE")
if [[ $role == null ]]; then
  cloud iam roles create "$READ_ROLE" --title='Places deployment read metadata' --permissions="$permissions" --stage=GA --format=none
else
  jq -e '.includedPermissions | sort == ["compute.instances.get","compute.instances.list","compute.projects.get"]' <<<"$role" >/dev/null || fail existing_read_role_mismatch
fi
cloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$deploy" --role="projects/$PROJECT_ID/roles/$READ_ROLE" --condition=None --format=none
network=$(read_resource compute networks describe "$PLACES_NETWORK")
if [[ $network == null ]]; then cloud compute networks create "$PLACES_NETWORK" --subnet-mode=custom --format=none;
else jq -e '.autoCreateSubnetworks == false' <<<"$network" >/dev/null || fail existing_network_not_custom; fi
subnet=$(read_resource compute networks subnets describe "$PLACES_SUBNET" --region="$REGION")
if [[ $subnet == null ]]; then
  cloud compute networks subnets create "$PLACES_SUBNET" --network="$PLACES_NETWORK" --region="$REGION" --range="$PLACES_SUBNET_CIDR" --format=none
else
  jq -e --arg n "/networks/$PLACES_NETWORK" --arg cidr "$PLACES_SUBNET_CIDR" '.network | endswith($n)' <<<"$subnet" >/dev/null || fail existing_subnet_network_mismatch
  [[ $(jq -r .ipCidrRange <<<"$subnet") == "$PLACES_SUBNET_CIDR" ]] || fail existing_subnet_cidr_mismatch
fi
firewall_name=places-iap-ssh
firewall=$(read_resource compute firewall-rules describe "$firewall_name")
if [[ $firewall == null ]]; then
  cloud compute firewall-rules create "$firewall_name" --network="$PLACES_NETWORK" --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-service-accounts="$runtime" --format=none
else
  jq -e --arg n "/networks/$PLACES_NETWORK" --arg r "$runtime" '.network | endswith($n)' <<<"$firewall" >/dev/null || fail existing_firewall_network_mismatch
  jq -e --arg r "$runtime" '.direction == "INGRESS" and .sourceRanges == ["35.235.240.0/20"] and .targetServiceAccounts == [$r] and .allowed == [{"IPProtocol":"tcp","ports":["22"]}] and (.disabled // false) == false' <<<"$firewall" >/dev/null || fail existing_firewall_mismatch
fi
firewalls=$(cloud compute firewall-rules list --filter="network:$PLACES_NETWORK" --format=json)
jq -e --arg f "$firewall_name" 'all(.[]; .direction != "INGRESS" or .name == $f or (.allowed | length) == 0)' <<<"$firewalls" >/dev/null || fail unexpected_existing_ingress_firewall
vm=$(read_resource compute instances describe "$VM_NAME" --zone="$ZONE")
if [[ $vm == null ]]; then
  cloud compute instances create "$VM_NAME" --zone="$ZONE" --machine-type=e2-small --network="$PLACES_NETWORK" --subnet="$PLACES_SUBNET" --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced --no-boot-disk-auto-delete --service-account="$runtime" --scopes=cloud-platform --shielded-secure-boot --metadata="enable-oslogin=TRUE,block-project-ssh-keys=TRUE,places-node-version=$NODE_VERSION" --metadata-from-file="startup-script=$root/infra/prepare-vm.sh,places-installer=$root/infra/install-release.sh,places-rollback=$root/infra/rollback-release.sh,places-validator=$root/infra/validate-release.py,places-unit=$root/infra/places-worker.service,places-env-template=$root/infra/worker.env.example" --format=none
  vm=$(read_resource compute instances describe "$VM_NAME" --zone="$ZONE")
else
  jq -e --arg r "$runtime" --arg network "/networks/$PLACES_NETWORK" --arg subnet "/subnetworks/$PLACES_SUBNET" '
    .machineType | endswith("/e2-small")' <<<"$vm" >/dev/null || fail existing_vm_machine_type_mismatch
  jq -e --arg r "$runtime" --arg network "/networks/$PLACES_NETWORK" --arg subnet "/subnetworks/$PLACES_SUBNET" '
    (.networkInterfaces | length) == 1 and any(.disks[]; .boot == true and .autoDelete == false)
    and .serviceAccounts == [{"email":$r,"scopes":["https://www.googleapis.com/auth/cloud-platform"]}]
    and (.networkInterfaces[0].network | endswith($network)) and (.networkInterfaces[0].subnetwork | endswith($subnet))
    and any(.metadata.items[]; .key == "enable-oslogin" and .value == "TRUE")
    and any(.metadata.items[]; .key == "block-project-ssh-keys" and .value == "TRUE")' <<<"$vm" >/dev/null || fail existing_vm_security_configuration_mismatch
  # Root helper updates need owner review and a deliberate startup-script re-run; no automatic reboot.
fi
internal_ip=$(jq -r '.networkInterfaces[0].networkIP' <<<"$vm")
condition="expression=destination.port == 22 && destination.ip == '$internal_ip',title=places-iap-ssh"
jq -e --arg d "serviceAccount:$deploy" --arg expression "destination.port == 22 && destination.ip == '$internal_ip'" '
  all(.bindings[]; .role != "roles/iap.tunnelResourceAccessor" or ((.members // []) | index($d)) == null or .condition.expression == $expression)' <<<"$policy" >/dev/null || fail existing_deploy_iap_condition_mismatch
for member in "serviceAccount:$deploy" "$ADMIN_MEMBER"; do
  cloud projects add-iam-policy-binding "$PROJECT_ID" --member="$member" --role=roles/iap.tunnelResourceAccessor --condition="$condition" --format=none
  cloud iam service-accounts add-iam-policy-binding "$runtime" --member="$member" --role=roles/iam.serviceAccountUser --format=none
  cloud compute instances add-iam-policy-binding "$VM_NAME" --zone="$ZONE" --member="$member" --role=roles/compute.osAdminLogin --format=none
done
repo=$(curl --fail --silent --show-error "https://api.github.com/repos/$REPOSITORY")
repo_id=$(jq -r .id <<<"$repo"); owner_id=$(jq -r .owner.id <<<"$repo")
[[ $repo_id =~ ^[0-9]+$ && $owner_id =~ ^[0-9]+$ ]] || fail github_numeric_identity_unavailable
pool=$(read_resource iam workload-identity-pools describe "$WIF_POOL" --location=global)
if [[ $pool == null ]]; then cloud iam workload-identity-pools create "$WIF_POOL" --location=global --display-name='Places GitHub production' --format=none;
else jq -e '.state == "ACTIVE" and (.disabled // false) == false' <<<"$pool" >/dev/null || fail existing_wif_pool_inactive; fi
providers=$(cloud iam workload-identity-pools providers list --location=global --workload-identity-pool="$WIF_POOL" --format=json)
jq -e --arg p "/providers/$WIF_PROVIDER" 'all(.[]; .name | endswith($p))' <<<"$providers" >/dev/null || fail unexpected_provider_in_dedicated_wif_pool
trust="assertion.repository_id == '$repo_id' && assertion.repository_owner_id == '$owner_id' && assertion.repository == '$REPOSITORY' && assertion.ref == 'refs/heads/main' && assertion.sub == 'repo:$REPOSITORY:environment:production'"
provider=$(read_resource iam workload-identity-pools providers describe "$WIF_PROVIDER" --location=global --workload-identity-pool="$WIF_POOL")
if [[ $provider == null ]]; then
  cloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" --location=global --workload-identity-pool="$WIF_POOL" --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id --attribute-condition="$trust" --format=none
else
  jq -e --arg trust "$trust" '.oidc.issuerUri == "https://token.actions.githubusercontent.com" and .attributeCondition == $trust and .attributeMapping == {"google.subject":"assertion.sub","attribute.repository_id":"assertion.repository_id"} and (.disabled // false) == false' <<<"$provider" >/dev/null || fail existing_wif_provider_mismatch
fi
principal="principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$WIF_POOL/attribute.repository_id/$repo_id"
deploy_policy=$(cloud iam service-accounts get-iam-policy "$deploy" --format=json)
jq -e --arg p "$principal" 'all(.bindings[]?; .role != "roles/iam.workloadIdentityUser" or (.members == [$p] and (.condition // null) == null))' <<<"$deploy_policy" >/dev/null || fail existing_deploy_federation_grant_mismatch
cloud iam service-accounts add-iam-policy-binding "$deploy" --member="$principal" --role=roles/iam.workloadIdentityUser --format=none
printf 'GCP_PROJECT_ID=%s\nGCP_ZONE=%s\nGCP_VM_NAME=%s\nGCP_WIF_PROVIDER=projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\nGCP_DEPLOY_SERVICE_ACCOUNT=%s\nREGION=%s\n' "$PROJECT_ID" "$ZONE" "$VM_NAME" "$number" "$WIF_POOL" "$WIF_PROVIDER" "$deploy" "$REGION"
echo 'BOOTSTRAP_COMPLETE:wait_for_VM_preparation_then_configure_GitHub_production_environment'
echo 'WORKER_NOT_STARTED:no_workspace_or_SIWC_profile_created'
