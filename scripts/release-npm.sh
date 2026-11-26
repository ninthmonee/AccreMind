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
CORE_PACKAGE="@accremind/core"
PLUGIN_PACKAGE="@accremind/dsh-plugin"
TMP_NPMRC=""
TMP_CACHE=""

cleanup() {
  if [ -n "$TMP_NPMRC" ]; then
    rm -f "$TMP_NPMRC"
  fi
  if [ -n "$TMP_CACHE" ]; then
    rm -rf "$TMP_CACHE"
  fi
}
trap cleanup EXIT

if [ -z "${npm_config_cache:-}" ]; then
  TMP_CACHE="$(mktemp -d -t accremind-npm-cache.XXXXXX)"
  npm_config_cache="$TMP_CACHE"
fi
export npm_config_registry="$REGISTRY"
mkdir -p "$npm_config_cache"

auth_token_from_npmrc() {
  local config_file token
  for config_file in \
    "$(npm config get userconfig --registry "$REGISTRY" 2>/dev/null | tr -d '\r\n')" \
    "$(npm config get globalconfig --registry "$REGISTRY" 2>/dev/null | tr -d '\r\n')" \
    "$ROOT/.npmrc"; do
    [ -n "$config_file" ] && [ -f "$config_file" ] || continue
    token="$(awk -F= '$1 == "//registry.npmjs.org/:_authToken" { sub(/^[^=]*=/, ""); print; exit }' "$config_file")"
    token="${token%\"}"
    token="${token#\"}"
    if [ -n "$token" ]; then
      printf '%s' "$token"
      return 0
    fi
  done
}

AUTH_TOKEN="${NPM_TOKEN:-}"
if [ -z "$AUTH_TOKEN" ]; then
  AUTH_TOKEN="$(auth_token_from_npmrc)"
fi

if [ -n "$AUTH_TOKEN" ]; then
  TMP_NPMRC="$(mktemp -t accremind-npmrc.XXXXXX)"
  printf '//registry.npmjs.org/:_authToken=%s\nregistry=%s\n' "$AUTH_TOKEN" "$REGISTRY" > "$TMP_NPMRC"
  chmod 600 "$TMP_NPMRC"
  export npm_config_userconfig="$TMP_NPMRC"
fi

# pnpm does not take the auth token from a userconfig or a project .npmrc: with the
# token only in a config file the publish dies 403 "two-factor authentication or
# granular access token with bypass 2fa enabled is required" (verified three ways).
# Injecting it as a per-registry environment variable for the publish step works.
PUBLISH_ENV=()
if [ -n "$AUTH_TOKEN" ]; then
  PUBLISH_ENV=("npm_config_//registry.npmjs.org/:_authToken=$AUTH_TOKEN" "npm_config_registry=$REGISTRY")
fi

OTP_FLAG=()
if [ -n "${NPM_OTP:-}" ]; then
  OTP_FLAG=(--otp "$NPM_OTP")
fi

cd "$ROOT"

manifest_version() {
  node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version)" "$1"
}

published_exact() {
  local name="$1"
  local version="$2"
  local found
  found="$(npm view "$name@$version" version --registry "$REGISTRY" 2>/dev/null)" || return 1
  [ "$(printf '%s' "$found" | tr -d '[:space:]')" = "$version" ]
}

publish_if_missing() {
  local label="$1"
  local name="$2"
  local version="$3"
  local dir="$4"

  echo "==> $label"
  if published_exact "$name" "$version"; then
    echo "    $name@$version is already on npm; skipping immutable version"
    return 0
  fi
  echo "    publishing $name@$version"
  (cd "$dir" && env ${PUBLISH_ENV[@]+"${PUBLISH_ENV[@]}"} pnpm publish --access public --no-git-checks --registry "$REGISTRY" ${OTP_FLAG[@]+"${OTP_FLAG[@]}"})
}

CORE_VERSION="$(manifest_version "$ROOT/packages/core/package.json")"
PLUGIN_VERSION="$(manifest_version "$ROOT/packages/dsh-plugin/package.json")"
if [ "$CORE_VERSION" != "$PLUGIN_VERSION" ]; then
  cat >&2 <<EOS
Version mismatch:
  $CORE_PACKAGE: $CORE_VERSION
  $PLUGIN_PACKAGE: $PLUGIN_VERSION

Keep both package versions identical before releasing. The plugin depends on the
exact kernel version, so a split release would install against the wrong kernel.
EOS
  exit 1
fi

echo "==> whoami (registry: $REGISTRY)"
if ! whoami_out="$(npm whoami --prefer-online --fetch-timeout=15000 --fetch-retries=0 2>&1)"; then
  cat >&2 <<'EOS'
Not authenticated against registry.npmjs.org.

Do one of these once, then re-run this script:
  a) npm login --registry=https://registry.npmjs.org/
                                (interactive; stores an npmjs.com token in ~/.npmrc)
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
# The committed index must keep pointing at the last published version until both
# packages are live. The release finishes with `market:index --from-npm --check`.
ACCREMIND_RELEASE_ALLOW_PENDING_INDEX=1 pnpm verify

publish_if_missing "$CORE_PACKAGE" "$CORE_PACKAGE" "$CORE_VERSION" "$ROOT/packages/core"
publish_if_missing "$PLUGIN_PACKAGE" "$PLUGIN_PACKAGE" "$PLUGIN_VERSION" "$ROOT/packages/dsh-plugin"

echo "==> verify published versions"
for spec in "$CORE_PACKAGE@$CORE_VERSION" "$PLUGIN_PACKAGE@$PLUGIN_VERSION"; do
  if ! npm view "$spec" version --registry "$REGISTRY"; then
    echo "Registry verification failed for $spec" >&2
    exit 1
  fi
done

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
