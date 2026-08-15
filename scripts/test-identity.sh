#!/usr/bin/env bash
# =============================================================
# Agent Hub v2.1 身份机制修复 — 隔离实例测试套件
# 任务 4a6e126b-64a1-44ce-ac8c-f5aab16e5522 验收测试 T1–T5
# 用法: bash scripts/test-identity.sh
# 依赖: node + better-sqlite3 (仓库 node_modules)；本机无 sqlite3 CLI，用 node 代替
# =============================================================
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PORT=8199
BASE="http://localhost:$PORT"
DB="/tmp/hub-test.sqlite"
TOKEN="test-token-identity-2601"

PASS=0; FAIL=0
ok()   { echo "  ✔ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✘ $1"; FAIL=$((FAIL+1)); }
section(){ echo; echo "=== $1 ==="; }

# A4: trap 清理——脚本任何退出路径（含中断/断言失败）都杀掉隔离实例进程、清理 /tmp 残留
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -f "$DB" "$DB-wal" "$DB-shm" /tmp/hub-test.log /tmp/hub-coldstart.log 2>/dev/null
}
trap cleanup EXIT INT TERM

# node 版 sqlite3 查询助手（替代 sqlite3 CLI）：输出裸值（字符串不带引号）
sq() { node -e "
const D=require('better-sqlite3');
const db=new D(process.argv[2]||'$DB',{readonly:true});
try{ const r=db.prepare(process.argv[1]).get(); const v=r?Object.values(r)[0]:null; console.log(v===null?'NULL':v); }
catch(e){ console.log('ERR:'+e.message); }
" "$1" "${2:-$DB}"; }

jq_get() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=process.argv[1].split('.').reduce((o,k)=>o==null?o:o[k],j);console.log(v===undefined?'undefined':(typeof v==='object'?JSON.stringify(v):v));}catch(e){console.log('PARSE_ERR')}})" "$1"; }

# ---------- 0. 准备隔离实例 ----------
section "T0 启动隔离实例 (PORT=$PORT DB=$DB)"
rm -f "$DB" "$DB-wal" "$DB-shm"
HUB_AUTH_TOKEN="$TOKEN" PORT=$PORT HUB_DB="$DB" HUB_WEBHOOK_URL="" node server.js > /tmp/hub-test.log 2>&1 &
SRV_PID=$!
sleep 1.2

HEALTH=$(curl -s "$BASE/health" | jq_get data.version)
if [ "$HEALTH" = "2.1.2" ]; then ok "health version=$HEALTH"; else bad "health version=$HEALTH (期望 2.1.2)"; cat /tmp/hub-test.log; fi

# 不带 token 应 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/agents")
[ "$CODE" = "401" ] && ok "无token访问401" || bad "无token访问返回$CODE(期望401)"

H() { curl -s -H "x-auth-token: $TOKEN" "$@"; }   # 带鉴权的 curl
reg() { H -X POST $BASE/api/register -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"role\":\"$2\",\"project\":\"yiyuan\"}" | jq_get data.agent_id; }

# ---------- T1 替换不可复活 ----------
section "T1 被替换agent不可复活（同角色双在线根因）"
X=$(reg agentX backend)
Y=$(reg agentY backend)
[ -n "$X" ] && [ "$X" != "undefined" ] && ok "register X=$X" || { bad "register X 失败"; }
[ -n "$Y" ] && [ "$Y" != "undefined" ] && ok "register Y=$Y（X 被替换）" || { bad "register Y 失败"; }
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
[ "$ST" = "replaced" ] && ok "X 状态=replaced（墓碑已写入）" || bad "X 状态=$ST（期望 replaced）"
# X 拉消息（旧轮询进程行为）→ 不得复活
H "$BASE/api/messages/$X" > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
[ "$ST" = "replaced" ] && ok "T1a X拉消息后仍 replaced（未复活）" || bad "T1a X拉消息后变成 $ST（复活了！）"
# X 心跳 → 不得复活
H -X POST $BASE/mcp/tools/heartbeat -H 'Content-Type: application/json' -d "{\"from_id\":\"$X\"}" > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
[ "$ST" = "replaced" ] && ok "T1b X心跳后仍 replaced（未复活）" || bad "T1b X心跳后变成 $ST（复活了！）"
# 在线列表不含 X
H "$BASE/api/agents" | grep -q "$X" && bad "T1c X 仍出现在在线列表" || ok "T1c X 不在在线列表"
# replaced_at 时间戳已写
RA=$(sq "SELECT replaced_at FROM agents WHERE id='$X'")
[ -n "$RA" ] && [ "$RA" != "NULL" ] && ok "T1d replaced_at=$RA" || bad "T1d replaced_at 未写入"

