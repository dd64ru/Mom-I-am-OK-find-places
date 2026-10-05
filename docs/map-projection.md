# Read-only map projection and export

Canonical Firestore Places → `ProjectionService` → GeoJSON / GPX / KML. This layer has no map application integration, Google Saved Places mutation, mobile companion or Mom-I-am-OK coupling. `placesFeed` is separate from `placesWebhook`; the existing webhook handler, webhook URL and webhook-only deploy workflow are unchanged. The new feed is disabled by default and has not been deployed.

## Application-owned labels

`Place.label` and `Place.labelSource` (`recognition` / `user`) are an optional atomic pair, so existing unlabeled production documents still parse. Confirmation derives a new label exclusively from independently stored `Discovery.recognition.clues[index].name`. Google matching records an optional bounded `recognitionClueIndex` to identify the original clue, even when Google/web uses a different spelling. The selected label never reads Google displayName, address, city, types or attribution. A single unbound recognition clue can also supply the label; ambiguous multiple unbound clues leave it absent. Existing Place labels, including future user labels, take precedence on deduplicating confirmation. No user label editor is added.

For example, recognition “Happy Harbour” becomes a durable recognition label even when Google calls the venue “OH Bay”. Recognition “Grande Alimentari” stays our label when the provider returns “Alimentari Grande”. The Google Place keeps its stable identity, source/evidence references, label provenance, status/tags/timestamps. It still has no durable Google display/location content. OSM canonical persistence remains intact; unlabeled OSM projections can use their independently licensed canonicalName.

## Owner backfill

Build with Node 22, then plan for the explicitly selected project/workspace:

```sh
npm run build
node scripts/backfill-place-labels.mjs --project <project-id> --workspace <workspace-id> --plan
```

Omitting `--plan` also plans; writes require explicit `--apply`. The utility uses owner ADC, scans only confirmed Places and Discoveries inside that workspace, and performs no Google requests. It derives labels only from confirmed Discoveries associated by `confirmedPlaceId`. Missing recognition, ambiguous unbound clues or conflicting independently derived labels remain unresolved. Existing labels are preserved. Output contains aggregate counts only, never labels, IDs, paths or provider/user content.

An explicitly authorized future apply re-reads each Place and its contributing Discoveries in a transaction, checks the planned Place fingerprint and association/label again, and updates only label, labelSource and updatedAt. Concurrent changes are skipped, user labels are never overwritten, repeated runs are idempotent. Scans exceeding 1,000 Places / 5,000 confirmed Discoveries fail closed before writes; more than 20 contributing Discoveries for one update require separate review and are skipped. This task does not run production plan/apply or mutate Firestore.

## Projection and adapters

`ProjectedPlace` is a separate transient model: stable internal id, application label, WGS84 coordinates, tags, providerIdentity and optional independently sourced category/sourceLink. It is never a canonical Place or Firestore write payload.

OSM uses stored coordinates and existing category/source identity. Google hydration calls the existing bounded ADC-authenticated Place ID refresh. Only the returned matching identity and valid coordinates are consumed. Google displayName, formattedAddress, category/types and attribution are excluded from both the projection and every export. The label remains ours. Missing Google labels are skipped without an API call; backfill supplies those labels independently.

At most 100 confirmed Places are read, with four concurrent refreshes, a maximum ten seconds per refresh and a thirty-second total hydration budget. A failed/timed-out refresh, wrong identity or malformed coordinates skips that feature and increments fixed aggregate diagnostics; successful siblings remain. Expired budget prevents new refreshes. There is no durable coordinate cache. A workspace exceeding the initial 100-place bound receives a fixed feed_limit_exceeded response rather than a silently incomplete export. Secret/read timeouts are five/ten seconds; the function deadline is sixty seconds.

GeoJSON is RFC 7946 FeatureCollection/Point output with `[longitude, latitude]`, stable internal Feature.id, label/tags/provider and optional OSM category/sourceLink. No CRS extension is emitted. GPX 1.1 contains WGS84 waypoints with our label as name. KML 2.2 contains named placemarks and longitude,latitude Points. All three adapters include fixed OpenStreetMap contributor/copyright credit only on OSM features/waypoints/placemarks; this never consumes Google attribution. Both XML adapters escape text and omit invalid XML characters. All formats derive from the same validated objects, sort by stable internal id, and omit generated timestamps so identical projections serialize identically.

