#!/usr/bin/env bash
# scripts/regime/install.sh
# One-shot setup for the regime-bot's Python dependency: vendors markov_regime.py
# from jackson-video-resources/markov-hedge-fund-method into src/regime-bot/vendor/markov/.
#
# Idempotent: safe to re-run. Aborts on any error.

set -euo pipefail

REPO_URL="https://github.com/jackson-video-resources/markov-hedge-fund-method.git"
SOURCE_FILE_REL="scripts/markov_regime.py"
TEMP_DIR="/tmp/markov-temp-$$"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENDOR_DIR="$PROJECT_ROOT/src/regime-bot/vendor/markov"

cleanup() {
  if [[ -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
    echo "  Cleaned up $TEMP_DIR"
  fi
}
trap cleanup EXIT

echo "regime-bot installer"
echo "  project root : $PROJECT_ROOT"
echo "  vendor dir   : $VENDOR_DIR"
echo ""

# ── Step 1: check uv ──────────────────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
  echo "[1/5] uv not installed."
  read -p "      Install via 'brew install uv'? [y/N] " ans
  if [[ "$ans" == "y" || "$ans" == "Y" ]]; then
    brew install uv
  else
    echo "      Aborted. Install uv manually then re-run."
    exit 1
  fi
else
  echo "[1/5] uv present: $(uv --version)"
fi

# ── Step 2: clone repo ────────────────────────────────────────────────────────
echo "[2/5] Cloning $REPO_URL → $TEMP_DIR"
git clone --depth=1 --quiet "$REPO_URL" "$TEMP_DIR"
COMMIT_HASH=$(cd "$TEMP_DIR" && git rev-parse HEAD)
COMMIT_DATE=$(cd "$TEMP_DIR" && git log -1 --format=%cI)
echo "      Cloned at commit $COMMIT_HASH ($COMMIT_DATE)"

# ── Step 3: verify source file exists ─────────────────────────────────────────
if [[ ! -f "$TEMP_DIR/$SOURCE_FILE_REL" ]]; then
  echo "      ERROR: $SOURCE_FILE_REL not found in cloned repo."
  echo "      Available scripts:"
  find "$TEMP_DIR/scripts" -name "*.py" 2>/dev/null | sed 's|^|        |'
  exit 1
fi
echo "[3/5] Source file located"

# ── Step 4: vendor the file ───────────────────────────────────────────────────
mkdir -p "$VENDOR_DIR"
cp "$TEMP_DIR/$SOURCE_FILE_REL" "$VENDOR_DIR/markov_regime.py"

# Also vendor the LICENSE so we honor the upstream license
if [[ -f "$TEMP_DIR/LICENSE" ]]; then
  cp "$TEMP_DIR/LICENSE" "$VENDOR_DIR/LICENSE"
fi

cat > "$VENDOR_DIR/SOURCE.md" <<EOF
# Vendored Source — markov_regime.py

This file is a vendored copy of \`scripts/markov_regime.py\` from:

- **Upstream repo:** https://github.com/jackson-video-resources/markov-hedge-fund-method
- **Commit:** $COMMIT_HASH
- **Commit date:** $COMMIT_DATE
- **Vendored on:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Why vendored

Per project rule: "Make our own copy into our repo so we maintain our code base."
This ensures the script can't change underneath us and our backtests stay reproducible.

## Modifications

**None.** The script is used as-is. Our integration relies on its existing
\`--csv\` flag for DB-backed price input.

## Refresh procedure

To update to a newer upstream version:
1. Re-run \`scripts/regime/install.sh\` — it will overwrite this directory
2. Review the diff in \`markov_regime.py\` before committing
3. Update commit hash above
4. Re-run regime-bot backtest to confirm no behavior change for the test basket

## Dependencies (PEP 723 inline)

Resolved automatically by \`uv\` on first run. The script declares:
\`\`\`python
# requires-python = ">=3.10"
# dependencies = ["numpy", "pandas", "yfinance", "hmmlearn", "scipy"]
\`\`\`

## Invocation

\`\`\`bash
uv run src/regime-bot/vendor/markov/markov_regime.py --csv <path-to-prices.csv> --json
\`\`\`
EOF

echo "[4/5] Vendored to $VENDOR_DIR/"
ls -la "$VENDOR_DIR" | sed 's|^|        |'

# ── Step 5: smoke test ────────────────────────────────────────────────────────
echo "[5/5] Smoke test — running on SPY via yfinance (first uv run downloads deps, may take ~30s)"
if uv run "$VENDOR_DIR/markov_regime.py" --ticker SPY --json >/tmp/regime-smoke.json 2>/tmp/regime-smoke.err; then
  CURRENT_REGIME=$(node -e "const j=require('/tmp/regime-smoke.json'); console.log(j.current_regime || 'parse-fail');" 2>/dev/null || echo "parse-fail")
  echo "        Smoke test OK — SPY current_regime = $CURRENT_REGIME"
  echo "        Full output in /tmp/regime-smoke.json"
else
  echo "        Smoke test FAILED — stderr in /tmp/regime-smoke.err"
  echo "        First 10 lines:"
  head -10 /tmp/regime-smoke.err | sed 's|^|          |'
  exit 1
fi

echo ""
echo "Done. Next: run 'npm run regime-bot:download-etfs' to backfill ETF prices,"
echo "      then 'npm run regime-bot:start' once the bot code is in place."
