#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# fnos-hermes-agent-web 发布脚本（GitHub API 版，无需 SSH）
# 创建 Release 并上传资产：
#   - fnos-hermes-agent_v<ver>.fpk          完整安装包
#   - incremental-<prev>-to-<cur>.tar.gz    增量更新包
#   - hot-patch.json                        更新元数据
# 依赖：GITHUB_TOKEN 环境变量（repo + workflow 权限）
# 可选：GH_PROXY（socks5 代理）
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="veenyi/fnos-hermes-agent-web"
GITHUB_TOKEN="${GITHUB_TOKEN:?需要设置 GITHUB_TOKEN 环境变量}"
CURL_BASE=(curl -sS)
if [ -n "${GH_PROXY:-}" ]; then CURL_BASE+=(--socks5 "$GH_PROXY"); fi

CUR_VERSION="$(cat VERSION | tr -d '[:space:]')"
TAG="v$CUR_VERSION"

echo "═══ 发布 $CUR_VERSION 到 $REPO ═══"

# ── 确保 dist 有产物 ───────────────────────────────────────────────
if [ ! -d "dist" ] || [ -z "$(ls dist/ 2>/dev/null)" ]; then
  echo "✗ dist/ 为空，请先运行 scripts/build.sh"
  exit 1
fi

# ── 删除已存在的同 tag release（重建）──────────────────────────────
EXISTING_ID="$(curl -sS ${GH_PROXY:+--socks5 "$GH_PROXY"} \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>/dev/null | grep -m1 '"id"' | grep -oE '[0-9]+' || true)"
if [ -n "$EXISTING_ID" ]; then
  echo "Release 已存在（id=$EXISTING_ID），删除重建"
  curl -sS ${GH_PROXY:+--socks5 "$GH_PROXY"} -X DELETE \
    -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/releases/$EXISTING_ID" >/dev/null 2>&1 || true
fi

# ── 创建 Release ────────────────────────────────────────────────────
RELEASE_BODY="## fnos-hermes-agent $CUR_VERSION

- 官方上游版本: $(echo "$CUR_VERSION" | cut -d- -f1)
- 更新内容: 增量更新（tar 解压），详见 hot-patch.json"

# 用 python 生成 JSON body（避免转义问题）
BODY_JSON="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$RELEASE_BODY" 2>/dev/null || echo '"update"')"

RELEASE_JSON="$(curl -sS ${GH_PROXY:+--socks5 "$GH_PROXY"} -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"fnos-hermes-agent $CUR_VERSION\",\"body\":$BODY_JSON,\"draft\":false,\"prerelease\":false}")"

RELEASE_ID="$(echo "$RELEASE_JSON" | grep -m1 '"id"' | grep -oE '[0-9]+')"
if [ -z "$RELEASE_ID" ]; then
  echo "✗ Release 创建失败: $(echo "$RELEASE_JSON" | head -c 200)"
  exit 1
fi
echo "✓ Release 已创建（id=$RELEASE_ID）"

# ── 上传资产 ────────────────────────────────────────────────────────
for asset in dist/*.fpk dist/incremental-*.tar.gz dist/hot-patch.json; do
  [ -f "$asset" ] || continue
  NAME="$(basename "$asset")"
  echo "── 上传 $NAME ──"
  RESULT="$(curl -sS ${GH_PROXY:+--socks5 "$GH_PROXY"} -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$NAME" \
    --data-binary "@$asset" 2>/dev/null)"
  if echo "$RESULT" | grep -q '"name"'; then
    echo "✓ 上传成功"
  else
    echo "⚠ 上传 $NAME 失败: $(echo "$RESULT" | head -c 150)"
  fi
done

echo ""
echo "═══ 发布完成: https://github.com/$REPO/releases/tag/$TAG ═══"
