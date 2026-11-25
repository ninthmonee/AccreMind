#!/usr/bin/env bash
# Publish @accremind/core and @accremind/dsh-plugin to the public npm registry.
#
#   NPM_TOKEN=npm_xxx ./scripts/release-npm.sh   # granular/automation token
#   NPM_OTP=123456 ./scripts/release-npm.sh      # or account 2FA code for one publish
#   ./scripts/release-npm.sh                     # or reuse a prior `npm login`
#
# Why a script instead of two `npm publish` calls:
#   * pnpm publish is required: it rewrites `workspace:*` into the real version.
#     `npm publish` leaves the dependency unrewritten (verified by packing both ways).
#   * the public registry is forced, so a mirror in ~/.npmrc cannot receive the release;
#   * the npm cache is redirected to a temp dir, so a sandboxed shell that cannot write
#     to ~/.npm still works;
#   * the kernel is published before the plugin, and the marketplace index is
#     regenerated from the published versions at the end.
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export npm_config_cache="${npm_config_cache:-/tmp/accremind-npm-cache}"
export npm_config_registry="$REGISTRY"
mkdir -p "$npm_config_cache"

if [ -n "${NPM_TOKEN:-}" ]; then
  TMP_NPMRC="$(mktemp -t accremind-npmrc.XXXXXX)"
  printf '//registry.npmjs.org/:_authToken=%s\nregistry=%s\n' "$NPM_TOKEN" "$REGISTRY" > "$TMP_NPMRC"
  chmod 600 "$TMP_NPMRC"
  export npm_config_userconfig="$TMP_NPMRC"
  trap 'rm -f "$TMP_NPMRC"' EXIT
fi

OTP_FLAG=()
if [ -n "${NPM_OTP:-}" ]; then
  OTP_FLAG=(--otp "$NPM_OTP")
fi

cd "$ROOT"

echo "==> whoami (registry: $REGISTRY)"
if ! whoami_out="$(npm whoami 2>&1)"; then
  cat >&2 <<'EOS'
Not authenticated against registry.npmjs.org.

Do one of these once, then re-run this script:
  a) npm login                 (interactive; stores a token in ~/.npmrc)
  b) create a Granular/Automation token with read+write on @accremind, then:
       NPM_TOKEN=npm_xxx ./scripts/release-npm.sh

The @accremind scope must exist as an npm organisation (free, public packages only):
https://www.npmjs.com/org/create  →  name: accremind
EOS
  exit 1
fi
echo "    authenticated as $whoami_out"

echo "==> build + verify"
node scripts/build.ts
pnpm verify

echo "==> publish @accremind/core"
(cd packages/core && pnpm publish --access public --no-git-checks --registry "$REGISTRY" ${OTP_FLAG[@]+"${OTP_FLAG[@]}"})

echo "==> publish @accremind/dsh-plugin"
(cd packages/dsh-plugin && pnpm publish --access public --no-git-checks --registry "$REGISTRY" ${OTP_FLAG[@]+"${OTP_FLAG[@]}"})

echo "==> published versions"
npm view @accremind/core version
npm view @accremind/dsh-plugin version

echo "==> refresh the marketplace index from the published manifests"
pnpm market:index --from-npm
node packages/dsh-plugin/scripts/market-index.mjs --check

cat <<'EOS'

Published. Remaining steps:
  1. git add -A && git commit -m "chore(market): refresh the index from the published packages"
  2. git push origin main
  3. index URL to paste into DSH → Plugins → Experimental plugins → Custom plugin indexes:
     https://raw.githubusercontent.com/ninthmonee/AccreMind/main/market/index.json
EOS