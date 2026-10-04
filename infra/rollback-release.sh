#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { echo rollback_arguments_rejected >&2; exit 1; }
exec 9>/run/places-deploy.lock
flock -n 9 || exit 1
release="/opt/places-releases/$1"
[[ -d $release && ! -L $release && -f $release/RELEASE.json && -L /opt/places ]] || exit 1
was_active=false
if systemctl is-active --quiet places-worker; then was_active=true; systemctl stop places-worker; fi
[[ ! -e /var/lib/places/owner.lock ]] || { echo rollback_session_owned_or_stale_lock >&2; exit 1; }
ln -sfn "$release" /opt/.places-rollback
mv -Tf /opt/.places-rollback /opt/places
if [[ $was_active == true ]]; then systemctl start places-worker; sleep 5; systemctl is-active --quiet places-worker; fi
printf 'release_rolled_back:%s worker_previously_active:%s\n' "$1" "$was_active"
