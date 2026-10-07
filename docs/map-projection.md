# Read-only map projection and export

Canonical Firestore Places → `ProjectionService` → GeoJSON / GPX / KML. This is the sole read-only Places Finder data source for the future Mom-I-am-OK backend and Map/Organic Maps clients; client implementation stays outside this repository. `placesFeed` is separate from `placesWebhook`; the existing webhook handler, webhook URL and webhook-only deploy workflow are unchanged. The new feed is disabled by default and has not been deployed.

## Application-owned labels

`Place.label` and `Place.labelSource` (`recognition` / `user`) are an optional atomic pair, so existing unlabeled production documents still parse. Confirmation derives a new label exclusively from independently stored `Discovery.recognition.clues[index].name`. Google matching records an optional bounded `recognitionClueIndex` to identify the original clue, even when Google/web uses a different spelling. The selected label never reads Google displayName, address, city, types or attribution. A single unbound recognition clue can also supply the label; ambiguous multiple unbound clues leave it absent. Existing Place labels, including future user labels, take precedence on deduplicating confirmation. No user label editor is added.

For example, recognition “Happy Harbour” becomes a durable recognition label even when Google calls the venue “OH Bay”. Recognition “Grande Alimentari” stays our label when the provider returns “Alimentari Grande”. The Google Place keeps its stable identity, source/evidence references, label provenance, status/tags/timestamps. It still has no durable Google display/location content. OSM canonical persistence remains intact; unlabeled OSM projections can use their independently licensed canonicalName.

## Application-owned map metadata

A Google Place may carry an optional strict `mapMetadata` object so map clients can group and describe points without any Google display content:

```json
{
  "mapMetadata": {
    "city": { "value": "Shanghai", "source": "user" },
    "category": { "value": "restaurant", "source": "recognition" }
  }
}
```

Both fields are optional (the object, when present, holds at least one), single-line, trimmed, bounded (city 200, category 100 characters) and carry an explicit provenance enum. Neither enum contains a provider value. Derivation (`mapMetadataFor`, used by confirmation and the backfill):

- **city**: `Discovery.cityOverride`, the city the user typed (`user`), first whenever it exists. Otherwise the bound clue's dedicated Recognition `cityHint` (`recognition`, `recognitionCity()`). The Vision contract defines `cityHint` as the city or municipality only (never a district, borough, neighbourhood, province, state, country or landmark), omitted whenever the city cannot be determined confidently; `areaHint` keeps its broader search-locality meaning and is **never** a map city. The `cityHint` is used only when the clue is bound deterministically (its `recognitionClueIndex`, or the only clue), its confidence is at least `RECOGNITION_LOCALITY_MIN_CONFIDENCE` (0.85, the same threshold `selectLocality` uses for a vision locality), it is one single-line city rather than alternatives (`;`, `/`, `|`, "or"/"или"/"或"), and in a single-venue Recognition no other confident clue names a different `cityHint` (a recommendation list's clues are different venues, so each keeps its own hint). The hint is stored as written. Only for the photographed venue itself; a related branch/chain location never inherits it. Candidate address/city, Google formattedAddress, address components, district and Verification are never read: the durable Google stored candidate does not even contain them. No city is inferred from the Google response; without an independent city the field is omitted. Recognition documents written before `cityHint` existed keep parsing and simply give no Recognition city.
- **category**: the bound Recognition clue's own `category` (`recognition`), never Google types. A related branch of the same deterministically bound clue may inherit it because it describes the same brand.
- **binding**: the same rule as labels (`recognitionClue`): the candidate's `recognitionClueIndex`, or the only clue of a single-clue Recognition. Several unbound clues are ambiguous and give no clue-derived value.

New confirmed Google Places persist the metadata when derivable. When confirmation resolves to an already stored Google Place, the same derivation fills only the fields that Place does not have yet, inside the confirmation transaction (`fillMissingMapMetadata()`; the update writes only `mapMetadata` and `updatedAt`). An existing city or category is never overwritten, whatever its source, and the label, provider identity, references, tags and status are not touched because a Place was reused; with nothing missing the Place is not written. Existing documents without the field keep parsing. OSM Places keep their independently licensed `address`/`category` and have no `mapMetadata`.

### Map metadata backfill

