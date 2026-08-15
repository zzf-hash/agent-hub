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
if [ "$HEALTH" = "2.3.1" ]; then ok "health version=$HEALTH"; else bad "health version=$HEALTH (期望 2.3.1)"; cat /tmp/hub-test.log; fi

# 不带 token 应 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/agents")
[ "$CODE" = "401" ] && ok "无token访问401" || bad "无token访问返回$CODE(期望401)"

H() { curl -s -H "x-auth-token: $TOKEN" "$@"; }   # 带鉴权的 curl
reg() { H -X POST $BASE/api/register -H 'Content-Type: application/json' -d "{\"name\":\"$1\",\"role\":\"$2\",\"project\":\"yiyuan\"}" | jq_get data.agent_id; }

# ---------- T1 替换不可复活 ----------
section "T1 被替换agent不可复活（v2.2：手动替换）"
X=$(reg agentX backend)
Y=$(reg agentY backend)
[ -n "$X" ] && [ "$X" != "undefined" ] && ok "register X=$X" || { bad "register X 失败"; }
[ -n "$Y" ] && [ "$Y" != "undefined" ] && ok "register Y=$Y（X 不受影响——v2.2 幂等注册不自动替换）" || { bad "register Y 失败"; }
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
[ "$ST" = "online" ] && ok "T1-0 X 仍 online（register 不再自动墓碑）" || bad "T1-0 X 状态=$ST（期望 online）"
# v2.2：替换改为手动 API（面板操作）
H -X POST $BASE/api/agents/$X/replace -H 'Content-Type: application/json' -d '{"reason":"T1测试替换"}' > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$X'")
[ "$ST" = "replaced" ] && ok "手动替换后 X=replaced（墓碑已写入）" || bad "X 状态=$ST（期望 replaced）"
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
# v2.2：同项目同角色不再自动顶替（各自独立身份）。互斥拒绝场景：
# 1) 异角色（QA）操作认领人任务；2) 同角色但非认领人的在途任务操作。
QA=$(reg agentQA qa)
RESP=$(H -X PUT $BASE/api/tasks/$TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$QA\",\"status\":\"in_review\"}")
echo "$RESP" | grep -q "已由 agentF 认领" && ok "T4a QA被拒（错误信息含认领人名字）" || bad "T4a QA未被正确拒绝: $RESP"
ST=$(sq "SELECT status FROM tasks WHERE id='$TASK'")
[ "$ST" = "in_progress" ] && ok "T4b 任务状态未被篡改（仍 in_progress）" || bad "T4b 状态被改: $ST"
RESP=$(H -X PUT $BASE/api/tasks/$TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"in_review\"}")
echo "$RESP" | grep -q '"code":0' && ok "T4c manager 强制流转成功" || bad "T4c manager 流转失败: $RESP"

# ---------- T4d/e/f 死亡身份接管 + 僵尸守卫（v2.1.1）----------
section "T4d/e/f 死亡身份接管 + 僵尸守卫"
# 用独立项目 yiyuan2 隔离；v2.2 下旧身份用「手动替换（无后继）」构造
RTK=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan2\",\"title\":\"T4d接管测试\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
FO=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontOld","role":"frontend","project":"yiyuan2"}' | jq_get data.agent_id)
FN=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontNew","role":"frontend","project":"yiyuan2"}' | jq_get data.agent_id)
H -X POST $BASE/api/agents/$FO/replace -H 'Content-Type: application/json' -d '{"reason":"T4d构造死亡assignee"}' > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$FO'")
[ "$ST" = "replaced" ] && ok "T4d-0 frontOld 被手动替换为 replaced" || bad "T4d-0 frontOld状态=$ST"
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
# 注：v2.2 下 F 不再被自动顶替；但 T4 已把任务流转到 in_review，此处用 M 建新任务验证 review 流
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
# 对照：online 身份 offline 仍正常（v2.2 下各身份独立，用新鲜注册的 online 身份验证）
Z2=$(reg agentZ2 backend)
RESP=$(H -X POST $BASE/api/offline/$Z2)
ST=$(sq "SELECT status FROM agents WHERE id='$Z2'")
[ "$ST" = "offline" ] && ok "T6c 正常online身份offline成功" || bad "T6c online身份offline失败: $ST resp=$RESP"

