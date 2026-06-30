#!/usr/bin/env bash
# Build a SHA-256 integrity manifest of the entire /Volumes/Archive data set.
# READ-ONLY. Resumable: re-running skips files already hashed (size-matched).
# Purpose: detect bit-rot / truncated files, and verify integrity AFTER the DAS is
# physically moved to the Mac Studio (re-run on the new machine, diff the manifests).
#
#   Run:    bash scripts/build-archive-manifest.sh
#   Verify: bash scripts/build-archive-manifest.sh --verify   (re-hash, report mismatches)
set -uo pipefail

ROOT=/Volumes/Archive
OUT="$ROOT/manifests"
MAN="$OUT/archive_manifest.tsv"          # sha256<TAB>size<TAB>mtime<TAB>relpath
LOG="$HOME/Library/Logs/archive_manifest.log"
mkdir -p "$OUT" 2>/dev/null
exec >>"$LOG" 2>&1

MODE="${1:-build}"
echo "[$(date '+%F %T %Z')] manifest $MODE START (root=$ROOT)"

if [ ! -d "$ROOT/polygon-flatfiles" ]; then echo "FATAL: $ROOT not mounted"; exit 1; fi

# Resume (bash 3.2 compatible, no assoc arrays): files are processed in `find | sort`
# order and appended only after a full hash, so the last manifest line marks where we
# stopped. On resume we skip every file lexicographically <= that last path.
LASTREL=""
if [ "$MODE" = "build" ] && [ -s "$MAN" ]; then
  LASTREL=$(tail -1 "$MAN" | cut -f4)
  echo "  resume: $(wc -l < "$MAN") files already hashed; last=$LASTREL"
fi

[ "$MODE" = "verify" ] && VERIFY_MAN="$OUT/archive_manifest_verify.tsv" && : > "$VERIFY_MAN"

n=0; new=0; skip=0; mism=0
while IFS= read -r f; do
  n=$((n+1))
  rel="${f#$ROOT/}"
  size=$(stat -f %z "$f" 2>/dev/null) || continue
  mtime=$(stat -f %m "$f" 2>/dev/null)

  if [ "$MODE" = "build" ] && [ -n "$LASTREL" ] && { [[ "$rel" < "$LASTREL" ]] || [ "$rel" = "$LASTREL" ]; }; then
    skip=$((skip+1))
  else
    sha=$(shasum -a 256 "$f" 2>/dev/null | awk '{print $1}')
    [ -z "$sha" ] && { echo "  ERR hash failed: $rel"; continue; }
    line="$sha	$size	$mtime	$rel"
    if [ "$MODE" = "verify" ]; then
      printf '%s\n' "$line" >> "$VERIFY_MAN"
      prev=$(awk -F'\t' -v r="$rel" '$4==r{print $1}' "$MAN" 2>/dev/null | head -1)
      if [ -n "$prev" ] && [ "$prev" != "$sha" ]; then
        echo "  !! MISMATCH $rel  was=$prev now=$sha"; mism=$((mism+1))
      fi
    else
      printf '%s\n' "$line" >> "$MAN"
    fi
    new=$((new+1))
  fi
  if [ $((n % 500)) -eq 0 ]; then
    echo "  [$(date '+%T')] scanned=$n new=$new skip=$skip mism=$mism"
  fi
done < <(find "$ROOT/polygon-flatfiles" "$ROOT/polygon-rest" "$ROOT/benzinga-news" -type f \
            \( -name '*.gz' -o -name '*.json' -o -name '*.jsonl' \) 2>/dev/null | sort)

echo "[$(date '+%F %T %Z')] manifest $MODE DONE — scanned=$n new=$new skip=$skip mismatch=$mism"
echo "  manifest: $MAN ($(wc -l < "$MAN" 2>/dev/null) entries)"
