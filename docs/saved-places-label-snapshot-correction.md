# Saved Places labels and current snapshots

The 2026-10-08 Telegram incident supplied `confirmedCount=7`, `reusedCount=0`; the feed subsequently reported total 12, projected/hydrated 6, missingLabels 6, and zero provider failures, invalid records or budget skips. Saving and projection are separate stages. The exact omission was the projection's pre-hydration `if (!label) continue`: six valid Google identities never reached coordinate hydration because their optional application labels were absent. A successful save did not prove successful projection.

The App had a separate presentation defect: `decideSnapshotUpdate` kept **and displayed** an old complete body instead of the successfully received partial response. Thus manual refresh could fetch six points while still displaying five old points.

The Finder correction prioritizes existing valid application/user labels. New human-confirmed Places can derive an independently recognized native venue name, or an explicitly recognized shared brand for related branches. Multiple branches may have the same legitimate name because their Google identities, canonical hashes and hydrated positions remain distinct. A branch-specific photographed name is never assigned to another branch without shared-brand evidence. Existing labels win on canonical reuse. For existing unlabeled Google documents the feed supplies neutral `Saved location` text only in the transient projection. Google displayName, formatted address, types and other display fields are neither promoted into labels nor persisted. No schema makes Google labels mandatory.

The existing six documents need no migration, backfill, resave or deletion. After the corrected code is deployed, ordinary authenticated feed projection can hydrate their existing Google identities and display them with the neutral fallback. Provider hydration must still succeed; failure, malformed coordinates/identity or exhausted budget remains a genuine omission and produces a partial snapshot. Optional absent names are no longer counted as unprojectable locations. Google coordinate correction, source restrictions and feed v1 remain unchanged.

Online, every valid current response is shown, including 6/12 with an explicit partial indicator. Offline storage keeps the old complete body, or a partial body when the incoming partial omits one of its IDs. Only whole upstream bodies are stored or displayed, with their own ETags and validation times; no union or artificial deletion is synthesized. Offline prefers the retained stored body. The incoming online body's validation cannot renew omitted offline coordinates. A later complete 12/12 replaces both. A valid 304 still validates the exact cached ETag/body and takes fresh aggregates. Auth generations, account/logout fences, 30-day expiration and the existing mutation/reconnect synchronization controller remain in place.

Telegram's already-saved notice now requires active `confirmed` status. An explicit new confirmation of an archived canonical identity restores that record to confirmed without duplicating it or replacing its owned label. An idempotent retry of an earlier completed discovery remains unchanged.

## Changed files

App:

- `src/lib/placesMap/snapshotPolicy.ts`: current online presentation; conservative whole-body offline replacement; connectivity selector.
- `src/lib/placesMap/placesMapController.ts`: documentation of display validation time.
- `src/context/PlacesMapContext.tsx`: offline selection, partial/offline-copy notice, validation time for the shown body.
- `test/places-map-client.test.ts`, `test/places-map-refresh-semantics.test.ts`, `test/places-map-retention.test.ts`: updated omission expectations plus 5/5 → 6/12 → 12/12 and missing-ID cache regression.
- `test/e2e/places-map-background-sync.spec.ts`: real provider/UI manual-refresh/offline/reconnect regression with mocked callable responses and local emulators.
- `docs/places-map-pilot.md`, this report, `app-version.json`.

Finder:

- `packages/core/src/projection.ts`: neutral projection-time fallback, no write port.
- `packages/schemas/src/index.ts`: native name preference and independently recognized shared-brand labels, optional Google durable label unchanged.
- `packages/providers/src/firestore.ts`: shared-brand confirmation labels and explicit archived identity reactivation.
- `packages/core/src/service-api.ts`: same independent label rule for transient review responses.
- `apps/functions/src/interactions.ts`: active-status canonical saved check.
- `tests/saved-places-label-projection.test.mjs`, `tests/projection.test.mjs`, `tests/saved-places-service.test.mjs`: seven real Telegram selections/confirmation, canonical reuse/idempotency, shared native name/distinct positions, unlabeled fallback, provider failure, no durable transient content, v1/ETag completeness.
- `docs/map-projection.md`.

## Focused verification

Deterministic Finder checks cover the new label/projection regressions and nearby projection/feed, Saved Places service, canonical confirmation/Telegram workflow, chain resolution, metadata, earlier singleton/alias correction, coordinate semantics and standalone feed/service packaging. Provider transports are local doubles. App checks cover map controller/policy, global synchronization, Auth isolation, retention/offline storage, Saved Places lifecycle, cross-repository discovery/confirmation, private feed proxy, version gates and frontend types/build. Only the map background-sync browser spec runs, inside local emulators with mocked feed responses. Existing source/test files retain their established legacy style; changed modern files/docs pass targeted Prettier and all staged files pass whitespace/secret checks.

No acceptance campaign, live provider request, production read/write, backfill, merge or deployment was performed. This is a verified code correction, not a claim that the production records have already appeared. The broader earlier incident's real alias identity and original spinner remain unverified as documented in `saved-places-corrective-pass.md`.
