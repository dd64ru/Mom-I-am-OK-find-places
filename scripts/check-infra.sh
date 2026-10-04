#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for script in scripts/*.sh; do bash -n "$script"; done
python3 - <<'PY'
import ast
from pathlib import Path
ast.parse(Path('infra/migrate-serverless.py').read_text())
PY
python3 infra/migrate-serverless.py --validate
echo infrastructure_static_checks_ok
