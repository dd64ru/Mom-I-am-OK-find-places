# Private Places service production rollout

This is an owner-operated runbook, not an executed rollout. Merge the rollout
preparation branch before using the new manual workflow. Deploy only from a
reviewed main SHA; the workflow reconciles only placesService caller IAM after each deployment,
and does not run migrations or release the App. Do not grant the deployment identity IAM administrator or project-wide Invoker roles. Existing SIWC, Secret
Manager and ADC access remain unchanged.

## First-time rollout order

1. Merge rollout preparation to Places main.
2. If reviewAiChatSavedPlaces is not already deployed by a compatible backend,
   run App Production Release target=backend at reviewed App SHA
   containing these reviewed corrective changes. Do not publish clients yet.
3. Read the function's actual serviceConfig.serviceAccountEmail and configure
   PLACES_EXPECTED_APP_CALLER_SA in the protected Places production environment.
4. Ensure the deployment identity has the narrowly scoped Run service IAM
   permissions below, then deploy placesService with service_enabled=false.
   The workflow reconciles/verifies the caller binding after this deploy.
5. Verify the dormant private service and its caller policy.
6. Deploy placesService with service_enabled=true. The same automatic IAM
   reconciliation runs again, because Firebase can erase caller bindings.
7. Verify unauthenticated access is denied and the policy remains private.
8. Publish clients using App Production Release target=both at the same reviewed SHA.
9. Perform the explicit-confirmation production smoke.

If a compatible backend already provides reviewAiChatSavedPlaces, skip the
backend bootstrap after verifying compatibility. Always read its actual runtime
identity; never rely on the expected default account. Complete the backend and
caller configuration before the first service workflow, including a dormant deploy.

For later complete releases, target=all is appropriate. For this first rollout,
backend → service IAM/enablement → clients avoids exposing the UI before its
private dependency is ready. Each production release requires owner authorization;
these commands document the sequence and do not authorize execution here.

## Caller configuration and deploy dormant

Before the service dispatch, follow the App production-release skill from a clean
detached worktree of the reviewed App SHA to bootstrap backend if needed:

```bash
APP_REVIEWED_SHA='<reviewed-corrective-App-main-SHA>'
test "$(gh api repos/dd64ru/Mom-I-am-OK/git/ref/heads/main --jq .object.sha)" = "$APP_REVIEWED_SHA"
node scripts/release/productionRelease.mjs --target backend --expected-sha "$APP_REVIEWED_SHA"
APP_RUNTIME_SA=$(gcloud functions describe reviewAiChatSavedPlaces --gen2 --region europe-west1 --project where-i-am-cbde1 --format='value(serviceConfig.serviceAccountEmail)')
test -n "$APP_RUNTIME_SA"
gh variable set PLACES_EXPECTED_APP_CALLER_SA --repo dd64ru/Mom-I-am-OK-find-places --env production --body "$APP_RUNTIME_SA"
```

These are owner steps, not performed by preparation. Review/approve the caller
configuration and protect changes to it. The workflow refuses absent/malformed
callers before deployment and refuses any Places-project runtime SA as caller.
No application source hardcodes today's concrete App runtime account.

Firebase's invoker: private deployment can remove manual caller grants. Every
service deployment now reconciles roles/run.invoker on ONLY its underlying Run
service using the existing deployment identity, then reads back and verifies the
policy. Disabled deployments do this too. Ensure that identity has run.services.get,
run.services.getIamPolicy and run.services.setIamPolicy scoped only to
placesservice (or an IAM condition limiting the resource if an initial creation
requires bootstrap permissions). No IAM administrator role, project-wide Invoker,
public principal or sibling IAM permission is required for reconciliation. An owner
must separately review any required permission provisioning; the workflow does
not provision its own privileges. Missing permissions fail the workflow closed.

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

## Verify dormant service and bootstrap the backend

```bash
gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format=json > placesService.dormant.json
PLACES_RUN_RESOURCE=$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.service)')
PLACES_RUN_SERVICE=${PLACES_RUN_RESOURCE##*/}
test -n "$PLACES_RUN_SERVICE"
test "$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.serviceAccountEmail)')" = 'places-runtime@mom-im-ok-places.iam.gserviceaccount.com'
test "$(gcloud functions describe placesService --gen2 --region europe-west3 --project mom-im-ok-places --format='value(serviceConfig.environmentVariables.PLACES_SERVICE_ENABLED)')" = false
gcloud run services describe "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.run.dormant.json
gcloud run services get-iam-policy "$PLACES_RUN_SERVICE" --region europe-west3 --project mom-im-ok-places --format=json > placesService.iam.before.json

```

Inspect the saved function/Run descriptions: region europe-west3, expected runtime
SA, Run service exists, and Run invoker IAM checks remain enabled (no
invoker-iam-disabled configuration). Inspect the IAM policy for any allUsers or
allAuthenticatedUsers invoker grant; stop if either exists. Also inspect inherited
project/folder/org policies using the organization's IAM review tools: a private
service policy cannot counter an inherited public binding.

Read the final policy saved above after each deployment: it must include an
unconditional roles/run.invoker membership consisting only of the configured
actual App caller, with no additional/conditional Invoker members and no
allUsers/allAuthenticatedUsers anywhere. Unexpected existing invokers stop
reconciliation before any write and require owner review; unrelated roles are
preserved. The workflow checks the discovered
underlying resource, enabled IAM enforcement, pre-write public bindings and the
post-write expected grant. Reconciliation failure or missing/public final policy
fails the deployment workflow; do not proceed to clients. Compare sibling function
and IAM snapshots independently; reconciliation addresses only placesservice.

The owner can inspect the actual caller again and compare it with the protected
configuration. If the backend runtime identity changes, review and update that
configuration before deploying the service. Do not substitute a developer or the
Places runtime account. No separate manual caller-binding repair is needed after
an ordinary successful deployment.

## Enable, verify isolation, then publish clients

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
changes before publishing clients. No locality backfill is required.

Only after the service is ready, explicitly authorize Mom-I-am-OK Production
Release **both** (web + Android) at the same reviewed corrective App SHA.
Follow that repository's production-release skill and use its launcher from a
clean detached worktree of that exact SHA:

```bash
test "$(gh api repos/dd64ru/Mom-I-am-OK/git/ref/heads/main --jq .object.sha)" = "$APP_REVIEWED_SHA"
node scripts/release/productionRelease.mjs --target both --expected-sha "$APP_REVIEWED_SHA"
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

## Cost safety

placesService uses minInstances=0 and maxInstances=2; no always-on VM is
introduced. Locality backfill is optional and must not be part of rollout.
No paid real-provider acceptance is required for rollout. The explicit production
smoke may use providers as part of normal application behavior; it is separate
from any billed acceptance campaign.

## Rollback and optional maintenance

Immediately redeploy the reviewed service with service_enabled=false using the
same manual workflow; wait for success and read back PLACES_SERVICE_ENABLED=false.
IAM reconciliation still runs after this disabled deployment, because Firebase
may replace the binding again. Require the private-policy verification to pass.
App release need not be rolled back merely to disable this
integration. A failed deployment is not proof of disablement: verify live state.

Locality backfill is optional, requires separate review/authorization, and is not
a rollout prerequisite. Never run it as part of service deployment.
