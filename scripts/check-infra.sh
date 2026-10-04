#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
cd "$root"
for script in infra/*.sh scripts/*.sh; do bash -n "$script"; done
python3 - <<'PY'
import ast
from pathlib import Path
ast.parse(Path('infra/validate-release.py').read_text())
PY
bash infra/bootstrap-gcp.sh --validate
echo infrastructure_static_checks_ok
