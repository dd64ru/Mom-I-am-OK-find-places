# Serverless production operations

Canonical runtime: Telegram HTTPS webhook → Firebase Functions v2 / Cloud Run request execution → Places Core → OpenAI SIWC vision/search → Google Places primary / Nominatim fallback → explicit confirmation → Firestore. Project `mom-im-ok-places`, region and existing Firestore location `europe-west3`. The owner reports that the abandoned `places-worker` VM and retained boot disk are deleted. The owner also reports the old custom network, subnet, firewall, Compute role and GCE/IAP bindings are removed; a final plan reuses runtime/deploy/WIF with no cleanup remaining. The owner reports that the production function is deployed and its Telegram webhook registered. This implementation has no `gcloud` or cloud credentials; **no cloud deployment or cleanup was performed by the agent**.

## Runtime, cost and durable state

`placesWebhook`: Node 22, `europe-west3`, `minInstances: 0`, `maxInstances: 2`, concurrency 16, 1 CPU, 512 MiB, 300-second HTTP timeout. CPU is request-based; cold starts are acceptable. No VM, production poller, VPC connector, NAT, scheduler, load balancer or custom domain. A Firestore image-processing lease limits image memory to one batch globally while concurrent HTTP requests collect album members. No work runs after the handler returns.

The design intentionally avoids always-on compute. Low personal usage should normally be inside or near Google's free/low-use allowances. Actual requests, Firestore operations, builds, Secret Manager versions, Artifact Registry storage, network and AI usage can still incur charges; **a zero bill is not guaranteed**. A new `gcf-artifacts` repository gets a seven-day cleanup policy using Google's supported artifact cleanup mechanism. An existing repository without a policy requires explicit owner review; the script does not change unrelated cleanup policies. No warm instances or keep-alive jobs are configured. Refreshes append Secret Manager versions; periodically disable/destroy obsolete versions through owner operations, retaining the latest valid session. No runtime version-deletion permission is granted.

The runtime identity remains `places-runtime`: project `datastore.user`; `secretAccessor` on `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_SIWC_SESSION`; a custom role containing **only** `secretmanager.versions.add`, bound **only** to `OPENAI_SIWC_SESSION`. Gemini has no runtime secret grant and stays disabled. Credentials never appear in Firestore lock documents or normal function environment variables.

`OPENAI_HOST_ID` is a durable, non-secret `urn:uuid:...` configuration value shared across deployments/cold starts, generated once with `node -e "console.log('urn:uuid:'+require('node:crypto').randomUUID())"`. Keep it in the GitHub production environment settings and preserve it during redeploys. Do not derive it from an account/email. Import preserves the existing issued registration; as in OpenAI’s documented host-transfer guidance, the new host ID is used for subsequent authorization and does not retroactively reattribute an imported session. Secret Manager reads use `latest` for initial state and the immutable latest committed version after rotation, rather than a deployment-pinned environment secret.

## Owner migration and cleanup

From an authenticated owner Cloud Shell checkout of current `main`:

```sh
python3 infra/migrate-serverless.py --plan
```

Plan reads resource/IAM metadata and public GitHub repository identifiers; it never reads secret payloads or mutates cloud resources. It verifies the database location, VM/disk absence, old network/firewall/role shapes, and existing repository/main/production WIF trust. Its `wifProviderAction` is `create`, `reuse` or `upgrade`. Review its safe summary, then run:

```sh
python3 infra/migrate-serverless.py --apply
```

Apply removes only the recognized abandoned firewall/subnet/network, Compute read role, matching IAP bindings and former IAP administrators' runtime `actAs` grants. VM-scoped OS Login bindings disappeared with the deleted VM. Unexpected members, resources or broad account grants fail closed; no VM/disk deletion or migration is attempted. Dedicated runtime/deploy accounts and compatible numeric-ID-restricted WIF are reused. Existing Firestore and Telegram/Gemini secret values are untouched. The two new secrets are created **empty**; this script never generates/imports a payload.

Serverless APIs, artifact retention and deployment IAM are prepared. Deploy gets `cloudfunctions.developer`, `serviceUsageConsumer` and a small Firebase metadata/function-invoker policy role; resource-level `actAs` applies to the runtime, effective build account and hardened App Engine default account for Firebase CLI preflight, not all accounts. No Compute/IAP/SSH or direct secret access is retained. The current effective Cloud Build default is inspected: it receives Google's documented `cloudbuild.builds.builder` role; legacy Google-managed build identities do not receive an unsupported `actAs` binding. An effective build identity with Owner/Editor requires owner review. These deployment/build privileges are trusted: deploying code can indirectly use runtime permissions even though CI has no secret accessor role.

