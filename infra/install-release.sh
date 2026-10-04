#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 2 && $1 =~ ^[a-f0-9]{40}$ && $2 =~ ^[a-f0-9]{64}$ ]] || { echo release_install_arguments_rejected >&2; exit 1; }
commit=$1
expected_digest=$2
exec 9>/run/places-deploy.lock
flock -n 9 || { echo release_deployment_busy >&2; exit 1; }
[[ -f /usr/local/lib/places/validate-release.py && -f /etc/systemd/system/places-worker.service ]] || exit 1
upload="/tmp/places-${commit}.tgz"
[[ -f $upload && ! -L $upload ]] || { echo release_upload_missing >&2; exit 1; }
[[ ! -e /opt/places || -L /opt/places ]] || { echo release_current_path_not_symlink >&2; exit 1; }
# Only public code uploads/staging are cleaned; /var/lib/places is never cleanup input.
stage=$(mktemp -d /opt/places-releases/.incoming.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
cp -- "$upload" "$stage/upload.tgz"
chmod 600 "$stage/upload.tgz"
mkdir "$stage/code"
python3 /usr/local/lib/places/validate-release.py "$stage/upload.tgz" "$stage/code" "$commit" "$expected_digest"
chmod -R u=rwX,go=rX "$stage/code"
release="/opt/places-releases/${commit}"
if [[ -e $release ]]; then
  [[ ! -L $release && -d $release && -f $release/RELEASE.json ]] || exit 1
  diff -qr -- "$stage/code" "$release" >/dev/null || { echo release_existing_commit_mismatch >&2; exit 1; }
else
  mv -- "$stage/code" "$release"
fi
previous=$(readlink -f /opt/places 2>/dev/null || true)
was_active=false
if systemctl is-active --quiet places-worker; then was_active=true; fi
# Prepare/validate fully before stopping anything. Inactive first deployments stay inactive.
if [[ $was_active == true ]]; then systemctl stop places-worker; fi
[[ ! -e /var/lib/places/owner.lock ]] || { echo release_session_owned_or_stale_lock >&2; exit 1; }
ln -sfn "$release" /opt/.places-next
mv -Tf /opt/.places-next /opt/places
if [[ $was_active == true ]]; then
  if ! systemctl start places-worker || ! sleep 5 || ! systemctl is-active --quiet places-worker; then
    systemctl stop places-worker || true
    if [[ -n $previous ]]; then
      ln -sfn "$previous" /opt/.places-previous
      mv -Tf /opt/.places-previous /opt/places
      if [[ ! -e /var/lib/places/owner.lock ]]; then systemctl start places-worker || true; fi
    fi
    echo release_restart_failed_previous_code_restored >&2
    exit 1
  fi
fi
# Keep three recent releases plus the current/previous targets. Never inspect runtime state.
python3 - "$release" "$previous" <<'PY_RETENTION'
from pathlib import Path
import re, shutil, sys
root = Path('/opt/places-releases')
releases = sorted((p for p in root.iterdir() if p.is_dir() and not p.is_symlink()
                   and re.fullmatch('[a-f0-9]{40}', p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
keep = set(sys.argv[1:]) | {str(p) for p in releases[:3]}
for path in releases:
    if str(path) not in keep:
        shutil.rmtree(path)
PY_RETENTION
rm -f -- "$upload"
printf 'release_installed:%s worker_previously_active:%s\n' "$commit" "$was_active"
