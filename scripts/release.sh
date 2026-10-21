#!/usr/bin/env bash
# Release: align main with dev, bump the version on main, tag it and push; the Release workflow publishes the tag.
# Usage: bun run release <patch|minor|major>   (run it on dev, with nothing uncommitted)
set -euo pipefail

bump="${1:-}"
case "$bump" in
  patch | minor | major) ;;
  *)
    echo "usage: bun run release <patch|minor|major>" >&2
    exit 2
    ;;
esac

fail() {
  echo "$1" >&2
  exit 1
}

[ "$(git branch --show-current)" = dev ] || fail "run it on dev"
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean"
git fetch --quiet origin
# main may be fast-forwarded to dev only if it has nothing dev lacks, and dev must not be behind its remote.
git merge-base --is-ancestor origin/main dev || fail "main has commits dev lacks: merge origin/main into dev first"
git merge-base --is-ancestor origin/dev dev || fail "dev is behind origin/dev: pull first"

bun run verify
bun run check:package
bun run probe

trap 'echo "release stopped on $(git branch --show-current); look at git status before running it again" >&2' ERR

git switch --quiet main
git merge --ff-only --quiet origin/main
git merge --ff-only --quiet dev
npm version "$bump" --message "chore: release %s" > /dev/null
tag="v$(node -p "require('./package.json').version")"
git push --atomic origin main "$tag"

git switch --quiet dev
git merge --ff-only --quiet main
git push --quiet origin dev
echo "pushed $tag; the Release workflow publishes it (gh run watch)"
