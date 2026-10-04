#!/usr/bin/env bash
# Mature detector with built-in rules; output is fully redacted and no report artifact is saved.
set -euo pipefail
version=8.30.1
expected=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
[[ $(uname -sm) == 'Linux x86_64' ]] || { echo secret_check_requires_linux_x64 >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
curl --location --fail --silent --show-error "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz" -o "$stage/gitleaks.tgz"
printf '%s  %s\n' "$expected" "$stage/gitleaks.tgz" | sha256sum --check --strict >/dev/null
tar -xzf "$stage/gitleaks.tgz" -C "$stage" gitleaks
"$stage/gitleaks" git --redact=100 --no-banner --log-opts=--all "$root"
