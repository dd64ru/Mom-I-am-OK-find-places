# Mom I'm OK — Places

Private shared place discovery from images. Telegram is the first input; Firestore owns shared data. Future replaceable adapters may project/export canonical Places into existing third-party mapping products. The map client is not selected. The core is independent of country, input channel, AI vendor and map client.

## Local setup

Node.js 22.9+ and npm are required. No credentials are needed for installation, compilation or smoke tests:

```sh
npm ci
npm run check
```

`check` runs Prettier, TypeScript checking, builds, fixture/mocked workflow tests and infrastructure static checks. There is no separate linter. Tests use fixtures and fake transports, not production services.

Operational commands `oauth`, `models`, `vision:smoke` and `telegram:ids` automatically build current TypeScript. They are owner-only local/Cloud Shell setup tools; Node 22 is used by production. Copy `.env.example` privately and reuse the owner's already-authorized profile for pre-import diagnostics. Never provide real credentials to Codex or CI.

Production is now an authenticated **Firebase Functions v2 Telegram webhook** in `europe-west3`, with zero minimum instances. SIWC is stored/rotated explicitly through Secret Manager with a Firestore cross-instance lease. See [migration, deployment and owner setup](infra/README.md). No cloud writes or deployment are performed by development checks. The owner initializes an empty-members workspace after review; no Firebase Auth prerequisite exists.

## Repository

| Path                 | Responsibility                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/schemas`   | Runtime-validated canonical Place, Chain, Workspace, Discovery and recognition contracts                      |
| `packages/core`      | Discovery workflow and vision/search/POI/persistence ports                                                    |
| `packages/providers` | Firestore, Secret Manager, OpenAI OAuth/Responses, Gemini fallback                                            |
| `apps/worker`        | Local configuration, privacy gate and OAuth/model/vision/ID diagnostics                                       |
| `apps/functions`     | Authenticated HTTPS webhook, durable ingress and serverless composition                                       |
| `infra`              | Firestore client rules, index configuration, serverless migration and IAM/WIF preparation                     |
| `docs`               | Architecture, decisions, authorization, Telegram UX, geographic verification and future projection boundaries |

## What runs today

The webhook accepts images/albums from any human in one configured private group. Vision recognition is followed by bounded SIWC Responses web-search verification and Google Places API (New) deterministic POI resolution with Nominatim fallback. A proposal offers **Добавить / Изменить город / Отмена**. Change city uses an owned, expiring ForceReply and reruns only verification/geocoding. Explicit confirmation transactionally creates/reuses one canonical WGS84 Place in Firestore. This is the current “map update”; branch lookup and external map/export adapters are future work; no custom mobile/cartographic app is planned.

`/help` and `/area <city or region>` are supported. Ordinary conversation, unknown commands and captions are ignored. Opaque callback tokens are mapped to durable interaction records; discovery revisions fence stale actions, while terminal transactions prevent duplicate Places or inconsistent confirm/cancel races. Albums retain Firestore-backed debounce/leases and bounded images. See [Telegram behavior](docs/telegram.md).

Model availability is validated against the signed-in account once per cold instance. Gemini remains opt-in outage-only vision fallback for HTTP 502/503/504. Auth/config/model/schema/programming errors fail closed. Search uses the existing sole durable SIWC refresh owner, never an API key. Coordinates must come from deterministic POI results, never AI. Public Nominatim has strict [usage restrictions](https://operations.osmfoundation.org/policies/nominatim/): this deliberately selected low-volume venue workflow uses a cache, one global in-flight gate, 1.5-second spacing, fifty new requests/day and visible OSM attribution. See [geographic verification and limitations](docs/geography.md).

Telegram-only workspaces legitimately use `members: []`. `npm run workspace:init -- --id "$WORKSPACE_ID"` is an explicit owner-ADC command, idempotent for compatible existing workspaces and refusing conflicts. Empty membership grants no client reads; later real Mom-I-am-OK Firebase UIDs can enable member reads. No fake Firebase users are created.

In addition to `npm run check`, `npm run test:rules` uses a **local demo-project Firestore emulator** (Java 21 required) to exercise client rules and real transaction races. It uses synthetic identities and no live credentials. Production packaging, audit and full-history secret scanning are described in [operations](infra/README.md).

## Existing external infrastructure

The owner reports project `mom-im-ok-places`, europe-west3 Firestore, prepared serverless IAM/WIF and imported Secret Manager SIWC/webhook/bot secrets. Old GCE resources are gone. The owner reports that the production function is deployed and the Telegram webhook is registered; Firebase membership remains a future integration. These are owner-verified facts, not live checks performed by the development agent. Follow the reviewed owner-only setup sequence; existing SIWC import does not need repeating for this code change.

Read [architecture](docs/architecture.md), [decisions](docs/decisions.md), and [next infrastructure setup](infra/README.md).

## License

[MIT](LICENSE).

## Locality and resolution safety

Geographic verification receives distinct `cityOverride` and `workspaceAreaHint` fields. Explicit correction is a hard constraint; conflicting verified locality fails closed. Cited canonical city/locality beats vision clues and workspace hints. A workspace hint alone cannot authorize a same-name branch. Google Places and Nominatim prefer English and match bounded cited native/transliterated locality aliases with an optional ISO country constraint, retaining native venue names.

Missing/ambiguous locality may prompt for city. A known locality with an absent, unsupported or ambiguous POI is `unresolved`, with Change city / Cancel and no automatic city-prompt loop. Temporary provider failures retain webhook retry behavior. See [geography](docs/geography.md) for travel feature classifications and conservative matching limits.

Future boundary: **Firestore canonical Places → replaceable external map/export adapters**, for example GeoJSON/KML/GPX or supported third-party APIs/links. No external integration is implemented. Mom-I-am-OK's existing real users may later be attached to workspace membership.

Google Places uses the attached runtime service account through ADC and short-lived OAuth Bearer tokens, with explicit quota project and a custom `serviceusage.services.use`-only runtime role. No Places API key or new secret is needed. Owner preparation and provider limits are documented in [Google Places](docs/google-places.md). Telegram UI is Russian; fixed stage/status/duration telemetry contains no user/provider content.
