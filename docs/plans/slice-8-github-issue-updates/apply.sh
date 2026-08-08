#!/usr/bin/env bash
# Apply updated slice 8 issue bodies (#55–#64) to GitHub.
# Requires: gh auth with issues:write on RobinopdeBeek/jeeves
set -euo pipefail

REPO="${REPO:-RobinopdeBeek/jeeves}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Applying slice 8 issue bodies to $REPO ..."
for n in 55 56 57 58 59 60 61 62 63 64; do
  body_file="$DIR/$n.md"
  if [[ ! -f "$body_file" ]]; then
    echo "Missing $body_file" >&2
    exit 1
  fi
  echo "  #$n"
  gh issue edit "$n" --repo "$REPO" --body-file "$body_file"
done
echo "Done."
