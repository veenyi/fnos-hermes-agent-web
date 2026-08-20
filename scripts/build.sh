#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# fnos-hermes-agent-web 构建脚本
# 产出（放入 dist/）：
#   1. fnos-hermes-agent_v<ver>.fpk          完整安装包（含内置 venv，全新安装用）
#   2. incremental-<prev>-to-<cur>.tar.gz    增量更新包（tar 解压）
#   3. hot-patch.json                        更新元数据
#
# 依赖：
#   - upstream/hermes-src   （先运行 sync-upstream.js 克隆上游）
#   - fpk/                   FPK 骨架（manifest/cmd/config/ICON/wizard）
#   - venv-bundle.tar.gz     内置 venv（从已有部署提取，放 fpk/）
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 版本解析 ────────────────────────────────────────────────────────
CUR_VERSION="$(cat VERSION | tr -d '[:space:]')"
OFFICIAL_VER="$(echo "$CUR_VERSION" | cut -d- -f1)"
BUILD_NUM="$(echo "$CUR_VERSION" | sed -E 's/.*build([0-9]+)/\1/i')"

# 上一版本（从 git tag 取最近的非当前 tag）
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
if [ "$PREV_TAG" = "v$CUR_VERSION" ]; then
  # 当前版本已是 tag（可能是手动构建），用 git log 找上一个 tag
  PREV_TAG="$(git tag --sort=-creatordate | grep -v "^v$CUR_VERSION$" | head -1 || echo "")"
fi
PREV_VERSION="${PREV_TAG#v}"
PREV_VERSION="${PREV_VERSION:-}"

echo "═══ 构建 fnos-hermes-agent $CUR_VERSION ═══"
echo "官方版本: $OFFICIAL_VER | Build: $BUILD_NUM | 上一版: ${PREV_VERSION:-无}"

# ── 目录 ────────────────────────────────────────────────────────────
DIST="dist"
BUILD_DIR="build/$CUR_VERSION"
mkdir -p "$DIST" "$BUILD_DIR"

# ── 隐私扫描（强制）─────────────────────────────────────────────────
echo "── 隐私扫描 ──"
PRIV_LEAKS="$(grep -rnE 'password[=:][^ ]{4,}|token[=:][A-Za-z0-9_\-.]{12,}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|/vol[0-9]+/@app(home|data)/|sk-[A-Za-z0-9]{20}' src/ fpk/config/ app/server/ 2>/dev/null | grep -vE '\.pyc|node_modules|app_version|password[:=](password|true|false)|token[:=](token|true|false)' | head -20 || true)"
if [ -n "$PRIV_LEAKS" ]; then
  echo "✗ 隐私扫描发现泄漏："
  echo "$PRIV_LEAKS"
  exit 1
fi
echo "✓ 隐私扫描通过"

# ── 组装应用目录（完整包内容）──────────────────────────────────────
echo "── 组装应用目录 ──"
APP_STAGE="$BUILD_DIR/app"
rm -rf "$APP_STAGE"
mkdir -p "$APP_STAGE"

# 1. server（后端）
cp -r src/server "$APP_STAGE/server"

# 2. desktop-app（桌面端 Web：web-shim + index + i18n + skills）
mkdir -p "$APP_STAGE/desktop-app"
cp src/desktop-app-web-shim.js "$APP_STAGE/desktop-app/web-shim.js"
cp src/desktop-app-index.html "$APP_STAGE/desktop-app/index.html"
if [ -d "src/desktop-app" ]; then
  cp src/desktop-app/i18n-tNRQyTMd.js "$APP_STAGE/desktop-app/assets/i18n-tNRQyTMd.js" 2>/dev/null || true
  cp src/desktop-app/skills-DOyAoEBU.js "$APP_STAGE/desktop-app/assets/skills-DOyAoEBU.js" 2>/dev/null || true
fi

# 3. 上游 hermes-src（CI 克隆后）
if [ -d "upstream/hermes-src" ]; then
  cp -r upstream/hermes-src "$APP_STAGE/hermes-src"
  echo "✓ 上游 hermes-src 已带入"
else
  echo "⚠ 未找到 upstream/hermes-src（仅影响完整包，增量包不受影响）"
fi

# 4. 版本写入
echo "$CUR_VERSION" > "$APP_STAGE/VERSION"
if [ -f "fpk/manifest" ]; then
  sed -i "s/^version.*=.*/version               = $CUR_VERSION/" fpk/manifest
fi

