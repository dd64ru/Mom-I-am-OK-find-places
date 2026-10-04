"""Root-side extraction of a public, prebuilt release. No runtime state is read."""
import hashlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile


def allowed(name):
    if name in ('package.json', 'package-lock.json', 'LICENSE', 'RELEASE.json', '.', 'apps', 'packages', 'node_modules'):
        return True
    if name.startswith('node_modules/'):
        return True
    for workspace in ('apps/worker', 'packages/core', 'packages/schemas', 'packages/providers'):
        if name in (workspace, workspace + '/package.json', workspace + '/dist') or name.startswith(workspace + '/dist/'):
            return True
    return False


def extract_release(archive, destination, commit, digest):
    if not re.fullmatch('[a-f0-9]{40}', commit) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError('invalid_release_identifiers')
    destination = Path(destination)
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError('release_destination_not_empty')
    # Installer copies the upload into root-only staging before this function.
    with open(archive, 'rb') as data:
        if hashlib.file_digest(data, 'sha256').hexdigest() != digest:
            raise ValueError('release_digest_mismatch')
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 50000 or sum(m.size for m in members) > 512 * 1024 * 1024:
            raise ValueError('release_archive_too_large')
        names = set()
        links = set()
        for m in members:
            p = PurePosixPath(m.name)
            name = str(p)
            if p.is_absolute() or '..' in p.parts or '\\' in m.name or name in names or not allowed(name):
                raise ValueError('release_path_rejected')
            names.add(name)
            if not (m.isdir() or m.isreg() or m.issym()):
                raise ValueError('release_entry_type_rejected')
            if m.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.linkname))
                if not name.startswith('node_modules/') or m.linkname.startswith('/') or target.startswith('../') or target == '..':
                    raise ValueError('release_link_rejected')
                links.add(name)
        for m in members:
            p = PurePosixPath(m.name)
            if any(str(parent) in links for parent in p.parents):
                raise ValueError('release_link_parent_rejected')
            target = destination / str(p)
            if m.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif m.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(m.linkname)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as out, bundle.extractfile(m) as source:
                    while chunk := source.read(1024 * 1024):
                        out.write(chunk)
                target.chmod(0o755 if m.mode & 0o111 else 0o644)
        for name in links:
            path = destination / name
            if not path.resolve().is_relative_to(destination.resolve()) or not path.exists():
                raise ValueError('release_link_target_rejected')
    metadata = json.loads((destination / 'RELEASE.json').read_text())
    if metadata != {'version': 1, 'mode': 'production', 'commit': commit}:
        raise ValueError('release_metadata_mismatch')
    package = json.loads((destination / 'package.json').read_text())
    if 'devDependencies' in package or any(key.startswith('pre') for key in package['scripts']):
        raise ValueError('release_requires_prebuilt_runtime')
    for item in ('apps/worker/dist/main.js', 'apps/worker/dist/runtime-init-cli.js', 'node_modules'):
        if not (destination / item).exists():
            raise ValueError('release_runtime_missing')


if __name__ == '__main__':
    try:
        extract_release(*sys.argv[1:])
    except Exception:
        print('release_validation_failed', file=sys.stderr)
        sys.exit(1)
