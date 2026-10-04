#!/usr/bin/env bash
# Compute Engine startup script. Public bootstrap code only; never reads secret payloads.
set -euo pipefail
umask 077
trap 'echo vm_preparation_failed >&2' ERR
metadata() { curl --fail --silent --show-error --retry 5 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
node_version=$(metadata places-node-version)
[[ $node_version =~ ^22\.[0-9]+\.[0-9]+$ ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl python3 xz-utils util-linux
if ! id places >/dev/null 2>&1; then useradd --system --user-group --home-dir /var/lib/places --shell /usr/sbin/nologin places; fi
install -d -o places -g places -m 0700 /var/lib/places
install -d -o root -g root -m 0755 /opt/places-releases /usr/local/lib/places
install -d -o root -g places -m 0750 /etc/places
if [[ ! -x /usr/local/bin/node || $(/usr/local/bin/node --version) != "v${node_version}" ]]; then
  temp=$(mktemp -d)
  trap 'rm -rf -- "$temp"' EXIT
  archive="node-v${node_version}-linux-x64.tar.xz"
  curl --fail --silent --show-error "https://nodejs.org/dist/v${node_version}/${archive}" -o "$temp/$archive"
  curl --fail --silent --show-error "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$temp/checksums"
  (cd "$temp"; awk -v archive="$archive" '$2 == archive {print}' checksums | sha256sum --check --strict)
  tar -xJf "$temp/$archive" -C /usr/local/lib
  ln -sfn "/usr/local/lib/node-v${node_version}-linux-x64/bin/node" /usr/local/bin/node
  ln -sfn "/usr/local/lib/node-v${node_version}-linux-x64/bin/npm" /usr/local/bin/npm
fi
metadata places-installer > /usr/local/sbin/places-install-release
metadata places-rollback > /usr/local/sbin/places-rollback-release
metadata places-validator > /usr/local/lib/places/validate-release.py
chmod 0755 /usr/local/sbin/places-install-release /usr/local/sbin/places-rollback-release
chmod 0644 /usr/local/lib/places/validate-release.py
metadata places-unit > /etc/systemd/system/places-worker.service
chmod 0644 /etc/systemd/system/places-worker.service
# Owner runtime configuration survives all bootstrap re-runs and code deployments.
if [[ ! -e /etc/places/worker.env ]]; then
  metadata places-env-template > /etc/places/worker.env
  chown root:places /etc/places/worker.env
  chmod 0640 /etc/places/worker.env
fi
systemctl daemon-reload
# Do NOT enable/start the worker. Host initialization and profile import are separate owner actions.
echo vm_prepared_worker_not_started
