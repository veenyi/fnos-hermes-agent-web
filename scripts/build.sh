#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# fnos-hermes-agent-web 构建脚本
# 产出：
#   1. fnos-hermes-agent_v<ver>.fpk          — 完整安装包（全新安装）
#   2. incremental-v<prev>-to-v<cur>.tar.gz  — 增量更新包（tar 解压）
#   3. hot-patch.json                        — 更新元数据
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 版本解析 ────────────────────────────────────────────────────────
# VERSION 格式: <official>-build<NN>，如 0.20.4-build30
CUR_VERSION="$(cat VERSION | tr -d '[:space:]')"
OFFICIAL_VER="$(echo "$CUR_VERSION" | cut -d- -f1)"
BUILD_NUM="$(echo "$CUR_VERSION" | sed -E 's/.*build([0-9]+)/\1/i')"

# 上一版本（从 git tag 取，无则用当前）
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
PREV_VERSION="${PREV_TAG#v}"
PREV_VERSION="${PREV_VERSION:-$CUR_VERSION}"

echo "═══ 构建 fnos-hermes-agent $CUR_VERSION ═══"
echo "官方版本: $OFFICIAL_VER | Build: $BUILD_NUM | 上一版: $PREV_VERSION"

# ── 目录 ────────────────────────────────────────────────────────────
DIST="dist"
BUILD_DIR="build/$CUR_VERSION"
mkdir -p "$DIST" "$BUILD_DIR"

# ── 隐私扫描（强制）─────────────────────────────────────────────────
echo "── 隐私扫描 ──"
# 排除公开仓库名 veenyi/fnos-hermes-agent-web（项目标识）与 app_version 路径（部署约定）
PRIV_LEAKS="$(grep -rnE 'password[=:][^ ]{4,}|token[=:][A-Za-z0-9_\-.]{12,}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|/vol[0-9]+/@app(home|data)/|sk-[A-Za-z0-9]{20}' src/ fpk/config/ app/server/ 2>/dev/null | grep -vE '\.pyc|node_modules|app_version' | head -20 || true)"
if [ -n "$PRIV_LEAKS" ]; then
  echo "✗ 隐私扫描发现泄漏："
  echo "$PRIV_LEAKS"
  exit 1
fi
echo "✓ 隐私扫描通过"

# ── 组装应用目录（完整包内容）──────────────────────────────────────
# 从 src/ 复制自定义文件 + 从上游/编译产物复制
APP_STAGE="$BUILD_DIR/app"
mkdir -p "$APP_STAGE"
cp -r src/server "$APP_STAGE/server" 2>/dev/null || true
cp -r src/ui "$APP_STAGE/ui" 2>/dev/null || true

# 桌面端 Web（desktop-app）：web-shim 汉化层 + index.html 注入
mkdir -p "$APP_STAGE/desktop-app"
cp src/desktop-app-web-shim.js "$APP_STAGE/desktop-app/web-shim.js"
cp src/desktop-app-index.html "$APP_STAGE/desktop-app/index.html"

# 上游 hermes-src（需先 sync-upstream.sh 拉取）
if [ -d "upstream/hermes-src" ]; then
  cp -r upstream/hermes-src "$APP_STAGE/hermes-src"
  echo "✓ 上游 hermes-src 已带入"
else
  echo "⚠ 未找到 upstream/hermes-src，请先运行 scripts/sync-upstream.sh"
fi

# ── 版本写入 ────────────────────────────────────────────────────────
echo "$CUR_VERSION" > "$APP_STAGE/VERSION"
# manifest 版本 = 官方版本（fnOS 应用中心显示）
if [ -f "$APP_STAGE/manifest" ]; then
  sed -i "s/^version.*=.*/version               = $OFFICIAL_VER/" "$APP_STAGE/manifest"
fi

# ── 打包完整 FPK ────────────────────────────────────────────────────
echo "── 打包完整 FPK ──"
# 注：完整 FPK 需要 venv-bundle（180MB 内置 venv）与 cmd/config 等，
# 这些由 fpk-build 目录提供（脱敏后的 fnOS 应用包骨架）
if [ -d "fpk-build" ]; then
  tar czf "$DIST/fnos-hermes-agent_v${CUR_VERSION}.fpk" \
    -C fpk-build manifest app.tgz cmd config ICON.PNG ICON_256.PNG LICENSE wizard 2>/dev/null || \
  echo "⚠ 完整 FPK 打包跳过（缺 fpk-build 骨架）"
else
  echo "⚠ 未找到 fpk-build，完整 FPK 跳过（增量更新不受影响）"
fi

# ── 生成增量更新包 ──────────────────────────────────────────────────
echo "── 生成增量更新包 ──"
# 对比当前 git 树与上一 tag 的 src/ 变更文件，打成 tar.gz
# 变更文件 = git diff 的 src/ 部分；tar 内路径 = 部署相对路径：
#   src/server/monitor.js        → server/monitor.js        （APP_DIR/server/）
#   src/desktop-app-web-shim.js  → desktop-app/web-shim.js  （APP_DIR/desktop-app/）
#   src/desktop-app-index.html   → desktop-app/index.html
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v$CUR_VERSION" ]; then
  CHANGED_FILES="$(git diff --name-only "$PREV_TAG" HEAD -- src/ 2>/dev/null || true)"
  if [ -n "$CHANGED_FILES" ]; then
    # 构建 staging 目录，映射 src/ → 部署路径
    INC_STAGE="$BUILD_DIR/inc-stage"
    rm -rf "$INC_STAGE"
    mkdir -p "$INC_STAGE"
    for f in $CHANGED_FILES; do
      case "$f" in
        src/server/*)      DEST="$INC_STAGE/server/$(basename "$f")" ;;
        src/desktop-app-web-shim.js) DEST="$INC_STAGE/desktop-app/web-shim.js" ;;
        src/desktop-app-index.html)  DEST="$INC_STAGE/desktop-app/index.html" ;;
        src/desktop-app/*) DEST="$INC_STAGE/desktop-app/$(basename "$f")" ;;
        src/ui/*)          DEST="$INC_STAGE/ui/$(basename "$f")" ;;
        *)                 DEST="$INC_STAGE/$(basename "$f")" ;;
      esac
      mkdir -p "$(dirname "$DEST")"
      cp "$f" "$DEST"
    done
    tar czf "$DIST/incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz" -C "$INC_STAGE" .
    echo "✓ 增量包: incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz ($CHANGED_FILES 文件)"
  else
    echo "⚠ src/ 无变更，跳过增量包"
  fi
else
  echo "⚠ 无上一版本 tag，跳过增量包（首次发布）"
fi

# ── 生成 hot-patch.json ─────────────────────────────────────────────
echo "── 生成 hot-patch.json ──"
if [ -f "$DIST/incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz" ]; then
  ARCHIVE_MD5="$(md5sum "$DIST/incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz" | awk '{print $1}')"
  cat > "$DIST/hot-patch.json" << JSONEOF
{
  "version": "$CUR_VERSION",
  "base_version": "$PREV_VERSION",
  "archive": "incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz",
  "archive_md5": "$ARCHIVE_MD5",
  "files": []
}
JSONEOF
  echo "✓ hot-patch.json 已生成（tar 增量模式）"
else
  echo "⚠ 无增量包，hot-patch.json 跳过"
fi

echo ""
echo "═══ 构建完成 ═══"
ls -la "$DIST/" 2>/dev/null || true