# ---------- T7 手动替换移交（v2.2：replace+successor_id）----------
section "T7 手动替换移交在途任务"
# F2 持任务 in_progress → 手动替换（后继=F3）→ 任务应移交 F3 且 F3 可直接流转
T7TASK=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan3\",\"title\":\"T7移交测试\",\"to_role\":\"frontend\"}" | jq_get data.task_id)
FH=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FH\",\"status\":\"in_progress\"}" > /dev/null
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH" ] && ok "T7a frontHand 持任务 in_progress" || bad "T7a 认领失败 assigned_id=$AID"
# 后继 F3（同角色同项目）
FH3=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand3","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
[ -n "$FH3" ] && [ "$FH3" != "undefined" ] && ok "T7b 后继 F3 注册" || bad "T7b F3 注册失败: $FH3"
# 手动替换 F → 后继 F3
RESP=$(H -X POST $BASE/api/agents/$FH/replace -H 'Content-Type: application/json' -d "{\"successor_id\":\"$FH3\",\"reason\":\"T7移交\"}")
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH3" ] && ok "T7c 任务 assigned_id 已移交后继 F3" || bad "T7c 未移交 assigned_id=$AID（期望 $FH3）resp=$RESP"
# F3（后继）直接流转——不得因绑定旧身份被拒
RESP=$(H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$FH3\",\"status\":\"in_review\"}")
ST=$(sq "SELECT status FROM tasks WHERE id='$T7TASK'")
if [ "$ST" = "in_review" ]; then ok "T7d 后继可直接流转（无死锁）"; else bad "T7d 流转失败: $ST resp=$RESP"; fi
# 终态任务不被移交（回归保护）
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"testing\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"test_passed\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T7TASK -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"completed\"}" > /dev/null
FH4=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"frontHand4","role":"frontend","project":"yiyuan3"}' | jq_get data.agent_id)
H -X POST $BASE/api/agents/$FH4/replace -H 'Content-Type: application/json' -d "{\"successor_id\":\"$FH3\"}" > /dev/null
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T7TASK'")
[ "$AID" = "$FH3" ] && ok "T7e 终态任务不被移交（completed保持原assignee）" || bad "T7e 终态任务被误移交: $AID"

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
[ "$CV" = "2.3.1" ] && ok "T8b 版本=$CV" || bad "T8b 版本=$CV（期望 2.3.1）"
# 子 shell 里的 $! 拿不到外层，兜底 pkill 本脚本启动的 8298 node（端口唯一，误杀面为零）
pkill -f "PORT=8298" 2>/dev/null; sleep 0.3
COLD_NODE=$(ss -tlnp 2>/dev/null | grep ':8298' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -z "$COLD_NODE" ] || kill "$COLD_NODE" 2>/dev/null
rm -rf "$COLD" /tmp/hub-coldstart.pid

# ---------- T9 v2.2 幂等注册 + 手动替换/移交 ----------
section "T9 v2.2 幂等注册与手动替换/移交"
# T9a 同名重注册幂等：返回同一 agent_id，不顶替
IA=$(reg idemA backend)
IA2=$(reg idemA backend)
[ "$IA" = "$IA2" ] && [ -n "$IA" ] && [ "$IA" != "undefined" ] && ok "T9a 同名重注册幂等（同一ID）" || bad "T9a 重注册不幂等: $IA vs $IA2"
# T9b offline 身份重注册 → 复用同一ID并复活 online（agent_id 类比 openid 的定案语义）
H -X POST $BASE/api/offline/$IA > /dev/null
IA3=$(reg idemA backend)
ST=$(sq "SELECT status FROM agents WHERE id='$IA'")
[ "$IA3" = "$IA" ] && [ "$ST" = "online" ] && ok "T9b offline身份重注册复活online（同ID）" || bad "T9b 重注册: id=$IA3/$IA status=$ST"
# T9c replaced 身份重注册 → 新 agent_id，旧墓碑不受影响（幂等边界）
TB=$(reg lifeB backend)
H -X POST $BASE/api/agents/$TB/replace -H 'Content-Type: application/json' -d '{"reason":"T9c边界"}' > /dev/null
TB2=$(reg lifeB backend)
STOLD=$(sq "SELECT status FROM agents WHERE id='$TB'")
[ "$TB2" != "$TB" ] && [ -n "$TB2" ] && [ "$TB2" != "undefined" ] && [ "$STOLD" = "replaced" ] \
  && ok "T9c replaced后同名重注册得新ID（旧墓碑不动）" || bad "T9c: new=$TB2 old=$TB oldStatus=$STOLD"
