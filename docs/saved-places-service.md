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

Owner rollout preparation and the dormant-first deployment, service-scoped IAM,
enablement, App release and rollback sequence are documented in
[the production rollout runbook](places-service-rollout.md). The manual service
workflow is separate from webhook/feed; no production actions occur merely by
merging this preparation.

## POST contract

JSON body at most 32 KiB; strict fields; IDs 1..128 safe ASCII characters.
All failures use fixed diagnostics; conflict is HTTP 409, dependency failure 503.
No raw request/provider response/address/coordinate/credential is logged.

- `prepare`: `{action, requestId, identities:[{placeId,label?,category?,city?}]}` OR
  `{action, requestId, recognition}`. At most eight Google IDs or three
  single-venue/scene clues. Labels must be independent application/user data.
  A label/category/city may come from an independently derived clue uniquely
  bound by existing grounded server state; array order never establishes identity.
  Otherwise review requires a bounded human label before confirmation. Provider
  display names remain transient and are never automatically used as labels. Grounded IDs refresh directly through Google Places; no model rediscovery.
  Structured clues use the existing bounded Discovery resolver. Coordinates and
  provider display content never become durable Google candidates or labels.
- `review`: `{action, discoveryId}` refreshes display-only candidates with
  index/name/Maps link/confidence. These responses must not be durably cached.
- `confirm`: `{action, discoveryId, revision, requestId, indices, labels?}` (1..8 unique
  bounded indices). Provider reads validate selected candidates. The existing
  `finishDiscovery` transaction consumes the selection, fences revision, creates
  or reuses canonical provider IDs and records all confirmedPlaceIds atomically.
- `cancel`: `{action, discoveryId, revision, requestId}` retires pending discovery
  through the same completion transaction. It creates no Places.

Prepare derives a Discovery ID from the request ID and persists an input digest;
changed payloads under the same key conflict. Confirm/cancel persist a completion
receipt (request ID, selection, human labels, counts), so retries return the same result even
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
Empty-clue scenes can retain bounded, cited, independent web hypotheses as
Recognition clues before deterministic matching associates candidate indices.
These meaningful labels retain recognition provenance. No generic label fallback
exists: an unbound service candidate needs a human label (`labelSource=user`);
Telegram refuses an unlabeled confirmation and asks for independent names.
The same atomic confirmation validates labels (1..300 characters, no control
characters or generic placeholders) and preserves an existing canonical label.
Human label indices must be selected candidates; no Place IDs or coordinates
are accepted in the label step. The completion receipt fences changed labels.

## Locality identity

`mapMetadata.city` remains independent display text and its user/recognition
provenance. `mapMetadata.locality={key,source}` is separate: `google-locality:`
plus SHA-256 of the deterministic Google locality Place ID, source
`google-places-locality`. No LLM-supplied identity or translation table is accepted.
The resolver independently reads English structured venue city/country/region,
resolves the supplied application city with an exact provider-returned spelling,
and separately resolves the structured venue city. Both locality searches are
bounded, unique, and must return the same stable provider Place ID. The structured
lookup proves country/region; the supplied lookup additionally requires country
and a direct localized name match. A script-based language preference requests
provider evidence only: it never creates translations or aliases. Missing city,
ambiguous/partial results, next pages, different IDs or wrong geography omit the
key. A search ranking that merely returns the venue city cannot prove a different
input city. Optional reads are bounded by eight candidates (three reads each),
and failure safely omits identity. A reused Place with a different existing
display city does not inherit a key proven only for the incoming city.

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
