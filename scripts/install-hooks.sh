#!/usr/bin/env bash
# Point git at the hooks committed in this repository.
#
# Hooks live in scripts/git-hooks/ rather than .git/hooks/ so they are version
# controlled and reviewable. core.hooksPath is per-clone configuration, so this
# has to be run once after cloning.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
chmod +x "$root/scripts/git-hooks/"*
git config core.hooksPath scripts/git-hooks

echo "core.hooksPath -> scripts/git-hooks"
echo
echo "Active hooks:"
for hook in "$root/scripts/git-hooks/"*; do
  [ -f "$hook" ] && echo "  $(basename "$hook")"
done
