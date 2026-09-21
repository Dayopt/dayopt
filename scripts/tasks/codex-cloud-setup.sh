#!/usr/bin/env bash

# Codex Cloud の自動 package-manager detection は workspace ごとに npm を
# 実行することがあり、pnpm の `catalog:` / `workspace:` を解釈できない。
# この script はリポジトリ全体を pnpm の lockfile から一度だけ構成する。
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

EXPECTED_NODE_MAJOR="$(tr -d '[:space:]' < .nvmrc | sed -E 's/[^0-9].*//')"
ACTUAL_NODE_VERSION="$(node --version)"
ACTUAL_NODE_MAJOR="${ACTUAL_NODE_VERSION#v}"
ACTUAL_NODE_MAJOR="${ACTUAL_NODE_MAJOR%%.*}"

if [[ -z "$EXPECTED_NODE_MAJOR" || "$ACTUAL_NODE_MAJOR" != "$EXPECTED_NODE_MAJOR" ]]; then
  echo "Codex Cloud setup requires Node.js ${EXPECTED_NODE_MAJOR}.x; found ${ACTUAL_NODE_VERSION}." >&2
  exit 1
fi

EXPECTED_PNPM_VERSION="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")"

get_pnpm_version() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm --version 2>/dev/null || true
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm --version 2>/dev/null || true
  fi
}

ACTUAL_PNPM_VERSION="$(get_pnpm_version)"
if [[ "$ACTUAL_PNPM_VERSION" != "$EXPECTED_PNPM_VERSION" ]]; then
  if command -v npm >/dev/null 2>&1; then
    # Node 24 の Corepack shim は未取得の pnpm をレジストリから取得する。
    # Cloud の Corepack 経路が失敗しても、npm の global install で固定版を導入する。
    npm install --global --force "pnpm@${EXPECTED_PNPM_VERSION}"
  elif command -v corepack >/dev/null 2>&1; then
    corepack install --global "pnpm@${EXPECTED_PNPM_VERSION}"
  else
    echo "pnpm@${EXPECTED_PNPM_VERSION} is required, but Corepack and npm are unavailable." >&2
    exit 1
  fi
  ACTUAL_PNPM_VERSION="$(get_pnpm_version)"
fi

if [[ "$ACTUAL_PNPM_VERSION" != "$EXPECTED_PNPM_VERSION" ]]; then
  echo "Expected pnpm@${EXPECTED_PNPM_VERSION}; found ${ACTUAL_PNPM_VERSION:-unavailable}." >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm install --frozen-lockfile
else
  echo "pnpm@${EXPECTED_PNPM_VERSION} is unavailable after setup." >&2
  exit 1
fi
