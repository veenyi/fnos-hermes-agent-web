#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# fnos-hermes-agent-web 发布脚本
# 创建 GitHub Release 并上传资产：
#   - fnos-hermes-agent_v<ver>.fpk          完整安装包
#   - incremental-<prev>-to-<cur>.tar.gz    增量更新包
#   - hot-patch.json                        更新元数据
# 依赖：GITHUB_TOKEN 环境变量（repo + workflow 权限）
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="veenyi/fnos-hermes-agent-web"
GITHUB_TOKEN="${GITHUB_TOKEN:?需要设置 GITHUB_TOKEN 环境变量}"

CUR_VERSION="$(cat VERSION | tr -d '[:space:]')"
TAG="v$CUR_VERSION"

echo "═══ 发布 $CUR_VERSION 到 $REPO ═══"

# ── 确保 dist 有产物 ───────────────────────────────────────────────
if [ ! -d "dist" ] || [ -z "$(ls dist/ 2>/dev/null)" ]; then
  echo "✗ dist/ 为空，请先运行 scripts/build.sh"
  exit 1
fi

# ── git 提交 ────────────────────────────────────────────────────────
git add -A
if ! git diff --cached --quiet; then
  git commit -m "release: $CUR_VERSION" --allow-empty
  echo "✓ 已提交"
fi

# ── 推送 ────────────────────────────────────────────────────────────
git push origin HEAD:main 2>&1 | head -5 || echo "⚠ 推送失败（首次推送需先建远程仓库）"

# ── 创建/更新 tag ──────────────────────────────────────────────────
if git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -d "$TAG" && git push origin ":refs/tags/$TAG" 2>/dev/null || true
fi
git tag "$TAG"
git push origin "$TAG" 2>&1 | head -3 || echo "⚠ tag 推送失败"

# ── 创建 Release ────────────────────────────────────────────────────
# 检查是否已存在同 tag release
EXISTING_ID="$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/releases/tags/$TAG" | grep '"id"' | head -1 | grep -oE '[0-9]+' || true)"

RELEASE_BODY="## fnos-hermes-agent $CUR_VERSION

- 官方上游版本: $(echo "$CUR_VERSION" | cut -d- -f1)
- 更新内容: $(git log --oneline -5 2>/dev/null | head -5 | tr '\n' ' ' || echo '增量更新')"

if [ -n "$EXISTING_ID" ]; then
  echo "Release 已存在（id=$EXISTING_ID），删除重建"
  curl -s -X DELETE -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/releases/$EXISTING_ID" >/dev/null
fi

RELEASE_JSON="$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"fnos-hermes-agent $CUR_VERSION\",\"body\":$(echo "$RELEASE_BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '"update"'),\"draft\":false,\"prerelease\":false}")"

RELEASE_ID="$(echo "$RELEASE_JSON" | grep '"id"' | head -1 | grep -oE '[0-9]+')"
if [ -z "$RELEASE_ID" ]; then
  echo "✗ Release 创建失败: $RELEASE_JSON" | head -5
  exit 1
fi
echo "✓ Release 已创建（id=$RELEASE_ID）"

# ── 上传资产 ────────────────────────────────────────────────────────
for asset in dist/*.fpk dist/incremental-*.tar.gz dist/hot-patch.json; do
  [ -f "$asset" ] || continue
  NAME="$(basename "$asset")"
  echo "── 上传 $NAME ──"
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$NAME" \
    --data-binary "@$asset" | grep -o '"name":"[^"]*"' | head -1 || echo "⚠ 上传 $NAME 失败"
done

echo ""
echo "═══ 发布完成: https://github.com/$REPO/releases/tag/$TAG ═══"