Google coordinate hydration remains provider-derived transient content; exports must not be treated as independently owned Google coordinates or an unrestricted reusable Google dataset. A fresh Place ID lookup does not remove [Google Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) or destination restrictions. This task implements the requested restricted coordinate projection; it does not certify arbitrary external retention/redistribution. OSM consumers retain their existing OSM/ODbL obligations and source identity.

## Private HTTPS feed

Future owner-reviewed deployment can expose `placesFeed?format=geojson|gpx|kml`; default format is GeoJSON. GET only; POST/PUT/DELETE/HEAD return 405. Formats use application/geo+json, application/gpx+xml and application/vnd.google-earth.kml+xml with UTF-8. Content-derived SHA-256 ETags support authenticated If-None-Match / 304 (including weak/list validators). Every request hydrates current data before comparison. Cache-Control is private, no-cache, max-age=0, must-revalidate; Referrer-Policy is no-referrer. Errors are fixed safe strings.

The function uses europe-west3, minInstances 0, maxInstances 1, concurrency 2, the existing places-runtime identity and read-only Firestore/provider ports. Admin SDK credentials already have runtime permissions; no new writer port, canonical mutation, IAM change or service-account key is added. Workspace comes from server WORKSPACE_ID only, never a request parameter.

Authentication uses a cryptographically random 32-byte (256-bit) base64url bearer token. Only its lowercase SHA-256 digest belongs in a future Secret Manager secret named PLACES_FEED_TOKEN_SHA256; no plaintext token is stored in Firestore or server configuration. Constant-time comparison checks fixed-size hashes. The latest secret version is read per request so rotation immediately invalidates the old token without waiting for a cold start. No production token/secret or IAM grant is created here. Future owner setup must narrowly allow the runtime identity to read that specific secret, without widening CI IAM.

Authorization: Bearer <token> supports private download tools without placing credentials in URLs. Feed enablement requires PLACES_FEED_ENABLED=true; URL-based consumers separately require PLACES_FEED_URL_TOKENS_ENABLED=true. Both default false. The webhook-only production env generator explicitly writes both flags as false for non-interactive full-codebase analysis, regardless of any ambient GitHub/environment flag values. Future feed enablement requires a separate owner-reviewed deployment configuration rather than overriding this generator. An owner must review those settings, secret access and a separate feed deployment; the existing queued webhook-only deployment remains unchanged.

An optional URL is `?format=geojson&token=<opaque-token>`. Its token is a bearer secret disclosed to any third-party service consuming the URL and potentially browser history, referrers or platform/proxy request logs. Application diagnostics never log request URLs, headers or tokens; platform access logs are outside this code. Before enabling URL mode, the owner must ensure the hosting/proxy logging path omits or redacts query credentials. Use Authorization-based downloads until that is reviewed. Referrer-Policy helps but does not eliminate disclosure to the consuming service. Rotation means creating a new independent random token/digest and retiring old URLs.

## Consumers and diagnostics

Likely consumers include Organic Maps (manual GeoJSON/GPX/KML import where supported by its version), OsmAnd (manual GPX/KML import), uMap/compatible web maps (possible remote GeoJSON URL via their supported fetch/proxy mechanism) and future custom/PWA clients (direct GeoJSON consumption). Import support, CORS/proxy behavior, provider terms and remote URL credential disclosure must be assessed for the chosen client. No client-specific adapter is implemented.

`projection_request` contains fixed format, placesTotal, placesProjected, googleHydrated, providerFailures, missingLabels, invalidPlaces, budgetSkipped and truncated. No labels, coordinates, Place IDs, source URLs, feed tokens, headers, raw provider/errors or user content are logged. Provider refresh errors are isolated; application diagnostics remain aggregate-only. Tests exercise the standalone feed, all formats, independent labels/backfill, refresh isolation/timeouts/concurrency, ETags/authentication and absence of canonical writes with credential-free mocks.
