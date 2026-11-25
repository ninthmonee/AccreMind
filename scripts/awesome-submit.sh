#!/usr/bin/env bash
# Submit AccreMind to the awesome-dsh-plugin catalog (the source of the public
# catalog behind dsh-market) and set the repository topics its CI requires.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./scripts/awesome-submit.sh
#   GITHUB_TOKEN=ghp_xxx ./scripts/awesome-submit.sh --topic-only
#   GITHUB_TOKEN=ghp_xxx ./scripts/awesome-submit.sh --pr-only
#   ./scripts/awesome-submit.sh --dry-run          # read-only, no token needed
#
# Token scopes -- classic: repo; fine-grained: Contents R/W, Pull requests R/W,
# Administration R/W (topics), Metadata R.
set -euo pipefail

UPSTREAM_OWNER="awesome-dsh-plugin"
UPSTREAM_REPO="awesome-dsh-plugin"
OWNER="ninthmonee"
REPO="AccreMind"
ENTRY_FILE="data/plugins/ninthmonee__AccreMind--packages-dsh-plugin.yml"
BRANCH="add-accremind-dsh-plugin"
API="https://api.github.com"
TOPICS='["dsh-plugin","memory","tools","knowledge-base","deepseek-harness","local-first"]'

MODE="all"
for arg in "$@"; do
  case "$arg" in
    --topic-only) MODE="topic" ;;
    --pr-only) MODE="pr" ;;
    --dry-run) MODE="dry" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

need_token() {
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "GITHUB_TOKEN is required for $1." >&2
    echo "Create one at https://github.com/settings/tokens (classic, scope: repo)." >&2
    exit 2
  fi
}

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS -X "${method}" -H "Authorization: Bearer ${GITHUB_TOKEN}"
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"
    -w '\n%{http_code}')
  if [ -n "${body}" ]; then args+=(-H "Content-Type: application/json" -d "${body}"); fi
  curl "${args[@]}" "${API}${path}"
}

split_code() { printf '%s\n' "$1" | tail -n1; }
split_body() { printf '%s\n' "$1" | sed '$d'; }
ok_code() { case "$1" in 200|201|202|204) return 0 ;; *) return 1 ;; esac; }

entry_content() {
  cat <<'YAML'
url: https://github.com/ninthmonee/AccreMind/tree/main/packages/dsh-plugin
name: ninthmonee/AccreMind#dsh-plugin
category: memory
description:
  en: "Captures engineering experience from a coding session into a local Markdown knowledge base and hands the relevant parts back at the start of each turn; ships a CLI, a standalone workbench and a DeepSeek Harness adapter."
  zh: "把编码过程中的工程经验沉淀成本地 Markdown 知识库，并在每回合开始时把相关的部分交还给模型；带 CLI、独立工作台与 DeepSeek Harness 适配层。"
YAML
}

echo "== 1. read-only checks"
BASE_SHA="$(curl -sS "${API}/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/git/ref/heads/main" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])' 2>/dev/null || true)"
if [ -z "${BASE_SHA}" ]; then echo "cannot read upstream main (network or rate limit)" >&2; exit 1; fi
echo "  upstream main: ${BASE_SHA}"

EXISTING_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${API}/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/contents/${ENTRY_FILE}")"
if [ "${EXISTING_CODE}" = "200" ]; then
  echo "  entry already exists upstream: ${ENTRY_FILE}" >&2
  exit 0
fi
echo "  entry missing upstream (expected): ${EXISTING_CODE}"

NOW_TOPICS="$(curl -sS -H 'Accept: application/vnd.github+json' "${API}/repos/${OWNER}/${REPO}/topics" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("names"))' 2>/dev/null || true)"
echo "  current topics: ${NOW_TOPICS}"

if [ "${MODE}" = "dry" ]; then
  echo
  echo "entry to submit:"
  entry_content
  echo
  echo "dry run finished; re-run with GITHUB_TOKEN to apply."
  exit 0