# ── 组装完整 FPK ────────────────────────────────────────────────────
echo "── 打包完整 FPK ──"
# FPK 结构：manifest + app.tgz + cmd + config + ICON + LICENSE + wizard
# app.tgz = 应用部署目录（bin/config/desktop-app/hermes-src/server/ui + venv-bundle.tar.gz）
if [ -d "fpk/cmd" ]; then
  # 生成 app.tgz（含 venv-bundle）
  APP_TGZ_STAGE="$BUILD_DIR/fpk-app"
  rm -rf "$APP_TGZ_STAGE"
  mkdir -p "$APP_TGZ_STAGE"
  cp -r "$APP_STAGE"/* "$APP_TGZ_STAGE/" 2>/dev/null || true
  # 内置 venv：优先 fpk/venv-bundle.tar.gz，其次从 dist 已有完整包提取
  VENV_SRC="fpk/venv-bundle.tar.gz"
  if [ ! -f "$VENV_SRC" ]; then
    # 从已有完整 FPK 提取（app.tgz 内含 venv-bundle.tar.gz）
    OLD_FPK="$(ls dist/fnos-hermes-agent_v*.fpk 2>/dev/null | grep -v "v$CUR_VERSION" | head -1 || true)"
    if [ -n "$OLD_FPK" ]; then
      echo "── 从 $OLD_FPK 提取内置 venv ──"
      (cd "$BUILD_DIR" && tar xzf "$ROOT/$OLD_FPK" app.tgz && tar xzf app.tgz venv-bundle.tar.gz 2>/dev/null && cp venv-bundle.tar.gz "$ROOT/fpk/venv-bundle.tar.gz") || true
      VENV_SRC="fpk/venv-bundle.tar.gz"
    fi
  fi
  if [ -f "$VENV_SRC" ]; then
    cp "$VENV_SRC" "$APP_TGZ_STAGE/"
    echo "✓ 内置 venv 已带入（$(du -sh "$VENV_SRC" | cut -f1)）"
  else
    echo "⚠ 未找到 venv-bundle（完整包不含内置 venv，安装需在线）"
  fi
  # 打包 app.tgz
  tar czf "$BUILD_DIR/app.tgz" -C "$APP_TGZ_STAGE" . 2>/dev/null

  # 组装 FPK
  FPK_STAGE="$BUILD_DIR/fpk-out"
  rm -rf "$FPK_STAGE"
  mkdir -p "$FPK_STAGE"
  cp "$BUILD_DIR/app.tgz" "$FPK_STAGE/"
  cp fpk/manifest "$FPK_STAGE/"
  cp -r fpk/cmd "$FPK_STAGE/"
  cp -r fpk/config "$FPK_STAGE/"
  cp fpk/ICON.PNG fpk/ICON_256.PNG fpk/LICENSE "$FPK_STAGE/" 2>/dev/null || true
  cp -r fpk/wizard "$FPK_STAGE/" 2>/dev/null || true

  # 计算 checksum 并更新 manifest
  APP_MD5="$(md5sum "$FPK_STAGE/app.tgz" | awk '{print $1}')"
  sed -i "s/^checksum.*=.*/checksum              = $APP_MD5/" "$FPK_STAGE/manifest"
  echo "app.tgz checksum: $APP_MD5"

  # 打包 FPK
  tar czf "$DIST/fnos-hermes-agent_v${CUR_VERSION}.fpk" \
    -C "$FPK_STAGE" manifest app.tgz cmd config ICON.PNG ICON_256.PNG LICENSE wizard 2>/dev/null || \
  tar czf "$DIST/fnos-hermes-agent_v${CUR_VERSION}.fpk" \
    -C "$FPK_STAGE" manifest app.tgz cmd config ICON.PNG ICON_256.PNG LICENSE
  echo "✓ 完整 FPK: $DIST/fnos-hermes-agent_v${CUR_VERSION}.fpk"
else
  echo "⚠ 未找到 fpk/cmd，完整 FPK 跳过"
fi

# ── 生成增量更新包 ──────────────────────────────────────────────────
echo "── 生成增量更新包 ──"
if [ -n "$PREV_VERSION" ] && [ "$PREV_TAG" != "v$CUR_VERSION" ]; then
  CHANGED_FILES="$(git diff --name-only "$PREV_TAG" HEAD -- src/ 2>/dev/null || true)"
  if [ -n "$CHANGED_FILES" ]; then
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
    echo "✓ 增量包: incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz"
  else
    echo "⚠ src/ 无变更，跳过增量包"
  fi
else
  echo "⚠ 无上一版本，跳过增量包（首次发布）"
fi

# ── 生成 hot-patch.json ─────────────────────────────────────────────
echo "── 生成 hot-patch.json ──"
if [ -n "$PREV_VERSION" ] && [ -f "$DIST/incremental-${PREV_VERSION}-to-${CUR_VERSION}.tar.gz" ]; then
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
  echo "✓ hot-patch.json 已生成"
else
  echo "⚠ 无增量包，hot-patch.json 跳过"
fi

echo ""
echo "═══ 构建完成 ═══"
ls -la "$DIST/" 2>/dev/null || true