# replaced 身份心跳/拉消息均不复活（快速回归，详见T1）
H -X POST $BASE/mcp/tools/heartbeat -H 'Content-Type: application/json' -d "{\"from_id\":\"$TB\"}" > /dev/null
H "$BASE/api/messages/$TB" > /dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$TB'")
[ "$ST" = "replaced" ] && ok "T9c-2 replaced 心跳+拉消息不复活" || bad "T9c-2 replaced被复活: $ST"

# T9d replace 后继校验：跨角色后继被拒
RC=$(reg roleCk frontend)
RB=$(reg roleBk backend)
RESP=$(H -X POST $BASE/api/agents/$RB/replace -H 'Content-Type: application/json' -d "{\"successor_id\":\"$RC\",\"reason\":\"跨角色\"}")
ST=$(sq "SELECT status FROM agents WHERE id='$RB'")
echo "$RESP" | grep -q '"code":1' && [ "$ST" != "replaced" ] && ok "T9d replace 跨角色后继被拒（源未动）" || bad "T9d 跨角色未被拒或源被动: resp=$RESP st=$ST"
# 重复替换已 replaced 身份被拒
RESP=$(H -X POST $BASE/api/agents/$TB/replace -H 'Content-Type: application/json' -d '{"reason":"二次替换"}')
echo "$RESP" | grep -q '"code":1' && ok "T9d-2 二次replace被拒" || bad "T9d-2 二次replace未被拒: $RESP"

# T9e 任务级手动移交 POST /api/tasks/:id/transfer
T9T=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$M\",\"project\":\"yiyuan4\",\"title\":\"T9移交测试\",\"to_role\":\"backend\"}" | jq_get data.task_id)
TF=$(reg transferFrom backend)
TT=$(reg transferTo backend)
H -X PUT $BASE/api/tasks/$T9T -H 'Content-Type: application/json' -d "{\"from_id\":\"$TF\",\"status\":\"in_progress\"}" > /dev/null
RESP=$(H -X POST $BASE/api/tasks/$T9T/transfer -H 'Content-Type: application/json' -d "{\"to_id\":\"$TT\"}")
AID=$(sq "SELECT assigned_id FROM tasks WHERE id='$T9T'")
[ "$AID" = "$TT" ] && ok "T9e-1 transfer 后 assigned_id 移交" || bad "T9e-1 未移交: $AID（期望 $TT）resp=$RESP"
# 源身份不被墓碑（任务移交≠身份替换）
ST=$(sq "SELECT status FROM agents WHERE id='$TF'")
[ "$ST" = "online" ] && ok "T9e-2 源身份仍 online（不墓碑）" || bad "T9e-2 源身份被误动: $ST"
# 后继可直接流转（无死锁）
H -X PUT $BASE/api/tasks/$T9T -H 'Content-Type: application/json' -d "{\"from_id\":\"$TT\",\"status\":\"in_review\"}" > /dev/null
ST=$(sq "SELECT status FROM tasks WHERE id='$T9T'")
[ "$ST" = "in_review" ] && ok "T9e-3 新持有人可直接流转" || bad "T9e-3 流转失败: $ST"
# 已由目标持有时再移交被拒
RESP=$(H -X POST $BASE/api/tasks/$T9T/transfer -H 'Content-Type: application/json' -d "{\"to_id\":\"$TT\"}")
echo "$RESP" | grep -q '"code":1' && ok "T9e-4 重复移交目标本人被拒" || bad "T9e-4 未被拒: $RESP"
# 跨角色目标被拒
TQ=$(reg transferQa qa)
RESP=$(H -X POST $BASE/api/tasks/$T9T/transfer -H 'Content-Type: application/json' -d "{\"to_id\":\"$TQ\"}")
echo "$RESP" | grep -q '"code":1' && ok "T9e-5 跨角色移交被拒" || bad "T9e-5 未被拒: $RESP"
# 终态任务不可移交（回归保护）
H -X PUT $BASE/api/tasks/$T9T -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"testing\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T9T -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"test_passed\"}" > /dev/null
H -X PUT $BASE/api/tasks/$T9T -H 'Content-Type: application/json' -d "{\"from_id\":\"$M\",\"status\":\"completed\"}" > /dev/null
RESP=$(H -X POST $BASE/api/tasks/$T9T/transfer -H 'Content-Type: application/json' -d "{\"to_id\":\"$TF\"}")
echo "$RESP" | grep -q '"code":1' && ok "T9e-6 终态任务不可移交" || bad "T9e-6 终态未被拒: $RESP"

