# Mom I'm OK — Places

Private shared place discovery from images. Telegram is the first input; Firestore owns shared data. A future Android companion will synchronize confirmed places into installed OsmAnd. The core is independent of country, input channel, AI vendor and map client.

## Local setup

Node.js 22.9+ and npm are required. No credentials are needed for installation, compilation or smoke tests:

```sh
npm ci
npm run check
```

`check` runs Prettier, TypeScript checking, builds, focused smoke tests and infrastructure static checks. There is no separate linter. Tests use fixtures and fake transports, not production services.

Operational commands `oauth`, `models`, `vision:smoke` and `telegram:ids` automatically build current TypeScript. They are owner-only local/Cloud Shell setup tools; Node 22 is used by production. Copy `.env.example` privately and reuse the owner's already-authorized profile for pre-import diagnostics. Never provide real credentials to Codex or CI.

Production is now an authenticated **Firebase Functions v2 Telegram webhook** in `europe-west3`, with zero minimum instances. SIWC is stored/rotated explicitly through Secret Manager with a Firestore cross-instance lease. See [migration, deployment and owner setup](infra/README.md). No cloud cleanup/deployment was performed here and no workspace/member documents are created by this task.

## Repository

| Path                 | Responsibility                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `packages/schemas`   | Runtime-validated canonical Place, Chain, Workspace, Discovery and recognition contracts  |
| `packages/core`      | Discovery workflow and vision/search/POI/persistence ports                                |
| `packages/providers` | Firestore, Secret Manager, OpenAI OAuth/Responses, Gemini fallback                        |
| `apps/worker`        | Local configuration, privacy gate and OAuth/model/vision/ID diagnostics                   |
| `apps/functions`     | Authenticated HTTPS webhook, durable ingress and serverless composition                   |
| `apps/android-sync`  | Companion-app scaffold documentation; no Android build yet                                |
| `infra`              | Firestore client rules, index configuration, serverless migration and IAM/WIF preparation |
| `docs`               | Architecture, decisions, authorization, Telegram UX, Android integration                  |

## What runs today

The configured webhook serves one allowed group, accepts photos and supported image documents from allowed users, groups albums, downloads bounded images, calls OpenAI vision, and writes a **pending discovery** to Firestore. It replies with possible names/confidence. `/help` and `/area <city or region>` are supported. The primary model is validated against the signed-in account catalog once per cold instance before its first inference; unavailable models fail processing with `openai_model_unavailable`. Gemini is an opt-in emergency fallback only for Responses HTTP 502/503/504 service outages, with its actual use recorded. Authentication, permissions, configuration, model, schema, programming, quota and unclassified transport errors fail closed without switching providers. Ordinary conversation and image captions are ignored, never sent to AI, stored or logged. No conversational assistant behavior exists.

Canonical confirmed places and chains have real schemas and repository operations. Recognition alone never creates a geographic point. Search and POI verification ports exist, but no real search/geocoding provider is wired; consequently the adapter currently saves no confirmed places. User confirmation, chain linking, `/find`, `/branches`, `/map`, `/undo`, exports and Android/OsmAnd sync remain future work.

Firestore-backed album debounce, processing leases and completed discovery IDs replace in-memory polling state. Only accepted image IDs/source metadata are persisted; image bytes remain transient. See [Telegram behavior](docs/telegram.md) for retry and late-album limits.

## Existing external infrastructure

Already created by the owner: project `mom-im-ok-places`, Firestore `(default)`, Firebase Authentication with Google enabled, Secret Manager secrets `TELEGRAM_BOT_TOKEN` and `GEMINI_API_KEY`, Blaze billing, and public GitHub repository `dd64ru/Mom-I-am-OK-find-places`. These are supplied facts, not resources provisioned or verified by this implementation. No production deployment, Android registration, secret access or live-service validation was performed by the development agent. The owner subsequently completed real SIWC authorization, model listing and a real vision smoke test outside this environment. The owner subsequently ran the GCE bootstrap and deleted its VM and retained disk. The serverless migration script assesses the remaining resources; this change did not mutate cloud state.

Read [architecture](docs/architecture.md), [decisions](docs/decisions.md), and [next infrastructure setup](infra/README.md).

## License

[MIT](LICENSE).