`scripts/backfill-place-map-metadata.mjs` (same arguments as the label backfill; `--plan` is the default, writes need `--apply`) derives only missing fields from persisted confirmed Discoveries through the shared `confirmedAssociations` rule, so city comes only from `cityOverride` or a bound `cityHint`; a historical `areaHint` is never promoted into a city. Per field, the strongest source present (`user` before `recognition`) must agree on exactly one value; otherwise the field is counted as a conflict and skipped. Existing values are never replaced. Apply re-reads the Place and its contributing Discoveries in a transaction, checks the Place fingerprint and the re-derived additions, and writes only `mapMetadata` (existing fields win) and `updatedAt`. No Google request, aggregate counts only. It has not been run against production.

## Owner backfill

Build with Node 22, then plan for the explicitly selected project/workspace:

```sh
npm run build
node scripts/backfill-place-labels.mjs --project <project-id> --workspace <workspace-id> --plan
```

Omitting `--plan` also plans; writes require explicit `--apply`. The utility uses owner ADC, scans only confirmed Places and Discoveries inside that workspace, and performs no Google requests. It derives labels only from confirmed Discoveries associated by current `confirmedPlaceIds` or legacy `confirmedPlaceId`. Multi-confirmation binds each Google identity to one unique candidate and its original recognition clue, regardless of candidate/Place-ID ordering. Related branches/chain locations, duplicate identity entries and unassociated Places never inherit a photographed-venue label. Missing recognition, ambiguous unbound clues or conflicting independently derived labels remain unresolved. Existing labels are preserved. Output contains aggregate counts only, never labels, IDs, paths or provider/user content.

An explicitly authorized future apply re-reads each Place and its contributing Discoveries in a transaction, checks the planned Place fingerprint and association/label again, and updates only label, labelSource and updatedAt. Concurrent changes are skipped, user labels are never overwritten, repeated runs are idempotent. Scans exceeding 1,000 Places / 5,000 confirmed Discoveries fail closed before writes; more than 20 contributing Discoveries for one update require separate review and are skipped. This task does not run production plan/apply or mutate Firestore.

## Projection and adapters

`ProjectedPlace` is a separate transient model: stable internal id, application label, coordinates with their `coordinateSystem`, tags, providerIdentity and optional independently sourced category/city/address/sourceLink. It is never a canonical Place or Firestore write payload. Its schema refuses an `address` on a Google feature.

OSM uses stored coordinates, existing category/source identity, its stored `address.city` and `address.formatted`. Google hydration calls the existing bounded ADC-authenticated Place ID refresh. Only the returned matching identity and valid coordinates are consumed; a Google feature's city/category come only from its application-owned `mapMetadata`. Google displayName, formattedAddress, address components, category/types and attribution are excluded from both the projection and every export. The label remains ours. Missing Google labels are skipped without an API call; backfill supplies those labels independently.

At most 100 confirmed Places are read, with four concurrent refreshes, a maximum ten seconds per refresh and a thirty-second total hydration budget. A failed/timed-out refresh, wrong identity or malformed coordinates skips that feature and increments fixed aggregate diagnostics; successful siblings remain. Expired budget prevents new refreshes. There is no durable coordinate cache. A workspace exceeding the initial 100-place bound receives a fixed feed_limit_exceeded response rather than a silently incomplete export. Secret/read timeouts are five/ten seconds; the function deadline is sixty seconds.

GeoJSON is RFC 7946 FeatureCollection/Point output with `[longitude, latitude]`, stable internal Feature.id, label/tags/provider/coordinateSystem and the optional properties below. No CRS extension is emitted; instead each feature names the reference system of its own coordinates (below), because Google-backed coordinates in mainland China are GCJ-02, not the WGS84 RFC 7946 assumes. GPX 1.1 contains waypoints with our label as name (same coordinates, no adaptation: a GPX/KML consumer that needs WGS84 sees the GCJ-02 offset on Google points in mainland China). KML 2.2 contains named placemarks and longitude,latitude Points. All three adapters include fixed OpenStreetMap contributor/copyright credit only on OSM features/waypoints/placemarks; this never consumes Google attribution. Both XML adapters escape text and omit invalid XML characters. All formats derive from the same validated objects, sort by stable internal id, and omit generated timestamps so identical projections serialize identically.

Google coordinate hydration remains provider-derived transient content; exports must not be treated as independently owned Google coordinates or an unrestricted reusable Google dataset. A fresh Place ID lookup does not remove [Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) or destination restrictions. This task implements the requested restricted coordinate projection; it does not certify arbitrary external retention/redistribution. OSM consumers retain their existing OSM/ODbL obligations and source identity.

## Stable feed API v1

