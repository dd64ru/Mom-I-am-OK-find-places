# Runtime and infrastructure preparation

Nothing here provisions or deploys production resources. Existing owner-provisioned project: `mom-im-ok-places`, Firestore `(default)`, Firebase Google authentication, Secret Manager, two named secrets and Blaze billing.

## Runtime identity and secret access

Use one VM attached service account with Application Default Credentials; never create a service-account JSON key. Grant Firestore access (`roles/datastore.user`) to that runtime identity and `roles/secretmanager.secretAccessor` on **only** `TELEGRAM_BOT_TOKEN` and, if fallback is enabled, `GEMINI_API_KEY`. Secret Manager and Firestore APIs must be enabled. OAuth sessions are local protected files, separate from these Google secrets.

For local live work, use an owner-authorized ADC setup or impersonate the intended runtime service account with appropriate IAM; this is an operator action, not part of bootstrap. Secret values need not be exposed to development agents. `SECRET_SOURCE=google` resolves secret versions at runtime. No key files, secret values or arbitrary Firebase app registrations are included.

## Initial workspace

After the intended users sign in with Firebase Google, obtain their Firebase Auth UIDs. Separately obtain the group chat ID and permitted Telegram numeric user IDs; no automatic identity mapping exists. Choose a path-safe workspace ID, e.g. `shared`, and create `workspaces/shared` using the trusted console/admin identity:

```json
{
  "id": "shared",
  "members": ["FIRST_FIREBASE_UID", "SECOND_FIREBASE_UID"],
  "settings": { "locale": "en" },
  "createdAt": "2026-10-04T00:00:00.000Z",
  "updatedAt": "2026-10-04T00:00:00.000Z"
}
```

Replace the sample UIDs and times with actual values. Timestamps are ISO strings. `areaHint` is optional. The worker validates this document and refuses to run if missing; it does not invent memberships. Configure the real workspace/chat/user IDs in the runtime environment.

`firestore.rules` allows Firebase members to read only their workspace and its places, chains and discoveries; all client writes and other paths are denied. The server's Admin SDK uses IAM and bypasses rules. Client queries must be workspace scoped (or constrain workspace enumeration by membership). `firestore.indexes.json` has no composite indexes because current repository operations are document reads/writes. Future ordered status queries may need additional indexes.

`firebase.json` prepares an opt-in Firestore emulator and explicit rule/index deployment. Do not run deployment against production as part of a normal build. Rules have been source-reviewed, not emulator-tested here; add Firebase rules emulator tests before releasing any client. No Firebase CLI or Java installation is required for the TypeScript checks.

## Persistent worker

Build with `npm ci && npm run build`, install under `/opt/places`, and use the supplied systemd template after creating the `places` Unix user and `/var/lib/places` (`0700`, runtime-owned). Set `OPENAI_SESSION_DIR=/var/lib/places` and non-secret worker settings in `/etc/places/worker.env`. Import the OAuth profile securely as described in `docs/openai-siwc.md`, preserving the VM's own host ID. Secret Manager supplies Telegram/Gemini credentials. Configure only one poller and refresh owner.

The lifetime `owner.lock` protects rotating refresh tokens. Clean shutdown removes it. On a crash it intentionally remains: verify that the old process is gone, remove the stale lock and restart. The service template may retry until the operator resolves this. This fail-closed tradeoff is preferable to racing a copied session; production automation for stale-lock recovery is a future improvement. Deployment scripts must allow graceful drain and must not replace/delete the persistent credential directory.

## CI and future deployment

The included GitHub Actions workflow installs dependencies, checks formatting, typechecks/builds all implemented modules and runs credential-free smoke tests. It has repository read permission and no cloud authentication or deployment step.

For later GitHub → Google Cloud deployment, create a Workload Identity Federation pool/provider constrained to this repository and the intended owner/ref/environment, grant the scoped deploy identity `roles/iam.workloadIdentityUser`, and use short-lived OIDC credentials with `id-token: write` only in the deployment job. Restrict production environment access; do not expose deployment credentials to untrusted pull-request code. Keep deploy IAM separate from the runtime account and grant only the selected VM/artifact deployment permissions once the delivery mechanism is chosen. No WIF provider, deploy account, VM, key or production rule deployment was created here.
