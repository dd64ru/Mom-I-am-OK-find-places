# Production runtime preparation

The owner already has project `mom-im-ok-places`, Firestore `(default)`, Firebase Google authentication, Blaze billing and Secret Manager secrets `TELEGRAM_BOT_TOKEN` / `GEMINI_API_KEY`. These are owner-supplied facts. This change has **not** provisioned or verified cloud resources: the agent environment has no `gcloud`. All tests are credential-free. No workspace/member documents are created here, and the production worker must remain stopped.

## Design and access

One Debian 12 Compute Engine VM, Node 22.23.3, `e2-small` (2 GB RAM), a retained 20 GB `pd-balanced` boot disk, and one unprivileged `places` systemd worker. Debian 12 is supported until June 2028; schedule OS/Node updates. Region/zone are deliberately unset until the existing Firestore location is inspected. There is no application ingress, webhook, load balancer, domain or container. A custom VPC permits TCP 22 only from IAP's `35.235.240.0/20`, targeting the runtime service account. An ephemeral external IP supplies outbound internet without adding paid Cloud NAT infrastructure; it does not open public SSH. Normal outbound access permits Telegram/OpenAI/Google/Gemini HTTPS.

- `places-runtime`: attached VM identity, `cloud-platform` scope bounded by IAM; project `roles/datastore.user` for server Firestore operations, per-secret `secretAccessor` on Telegram only. Optional `GRANT_GEMINI_ACCESS=true` adds the Gemini secret grant; fallback remains disabled until separately configured/tested. Firestore server IAM bypasses client rules, so this trusted identity can access the project's database.
- `places-deploy`: distinct identity; a three-permission project read role (`compute.instances.get/list`, `compute.projects.get`), IAP tunnel access conditioned on this VM's internal IP and port 22, VM-scoped OS Admin Login, and `serviceAccountUser` on the attached runtime account, as required for SSH to that VM. No direct Firestore or Secret Manager payload grant, and no JSON keys.
- GitHub OIDC → dedicated WIF pool/provider → deploy identity. Trust checks numeric repository/owner IDs, exact `dd64ru/Mom-I-am-OK-find-places`, `refs/heads/main` and the `production` environment subject. PR CI has no Google authentication. VM administration and application deployment are trusted privileges: deployers can execute runtime code and use its identity. Separate IAM is **not** a security boundary against a malicious trusted deployer.

Code is root-owned in `/opt/places-releases/<40-character-commit>`, with `/opt/places` an atomic symlink. Private state stays in `/var/lib/places` (`places:places`, `0700`); deployments never copy, clean or replace it. `/etc/places/worker.env` (`root:places`, `0640`) contains only non-secret settings. The template sets the owner's initial `gpt-5.6-terra` / `low`; application defaults are unchanged. Workspace/chat/user IDs and Gemini model remain blank. Telegram/Gemini payloads come from Secret Manager at runtime; SIWC stays exclusively in protected VM files.

## Owner bootstrap (Cloud Shell)

Use an authenticated owner/admin identity with permission to inspect existing resources and create the listed VM/IAM/WIF/network resources. Do not supply a key file. Start in a checkout of current `main`:

```sh
bash infra/bootstrap-gcp.sh --plan
```

This reads project/Firestore/secret **metadata only**, prints the Firestore location, and makes no changes. Choose a nearby compatible region and an available zone based on that actual location (multi-region locations are not zone names). Review VM/IP/disk costs and the explicit settings near the script's top. Then run, replacing the three owner choices:

```sh
REGION=CHOSEN_REGION ZONE=CHOSEN_ZONE ADMIN_MEMBER=user:OWNER_EMAIL \
  bash infra/bootstrap-gcp.sh --apply
```

The apply step enables APIs, reuses the existing project/database/secrets, creates dedicated identities/WIF/network/VM as necessary, and grants scoped IAM. It does not read/overwrite secret payloads or create Firestore documents. Reruns reuse resources; mismatched security settings, broad account grants, disabled-fallback secret grants or changed WIF trust fail closed for owner review. Bootstrap is not transactional: an interrupted run can leave already-created resources; inspect and rerun. Existing VM root helper changes require deliberate owner review and startup preparation rerun; bootstrap does not reboot an existing VM.

Wait for startup preparation to finish. Inspect only public startup status via the Google Console/serial log or IAP SSH. Verify:

```sh
sudo test -x /usr/local/sbin/places-install-release
/usr/local/bin/node --version
sudo stat -c '%U:%G %a' /var/lib/places /etc/places/worker.env
sudo systemctl is-active places-worker # expected inactive (nonzero)
sudo systemctl is-enabled places-worker # expected disabled (nonzero)
```

The worker is neither enabled nor started. Keep the retained boot disk and its private state protected; deleting a VM retains its disk but does not make a backup. No snapshots/backups are configured by this task.

## GitHub production deployment

Create GitHub environment `production`, restrict its deployment branches to **main**, and configure an owner approval protection if available for the repository plan. Put bootstrap's printed safe values in its environment variables:

