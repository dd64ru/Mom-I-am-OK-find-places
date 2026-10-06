# Production placesFeed owner runbook

This runbook is for later, deliberate owner execution. Development does not execute these commands, deploy, create secrets or grant IAM. Read the [feed API v1 and caching contract](../docs/map-projection.md) first. The service credential belongs only on servers: never browser JS, an Android APK, GitHub variables/secrets/artifacts, repository files, Firestore, URLs, chat or logs. No service-account key is needed; use the existing owner gcloud login/ADC and runtime identity.

## One-time digest setup

On the owner's trusted machine, use a private terminal without session recording. Disable shell tracing before handling credentials. Create a private temporary directory **outside the checkout**; the commands below never print the plaintext token or put it in command arguments/history. Transfer the plaintext file through your approved encrypted secret/password-manager import into temporary secure custody for the later Mom-I-am-OK backend secret setup. Do not copy it into this repository or a synchronized/plaintext notes folder.

```sh
set +x
umask 077
export PLACES_SETUP_DIRECTORY="$(mktemp -d /tmp/places-feed-XXXXXX)"
node --input-type=module <<'JS'
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const token = randomBytes(32).toString('base64url');
const digest = createHash('sha256').update(token, 'utf8').digest('hex');
writeFileSync(join(process.env.PLACES_SETUP_DIRECTORY, 'token'), token + '\n', { mode: 0o600 });
writeFileSync(join(process.env.PLACES_SETUP_DIRECTORY, 'digest'), digest, { mode: 0o600 });
JS
```

The 43-character base64url token encodes 32 cryptographically random bytes. Hash the **UTF-8 token string**, without a newline; this is the feed's comparison contract, rather than hashing decoded random bytes. Node emits a lowercase 64-character hex digest. Only that digest goes into the Places Finder project:

```sh
gcloud secrets create PLACES_FEED_TOKEN_SHA256 \
  --project=mom-im-ok-places --replication-policy=automatic
gcloud secrets versions add PLACES_FEED_TOKEN_SHA256 \
  --project=mom-im-ok-places --data-file="$PLACES_SETUP_DIRECTORY/digest"
gcloud secrets add-iam-policy-binding PLACES_FEED_TOKEN_SHA256 \
  --project=mom-im-ok-places \
  --member=serviceAccount:places-runtime@mom-im-ok-places.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

For an already existing secret, inspect its metadata/IAM first and omit `create`; do not blindly overwrite unrelated credentials or broaden access. Grant only secretAccessor on **this specific secret**, not at project level. No access is added to `places-deploy`; the CI workflow never reads the secret value and does not manage its IAM. The runtime already has its reviewed Firestore/Places quota access. No service-enablement or other runtime role change is part of feed setup.

Keep the plaintext in approved encrypted custody until the future Mom-I-am-OK backend can store it in its own server-side secret. After import/smoke, delete the private local files/directory and unset local variables. Do not print the token for copy/paste. Temporary storage, backups and terminal recording must follow the owner's normal credential handling.

## Independent deployment and read-only smoke

After reviewing the commit, secret-specific access and WORKSPACE_ID, manually trigger **Deploy places feed** on main in the production Environment. It deploys only `functions:places:placesFeed`, enabled, with URL tokens disabled. The existing **Deploy production** workflow still deploys only `placesWebhook` and cannot reconfigure the feed. Never run a broad `firebase deploy` for this setup. Use the actual resulting URL (expected shape below):

```sh
export PLACES_FEED_URL=https://europe-west3-mom-im-ok-places.cloudfunctions.net/placesFeed
IFS= read -r PLACES_FEED_TOKEN < "$PLACES_SETUP_DIRECTORY/token"
export PLACES_FEED_TOKEN
npm run feed:smoke
unset PLACES_FEED_TOKEN PLACES_FEED_URL
```

The owner smoke script performs only six HTTP requests: authenticated GeoJSON GET, conditional GET requiring 304, missing-token GET requiring 401, malformed-token GET requiring 401, unsupported-format GET requiring 400, and POST requiring 405. The POST is a method-rejection probe; the endpoint has no mutation handler. The script rejects redirects and credential/query-bearing URLs, bounds time/body size, validates v1/Content-Type/GeoJSON/unique internal IDs/coordinate ranges and aggregate headers. Output is only feature count, complete state, total/projected counts and ETag success; failure is the fixed string `feed_smoke_failed`. It never prints labels, coordinates, IDs, token, response bodies or ETag value. No live smoke is wired into CI or normal tests. A data change between the two GETs can legitimately cause the required 304 check to fail; retry the owner smoke when the snapshot is stable.

After deployment, check label readiness **with plan first**:

```sh
npm run build
node scripts/backfill-place-labels.mjs \
  --project mom-im-ok-places --workspace <reviewed-workspace-id> --plan
```

Inspect aggregate planned/unresolved/alreadyLabeled counts. Current multi-confirmation (`confirmedPlaceIds`) and legacy single confirmation (`confirmedPlaceId`) are supported; each uniquely associated original candidate/clue is checked. Related branches and ambiguous identities never acquire the photographed venue's label. Missing independent labels remain excluded from the feed, making it incomplete. Never substitute Google displayName. Only later, after separate explicit owner review/approval, use `--apply` if needed; it revalidates associations transactionally and never overwrites existing labels. This development task does not run production backfill.

After secure custody/import and smoke are complete:

```sh
rm -rf -- "$PLACES_SETUP_DIRECTORY"
unset PLACES_SETUP_DIRECTORY
```

## Deliberate rotation

Generate a **new independent** token/digest using the same private local procedure; never reuse/re-hash an old token. Coordinate the future backend's server-side secret replacement with a new Places Finder digest version (`gcloud secrets versions add ... --data-file=...`). The feed reads latest on every request, so no redeploy/cold-start wait is required once Secret Manager latest propagates. It accepts only one digest at a time; old/new tokens are not accepted in parallel. Plan the brief mismatch window: consumers retain their cached snapshot on 401/network failure.

Update/reload the future backend's server secret deliberately, verify owner smoke with the new token, then retire obsolete secret versions and encrypted custody according to owner policy. Never send either token through URLs, GitHub variables, logs or clients. Token rotation is a server-to-server operation; application-user authentication remains the future Mom-I-am-OK backend's responsibility.
