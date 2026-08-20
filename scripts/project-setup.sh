#!/usr/bin/env bash
# project-setup.sh — 一条命令注册新项目到 Agent Hub 并生成开工包
# 用法: ./project-setup.sh <project_key> <项目中文名> [描述]
set -euo pipefail

KEY="${1:?用法: $0 <project_key 英文标识> <中文名> [描述]}"
NAME="${2:?缺少项目中文名}"
DESC="${3:-}"
HUB="${AGENTHUB_URL:-http://localhost:8100}"
DASH="${AGENTHUB_DASH:-http://43.155.210.25:3005}"
HUBDIR="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${AGENTHUB_TOKEN:-$(cat "$HUBDIR/.agenthub_token" 2>/dev/null || grep -oP '(?<=auth_token: ")[^"]+' "$HUBDIR/config.yaml")}"
DOCS_DIR="${AGENTHUB_DOCS:-$HUBDIR/docs}"

[ -f "$DOCS_DIR" ] && DOCS_DIR="$HUBDIR"
mkdir -p "$DOCS_DIR"

echo "== 1/2 注册项目 $KEY ($NAME) 到 hub ..."
RESULT=$(curl -s -m 8 -X POST "$HUB/api/projects" \
  -H "Content-Type: application/json" -H "x-auth-token: $TOKEN" \
  -d "{\"key\":\"$KEY\",\"name\":\"$NAME\",\"description\":\"$DESC\"}")
echo "$RESULT"
echo "$RESULT" | grep -q '"code":0' || { echo "❌ 注册失败"; exit 1; }
echo "$RESULT" | grep -q '"existed":true' && echo "(项目已存在，开工包将重新生成)"

OUT="$DOCS_DIR/onboarding-$KEY.md"
echo "== 2/2 生成开工包 $OUT ..."
sed -e "s|{{PROJECT_KEY}}|$KEY|g" \
    -e "s|{{PROJECT_NAME}}|$NAME|g" \
    -e "s|{{HUB_URL}}|$HUB|g" \
    -e "s|{{DASH_URL}}|$DASH|g" \
    -e "s|{{GENERATED_AT}}|$(date '+%Y-%m-%d %H:%M')|g" \
    "$HUBDIR/templates/onboarding-project-template.md" > "$OUT"

echo ""
echo "✅ 完成。交付给任何机器人一句话："
echo "   「读 $OUT（或仓库 docs/onboarding-$KEY.md），按你的角色执行接入三步」"