# ---------- T2 超时可复活 ----------
section "T2 真超时offline可复活（保留2cfe52d语义）"
Z=$(reg agentZ backend)
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE agents SET status='offline' WHERE id=?\").run('$Z');"
ST=$(sq "SELECT status FROM agents WHERE id='$Z'")
[ "$ST" = "offline" ] && ok "Z 手动置 offline（模拟5min清扫）" || bad "Z 置 offline 失败: $ST"
H "$BASE/api/messages/$Z" > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$Z'")
[ "$ST" = "online" ] && ok "T2 Z拉消息后复活 online" || bad "T2 Z拉消息后为 $ST（应复活）"

# ---------- T3 认领绑定 ----------
section "T3 pending→in_progress 认领绑定 assigned_id"
M=$(reg PM-test manager)
TASK=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan\",\"title\":\"T3测试任务\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
# 注：to_role=frontend 避免在线 backend 被自动指派，验证「从空 assigned_id 认领绑定」
[ -n "$TASK" ] && [ "$TASK" != "undefined" ] && ok "manager建任务 $TASK（to_role=frontend，assigned_id 初始为空）" || bad "建任务失败"
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$TASK'")
[ "$AID" = "NULL" ] && ok "初始 assigned_id=NULL" || bad "初始 assigned_id=$AID"
# frontend agent F 认领
F=$(reg agentF frontend)
H -X PUT $BASE/api/tasks/$TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$F\",\"status\":\"in_progress\"}" > /dev/null
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$TASK'")
[ "$AID" = "$F" ] && ok "T3a assigned_id 已绑定 F（认领人回写）" || bad "T3a assigned_id=$AID（期望 $F）"
EV=$(sq "SELECT COUNT(*) FROM task_events WHERE task_id='$TASK' AND event='claimed'")
[ "$EV" = "1" ] && ok "T3b events 有 claimed 事件" || bad "T3b claimed 事件数=$EV（期望1）"

# ---------- T4 认领互斥 ----------
section "T4 认领互斥 + manager强制流转"
# 注意：同项目同角色注册会顶掉旧身份（F→replaced），此时 F2 操作走“接管”而非互斥。
# 互斥拒绝的正确场景：异角色（QA）操作仍在线认领人（agentF）的任务。
QA=$(reg agentQA qa)
RESP=$(H -X PUT $BASE/api/tasks/$TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$QA\",\"status\":\"in_review\"}")
echo "$RESP" | grep -q "已由 agentF 认领" && ok "T4a QA被拒（错误信息含认领人名字）" || bad "T4a QA未被正确拒绝: $RESP"
ST=$(sq "SELECT status FROM tasks WHERE id='$TASK'")
[ "$ST" = "in_progress" ] && ok "T4b 任务状态未被篡改（仍 in_progress）" || bad "T4b 状态被改: $ST"
RESP=$(H -X PUT $BASE/api/tasks/$TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"in_review\"}")
echo "$RESP" | grep -q '"code":0' && ok "T4c manager 强制流转成功" || bad "T4c manager 流转失败: $RESP"

