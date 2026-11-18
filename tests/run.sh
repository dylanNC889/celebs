#!/bin/sh
# Runs the browser tests: the real index.html + app.js in jsdom, with a pretend GitHub API and Gemini (no network).
# Needs node 18+, npm and python3 with the "cryptography" package.  Usage: sh tests/run.sh [test-name.js ...]
# Set T to reuse a work folder (keeps jsdom installed between runs).
set -e
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
T=${T:-${TMPDIR:-/tmp}/celebs-tests}
export T
mkdir -p "$T"
cp "$repo/app.js" "$repo/index.html" "$repo/data.json" "$T/"
python3 "$here/make-fixtures.py" "$repo" "$T" >/dev/null
[ -d "$T/node_modules/jsdom" ] || (cd "$T" && npm install --silent --no-audit --no-fund jsdom@24.1.3 >/dev/null)
if [ $# -gt 0 ]; then tests="$*"; else tests=$(cd "$here" && ls test-*.js); fi
failed=0
for t in $tests; do
  echo "== $t"
  node "$here/$t" > "$T/out.txt" 2>&1 || true
  cat "$T/out.txt"
  if grep -q '^FAIL' "$T/out.txt" || ! grep -q '^PASS' "$T/out.txt" || grep -q 'Error' "$T/out.txt"; then failed=$((failed + 1)); fi
done
echo
[ "$failed" -eq 0 ] && echo "All test files passed." || { echo "$failed test file(s) failed."; exit 1; }
