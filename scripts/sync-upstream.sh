#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# fnos-hermes-agent-web 上游同步脚本
# 检测官方 NousResearch/hermes-agent 新版本，拉取 hermes-src 源码
# 版本规则：官方版本变化 → 重新 Build V01；不变 → Build +1
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REPO="NousResearch/hermes-agent"
UPSTREAM_DIR="upstream"

echo "═══ 同步上游 $UPSTREAM_REPO ═══"

# ── 获取官方最新版本 ────────────────────────────────────────────────
# 方式1: GitHub API latest release（需网络）
LATEST_VER=""
if command -v curl >/dev/null 2>&1; then
  LATEST_VER="$(curl -s --max-time 15 "https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"v?([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
fi

# 方式2: pyproject.toml（上游仓库已 clone 时）
if [ -z "$LATEST_VER" ] && [ -d "$UPSTREAM_DIR/hermes-src" ]; then
  LATEST_VER="$(grep -m1 '^version' "$UPSTREAM_DIR/hermes-src/pyproject.toml" 2>/dev/null | sed -E 's/.*"([0-9.]+)".*/\1/')"
fi

if [ -z "$LATEST_VER" ]; then
  echo "⚠ 无法获取官方最新版本，请检查网络或手动设置 UPSTREAM_VERSION"
  exit 1
fi
echo "官方最新版本: $LATEST_VER"

# ── 当前 Build 版本 ─────────────────────────────────────────────────
CUR_VERSION="$(cat VERSION | tr -d '[:space:]')"
CUR_OFFICIAL="$(echo "$CUR_VERSION" | cut -d- -f1)"
CUR_BUILD="$(echo "$CUR_VERSION" | sed -E 's/.*build([0-9]+)/\1/i')"

# ── 版本决策 ────────────────────────────────────────────────────────
NEW_VERSION=""
if [ "$LATEST_VER" != "$CUR_OFFICIAL" ]; then
  # 官方升级 → 新 Build 从 V01 开始
  NEW_VERSION="${LATEST_VER}-build01"
  echo "官方版本变化: $CUR_OFFICIAL → $LATEST_VER → 重置 Build V01"
else
  # 官方不变 → Build +1
  NEW_BUILD=$((10#$CUR_BUILD + 1))
  NEW_VERSION="${CUR_OFFICIAL}-build$(printf '%02d' $NEW_BUILD)"
  echo "官方版本不变: Build V$CUR_BUILD → V$(printf '%02d' $NEW_BUILD)"
fi

echo "新版本: $NEW_VERSION"

# ── 拉取上游源码 ────────────────────────────────────────────────────
if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  echo "── 克隆上游（浅克隆，仅最新）──"
  git clone --depth 1 "https://github.com/${UPSTREAM_REPO}.git" "$UPSTREAM_DIR"
else
  echo "── 拉取上游更新 ──"
  (cd "$UPSTREAM_DIR" && git fetch --depth 1 origin && git reset --hard origin/master 2>/dev/null || git reset --hard origin/main 2>/dev/null)
fi

# ── 更新 VERSION ────────────────────────────────────────────────────
echo "$NEW_VERSION" > VERSION
echo "VERSION → $NEW_VERSION"
echo ""
echo "═══ 同步完成，请运行 scripts/build.sh 构建 ═══"