The primary application request is `GET /placesFeed?format=geojson` with `Authorization: Bearer <service token>`. The default format is GeoJSON. GPX and KML remain manual/export alternatives from the same projection (`format=gpx|kml`); there is no second map dataset.

Successful 200/304 responses include `X-Places-Feed-Version: 1`. A GeoJSON 200 has `Content-Type: application/geo+json; charset=utf-8` and an RFC 7946 `FeatureCollection`. Each feature has:

| Field                         | v1 contract                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                        | `Feature`                                                                                                                                                                                                                                                                                                                                                      |
| `id`                          | Stable internal canonical Place ID, unique within the snapshot; never the Google Place ID                                                                                                                                                                                                                                                                      |
| `geometry`                    | `Point`, `coordinates: [longitude, latitude]` in `properties.coordinateSystem`; longitude -180..180, latitude -90..90                                                                                                                                                                                                                                          |
| `properties.label`            | Application-owned recognition/user label; OSM may use independently licensed canonicalName                                                                                                                                                                                                                                                                     |
| `properties.tags`             | Array of application tags                                                                                                                                                                                                                                                                                                                                      |
| `properties.provider`         | Enum: `google-places`, `nominatim`, `osm`                                                                                                                                                                                                                                                                                                                      |
| `properties.coordinateSystem` | Additive. Enum: `gcj02` on every Google feature (Google coordinates follow GCJ-02 in mainland China; outside it GCJ-02 applies no offset, so they equal WGS84), `wgs84` on every OSM/Nominatim feature. Coordinate semantics only, not provider display content. Coordinates are never converted here; a consumer adapts them at its own external-map boundary |
| `properties.city`             | Optional. Google: only `mapMetadata.city`. OSM/Nominatim: its stored independently licensed city                                                                                                                                                                                                                                                               |
| `properties.category`         | Optional. Google: only `mapMetadata.category`. OSM/Nominatim: its stored category                                                                                                                                                                                                                                                                              |
| `properties.address`          | Optional. OSM/Nominatim stored formatted address only. **Always absent on Google features**                                                                                                                                                                                                                                                                    |
| Other optional                | OSM `sourceLink` and fixed `attribution`; absent on Google features                                                                                                                                                                                                                                                                                            |

`city`, `category` and `address` are additive optional fields under the v1 rule below; the feed version stays 1. No Google displayName, formatted address, address components, types/category, attribution payload, query or raw Place ID is exposed. No Telegram data, credentials or additional recognition source text is exposed. Unknown persisted providers and malformed Places are excluded as invalid rather than exported as arbitrary enum values. There is no CRS extension. Features sort by internal ID. ID/label semantics, coordinate order, provider enum and required property types are stable in v1. Additive optional independently sourced fields or new aggregate headers may be introduced without changing version; consumers must ignore unknown fields/headers. Changes to required fields, existing semantics or provider enum require a new version and an explicit consumer migration. Exact ETag values/body bytes are not compatibility promises; source changes may change both.

GET is the only feed method (including HEAD rejection): other methods return 405 with `Allow: GET`. Missing/malformed/incorrect authentication returns 401; unsupported formats/unknown request parameters return 400. Unavailable secret/Firestore or scope mismatch returns fixed 503 `feed_unavailable`. More than 100 confirmed Places or truncation returns hard 503 `feed_limit_exceeded`; this is never a successful capped snapshot. Errors never include provider bodies or user data. No create/update/delete endpoint or canonical write port exists.

### Snapshot completeness and caching

Authenticated 200 **and 304** include these decimal aggregate headers:

| Header                       | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `X-Places-Total`             | Number of confirmed source Places read for this snapshot (maximum 100) |
| `X-Places-Projected`         | Number of represented features                                         |
| `X-Places-Snapshot-Complete` | Literal `true` or `false`                                              |

Complete means total equals projected and providerFailures, missingLabels, invalidPlaces and budgetSkipped are all zero, with no truncation. An empty confirmed dataset is complete. A single refresh failure, missing label, invalid Place or budget skip makes the snapshot incomplete, even though successful siblings are returned. Headers/logs contain aggregates only, never names, IDs or coordinates. Scope mismatches remain hard failures. Error responses have no usable snapshot metadata.

Content-derived SHA-256 ETags support authenticated `If-None-Match` / 304 (weak/list validators supported). Each request reads and hydrates current data before comparison; ETag identifies the body, while completeness describes the current projection attempt. A 304 can therefore carry updated completeness metadata with the same body. `Cache-Control: private, no-cache, max-age=0, must-revalidate`; `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` are set. No permissive browser CORS is added.