`GCP_PROJECT_ID`, `GCP_ZONE`, `GCP_VM_NAME`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`.

No GitHub secrets are needed. Enable Actions and manually run **Deploy production** on `main`. The workflow checks the complete repository, builds, prunes development dependencies and packages only the four compiled workspaces, production dependencies, public package metadata and MIT license. It records the exact commit in `RELEASE.json`; no `.env`, credentials, tests, Git checkout or compiler are shipped. The artifact job has no Google authentication. The deployment job acquires short-lived Google OIDC credentials only after packaging and uses IAP/OS Login with an expiring SSH key. Actions are pinned by commit. Gitleaks 8.30.1 is downloaded with a fixed SHA-256 and scans full Git history with redacted output; no secret-scan report is uploaded. This is a mature additional check, not proof that arbitrary private data cannot leak.

The root installer validates SHA-256, paths, symlinks, metadata and prebuilt layout before switching the symlink. Transfers/staging failures leave current code intact. It restarts only an already-active worker, allows up to 300 seconds for graceful shutdown, checks process status after five seconds, and restores previous code on early restart failure. This is a process-status check, not an application readiness probe; later failures still need owner investigation. Initial deployment remains inactive. Three recent releases plus current/previous targets are retained. `/var/lib/places` and the environment file are outside all release cleanup.

## VM initialization and owner-only profile import

Use IAP from the owner's authenticated computer; set these **non-secret** local variables to the bootstrap values:

```sh
PROJECT_ID=mom-im-ok-places
ZONE=CHOSEN_ZONE
VM_NAME=places-worker
```

Open a VM shell:

```sh
gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap
```

On the VM, ensure the worker is stopped and initialize its own host identity (this command does not perform OAuth or read an account profile):

```sh
sudo systemctl stop places-worker
sudo -u places sh -c 'set -a; . /etc/places/worker.env; set +a; cd /opt/places; npm run runtime:init'
```

It reports initialization/path/ownership/permission/host-presence checks only. Stop all laptop OAuth/model/vision/worker processes using the selected profile before transfer. From the owner's computer, with `LOCAL_OWNER_PROFILE` pointing privately to the already-authorized `owner.json`:

```sh
gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap \
  --command='install -d -m 0700 "$HOME/places-import"'
gcloud compute scp "$LOCAL_OWNER_PROFILE" "$VM_NAME:places-import/owner.json" \
  --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap
```

Back in the VM shell, import **only** `owner.json`. Do not transfer or replace `host.json`. For a first import:

```sh
sudo systemctl stop places-worker
sudo test ! -e /var/lib/places/owner.lock
sudo test ! -e /var/lib/places/owner.json
sudo test -f /var/lib/places/host.json
chmod 0600 "$HOME/places-import/owner.json"
sudo install -o places -g places -m 0600 "$HOME/places-import/owner.json" /var/lib/places/owner.json
rm -- "$HOME/places-import/owner.json"
rmdir -- "$HOME/places-import"
sudo stat -c '%U:%G %a' /var/lib/places/owner.json /var/lib/places/host.json
```

Stop if any `test` fails; do not paste this block into a shell that continues after a failed prerequisite (run checks individually or use `set -e` in a dedicated script). Never display the profile, upload it through Codex/GitHub/CI/Secret Manager/public URLs, or copy it into the deployment checkout. The VM becomes the sole refresh owner; do not reuse the copied laptop session. The official SIWC guidance preserves the VM's host identity and notes that transferred sessions do not yet have host-specific attribution/revocation. See [SIWC](../docs/openai-siwc.md).

## First validation — worker stays stopped

In the VM shell, run each diagnostic as the runtime user with the non-secret environment:

```sh
sudo -u places sh -c 'set -a; . /etc/places/worker.env; set +a; cd /opt/places; npm run models'
# Optional: owner securely transfers a harmless image, readable by places, outside private state.
sudo -u places sh -c 'set -a; . /etc/places/worker.env; set +a; cd /opt/places; npm run vision:smoke -- /tmp/harmless-test.png'
sudo -u places sh -c 'set -a; . /etc/places/worker.env; set +a; cd /opt/places; npm run telegram:ids'
```

Model listing must confirm the configured account model. Vision validates a real optional image. No workspace is required by these commands. For `telegram:ids`, stop every other bot poller, send one harmless event from each intended user in the intended group, record the numeric group ID and both user IDs, then **Ctrl+C**. Remove the optional image. Confirm `places-worker` remains inactive. Do not enable Gemini fallback or start the worker.

Only a later task will create the actual workspace/member documents with real Firebase UIDs, fill workspace/chat/user settings, and start/enable the worker. No fake UIDs or members are generated here. Existing [Firestore rules](firestore.rules) and index definitions are unchanged; client rule emulator verification remains future work before releasing a client.

## Recovery

Inspect current public release with `readlink -f /opt/places` and `/opt/places/RELEASE.json`. To restore a retained known-good commit on the VM:

```sh
sudo /usr/local/sbin/places-rollback-release KNOWN_GOOD_40_CHARACTER_COMMIT
```

Rollback preserves state/configuration and only restarts a worker that was already active. A stale `owner.lock` deliberately fails closed: confirm **all** session-owning processes have exited before manually removing that one lock. Never delete the profile or host identity to unblock a deployment. If a restart fails, inspect fixed application diagnostics and service status; do not print secret files or upstream bodies. A five-second check cannot guarantee subsequent readiness. VM replacement/profile recovery and private backups remain owner operations, outside this bootstrap.

Official references rechecked 2026-10-04: [attached service accounts](https://cloud.google.com/compute/docs/access/service-accounts), [Secret Manager IAM](https://cloud.google.com/secret-manager/docs/access-control), [deployment WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [OS Login](https://cloud.google.com/compute/docs/oslogin/set-up-oslogin), [IAP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding), [supported OS images](https://cloud.google.com/compute/docs/images/os-details), [OpenAI self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
