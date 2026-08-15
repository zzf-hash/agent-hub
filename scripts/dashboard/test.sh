#!/usr/bin/env bash
# AgentHub 监控面板自测脚本
# 用法: AGENTHUB_TOKEN=xxx bash scripts/dashboard/test.sh
set -u

cd "$(dirname "$0")/../.."
DASH="scripts/dashboard/server.js"
PORT=3997
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ok(){ PASS=$((PASS+1)); echo "  ✅ $1"; }
no(){ FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# ---------- 1. 无 token 必须启动失败 ----------
echo "[1] 无 token 启动 fail-fast"
rm -f /tmp/dash_nodetoken.log
env -u AGENTHUB_TOKEN PORT=$PORT node "$DASH" >/tmp/dash_nodetoken.log 2>&1
CODE=$?
if [ $CODE -ne 0 ]; then ok "退出码非0 ($CODE)"; else no "退出码为0，应报错退出"; fi
grep -q AGENTHUB_TOKEN /tmp/dash_nodetoken.log && ok "报错信息含提示" || no "报错信息缺提示"

# ---------- 2. 正常启动 ----------
echo "[2] 正常启动 (PORT=$PORT)"
TOKEN="${AGENTHUB_TOKEN:?需要环境变量 AGENTHUB_TOKEN}"
AGENTHUB_BASE="${AGENTHUB_BASE:-http://127.0.0.1:8100}"
AGENTHUB_TOKEN="$TOKEN" AGENTHUB_BASE="$AGENTHUB_BASE" PORT=$PORT node "$DASH" >/tmp/dash_run.log 2>&1 &
DASH_PID=$!
sleep 1.2

if kill -0 $DASH_PID 2>/dev/null; then ok "进程存活"; else no "进程启动即退出"; cat /tmp/dash_run.log; exit 1; fi

cleanup(){ kill $DASH_PID 2>/dev/null; wait $DASH_PID 2>/dev/null; }
trap cleanup EXIT

# ---------- 3. 首页 ----------
echo "[3] GET /"
BODY=$(curl -s "$BASE/")
echo "$BODY" | grep -q '<div id="app"' 2>/dev/null || echo "$BODY" | grep -q 'id=app' 2>/dev/null || true
if echo "$BODY" | grep -q 'AgentHub 监控面板'; then ok "返回 HTML 含标题"; else no "HTML 异常"; fi

# ---------- 4. overview ----------
echo "[4] GET /api/overview"
OV=$(curl -s "$BASE/api/overview")
echo "$OV" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['code']==0, 'code!=0'
data=d['data']
assert isinstance(data.get('agents'),list), 'agents 非数组'
assert 'completed' in data.get('taskStats',{}), 'taskStats 无 completed'
assert 'activeTasks' in data and 'historyTasks' in data
print('JSON结构OK')
" && ok "JSON 结构正确（agents数组/taskStats.completed）" || no "JSON 结构异常"

# ---------- 5. events ----------
echo "[5] GET /api/task/<id>/events"
TASK_ID=$(echo "$OV" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
for t in d['historyTasks']+d['activeTasks']:
    print(t['id']); break
" 2>/dev/null)
if [ -n "${TASK_ID:-}" ]; then
  EV=$(curl -s "$BASE/api/task/$TASK_ID/events")
  echo "$EV" | python3 -c "
import sys,json
d=json.load(sys.stdin)
evs=d['data']['events']
assert len(evs)>0, 'events 为空'
print(f'{len(evs)} events')
" && ok "events 返回且>0" || no "events 异常"
else
  no "无任务可测 events"
fi

# ---------- 6. 零依赖检查 ----------
echo "[6] 零依赖约束"
if [ ! -f scripts/dashboard/package-lock.json ] && [ ! -f scripts/dashboard/package.json ]; then ok "无 package/lock 文件"; else no "存在 package 文件"; fi
NODE_MODS=$(grep -cE "require\(['\"](?!\.|node:)" "$DASH" 2>/dev/null || true)
BUILTIN=$(grep -oE "require\('[a-z_]+'\)" "$DASH" | grep -vE "require\('(http|fs|path)'\)" | head -3)
if [ -z "$BUILTIN" ]; then ok "仅内置模块 http/fs/path"; else no "发现非内置require: $BUILTIN"; fi

echo ""
echo "=============================="
echo "PASS: $PASS  FAIL: $FAIL"
[ $FAIL -eq 0 ] && echo "ALL PASS ✅" || { echo "存在失败 ❌"; exit 1; }
