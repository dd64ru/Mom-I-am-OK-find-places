# Mom I'm OK — Places

Private shared place discovery from images. Telegram is the first input; Firestore owns shared data. A future Android companion will synchronize confirmed places into installed OsmAnd. The core is independent of country, input channel, AI vendor and map client.

## Local setup

Node.js 22.9+ and npm are required. No credentials are needed for installation, compilation or smoke tests:

```sh
npm ci
npm run check
```

`check` runs Prettier, TypeScript checking, builds, and focused smoke tests. There is no separate linter. Tests use fixtures and fake transports, not production services.

To prepare a real worker:

```sh
cp .env.example .env
npm run build
npm run oauth # first authorization only; reuse an already-authorized protected profile
npm run models
# Fill OPENAI_MODEL from the current catalog; set OPENAI_REASONING_EFFORT independently.
# Worker also needs the workspace/chat/user IDs.
npm run worker
```

Operational commands load an optional local `.env`; on the VM they can use only the inherited runtime environment. OAuth and model listing require only the session settings. The laptop is a temporary setup/diagnostic tool, not the intended permanent runtime. Worker configuration intentionally fails closed when IDs or model selection are absent. Use an available image-capable OpenAI model; no model is hardcoded. Complete OAuth on the computer running the browser. See [OpenAI authorization](docs/openai-siwc.md) for returning accounts and VM transfer.

The owner has already completed SIWC authorization and account-specific model listing. Reuse that protected profile for `npm run vision:smoke -- <image-path>`. `OPENAI_MODEL` selects an available account model; `OPENAI_REASONING_EFFORT` independently selects reasoning depth (default `low` only when unset). No permanent model recommendation is coded. `npm run telegram:ids` discovers group/member IDs without starting the worker. See [diagnostics and prerequisites](docs/diagnostics.md) for both commands; neither needs a Firestore workspace.

Before starting the worker, provision `workspaces/{WORKSPACE_ID}` with the schema described in [infrastructure](infra/README.md), obtain the two users' Firebase Auth UIDs, and arrange Application Default Credentials (ADC) with Firestore and per-secret access. The environment used to build this foundation had no secret values or Google credentials. Default secret source is Secret Manager; `SECRET_SOURCE=env` is an explicit local alternative. Never commit `.env`, credentials or session files.

## Repository

| Path                 | Responsibility                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `packages/schemas`   | Runtime-validated canonical Place, Chain, Workspace, Discovery and recognition contracts |
| `packages/core`      | Discovery workflow and vision/search/POI/persistence ports                               |
| `packages/providers` | Firestore, Secret Manager, OpenAI OAuth/Responses, Gemini fallback                       |
| `apps/worker`        | Central configuration, narrow Telegram adapter, OAuth/model/vision/ID diagnostics        |
| `apps/android-sync`  | Companion-app scaffold documentation; no Android build yet                               |
| `infra`              | Firestore client rules, index configuration, service template and IAM/WIF preparation    |
| `docs`               | Architecture, decisions, authorization, Telegram UX, Android integration                 |

## What runs today

The configured worker long-polls one allowed group, accepts photos and supported image documents from allowed users, groups albums, downloads bounded images, calls OpenAI vision, and writes a **pending discovery** to Firestore. It replies with possible names/confidence. `/help` and `/area <city or region>` are supported. The primary model is validated against the signed-in account catalog once at worker startup; unavailable models fail startup with `openai_model_unavailable`. Gemini is an opt-in emergency fallback only for Responses HTTP 502/503/504 service outages, with its actual use recorded. Authentication, permissions, configuration, model, schema, programming, quota and unclassified transport errors fail closed without switching providers. Ordinary conversation and image captions are ignored, never sent to AI, stored or logged. No conversational assistant behavior exists.

Canonical confirmed places and chains have real schemas and repository operations. Recognition alone never creates a geographic point. Search and POI verification ports exist, but no real search/geocoding provider is wired; consequently the worker currently saves no confirmed places. User confirmation, chain linking, `/find`, `/branches`, `/map`, `/undo`, exports and Android/OsmAnd sync remain future work.

The album buffer and work queue are bounded in-memory structures for a single VM worker. They are not crash-durable. A crash can lose an acknowledged album; resend it. Completed discoveries are idempotent by Telegram source. See [Telegram behavior](docs/telegram.md) for limits.

## Existing external infrastructure

Already created by the owner: project `mom-im-ok-places`, Firestore `(default)`, Firebase Authentication with Google enabled, Secret Manager secrets `TELEGRAM_BOT_TOKEN` and `GEMINI_API_KEY`, Blaze billing, and public GitHub repository `dd64ru/Mom-I-am-OK-find-places`. These are supplied facts, not resources provisioned or verified by this implementation. No production deployment, Android registration, secret access or live-service validation was performed by the development agent. The owner subsequently completed real SIWC authorization and model listing outside this environment.

Read [architecture](docs/architecture.md), [decisions](docs/decisions.md), and [next infrastructure setup](infra/README.md).

## License

[MIT](LICENSE).
