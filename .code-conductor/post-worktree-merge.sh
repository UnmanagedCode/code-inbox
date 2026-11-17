#!/usr/bin/env bash
# frontend/dist is gitignored and built only by `prepare` (run on `npm install`), so a merge that changes the UI
# leaves the main checkout serving the previous build. Rebuild it here. Writes only git-ignored paths.
set -uo pipefail
TAG='[post-worktree-merge] ui:'
dirs=$(git rev-parse --path-format=absolute --git-dir --git-common-dir) || { echo "$TAG git rev-parse failed" >&2; exit 1; }
if [ "$(sed -n 1p <<<"$dirs")" != "$(sed -n 2p <<<"$dirs")" ]; then echo "$TAG linked worktree, skipped"; exit 0; fi
changed=$(git diff --name-only "${CC_PRE_MERGE_SHA:?}" "${CC_POST_MERGE_SHA:?}" -- package.json frontend) || { echo "$TAG git diff failed" >&2; exit 1; }
if [ -z "$changed" ]; then echo "$TAG unchanged, not rebuilt"; exit 0; fi
if grep -qx package.json <<<"$changed"; then cmd=(npm install); else cmd=(npm run prepare); fi
"${cmd[@]}" || { echo "$TAG BUILD FAILED (${cmd[*]}): the page still serves the previous build; run it in $PWD" >&2; exit 1; }
echo "$TAG rebuilt (${cmd[*]})"
