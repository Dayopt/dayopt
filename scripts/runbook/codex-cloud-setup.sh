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
PNPM_RUNNER=()

resolve_pnpm_runner() {
  PNPM_RUNNER=()
  if command -v pnpm >/dev/null 2>&1; then
    local direct_version
    direct_version="$(pnpm --version 2>/dev/null || true)"
    if [[ "$direct_version" == "$EXPECTED_PNPM_VERSION" ]]; then
      PNPM_RUNNER=(pnpm)
      return 0
    fi
  fi
  if command -v corepack >/dev/null 2>&1; then
    local corepack_version
    corepack_version="$(corepack pnpm --version 2>/dev/null || true)"
    if [[ "$corepack_version" == "$EXPECTED_PNPM_VERSION" ]]; then
      PNPM_RUNNER=(corepack pnpm)
      return 0
    fi
  fi
  return 1
}

install_pnpm_with_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    return 1
  fi
  # Node 24 の Corepack shim は未取得の pnpm をレジストリから取得する。
  # Cloud の Corepack 経路が失敗しても、npm の global install で固定版を導入する。
  npm install --global --force "pnpm@${EXPECTED_PNPM_VERSION}"
}

if ! resolve_pnpm_runner; then
  if ! install_pnpm_with_npm && command -v corepack >/dev/null 2>&1; then
    corepack install --global "pnpm@${EXPECTED_PNPM_VERSION}"
  elif ! command -v npm >/dev/null 2>&1 && ! command -v corepack >/dev/null 2>&1; then
    echo "pnpm@${EXPECTED_PNPM_VERSION} is required, but Corepack and npm are unavailable." >&2
    exit 1
  fi
  if ! resolve_pnpm_runner; then
    echo "Expected pnpm@${EXPECTED_PNPM_VERSION}; no matching pnpm or Corepack entrypoint is available." >&2
    exit 1
  fi
fi

if [[ "${PNPM_RUNNER[*]}" == "corepack pnpm" ]]; then
  COREPACK_BIN="$(command -v corepack || true)"
  if [[ -n "$COREPACK_BIN" ]]; then
    COREPACK_DIR="${COREPACK_BIN%/*}"
    if corepack enable --install-directory "$COREPACK_DIR" pnpm; then
      hash -r 2>/dev/null || true
      resolve_pnpm_runner || true
    fi
  fi
fi

if [[ "${PNPM_RUNNER[*]}" != "pnpm" ]]; then
  install_pnpm_with_npm || true
  hash -r 2>/dev/null || true
  resolve_pnpm_runner || true
fi

if [[ "${PNPM_RUNNER[*]}" != "pnpm" ]]; then
  echo "Expected pnpm@${EXPECTED_PNPM_VERSION}; bare pnpm shim is unavailable after setup." >&2
  exit 1
fi

"${PNPM_RUNNER[@]}" install --frozen-lockfile