# ---------- T10 v2.3.1 busy 优先 + 清扫豁免 + 四色数据源 ----------
section "T10 v2.3.1 busy优先/清扫豁免/pending数据源"
# T10 前置：建 PM + backend agent + 任务，用独立项目 yiyuan5 隔离
T10M=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"t10pm","role":"manager","project":"yiyuan5"}' | jq_get data.agent_id)
B1=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"t10busy1","role":"backend","project":"yiyuan5"}' | jq_get data.agent_id)
[ -n "$B1" ] && [ "$B1" != "undefined" ] && ok "T10-0 busy agent 注册" || bad "T10-0 注册失败: $B1"

# T10.1 claim 任务后不心跳>5min → display_state 仍 busy（豁免清扫 + busy 优先双保险）
T10T1=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$T10M\",\"project\":\"yiyuan5\",\"title\":\"T10.1豁免测试\",\"to_role\":\"backend\",\"to_id\":\"$B1\"}" | jq_get data.task_id)
H -X PUT $BASE/api/tasks/$T10T1 -H 'Content-Type: application/json' -d "{\"from_id\":\"$B1\",\"status\":\"in_progress\"}" > /dev/null
# 模拟「claim 后深度干活，5min 无任何请求」：把 last_seen 拨回 10min 前，跑一次清扫等价 SQL 判定
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE agents SET last_seen=datetime('now','-10 minutes') WHERE id=?\").run('$B1');" 2>/dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$B1'")
DS=$(H "$BASE/api/agents?project=yiyuan5&online_only=false" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const a=(j.data.agents||[]).find(x=>x.id==='$B1');console.log(a?a.display_state:'NOT_FOUND')})")
[ "$DS" = "online_busy" ] && ok "T10.1 claim后10min无请求 display_state=$DS（busy 优先，未降级离线）" || bad "T10.1 display_state=$DS status=$ST（期望 online_busy）"

# T10.2 work-start 后同样（external 工作项路径）
#   注：B2 用 frontend 角色，避免 T10.4 的 backend 队列任务被自动指派到 B2（确定性）
B2=$(H -X POST $BASE/api/register -H 'Content-Type: application/json' -d '{"name":"t10busy2","role":"frontend","project":"yiyuan5"}' | jq_get data.agent_id)
H -X POST $BASE/api/agents/$B2/work/start -H 'Content-Type: application/json' -d "{\"from_id\":\"$B2\",\"title\":\"T10.2外部工作\"}" > /dev/null
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE agents SET last_seen=datetime('now','-10 minutes') WHERE id=?\").run('$B2');" 2>/dev/null
DS=$(H "$BASE/api/agents?project=yiyuan5&online_only=false" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const a=(j.data.agents||[]).find(x=>x.id==='$B2');console.log(a?a.display_state:'NOT_FOUND')})")
[ "$DS" = "online_busy" ] && ok "T10.2 work-start后10min无请求 display_state=$DS（busy 优先）" || bad "T10.2 display_state=$DS（期望 online_busy）"

