# Channel-neutral Saved Places discovery

Saved Places remains one server-configured shared workspace. Telegram and
Mom-I-am-OK AI Chat are input adapters to the same DiscoveryService and
FirestoreRepository. Neither adapter writes Trip data. The private `placesService`
function is independent of the read-only `placesFeed`; feed tokens never authorize
writes and are not bound to the new function.

## Authentication and packaging

`placesService` is Functions v2 in europe-west3, `invoker: private`, disabled by
`PLACES_SERVICE_ENABLED=false` by default. Cloud Run checks the audience-bound
Google OIDC token and IAM invoker permission before executing the handler. The
owner must grant `roles/run.invoker` on this function's underlying service ONLY to
the Mom-I-am-OK backend runtime service account. Do not grant allUsers or
allAuthenticatedUsers. Workspace comes from WORKSPACE_ID, not a payload.
The browser uses an authenticated Mom-I-am-OK callable, never this endpoint or
an IAM credential. There is no admin-only restriction in the new application callable.

Owner deployment preparation (NOT executed in this change): package with
`npm run deploy:package -- --output <empty-directory> --target service` from a
clean reviewed checkout; configure WORKSPACE_ID, OPENAI_MODEL,
OPENAI_REASONING_EFFORT and OPENAI_HOST_ID; review existing Places runtime
provider/SIWC access, provision the private invoker binding, deploy this target
separately, then enable PLACES_SERVICE_ENABLED. The webhook/feed deploy workflows
remain separate. No production IAM, secrets, backfill or deployment was changed.

## POST contract

JSON body at most 32 KiB; strict fields; IDs 1..128 safe ASCII characters.
All failures use fixed diagnostics; conflict is HTTP 409, dependency failure 503.
No raw request/provider response/address/coordinate/credential is logged.

- `prepare`: `{action, requestId, identities:[{placeId,label,city?}]}` OR
  `{action, requestId, recognition}`. At most eight Google IDs or three
  single-venue/scene clues. Labels must be independent application/user data.
  Mom-I-am-OK uses application-owned `Saved place N` when there is no independent
  label. Grounded IDs refresh directly through Google Places; no model rediscovery.
  Structured clues use the existing bounded Discovery resolver. Coordinates and
  provider display content never become durable Google candidates or labels.
- `review`: `{action, discoveryId}` refreshes display-only candidates with
  index/name/Maps link/confidence. These responses must not be durably cached.
- `confirm`: `{action, discoveryId, revision, requestId, indices}` (1..8 unique
  bounded indices). Provider reads validate selected candidates. The existing
  `finishDiscovery` transaction consumes the selection, fences revision, creates
  or reuses canonical provider IDs and records all confirmedPlaceIds atomically.
- `cancel`: `{action, discoveryId, revision, requestId}` retires pending discovery
  through the same completion transaction. It creates no Places.

Prepare derives a Discovery ID from the request ID and persists an input digest;
changed payloads under the same key conflict. Confirm/cancel persist a completion
receipt (request ID, selection, counts), so retries return the same result even
after an ambiguous network outcome. Changed selections/terminal races/stale
revisions fail. Pending service discoveries expire for confirmation after 24h.
Different Google Place IDs remain distinct even with equal labels or branches.

## Exact venue versus scene/viewpoint

Recognition's optional `scene_viewpoint` mode contains bounded visible landmark
context, known city, optional country and a fixed foreground class. Its clues
name possible camera locations; landmarks are not camera candidates. Old
single-venue/recommendation contracts still parse. Empty ordinary images still
stop at no_place_evidence. A scene with locality/landmark context can run exactly
one optional web enrichment (at most two searches) and the bounded Google phase
(at most two queries). No OCR free-for-all, proximity winner or invented pins.
Hard geography contradictions remain exclusions. All scene results are low
confidence with `viewpoint_hypothesis`; multiple results use existing alternatives,
checkboxes and atomic multi-confirmation. Telegram explicitly says the exact
camera point is unproven. With no deterministic candidate the result is unresolved.
A scene without an independent label uses application-owned `Viewpoint hypothesis`.

## Locality identity

`mapMetadata.city` remains independent display text and its user/recognition
provenance. `mapMetadata.locality={key,source}` is separate: `google-locality:`
plus SHA-256 of the deterministic Google locality Place ID, source
`google-places-locality`. No LLM-supplied identity or translation table is accepted.
The resolver reads the venue's structured city/country/region, then performs one
bounded locality lookup using the display input plus that geography. It requires
a unique locality row matching the venue city and country/region, with no next
page; missing geography, multiple same-name rows or mismatches yield no key.
Same city scripts can resolve to the same provider ID; homonyms cannot merge
merely because country+name matches. Optional reads are bounded by eight candidates
(two reads each) and fail safely without blocking review.

The projection/feed adds optional cityKey. Old records remain valid. Google
coordinates still refresh and undergo mainland alignment correction exactly once
in ProjectionService; locality identity does not alter coordinates. The application
chooses a deterministic display spelling independently from the identity key.
Legacy textual groups remain separate from proven locality groups.

`node scripts/plan-localities.mjs --input <local-place-export.json> --quota-project
<project>` emits a PLAN ONLY with Place IDs, original updatedAt fences and proposed
locality identities. It has no Firestore client or apply mode. It performs bounded
provider reads only when an owner deliberately invokes it. Nothing was run against
production. Applying reviewed plans to legacy Places requires a later authorized
migration with stale fencing; ambiguous results must stay unchanged.