# ---------- T4d/e/f 死亡身份接管 + 僵尸守卫（v2.1.1）----------
section "T4d/e/f 死亡身份接管 + 僵尸守卫"
# 用独立项目 yiyuan2 隔离，避免与前面的 agentF/frontend 身份链互相顶替
RTK=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan2\",\"title\":\"T4d接管测试\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
FO=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontOld","role":"frontend","project":"yiyuan2"}' | jq_get data.agent_id)
FN=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontNew","role":"frontend","project":"yiyuan2"}' | jq_get data.agent_id)
ST=$(sq "SELECT status FROM agents WHERE id='$FO'")
[ "$ST" = "replaced" ] && ok "T4d-0 frontOld 被 frontNew 替换为 replaced" || bad "T4d-0 frontOld状态=$ST"
# frontOld（僵尸身份）直接操作 → 应被僵尸守卫拒绝
RESP=$(H -X PUT $BASE/api/tasks/$RTK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FO\",\"status\":\"in_progress\"}")
echo "$RESP" | grep -q '"code":1' && ok "T4f 僵尸身份操作任务被拒" || bad "T4f 僵尸身份未被拒: $RESP"
# frontNew（同角色新身份）认领 → 绑定（auto-bind 或 claimed/takeover 任一路径，终态都是 FN）
H -X PUT $BASE/api/tasks/$RTK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FN\",\"status\":\"in_progress\"}" > /dev/null
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$RTK'")
[ "$AID" = "$FN" ] && ok "T4d-1 frontNew 认领绑定" || bad "T4d-1 assigned_id=$AID（期望 $FN）"
# 模拟历史任务：把 assigned_id 手动绑到已死的 frontOld
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE tasks SET assigned_id=? WHERE id=?\").run('$FO','$RTK');"
# 异角色（backend）不得接管死亡 assignee 的 frontend 任务
BKO=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"bkrTakeover","role":"backend","project":"yiyuan2"}' | jq_get data.agent_id)
RESP=$(H -X PUT $BASE/api/tasks/$RTK -H 'Content-Type: application/json' -d "{\"from_id\":\"$BKO\",\"status\":\"in_review\"}")
echo "$RESP" | grep -q '"code":1' && ok "T4e 异角色接管死亡assignee被拒" || bad "T4e 异角色未被拒: $RESP"
# frontNew（同项目同角色）操作已死 assignee 的任务 → 接管重绑成功
RESP=$(H -X PUT $BASE/api/tasks/$RTK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FN\",\"status\":\"in_review\"}")
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$RTK'")
[ "$AID" = "$FN" ] && ok "T4d-2 死亡assignee被同角色接管重绑" || bad "T4d-2 接管失败 assigned_id=$AID resp=$RESP"
EVT=$(sq "SELECT COUNT(*) FROM task_events WHERE task_id='$RTK' AND event='takeover'")
[ "$EVT" = "1" ] && ok "T4d-3 events 有 takeover 事件" || bad "T4d-3 takeover事件数=$EVT（期望1）"

# ---------- T5 回归 ----------
section "T5 PM现有调用模式回归"
RESP=$(H -X POST $BASE/mcp/tools/heartbeat -H 'Content-Type: application/json' -d "{\"from_id\":\"$F\"}")
echo "$RESP" | grep -q '"code":0' && ok "T5a heartbeat(from_id) OK" || bad "T5a heartbeat失败: $RESP"
RESP=$(H "$BASE/api/messages/$F")
echo "$RESP" | grep -q '"code":0' && ok "T5b messages轮询 OK" || bad "T5b messages失败: $RESP"
RESP=$(H "$BASE/api/tasks?project=yiyuan&status=in_review")
echo "$RESP" | grep -q '"code":0' && ok "T5c tasks过滤 OK" || bad "T5c tasks过滤失败: $RESP"
RESP=$(H -X POST $BASE/api/send_message -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"from_role\":\"manager\",\"to_role\":\"backend\",\"project\":\"yiyuan\",\"content\":\"T5消息\"}")
echo "$RESP" | grep -q '"code":0' && ok "T5d send_message(to_role) OK" || bad "T5d send_message失败: $RESP"
# review approve（PM 实际用 approve:true 形式）
# 注：前面 T4 里 F2 注册把 F 顶成 replaced（F 的流转会静默失败），这里任务由 M 直接建并流转
RT=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan\",\"title\":\"T5审核测试\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
H -X PUT $BASE/api/tasks/$RT -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"in_progress\"}" > /dev/null
H -X PUT $BASE/api/tasks/$RT -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"in_review\"}" > /dev/null
NST=$(sq "SELECT status FROM tasks WHERE id='$RT'")
[ "$NST" = "in_review" ] || bad "T5前置失败：任务未到 in_review（$NST），检查 manager 流转"
RESP=$(H -X POST $BASE/api/tasks/$RT/review -H 'Content-Type: application/json' -d "{\"reviewer_id\":\"$M\",\"approve\":true,\"comment\":\"ok\"}")
echo "$RESP" | grep -q '"code":0' && ok "T5e review(approve:true) OK" || bad "T5e review失败: $RESP"
NST=$(sq "SELECT status FROM tasks WHERE id='$RT'")
[ "$NST" = "testing" ] && ok "T5f approve后进入 testing" || bad "T5f approve后状态=$NST（期望testing）"
# SSE/长轮询路由仍可用（挂1秒超时返回空列表）
CODE=$(H -o /dev/null -w '%{http_code}' "$BASE/api/messages/$F?wait=1")
[ "$CODE" = "200" ] && ok "T5g 长轮询端点可用" || bad "T5g 长轮询返回$CODE"

