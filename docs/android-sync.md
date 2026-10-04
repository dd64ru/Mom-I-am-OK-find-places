# Android → installed OsmAnd

Official sources inspected 2026-10-04:

- [OsmAnd Android AIDL API and SDK overview](https://osmand.net/docs/technical/osmand-api-sdk/)
- [Official API sample](https://github.com/osmandapp/osmand-api-demo/tree/master/OsmAnd-api-sample)
- [Published AIDL interface](https://github.com/osmandapp/OsmAnd/blob/master/OsmAnd/src/net/osmand/aidl/IOsmAndAidlInterface.aidl)
- [Official supported intents](https://osmand.net/docs/technical/algorithms/osmand-intents)
- [Firebase Google authentication on Android](https://firebase.google.com/docs/auth/android/google-signin)
- [Firestore offline data](https://firebase.google.com/docs/firestore/manage-data/enable-offline)

## Chosen integration path

A small Kotlin companion signs into Firebase with Google, listens to member workspaces' confirmed places, caches those records and reconciles an app-owned OsmAnd favorites group. Installed OsmAnd handles GPS, offline maps and normal navigation. Do not embed the full OsmAnd SDK: it adds size, licensing and coupling that this project does not need.

The official AIDL interface exposes `addFavoriteGroup`, `updateFavoriteGroup`, `addFavorite`, `updateFavorite`, `removeFavorite`, map-marker operations and `navigate`, with versioned parameter objects. Use the official sample/client library and a pinned reviewed interface version when implementing; do not invent Binder signatures from documentation. These APIs exist in the reviewed source; compatibility, permissions/user approval and behavior must still be tested against the actual installed OsmAnd edition/version.

Maintain a local mapping from canonical `workspaceId/placeId` to the last projected favorite name, group and coordinates. Favorites do not necessarily expose our canonical IDs. Use a dedicated group and deterministic naming to prevent collisions and preserve identity across retries. Update/remove only app-owned entries, and keep unrelated favorites intact. Archived places should remove the app-owned projection. Do not write a local OsmAnd edit back to Firestore until conflict/ownership semantics are deliberately designed. Prefer favorites for the initial collection; markers are an optional separate projection.

Basic `ACTION_VIEW` with a `geo:` URI or an officially supported OsmAnd map URL can open a point. Navigation intents/AIDL launch normal OsmAnd routing. Neither plain geo intents nor a successful launch proves favorites were synchronized. GPX can be a later explicit export/import fallback, not a sync database.

## Authentication and offline behavior

Use Google's current Android Credential Manager flow to obtain a Google credential and exchange it with Firebase Auth. Restore Firebase's existing `currentUser` on subsequent launches; trigger interactive login only when no usable session exists. Do not enable email/password auth. The Android package ID, debug/release signing certificates and Firebase registration must be chosen together in the implementation task.

Firestore Android persistent caching is enabled by default; retain already-cached confirmed places when offline. Cache completeness is limited to prior successful reads. Persist the projection mapping and a reconciliation journal locally so process death or a failed AIDL call does not duplicate favorites. Reconcile server changes after reconnect, and retry projection after OsmAnd becomes available. On sign-out/account switch, stop listeners and clear or partition private caches and app-owned projections so another account does not inherit the previous user's shared places. Only records fetched under that user's authorized workspace membership may be projected.

Use Firebase Auth UIDs for Firestore rules, not Google email or Telegram IDs. Reads are workspace-scoped. The companion is read-only at first; canonical writes remain in the trusted backend. A later Mom I'm OK integration can consume the same Firestore records without depending on this bridge.

## Required device validation before claiming a bridge

Install supported OsmAnd, verify binding/permission behavior using the official sample, then check add/update/archive replay in a dedicated group. Test no OsmAnd installed, denied API access, network loss, process death, expired/revoked Firebase membership, account switch and navigation from current location with downloaded offline maps. No Android or device validation was done in this task.
