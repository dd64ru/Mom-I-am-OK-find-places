# Private Places service production rollout

This is an owner-operated runbook, not an executed rollout. Merge the rollout
preparation branch before using the new manual workflow. Deploy only from a
reviewed main SHA; the workflow does not grant IAM, run migrations or release
the App. Do not widen the existing deployment identity. Existing SIWC, Secret
Manager and ADC access remain unchanged.

## Deploy dormant

Record the reviewed Places main SHA and verify it is still current before each
dispatch. Replace the value below with the reviewed post-merge SHA; stop if main
moves. Production environment settings must supply WORKSPACE_ID, OPENAI_MODEL,
OPENAI_REASONING_EFFORT and OPENAI_HOST_ID. NOMINATIM_ENDPOINT defaults to
https://nominatim.openstreetmap.org. The service env file contains exactly those
five settings plus PLACES_SERVICE_ENABLED, never Telegram settings or secrets.
The enabled value must be explicitly true or false; the workflow defaults false.

Owner commands (not run by this change):

```bash
PLACES_REVIEWED_SHA='<reviewed-post-merge-Places-main-SHA>'
test "$(gh api repos/dd64ru/Mom-I-am-OK-find-places/git/ref/heads/main --jq .object.sha)" = "$PLACES_REVIEWED_SHA"
# Keep local baseline evidence for the two siblings before the dormant deploy.
for sibling in placesWebhook placesFeed; do
  gcloud functions describe "$sibling" --gen2 --region europe-west3 --project mom-im-ok-places --format=json > "$sibling.before.json"
done
gh workflow run deploy-service.yml --repo dd64ru/Mom-I-am-OK-find-places --ref main -f service_enabled=false
# Locate the matching push SHA in the dispatch run, inspect it, then watch its ID.
gh run list --repo dd64ru/Mom-I-am-OK-find-places --workflow deploy-service.yml --limit 5 --json databaseId,headSha,status,conclusion
gh run watch '<matching-run-ID>' --repo dd64ru/Mom-I-am-OK-find-places --exit-status
```

Only functions:places:placesService is selected. The workflow runs secret scan,
deterministic checks and emulator rules tests, packages service only, writes the
service env, installs standalone production dependencies and performs a
credential-free import/discovery smoke before WIF authentication. It shares the
places-production-deploy concurrency lock with webhook/feed deployments. It
uses the existing GCP_WIF_PROVIDER and GCP_DEPLOY_SERVICE_ACCOUNT variables.

## Read the actual function, service and caller identity

```bash
gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format=json > placesService.dormant.json
PLACES_RUN_RESOURCE=$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.service)')
PLACES_RUN_SERVICE=${PLACES_RUN_RESOURCE##*/}
test -n "$PLACES_RUN_SERVICE"
test "$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.serviceAccountEmail)')" = 'places-runtime@mom-im-ok-places.iam.gserviceaccount.com'
test "$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.environmentVariables.PLACES_SERVICE_ENABLED)')" = false
gcloud run services describe "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.run.dormant.json
gcloud run services get-iam-policy "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.iam.before.json

gcloud functions describe reviewAiChatSavedPlaces --gen2 --region europe-west1 --project where-i-am-cbde1 --format=json > reviewAiChatSavedPlaces.runtime.json
APP_RUNTIME_SA=$(gcloud functions describe reviewAiChatSavedPlaces --gen2 --region europe-west1 --project where-i-am-cbde1 --format='value(serviceConfig.serviceAccountEmail)')
test -n "$APP_RUNTIME_SA"
printf 'Actual caller runtime service account: %s\n' "$APP_RUNTIME_SA"
```

Inspect the saved function/Run descriptions: region europe-west3, expected runtime
SA, Run service exists, and Run invoker IAM checks remain enabled (no
invoker-iam-disabled configuration). Inspect the IAM policy for any allUsers or
allAuthenticatedUsers invoker grant; stop if either exists. Also inspect inherited
project/folder/org policies using the organization's IAM review tools: a private
service policy cannot counter an inherited public binding.

The expected current App account is
142094474582-compute@developer.gserviceaccount.com, but use the actual live
serviceConfig.serviceAccountEmail above, never an assumed identity. If the caller
function does not yet exist, stop: establish its deployed runtime identity before
proceeding. Do not substitute a developer account.

## Grant only the caller, then read back

An owner with service-level IAM administration performs the following after
reviewing the before policy and actual caller. This is intentionally outside the
deployment workflow. Keep existing bindings; never replace the whole policy.

```bash
gcloud run services add-iam-policy-binding "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --member="serviceAccount:$APP_RUNTIME_SA" --role=roles/run.invoker
gcloud run services get-iam-policy "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.iam.after.json
```

Compare before/after: the only intended new permission is roles/run.invoker for
that exact caller on that exact Run service. No public principals, no project-wide
Run Invoker, no deployer IAM role expansion. Verify the service is still disabled.

## Enable, verify isolation, then release App

```bash
test "$(gh api repos/dd64ru/Mom-I-am-OK-find-places/git/ref/heads/main --jq .object.sha)" = "$PLACES_REVIEWED_SHA"
gh workflow run deploy-service.yml --repo dd64ru/Mom-I-am-OK-find-places --ref main -f service_enabled=true
# Find the matching dispatch as above and wait for success.
gh run watch '<enabled-run-ID>' --repo dd64ru/Mom-I-am-OK-find-places --exit-status
test "$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.environmentVariables.PLACES_SERVICE_ENABLED)')" = true
gcloud run services get-iam-policy "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.iam.enabled.json
PLACES_SERVICE_URL=$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.uri)')
# No Authorization header; invalid empty body cannot create/save a place.
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' --request POST --header 'Content-Type: application/json' --data '{}' "$PLACES_SERVICE_URL"
for sibling in placesWebhook placesFeed; do
  gcloud functions describe "$sibling" --gen2 --region europe-west3 --project mom-im-ok-places --format=json > "$sibling.after.json"
  diff -u "$sibling.before.json" "$sibling.after.json"
done
```

Require IAM rejection (401/403), not an application response. Verify the caller
binding survived redeployment, no public invoker exists, runtime SA is unchanged,
and neither sibling's code/config/update time changed. Resolve unexpected
changes before App release. No locality backfill is required.

Only after the service is ready, explicitly authorize Mom-I-am-OK Production
Release **all** at reviewed App SHA 111a023ac90ac76e8ca5c699c6306fe62acabdcd.
Follow that repository's production-release skill and use its launcher from a
clean detached worktree of that exact SHA:

```bash
node scripts/release/productionRelease.mjs --target all --expected-sha 111a023ac90ac76e8ca5c699c6306fe62acabdcd
```

Confirm App main is still that reviewed SHA; if it moved, obtain review for the
new SHA rather than releasing it implicitly. Never dispatch the App release as
part of service deployment.

After release, perform the explicitly authorized production smoke: authenticated
AI Chat → place discovery → Saved Places review → explicit confirmation → point
appears or canonical Place is correctly reused on Saved Places. This smoke writes
production data only through the human confirmation path; it is not run during
preparation or deployment checks. Verify meaningful durable labels and no Trip
mutation.

## Rollback and optional maintenance

Immediately redeploy the reviewed service with service_enabled=false using the
same manual workflow; wait for success and read back PLACES_SERVICE_ENABLED=false.
IAM remains private. App release need not be rolled back merely to disable this
integration. A failed deployment is not proof of disablement: verify live state.

Locality backfill is optional, requires separate review/authorization, and is not
a rollout prerequisite. Never run it as part of service deployment.