# ---------- T6 offline 旁路修复（v2.1.2 A1）----------
section "T6 offline 不得降级 replaced 墓碑"
# X 已在 T1 被 Y 替换为 replaced；对其调 offline（tools.offline 与 POST /api/offline/:id 同路径）
RESP=$(H -X POST $BASE/api/offline/$X)
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
if [ "$ST" = "replaced" ]; then ok "T6a X被替换后调offline仍 replaced"; else bad "T6a offline把墓碑降级成 $ST（旁路复活漏洞！）"; fi
echo "$RESP" | grep -q '不可置 offline\|replaced' && ok "T6b offline返回拒绝提示" || bad "T6b offline响应无拒绝语义: $RESP"
# 对照：online 身份 offline 仍正常（注：T2 里 Z 注册时顶掉了 Y，用新鲜注册的 online 身份验证）
Z2=$(reg agentZ2 backend)
RESP=$(H -X POST $BASE/api/offline/$Z2)
ST=$(sq "SELECT status FROM agents WHERE id='$Z2'")
[ "$ST" = "offline" ] && ok "T6c 正常online身份offline成功" || bad "T6c online身份offline失败: $ST resp=$RESP"

# ---------- T7 替换移交（v2.1.2 A3）----------
section "T7 同名重注册移交未终态任务"
# F2 持任务 in_progress → 同名同角色重注册 F2' → 任务应移交 F2' 且 F2' 可直接流转
T7TASK=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan3\",\"title\":\"T7移交测试\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
FH=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FH\",\"status\":\"in_progress\"}" > /dev/null
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH" ] && ok "T7a frontHand 持任务 in_progress" || bad "T7a 认领失败 assigned_id=$AID"
# 同名重注册（模拟换会话）
FH2=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
[ "$FH2" != "$FH" ] && [ -n "$FH2" ] && [ "$FH2" != "undefined" ] && ok "T7b 同名重注册得新身份" || bad "T7b 重注册失败: $FH2"
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH2" ] && ok "T7c 任务 assigned_id 已移交新身份" || bad "T7c 未移交 assigned_id=$AID（期望 $FH2）"
# F2'（新身份）直接流转——不得因绑定旧身份被拒
RESP=$(H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FH2\",\"status\":\"in_review\"}")
ST=$(sq "SELECT status FROM tasks WHERE id='$T7TASK'")
if [ "$ST" = "in_review" ]; then ok "T7d 新身份可直接流转（无死锁）"; else bad "T7d 流转失败: $ST resp=$RESP"; fi
# 终态任务不移交（回归保护）
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"testing\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"test_passed\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"completed\"}" > /dev/null
FH3=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH2" ] && ok "T7e 终态任务不被移交（completed保持原assignee）" || bad "T7e 终态任务被误移交: $AID"

# ---------- T8 冷启动（v2.1.2 A2）----------
section "T8 冷启动：无 config.yaml 可启动"
COLD=$(mktemp -d /tmp/hub-coldstart.XXXXXX)
# 复制最小运行集：server.js + node_modules 软链（不含 config.yaml / config.example.yaml，验证空默认兜底）
cp "$DIR/server.js" "$COLD/"
ln -s "$DIR/node_modules" "$COLD/node_modules"
COLD_PID=""
( cd "$COLD" && PORT=8298 HUB_DB="$COLD/cold.sqlite" HUB_AUTH_TOKEN="" node server.js > /tmp/hub-coldstart.log 2>&1 & COLD_PID=$!; echo $COLD_PID > /tmp/hub-coldstart.pid )
sleep 1.5
CH=$(curl -s http://localhost:8298/health | jq_get data.status)
CV=$(curl -s http://localhost:8298/health | jq_get data.version)
if [ "$CH" = "running" ]; then ok "T8a 无config.yaml启动成功 status=running"; else bad "T8a 冷启动失败: $CH"; cat /tmp/hub-coldstart.log; fi
[ "$CV" = "2.1.2" ] && ok "T8b 版本=$CV" || bad "T8b 版本=$CV（期望 2.1.2）"
# 子 shell 里的 $! 拿不到外层，兜底 pkill 本脚本启动的 8298 node（端口唯一，误杀面为零）
pkill -f "PORT=8298" 2>/dev/null; sleep 0.3
COLD_NODE=$(ss -tlnp 2>/dev/null | grep ':8298' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -z "$COLD_NODE" ] || kill "$COLD_NODE" 2>/dev/null
rm -rf "$COLD" /tmp/hub-coldstart.pid

# ---------- 收尾 ----------
echo
echo "================================"
echo "结果: PASS=$PASS FAIL=$FAIL"
echo "================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