fi

if [ "${MODE}" != "pr" ]; then
  echo "== 2. repository topics"
  need_token "setting topics"
  RESP="$(api PUT "/repos/${OWNER}/${REPO}/topics" "{\"names\":${TOPICS}}")"
  CODE="$(split_code "${RESP}")"
  if ok_code "${CODE}"; then
    echo "  topics set: ${TOPICS}"
  else
    echo "  FAIL (${CODE})" >&2; split_body "${RESP}" >&2; exit 1
  fi
fi

if [ "${MODE}" = "topic" ]; then exit 0; fi

echo "== 3. fork"
need_token "opening a pull request"
ME="$(api GET "/user" | sed '$d' | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"
echo "  authenticated as: ${ME}"
api POST "/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks" '{"default_branch_only":true}' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${GITHUB_TOKEN}" "${API}/repos/${ME}/${UPSTREAM_REPO}")"
  [ "${code}" = "200" ] && break
  sleep 3
done
echo "  fork: https://github.com/${ME}/${UPSTREAM_REPO}"

echo "== 4. branch ${BRANCH}"
REF_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${GITHUB_TOKEN}" "${API}/repos/${ME}/${UPSTREAM_REPO}/git/ref/heads/${BRANCH}")"
if [ "${REF_CODE}" = "200" ]; then
  echo "  branch already exists, reusing"
else
  RESP="$(api POST "/repos/${ME}/${UPSTREAM_REPO}/git/refs" "{\"ref\":\"refs/heads/${BRANCH}\",\"sha\":\"${BASE_SHA}\"}")"
  if ok_code "$(split_code "${RESP}")"; then echo "  branch created from ${BASE_SHA}"; else split_body "${RESP}" >&2; exit 1; fi
fi

echo "== 5. commit ${ENTRY_FILE}"
CONTENT_B64="$(entry_content | base64 | tr -d '\n')"
BODY="$(python3 - "${ENTRY_FILE}" "${BRANCH}" "${CONTENT_B64}" <<'PY'
import json, sys
path, branch, content = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"message": "Add ninthmonee/AccreMind#dsh-plugin", "content": content, "branch": branch}))
PY
)"
RESP="$(api PUT "/repos/${ME}/${UPSTREAM_REPO}/contents/${ENTRY_FILE}" "${BODY}")"
if ok_code "$(split_code "${RESP}")"; then echo "  committed"; else split_body "${RESP}" >&2; exit 1; fi

echo "== 6. pull request"
PR_BODY='Adds **AccreMind** - a local-first knowledge base for AI-assisted engineering: Markdown as the source of truth, a rebuildable local index, and budgeted injection layers.

- npm: @accremind/dsh-plugin 0.1.0 (published 2026-11-25), depends on @accremind/core 0.1.0
- dsh.bundle (cordis.patch.yml) is declared in packages/dsh-plugin/package.json; this is a monorepo, so url points at the subpackage
- the repository predates this PR by more than a day and carries the dsh-plugin topic
- six conversation tools (accremind_capture, accremind_search, accremind_get, accremind_validate, accremind_export_skill, accremind_propose_doc_change) plus a seven-view workbench; not a meta-package

The CLI (accremind) and the standalone workbench live in the same repo, outside the plugin.'
PR_JSON="$(python3 -c 'import json,sys; print(json.dumps({"title":"Add ninthmonee/AccreMind#dsh-plugin","head":sys.argv[1],"base":"main","body":sys.argv[2]}, ensure_ascii=False))' "${ME}:${BRANCH}" "${PR_BODY}")"
RESP="$(api POST "/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls" "${PR_JSON}")"
PR_URL="$(split_body "${RESP}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("html_url",""))' 2>/dev/null || true)"
if [ -n "${PR_URL}" ]; then
  echo "  PR opened: ${PR_URL}"
else
  split_body "${RESP}" >&2; exit 1
fi