Migration is not a cross-service transaction; already-completed steps can remain after an interruption. Reinspect and rerun. Do not widen permissions merely to suppress a failure. The script does not disable shared APIs, delete service accounts/WIF, or touch unrelated resources.

Owner-run apply idempotently pre-enables the complete Firebase Functions v2 deployment prerequisite API set: `cloudfunctions.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `run.googleapis.com`, `eventarc.googleapis.com`, `pubsub.googleapis.com`, `storage.googleapis.com`, `firebaseextensions.googleapis.com` and `cloudbilling.googleapis.com` and `places.googleapis.com`. It also preserves the existing migration APIs: `secretmanager.googleapis.com`, `firestore.googleapis.com`, `iam.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`, `firebase.googleapis.com` and `cloudresourcemanager.googleapis.com`. Plan performs no API enablement. Pre-enabling these with owner access lets the narrow GitHub deploy identity use already-enabled services without `roles/serviceusage.serviceUsageAdmin` or `serviceusage.services.enable`; deploy/runtime/build grants and WIF trust are unchanged.

Pinned Firebase CLI 15.32.1 calls `ensure(projectId, "cloudbilling.googleapis.com", "billing", true)` before reading project `billingInfo`, so Cloud Billing must also be pre-enabled by the owner. This enables the API without changing a billing account association. Optional trigger APIs such as Cloud Scheduler and Cloud Tasks are not enabled for this HTTPS Gen2 function deployment.

### App Engine default account and Firebase deploy preflight

The owner observed a legacy automatically granted project `roles/editor` binding for `serviceAccount:mom-im-ok-places@appspot.gserviceaccount.com`, with an empty service-account resource IAM policy (`etag` only). This is neither the Places function runtime (`places-runtime`) nor its effective Cloud Build identity. The pinned Firebase CLI 15.32.1 nevertheless checks the deploy caller's `iam.serviceAccounts.actAs` on this App Engine default account before functions deployment, even with an explicit function runtime.

Plan reports `appEngineDefaultAction: harden`, `removeAppEngineEditor` and `grantAppEnginePreflightActAs`. It accepts only an unconditional Editor grant (with unrelated binding members preserved) and an empty account policy or the exact unconditional `roles/iam.serviceAccountUser` binding for `serviceAccount:places-deploy@mom-im-ok-places.iam.gserviceaccount.com`. Missing/disabled accounts, Owner/additional project roles, conditional grants, unexpected resource-policy members and Token Creator/other roles require owner review before writes. A project-wide deploy Service Account User grant also fails the existing deploy-policy guard.

Owner-run apply first removes only the App Engine default member from the project Editor binding using a targeted removal. It does not replace Editor with another project role. It then adds Service Account User **on that one service-account resource** for the deploy account. No project-wide impersonation or Token Creator grant is added. An existing exact actAs grant does not excuse Editor: Editor still must be removed. No direct project roles plus the exact account-level actAs binding yields `appEngineDefaultAction: reuse` and no further App Engine IAM writes. No direct roles plus an empty account policy is the safe interrupted-hardening state; plan reports `harden` with only `grantAppEnginePreflightActAs`, allowing a rerun to finish the targeted grant.

The App Engine hardening preserves runtime/build identities, WIF trust, secret access/payloads, Firestore, webhook and GitHub production variables. Google Places adds only the separately reviewed runtime quota-consumption permission described below. After review, update the owner Cloud Shell checkout, run `python3 infra/migrate-serverless.py --plan`, review the specific hardening flags, run `python3 infra/migrate-serverless.py --apply`, then rerun plan and verify `appEngineDefaultAction: reuse` and `wifProviderAction: reuse`. These commands do not deploy the function or register the webhook.

### GitHub OIDC trust and legacy provider upgrade

GitHub repositories created after July 15, 2026 use immutable default OIDC subjects containing owner/repository IDs. This repository was created October 4, 2026. Authorization must not depend on the former exact `repo:dd64ru/Mom-I-am-OK-find-places:environment:production` subject. See [GitHub's documented OIDC claims and immutable subjects](https://docs.github.com/en/actions/reference/security/oidc).

The provider still maps `google.subject = assertion.sub`, but production authorization uses explicit mapped attributes: `repository_id == 1404706412`, `repository_owner_id == 26544806`, `ref == refs/heads/main`, `environment == production`, and `event_name == workflow_dispatch`. The last condition restricts access to the existing manual deployment event, including rejection of `pull_request_target` even when its ref is main. Other repositories, owners, branches, tags, environments, PR events and name-only claims are rejected. Public GitHub metadata must agree with the pinned immutable IDs; changed identity requires owner review.

An exactly matching current provider is reused. Only the exact legacy mapping/condition produced by the previous migration, with the same GitHub issuer and no disabled/custom-audience configuration, is eligible for `upgrade`. Plan reports this without writes. Owner-run apply uses `gcloud iam workload-identity-pools providers update-oidc` to replace the mapping and condition in place. It preserves pool/provider IDs, deploy account, repository-ID principalSet and the `GCP_WIF_PROVIDER` variable. No legacy-sub alternative is retained in the final condition. Any other mapping, condition or issuer fails closed with `existing_wif_provider_mismatch`; unrelated IAM remains subject to the existing migration guards.

After reviewing this fix, update the owner Cloud Shell checkout with `git pull --ff-only`, run `python3 infra/migrate-serverless.py --plan` and verify `wifProviderAction: upgrade` (or `reuse` if already upgraded). Then run `python3 infra/migrate-serverless.py --apply`, followed by plan to verify `reuse`. This migration does not deploy the function or register the Telegram webhook.

## One-time IDs, secrets and SIWC import

Use the owner's local checkout or authenticated Cloud Shell, `npm ci`, and Node 22. `npm run telegram:ids` is a temporary diagnostic only. With ADC permitted to read the Telegram secret, run it while no webhook/other poller is active; send one harmless event from each intended user in the intended group, record the chat ID (sender IDs are diagnostic only), then Ctrl+C. `npm run webhook -- remove` removes an existing webhook without dropping pending updates before this diagnostic.

Initialize the empty webhook secret once using owner ADC:

```sh
npm run webhook -- init-secret
```

The CLI generates a random token directly into Secret Manager, never prints it, and refuses to overwrite any existing version. Bot token and webhook secret are retrieved directly by the owner CLI for registration; neither is a CLI argument or GitHub value.

For SIWC import, stop all local OAuth/model/vision users of the copied `owner.json`. Keep that file private and outside the checkout. Before importing/replacing a production session, remove the webhook, prevent other requests (temporarily remove public invoker access if already deployed), and allow **all existing requests to drain for at least 300 seconds**. The old secret must not be refreshed concurrently. The owner can then run:

```sh
CONFIRM_WEBHOOK_STOPPED=true npm run siwc:import -- /PRIVATE/PATH/owner.json
```

The import validates the same strict credential schema, adds a version to `OPENAI_SIWC_SESSION`, then clears only the non-secret refresh recovery marker. It never displays payloads or uploads them through GitHub/Codex/artifacts. `CONFIRM_WEBHOOK_STOPPED` is an explicit operator assertion, not an automatic proof of shutdown. Serverless becomes the sole refresh owner. Do not keep using the copied local profile. For future reauthorization, suspend/drain production again, use local `OPENAI_HOST_ID=<the stable serverless UUID> npm run oauth` (the override supplies that host identity to authorization without replacing the local host file), import the resulting profile, then restore invoker access/webhook. The local file-backed implementation stays available for OAuth and pre-import diagnostics.

## Manual deployment and registration

Use GitHub environment `production`, main-only deployment branches, optional owner approval protection, and these **non-secret** variables:

- `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`: migration output.
- `WORKSPACE_ID`, `TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_USERNAME`: the chosen workspace and one private group; username without `@`. Every human participant is accepted.
- `OPENAI_HOST_ID`: the stable generated host UUID.
- `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`: your previously verified available model and supported effort; no model default is baked in.
- Optional `NOMINATIM_ENDPOINT`: HTTPS origin of a compatible service; defaults to public Nominatim. Review [the usage policy and limits](../docs/geography.md).

The existing secrets/session import and host ID are already verified by the owner. This change does not require a repeat import. There is no Firebase Auth prerequisite.

After code review, the minimal owner sequence is:

1. Choose `WORKSPACE_ID` externally and, in an owner-ADC Cloud Shell checkout of reviewed main, create/verify exactly that workspace:

   ```sh
   npm ci
   npm run workspace:init -- --id "$WORKSPACE_ID"
   ```

   This stores `members: []`, locale `en` and timestamps, performs no Firebase Auth operations, and leaves a compatible existing document unchanged. Conflicting schema/ID/membership/locale fails closed. Empty members denies all client reads; future real Firebase UIDs can be attached when Mom-I-am-OK integration is built.

2. Set the non-secret GitHub production variables listed above. Do not put tokens, SIWC payloads, API keys or env-file contents in GitHub.
3. Manually run **Deploy production** on main; there is no push-triggered deployment.
4. Register the HTTPS webhook with the already-enabled secrets using owner tooling below.
5. Check webhook status.
6. Send one image in the private group. Check the proposal and three actions, correct city through its exact ForceReply, cancel one discovery and confirm another. Verify one canonical confirmed Place with deterministic WGS84 coordinates in Firestore; confirming the same POI again must reuse its Place. This is the “map update”; no external map projection is implemented.

The development agent does not execute any step involving owner credentials or cloud writes. Existing client rules already deny empty membership; the updated rules additionally check list type and are locally emulator-tested. The workflow deploys functions only, preserving its existing scope.

Manually run **Deploy production** on main. Full checks and Gitleaks run before Google authentication. Pinned Firebase CLI 15.32.1 deploys only `functions:places:placesWebhook`; no rules/indexes/hosting deployment is bundled. Compiled application code, vendored compiled workspace packages, tested production dependency lock and MIT license are allowlisted into `.deploy/functions`; Git/credentials/tests/local env files are excluded. Only validated non-secret function parameters are added. `RELEASE.json` records the exact source commit. Cloud Build installs production dependencies; production does not compile TypeScript. GitHub gets short-lived WIF credentials, never secret payloads. No deployment artifact is uploaded to GitHub.

After deployment, take the HTTPS URL from the Firebase deployment/Google Console. Register and verify using owner ADC:

```sh
npm run webhook -- set https://europe-west3-mom-im-ok-places.cloudfunctions.net/placesWebhook
npm run webhook -- status
```

Registration sets `secret_token`, `allowed_updates: ['message', 'callback_query']`, `max_connections: 10`, and preserves pending updates. Use the actual deployed URL if it differs. Status prints only safe URL/count/error-presence metadata, never Telegram error descriptions. Removal for rollback is `npm run webhook -- remove`. Restore a previous reviewed source commit through the same manual deployment workflow; no filesystem release switching remains.

## Processing and recovery guarantees

Every delivery validates POST, JSON type and bounded body size, and checks the constant-time secret header before application parsing. Google/Firebase's HTTP framework may parse the body before user code; the application ignores `req.body` and uses bounded `rawBody` only after authentication. The configured group and human-sender checks precede media/command/callback projection. Conversation, captions, raw updates and bytes are never logged/persisted. Only photos/supported image documents, `/help` / `/area`, safe proposal callbacks and exact owned active city-prompt replies are accepted. Other text replies are discarded before ingress storage.

`workspaces/{workspace}/pendingIngress/{hash}` retains image file IDs, source message ID, first image sender ID for prompt ownership, quiet deadline and lease metadata, not update contents. Albums settle after 1.5 seconds of quiet, with up to ten deduplicated file IDs. Once processing is claimed, membership is sealed; unusually late members are preserved as separate single-image discoveries instead of being silently lost. Duplicates of completed work return 200; busy/failed work returns 503 so Telegram retries. Ingress/image leases expire after 330 seconds, beyond the 300-second handler bound; expired owners are fenced before subsequent writes. Completed discovery IDs are durable idempotency records. External OpenAI requests and Telegram replies cannot be exactly-once: a crash after an external effect may repeat an inference/reply on retry. Telegram retry retention is finite; if deliveries ultimately expire, resend affected images. There is no scheduler/queue sweeping abandoned pending documents; a subsequent delivery/resend drives recovery. Inbox metadata is retained to preserve deduplication; no TTL is configured.

SIWC refresh uses a 120-second Firestore transactional lease, a bounded 25-second acquisition wait and 20-second token exchange. Latest session is reread after acquisition; the non-secret lease record retains the exact successfully saved Secret Manager version name, and subsequent reads use that immutable version to avoid `latest` alias propagation races (initial state falls back to `latest`); valid tokens avoid refresh. Successful replacement tokens are saved as a new secret version. Known temporary HTTP failures preserve the previous version and release ownership. Terminal invalid grants, missing rotating replacements, uncertain network outcomes, crashes during refresh or failed durable writes block further refresh with a safe reauthorization diagnostic. This conservative marker prevents replaying a possibly consumed token after lease expiry. Owner suspension/drain/import clears it. Access tokens last roughly an hour; refresh tokens have a rolling roughly 30-day lifetime, so long idle periods can require local reauthorization. No always-on refresh scheduler is added.

Model selection is validated once per cold instance before its first image inference, with failed validation retried on later deliveries; no catalog query occurs per successful image batch. Auth/model/config/schema/programming failures remain visible through fixed diagnostics and never activate Gemini. The geographic/confirmation implementation is exercised only with fixtures and local emulators. No live Gemini activation, hosted search, public geocoding, Telegram sends or deployment were tested by the agent. Chains/branches and replaceable external map/export adapters remain future work; no custom mobile/cartographic application is planned.

References rechecked 2026-10-05: [Functions scaling/runtime](https://firebase.google.com/docs/functions/manage-functions), [Functions deployment IAM](https://cloud.google.com/functions/docs/reference/iam/roles), [Google GitHub auth / ADC](https://github.com/google-github-actions/auth), [Secret Manager IAM](https://cloud.google.com/secret-manager/docs/access-control), [version consistency](https://cloud.google.com/secret-manager/docs/consistency), [Telegram webhook](https://core.telegram.org/bots/api#setwebhook), [OpenAI sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions). The existing [Mom-I-am-OK backend workflow](https://github.com/dd64ru/Mom-I-am-OK/blob/main/.github/workflows/release-production-backend.yml) informed manual WIF/ADC deployment; its legacy text logging/webhook handling was not copied.

## Development verification and known limits

Run `npm run check` for formatting, TypeScript, mocked protocol/workflow tests and static infrastructure checks. `npm run test:rules` additionally runs local demo-project Firestore rules and real transaction race tests with Java 21; it creates synthetic emulator data only. CI runs both. `npm audit --omit=dev` currently reports six moderate Google Cloud SDK-chain findings, zero high/critical. The underlying uuid advisory concerns v3/v5/v6 with caller-supplied buffers; reviewed installed Google transports use v4. No forced major SDK upgrade or unrelated dependency churn was performed. These remain production audit findings, not dev-only findings.

Use the existing full-history `bash scripts/check-secrets.sh`. Standalone production packaging is validated locally with `packageFunctions` before committing (public compiled source/vendor packages/lock/LICENSE only) and a production-only install/import. The CLI entry requires a clean checkout and records HEAD; the exported function permits a local pre-commit staging validation. Never commit generated `.deploy` env files.

Hosted search may be disabled for the selected SIWC model/account. A tool/options HTTP 400 yields no web evidence; deterministic lookup may still use one high-confidence vision clue with a vision locality or explicit correction. A workspace hint alone cannot authorize a geographic candidate. Auth and other failures remain fail-closed. Nominatim name/locality matching is conservative; missing/ambiguous locality may ask for city; known-locality venue absence, ambiguous branches, unsupported feature categories and explicit-city conflicts stay unresolved with manual Change city / Cancel. English language preference, bounded cited locality aliases and ISO country checks support China without accepting a different city just because names match. A single request has bounded time/body/client search-count but no supported SIWC output-token billing cap. External Telegram sends can repeat/orphan after a crash before their message ID is committed; stale tokens cannot change canonical state. See [Telegram recovery](../docs/telegram.md) and [provider limits](../docs/geography.md).

## Google Places owner preparation

[Google Places API (New)](../docs/google-places.md) is now the primary deterministic POI resolver, with Nominatim fallback. The function uses the attached runtime service account via ADC, requested Text Search OAuth scope and short-lived Bearer tokens, plus `X-Goog-User-Project`. No new Secret Manager secret, API key, service-account key file, GitHub variable or credential import is required.

Owner-run migration apply pre-enables `places.googleapis.com`, creates/reuses custom `placesApiConsumer` with only `serviceusage.services.use`, and binds it to `places-runtime` on the quota project. Plan remains read-only and reports `placesApiConsumerAction: prepare/reuse`. Existing custom-role mismatches/deleted roles, conditional Places quota grants and unexpected runtime roles fail closed. Existing datastore, secret, deploy/build/App Engine and WIF grants are preserved. Deploy CI is not allowed to enable APIs. After review, the owner runs plan/apply/plan, checks `placesApiConsumerAction: reuse`, reviews Places billing/quotas and manually deploys the reviewed commit. No live Places request, credential creation, migration apply, deployment or webhook change is performed by the development task.

## Private production placesFeed

The [production feed runbook](places-feed.md) defines owner-only digest setup, secret-specific runtime access, rotation, read-only smoke and label backfill plan. [API v1](../docs/map-projection.md) is the stable GeoJSON service-to-service contract for the future Mom-I-am-OK backend; completeness headers protect complete cached snapshots from partial refreshes. GPX/KML remain exports. The service token never belongs in browser/Android clients.

The manually triggered `deploy-feed.yml` uses the production Environment/WIF and deploys only `functions:places:placesFeed`. Production packaging and parameter discovery use separate webhook/feed entrypoints; the existing webhook deployment stays scoped to `placesWebhook` and does not own/reconfigure feed enablement. Neither workflow changes rules/indexes, creates credentials, grants IAM or enables APIs. Feed enablement stays an explicit owner action; no live setup/deployment/backfill is performed by development.
