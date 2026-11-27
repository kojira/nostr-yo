#!/bin/sh
# Build from a clean clone of origin/main and force-push dist/ to gh-pages. No CI, no secrets.
set -eu
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
C=$(mktemp -d)
git clone -q git@github.com:kojira/nostr-yo.git "$C/r"
cd "$C/r"
SRC=$(git rev-parse HEAD)
corepack pnpm install --frozen-lockfile --store-dir "$C/store"
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cd dist
git init -q -b gh-pages
git add -A
git -c user.name=kojira -c user.email=kojira@users.noreply.github.com commit -qm "Deploy $SRC (clean clone build)"
git push -f git@github.com:kojira/nostr-yo.git gh-pages
echo "deployed $SRC from $C"