Consumer rules:

- Complete 200: safe to replace the cached snapshot, subject to the existing provider retention/licensing policy.
- Incomplete 200: may display live partial data; **MUST NOT automatically replace a previously complete offline snapshot**. Do not interpret omitted points as deletions.
- 304: cached body remains current; inspect returned completeness metadata. Do not promote a cached partial body to complete merely because it received a 304.
- 401, 503 or network failure: retain the cached snapshot.

Completeness is a synchronization safeguard, not a license for indefinite Google coordinate retention. Hydrated Google coordinates remain transient provider content and are never written back to Firestore. Consumer caching must respect the existing Google Places destination/retention restrictions independently of API version/completeness.

## Service-to-service authentication and deployment

`placesFeed` uses europe-west3, minInstances 0, maxInstances 1, concurrency 2, and `places-runtime@mom-im-ok-places.iam.gserviceaccount.com`. Server `WORKSPACE_ID` scopes every read; clients cannot choose a workspace. Authentication retains a cryptographically random 32-byte (256-bit) canonical base64url token and constant-time SHA-256 comparison. Only the lowercase SHA-256 digest is stored in Secret Manager `PLACES_FEED_TOKEN_SHA256`; the runtime reads the latest version on every request. The plaintext belongs only on the future Mom-I-am-OK backend. Browser JavaScript and Android APKs must never hold the service credential; that backend authenticates application users separately and proxies authorized snapshots.

Production URL-token mode remains `PLACES_FEED_URL_TOKENS_ENABLED=false`. Neither workflow creates/rotates credentials, grants IAM or enables APIs. The dedicated manually triggered **Deploy places feed** workflow runs only on main in the production GitHub Environment, using the same pinned Node/actions/WIF conventions and deployment concurrency lock as the webhook workflow. It runs secret scan, complete checks including rules, builds and smoke-imports a standalone production package, then deploys only `functions:places:placesFeed`. It never deploys webhook, Firestore rules/indexes or hosting.

Packaging selects a function-specific entrypoint: webhook (the default) uses `dist/webhook-entry.js`; feed uses `--target feed` and `dist/feed-entry.js`. Firebase analyzes only the selected export and its parameter declarations. The same codebase `places` is retained, with explicit function-only selectors; pinned Firebase CLI 15.32.1 planner regressions verify the sibling function is neither updated nor deleted. Each function receives its own revision's environment. Shared `WORKSPACE_ID` comes from the same production variable, and the non-secret env generator is the single source of profile defaults. Webhook writes dormant feed flags false/false and does not import/own the feed parameters. Feed writes only WORKSPACE_ID and feed flags true/false; bot parameters are not discovered. A later webhook deploy cannot disable a deployed feed, and a feed deploy cannot reconfigure the webhook. Never replace these selectors with an unscoped codebase deploy.

Expected function name: `placesFeed`. Expected URL shape: `https://europe-west3-mom-im-ok-places.cloudfunctions.net/placesFeed` (use the actual URL reported after owner deployment). Setup/rotation, post-deploy smoke and backfill plan are in the [production feed runbook](../infra/places-feed.md). Feed remains dormant until the owner sets up the digest/access and deliberately runs that workflow.

## Future Organic Maps consumer

Telegram Places Finder → canonical Firestore Places → private placesFeed → future Mom-I-am-OK backend → web/Android client → local cached snapshot → Organic Maps Android API.

The future native bridge receives stable internal `Feature.id`, application label, latitude (`coordinates[1]`) and longitude (`coordinates[0]`) and converts these into Organic Maps API points, adapting a `gcj02` coordinate inside mainland China to the WGS84 Organic Maps expects (Mom-I-am-OK `src/lib/maps/externalMapCoordinates.ts`). It must not depend on Google Place IDs or display payloads. Organic Maps owns current GPS position, offline base maps, walking routing and map UI. This repository adds no Organic Maps dependency, Android location permission, user location storage or routing logic. GPX/KML exports remain fallbacks rather than a parallel application-integration source.

`projection_request` contains only fixed format, placesTotal, placesProjected, googleHydrated, providerFailures, missingLabels, invalidPlaces, budgetSkipped and truncated. No request URLs, Authorization headers, labels, coordinates, Place IDs, source URLs, tokens, raw errors/provider bodies or user content are logged. All automated coverage uses local fixtures/emulators, including owner smoke-client transport mocks; the normal suite makes no live feed request.