# T10.3 active work 超 60min 无请求 → offline + work 标 stale + 任务回 pending
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE agents SET last_seen=datetime('now','-70 minutes') WHERE id=?\").run('$B2');" 2>/dev/null
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"UPDATE agent_work SET updated_at=datetime('now','-70 minutes') WHERE agent_id=? AND status='active'\").run('$B2');" 2>/dev/null
# 手动执行与清扫器等价的完整逻辑（隔离实例不等 60s tick）：
#   ① sweep：超5min 且不满足豁免（60min内有活动+有进行中工作）→ 置 offline
#   ② forsaken：已 offline 且超60min 的 working agent → active work 标 stale + in_progress 任务回 pending
node -e "
const D=require('better-sqlite3');const db=new D('$DB');
const soft=new Date(Date.now()-5*60*1000).toISOString();
const hard=new Date(Date.now()-60*60*1000).toISOString();
db.prepare(\`UPDATE agents SET status='offline', offline_at=datetime('now') WHERE status='online' AND last_seen < ? AND NOT (last_seen >= ? AND id IN (SELECT assigned_id FROM tasks WHERE status='in_progress' AND assigned_id IS NOT NULL UNION SELECT agent_id FROM agent_work WHERE status='active'))\`).run(soft, hard);
const forsaken=db.prepare(\`SELECT id FROM agents WHERE status='offline' AND last_seen < ? AND (id IN (SELECT assigned_id FROM tasks WHERE status='in_progress' AND assigned_id IS NOT NULL) OR id IN (SELECT agent_id FROM agent_work WHERE status='active'))\`).all(hard);
for (const ag of forsaken) {
  db.prepare(\`UPDATE agent_work SET status='stale', updated_at=datetime('now') WHERE agent_id=? AND status='active'\`).run(ag.id);
  db.prepare(\`UPDATE tasks SET status='pending', assigned_id=NULL WHERE assigned_id=? AND status='in_progress'\`).run(ag.id);
}
console.log('forsaken:'+forsaken.length);
" 2>/dev/null
ST=$(sq "SELECT status FROM agents WHERE id='$B2'")
WS=$(sq "SELECT status FROM agent_work WHERE agent_id='$B2' AND title='T10.2外部工作'")
[ "$ST" = "offline" ] && ok "T10.3a 超时 B2 状态=$ST" || bad "T10.3a B2 状态=$ST（期望 offline）"
[ "$WS" = "stale" ] && ok "T10.3b active work 已标 stale" || bad "T10.3b work 状态=$WS（期望 stale）"
# B2 复活拉回验证（心跳复活 → stale 拉回 active）
H -X POST $BASE/mcp/tools/heartbeat -H 'Content-Type: application/json' -d "{\"from_id\":\"$B2\"}" > /dev/null
WS=$(sq "SELECT status FROM agent_work WHERE agent_id='$B2' AND title='T10.2外部工作'")
[ "$WS" = "active" ] && ok "T10.3c 心跳复活后 stale 拉回 active" || bad "T10.3c 复活后 work=$WS（期望 active）"

# T10.4 agent 离线且 pending>0 → 响应仍含 pending_task_count（🟠徽标数据源）
#   前置：manager 先完结 B1 的 in_progress 任务（busy 解除），B1 置 offline；
#   再建 to_role=backend 任务——无在线 backend → 落角色队列（assigned_id=NULL），
#   B1（backend@yiyuan5）应得 pending_task_count=1 且 display_state=offline
H -X PUT $BASE/api/tasks/$T10T1 -H 'Content-Type: application/json' -d "{\"from_id\":\"$T10M\",\"status\":\"completed\",\"result\":\"T10.4前置收尾\"}" > /dev/null
H -X POST $BASE/api/offline/$B1 > /dev/null
T10T4=$(H -X POST $BASE/api/tasks -H 'Content-Type: application/json' -d "{\"created_by\":\"$T10M\",\"project\":\"yiyuan5\",\"title\":\"T10.4待接取徽标数据源\",\"to_role\":\"backend\"}" | jq_get data.task_id)
PT=$(H "$BASE/api/agents?project=yiyuan5&online_only=false" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const a=(j.data.agents||[]).find(x=>x.id==='$B1');console.log(a?('display_state='+a.display_state+' pending_task_count='+a.pending_task_count):'NOT_FOUND')})")
echo "$PT" | grep -q 'display_state=offline' && echo "$PT" | grep -q 'pending_task_count=[1-9]' && ok "T10.4 离线 agent 仍带 pending_task_count（$PT）" || bad "T10.4 $PT（期望 display_state=offline 且 pending_task_count>0）"

# T10.5 面板 HTML/JS 含四色 hex 映射
DASH_HTML="/home/agentuser/yiyuan-server/scripts/dashboard/public/index.html"
ALL4=1
for HEX in '#22c55e' '#facc15' '#f97316' '#ef4444'; do
  if grep -q -- "$HEX" "$DASH_HTML"; then :; else ALL4=0; fi
done
[ $ALL4 -eq 1 ] && ok "T10.5 面板含四色 hex（#22c55e/#facc15/#f97316/#ef4444）" || bad "T10.5 面板缺四色 hex 之一"

# ---------- 收尾 ----------
echo
echo "================================"
echo "结果: PASS=$PASS FAIL=$FAIL"
echo "================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
