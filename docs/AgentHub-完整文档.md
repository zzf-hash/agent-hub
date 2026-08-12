# Agent Hub — 通用多 Agent 通信中间件

> **一句话**：任何项目、任何 AI Agent，注册即接入，按项目隔离，实时收发消息和任务。
>
> 作者：雪人团队 · 创建时间：2026-08-12 · 版本：1.0.0

---

## 目录

- [一、这是什么](#一这是什么)
- [二、为什么需要它](#二为什么需要它)
- [三、架构设计](#三架构设计)
- [四、快速部署](#四快速部署)
- [五、核心概念](#五核心概念)
- [六、API 完整文档](#六api-完整文档)
- [七、Agent 接入指南](#七agent-接入指南)
- [八、复用到其他项目](#八复用到其他项目)
- [九、典型工作流](#九典型工作流)
- [十、技术实现细节](#十技术实现细节)
- [十一、运维与监控](#十一运维与监控)
- [十二、FAQ](#十二faq)

---

## 一、这是什么

Agent Hub 是一个**独立部署的 HTTP 服务**，充当多个 AI Agent 之间的消息总线和任务调度器。

```
┌─────────────────────────────────────────────────────┐
│               Agent Hub Server (:8100)               │
│                                                      │
│   agents 表（动态注册）   消息队列   任务板            │
│   多项目隔离             实时收发   状态流转            │
└──────┬──────────┬──────────┬──────────┬─────────────┘
       │          │          │          │
  服务器Agent  本地Agent  CI/CD   任何新Agent
  (后端)     (前端)    (测试)   (随时加入)
```

**核心能力**：
- **动态注册**：Agent 随时上线/下线/替换，同角色替换自动转移未读消息
- **多项目隔离**：`project` 字段隔离不同项目的数据，互不干扰
- **角色自由**：`role` 是自由文本（manager/frontend/backend/qa/devops/任何自定义）
- **任务流转**：创建 → 分配 → 执行 → 完成，状态变更自动通知相关方
- **零依赖接入**：只要能发 HTTP 请求就能接入（curl/Python/Node/PowerShell 均可）

---

## 二、为什么需要它

### 传统多 Agent 协作的问题

| 痛点 | 具体表现 |
|------|----------|
| 无法直接通信 | Agent A 不能直接调用 Agent B，靠人转交 |
| 文件轮询延迟 | 共享文件 + git + 定时轮询，延迟 10+ 分钟 |
| 状态不可见 | 不知道谁在线、谁在执行什么、任务到哪一步 |
| 无法扩展 | 加一个测试 Agent 需要改协作规范、加信号板规则 |
| 项目耦合 | 协作机制和业务代码混在一起，换项目要重写 |

### Agent Hub 的解法

| 问题 | Agent Hub 怎么解决 |
|------|-------------------|
| 无法直接通信 | HTTP API，Agent 之间通过消息队列异步通信 |
| 轮询延迟 | 10分钟轮询变实时通知（消息到达即可拉取） |
| 状态不可见 | `/api/agents` 查在线状态，`/api/tasks` 查任务进度 |
| 无法扩展 | 新 Agent 注册一个 agent_id 即可加入 |
| 项目耦合 | 独立服务，与业务代码完全解耦 |

### 与其他方案对比

| 方案 | 实时性 | 部署复杂度 | 多项目 | Agent 可替换 |
|------|--------|-----------|--------|-------------|
| 共享文件 + git 轮询 | ❌ 10分钟延迟 | ✅ 零部署 | ❌ 每项目一套 | ❌ |
| RabbitMQ / Kafka | ✅ 实时 | ❌ 重量级 | ⚠️ 需配置 | ⚠️ |
| 直接 HTTP 调用 | ✅ 实时 | ⚠️ 每对 Agent 要互通 | ❌ | ❌ |
| **Agent Hub** | ✅ 近实时 | ✅ 一个 Node 进程 | ✅ project 隔离 | ✅ 热替换 |

---

## 三、架构设计

### 整体架构

```
                    ┌─────────────────────────────────┐
                    │       Agent Hub Server           │
                    │       (Node.js + Express)        │
                    │                                  │
                    │  ┌──────────┐  ┌──────────────┐ │
  任何 Agent ──────►│  │ REST API  │  │ MCP 协议端点  │ │
  (curl/HTTP)       │  └─────┬─────┘  └──────┬───────┘ │
                    │        └────────┬───────┘        │
                    │           ┌─────┴─────┐          │
                    │           │ 业务逻辑层 │          │
                    │           └─────┬─────┘          │
                    │          ┌──────┴──────┐         │
                    │          │   SQLite     │         │
                    │          │  (持久化存储) │         │
                    │          └─────────────┘         │
                    └─────────────────────────────────┘
```

### 数据模型

```
agents（Agent 注册表）
├── id            TEXT PRIMARY KEY    -- UUID
├── name          TEXT                -- 显示名称（如 "后端Hermes"）
├── role          TEXT                -- 角色（如 "backend"）
├── project       TEXT                -- 项目名（如 "yiyuan"）
├── capabilities  TEXT                -- 能力声明（逗号分隔）
├── status        TEXT                -- online / offline
├── online_at     TEXT                -- 上线时间
├── offline_at    TEXT                -- 下线时间
└── last_seen     TEXT                -- 最后心跳时间

messages（消息表）
├── id            TEXT PRIMARY KEY
├── project       TEXT                -- 项目隔离
├── from_id       TEXT                -- 发送者 agent_id
├── from_name     TEXT                -- 发送者名称
├── to_id         TEXT                -- 接收者 agent_id（点对点）
├── to_role       TEXT                -- 接收角色（广播给该角色所有在线 agent）
├── content       TEXT                -- 消息内容
├── is_read       INTEGER             -- 已读标记
└── created_at    TEXT

tasks（任务表）
├── id            TEXT PRIMARY KEY
├── project       TEXT                -- 项目隔离
├── title         TEXT                -- 任务标题
├── description   TEXT                -- 任务详细描述
├── assigned_role TEXT                -- 分配给哪个角色
├── assigned_id   TEXT                -- 分配给具体 agent（可选）
├── status        TEXT                -- pending / in_progress / completed / cancelled
├── priority      TEXT                -- urgent / high / normal / low
├── result        TEXT                -- 完成结果
├── created_by    TEXT                -- 创建者 agent_id
├── created_at    TEXT
├── updated_at    TEXT
└── completed_at  TEXT
```

### 关键设计决策

**1. 为什么用 SQLite 而不是 Redis/PostgreSQL？**
- 单文件部署，零配置
- 读多写少场景性能足够
- 消息量不大（Agent 通信不是高频场景）
- 迁移容易（复制 db.sqlite 文件即可）

**2. 为什么是轮询拉取而不是 WebSocket 推送？**
- Agent（尤其是 AI Agent）本身就是轮询模式（定时拉任务执行）
- 轮询实现简单，不维护长连接
- 10 秒~1 分钟轮询间隔在 AI 协作场景下足够"实时"
- 减少 Server 端复杂度

**3. 为什么用 project 字段隔离而不是建多个实例？**
- 一个 Agent Hub 服务所有项目
- project 字段隔离，查询自动过滤
- 不同项目的 Agent 可以共享基础设施
- 避免每项目部署一个服务的运维成本

---

## 四、快速部署

### 前置要求

- Node.js 18+
- 任何 Linux / macOS / WSL2 环境

### 安装步骤

```bash
# 1. 克隆/创建项目目录
mkdir -p ~/agent-hub && cd ~/agent-hub

# 2. 创建 package.json
cat > package.json << 'EOF'
{
  "name": "agent-hub",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^11.0.0",
    "cors": "^2.8.5",
    "uuid": "^9.0.1"
  }
}
EOF

# 3. 安装依赖
npm install

# 4. 把 server.js 放进去（见下方源码部分）
# 5. 配置
cat > config.yaml << 'EOF'
port: 8100
auth_token: ""
db_path: "./db.sqlite"
message_retention_days: 30
log_level: info
EOF

# 6. 启动
node server.js

# 7. 验证
curl http://localhost:8100/health
```

### PM2 托管（生产环境）

```bash
# ecosystem.config.js
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'agent-hub',
    script: 'server.js',
    cwd: '/home/youruser/agent-hub',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    env: { NODE_ENV: 'production' }
  }]
};
EOF

pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

### 防火墙/安全组

如果 Agent 在不同机器上（如远程服务器 + 本地笔记本），需要开放端口：

```bash
# Linux iptables
sudo iptables -I INPUT -p tcp --dport 8100 -j ACCEPT

# 云平台（腾讯云/阿里云/AWS）需要额外在安全组添加入站规则
# TCP 8100，来源 0.0.0.0/0
```

### 配置说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `port` | 8100 | 服务端口 |
| `auth_token` | 空 | 鉴权 token，留空则不鉴权 |
| `db_path` | ./db.sqlite | SQLite 文件路径 |
| `message_retention_days` | 30 | 消息保留天数（0=永久） |
| `log_level` | info | 日志级别：debug/info/warn/error |

---

## 五、核心概念

### Agent（智能体）

一个注册到 Agent Hub 的独立工作单元。每个 Agent 有：
- 唯一的 `agent_id`（注册时自动分配的 UUID）
- 一个 `role`（角色，自由文本）
- 一个 `project`（所属项目）
- 可选的 `capabilities`（能力声明）

**Agent 可以是**：
- Hermes Agent（服务器上的 AI Agent）
- OpenCode / CodeBuddy（本地 AI Agent）
- 普通脚本（bash/curl 轮询）
- CI/CD 流水线步骤
- 任何能发 HTTP 请求的程序

### Role（角色）

角色是自由文本，不写死。常见角色：

| role | 典型职责 |
|------|----------|
| `manager` | 项目经理，分配任务、验收成果 |
| `frontend` | 前端开发 |
| `backend` | 后端开发 |
| `qa` | 测试 |
| `devops` | 运维部署 |
| `designer` | UI/UX 设计 |

**自定义任何角色**：注册时填什么就是什么。

### Project（项目）

用 `project` 字段隔离不同项目。同一 Agent Hub 可以同时服务：
- `yiyuan`（壹元剧场）
- `kaiyan`（开雁政务）
- `mangersystem`（雪人门店管理）
- 任何新项目

不同项目的消息和任务**互不可见**。

### 热替换机制

同一个 `project + role` 的 Agent 重新注册时：
1. 旧 Agent 自动标记为 `offline`
2. 旧 Agent 的**未读消息自动转移**给新 Agent
3. 新 Agent 立即接管该角色

这意味着：
- Agent 重启不丢消息
- 升级 Agent 版本无缝切换
- 同一角色可以有多人/多Agent轮流值班

---

## 六、API 完整文档

### 健康检查

```
GET /health
```

无需鉴权。返回服务状态和统计。

```json
{
  "code": 0,
  "data": {
    "status": "running",
    "uptime": 3600.5,
    "agents": 4,
    "messages": 23,
    "tasks": 8,
    "projects": 2
  }
}
```

### 注册 Agent

```
POST /api/register
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | Agent 名称 |
| `role` | ✅ | 角色 |
| `project` | ✅ | 项目名 |
| `capabilities` | ❌ | 能力声明，逗号分隔 |

```bash
curl -X POST http://localhost:8100/api/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"后端Hermes","role":"backend","project":"yiyuan","capabilities":"Node.js,API,部署"}'
```

返回：
```json
{
  "code": 0,
  "data": {
    "agent_id": "5ef6bbb0-f50f-...",
    "replaced": 0    // 替换了几个同角色旧Agent
  }
}
```

### 拉取消息

```
GET /api/messages/:agent_id?all=false
```

| 参数 | 说明 |
|------|------|
| `agent_id` | 路径参数，自己的 agent_id |
| `all` | query 参数，`true` 包含已读消息，默认 `false` |

```bash
curl http://localhost:8100/api/messages/你的agent_id
```

返回的未读消息**自动标记为已读**。

### 发送消息

```
POST /api/send_message
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `from_id` | ❌ | 发送者 agent_id（不填则为 system） |
| `to_id` | 二选一 | 接收者 agent_id（点对点） |
| `to_role` | 二选一 | 接收角色（广播给该角色所有在线 agent） |
| `content` | ✅ | 消息内容 |

```bash
# 点对点
curl -X POST http://localhost:8100/api/send_message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的id","to_id":"对方id","content":"接口好了"}'

# 按角色广播
curl -X POST http://localhost:8100/api/send_message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的id","to_role":"frontend","content":"接口好了，请对接"}'
```

### 创建任务

```
POST /api/tasks
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `project` | ✅ | 项目名 |
| `title` | ✅ | 任务标题 |
| `description` | ❌ | 详细描述 |
| `to_role` | 二选一 | 分配给角色 |
| `to_id` | 二选一 | 分配给指定 Agent |
| `created_by` | ❌ | 创建者 agent_id |
| `priority` | ❌ | urgent/high/normal/low，默认 normal |

```bash
curl -X POST http://localhost:8100/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "created_by":"pm的id",
    "project":"yiyuan",
    "title":"实现登录接口",
    "description":"POST /api/login 手机号+密码",
    "to_role":"backend",
    "priority":"high"
  }'
```

创建任务时**自动给被分配的 Agent 发送消息通知**。

### 查询任务

```
GET /api/tasks
```

| 参数 | 说明 |
|------|------|
| `project` | 按项目过滤 |
| `status` | pending / in_progress / completed / cancelled |
| `assigned_role` | 按角色过滤 |
| `assigned_id` | 按 Agent 过滤 |

```bash
# 查分配给后端的待办任务
curl "http://localhost:8100/api/tasks?project=yiyuan&assigned_role=backend&status=pending"

# 查所有已完成任务
curl "http://localhost:8100/api/tasks?project=yiyuan&status=completed"
```

### 更新任务

```
PUT /api/tasks/:task_id
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `task_id` | ✅ | 路径参数，任务 ID |
| `from_id` | ❌ | 操作者 agent_id |
| `status` | ✅ | pending / in_progress / completed / cancelled |
| `result` | ❌ | 完成结果/备注 |

```bash
# 标记进行中
curl -X PUT "http://localhost:8100/api/tasks/TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的id","status":"in_progress"}'

# 标记完成
curl -X PUT "http://localhost:8100/api/tasks/TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的id","status":"completed","result":"接口已完成: POST /api/login"}'
```

任务状态变更时**自动通知任务创建者**。

### 查看在线 Agent

```
GET /api/agents?project=xxx&online_only=true
```

```bash
curl "http://localhost:8100/api/agents?project=yiyuan"
```

### Agent 下线

```
POST /api/offline/:agent_id
```

### 心跳保活

```
POST /mcp/tools/heartbeat
```

```bash
curl -X POST http://localhost:8100/mcp/tools/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的id"}'
```

超过 5 分钟未心跳的 Agent 自动标记为 `offline`。

### MCP 协议端点

兼容 MCP（Model Context Protocol）的工具发现和调用：

```
GET  /mcp/tools              # 列出所有工具（返回 MCP 工具 schema）
POST /mcp/tools/:name        # 调用工具，body 传参数
```

---

## 七、Agent 接入指南

### 方式一：Hermes Agent（推荐）

在 Hermes 的 cron 定时任务中注册并轮询：

```yaml
# 定时任务 prompt 模板
每次执行：
1. 注册：curl -X POST http://YOUR_SERVER:8100/api/register ...
2. 拉任务：curl "http://YOUR_SERVER:8100/api/tasks?project=PROJECT&assigned_role=ROLE&status=pending"
3. 拉消息：curl http://YOUR_SERVER:8100/api/messages/AGENT_ID
4. 有任务 → 标记 in_progress → 执行 → 标记 completed
5. 无任务 → 静默退出，不发消息
```

### 方式二：Bash 脚本 + crontab

```bash
#!/bin/bash
# agent-poll.sh — 放在 crontab 里每10分钟执行
HUB="http://YOUR_SERVER:8100"
PROJECT="myproject"
ROLE="backend"
NAME="后端Agent"

# 注册
AGENT_ID=$(curl -s -X POST $HUB/api/register \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"role\":\"$ROLE\",\"project\":\"$PROJECT\"}" \
  | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

# 拉任务
TASKS=$(curl -s "$HUB/api/tasks?project=$PROJECT&assigned_role=$ROLE&status=pending")

# 如果有任务，写到文件供执行
if echo "$TASKS" | grep -q '"id"'; then
  echo "$TASKS" > /tmp/agent-tasks.json
  echo "有新任务！查看 /tmp/agent-tasks.json"
fi

# 心跳
curl -s -X POST $HUB/mcp/tools/heartbeat \
  -H 'Content-Type: application/json' \
  -d "{\"from_id\":\"$AGENT_ID\"}" > /dev/null
```

crontab 配置：
```bash
*/10 * * * * /path/to/agent-poll.sh
```

### 方式三：Python 脚本

```python
import requests

HUB = "http://YOUR_SERVER:8100"
PROJECT = "myproject"
ROLE = "backend"

# 注册
resp = requests.post(f"{HUB}/api/register", json={
    "name": "后端Agent",
    "role": ROLE,
    "project": PROJECT,
    "capabilities": "Python,API"
})
agent_id = resp.json()["data"]["agent_id"]

# 拉任务
tasks = requests.get(f"{HUB}/api/tasks", params={
    "project": PROJECT,
    "assigned_role": ROLE,
    "status": "pending"
}).json()["data"]["tasks"]

for task in tasks:
    # 标记进行中
    requests.put(f"{HUB}/api/tasks/{task['id']}", json={
        "from_id": agent_id,
        "status": "in_progress"
    })
    
    # 执行任务...
    result = execute_task(task)
    
    # 标记完成
    requests.put(f"{HUB}/api/tasks/{task['id']}", json={
        "from_id": agent_id,
        "status": "completed",
        "result": result
    })
```

### 方式四：PowerShell（Windows 本地 Agent）

```powershell
$HUB = "http://YOUR_SERVER:8100"

# 注册
$body = @{name="前端Agent";role="frontend";project="yiyuan"} | ConvertTo-Json
$resp = Invoke-WebRequest -Uri "$HUB/api/register" -Method POST -Body $body -ContentType "application/json"
$agentId = ($resp.Content | ConvertFrom-Json).data.agent_id

# 拉任务
$tasks = (Invoke-WebRequest -Uri "$HUB/api/tasks?project=yiyuan&assigned_role=frontend&status=pending").Content | ConvertFrom-Json

# 拉消息
$msgs = (Invoke-WebRequest -Uri "$HUB/api/messages/$agentId").Content | ConvertFrom-Json
```

### 方式五：OpenCode / CodeBuddy（指令注入）

在 AI Agent 的系统提示或 AGENTS.md 中加入：

```markdown
## Agent Hub 通信

你是 [项目名] 的 [角色]，通过 Agent Hub 协作。

### 每次启动注册
AGENT_ID=$(curl -s -X POST http://SERVER:8100/api/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"前端opencode","role":"frontend","project":"yiyuan"}' \
  | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

### 拉取任务
curl -s "http://SERVER:8100/api/tasks?project=yiyuan&assigned_role=frontend&status=pending"

### 拉取消息
curl -s "http://SERVER:8100/api/messages/$AGENT_ID"

### 完成任务
curl -X PUT "http://SERVER:8100/api/tasks/TASK_ID" \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"'$AGENT_ID'","status":"completed","result":"完成描述"}'

### 给后端发消息
curl -X POST http://SERVER:8100/api/send_message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"'$AGENT_ID'","to_role":"backend","content":"消息内容"}'
```

---

## 八、复用到其他项目

Agent Hub 设计为**通用中间件**，与业务完全解耦。复用步骤：

### 1. 部署一个 Agent Hub 实例

如果已经有实例运行（如服务器 8100 端口），**直接复用**，不需要再部署。

### 2. 新项目接入

只需在注册时指定新的 `project` 名称：

```bash
# 开雁项目
curl -X POST http://43.155.210.25:8100/api/register \
  -d '{"name":"开雁后端","role":"backend","project":"kaiyan"}'

# 雪人门店管理项目
curl -X POST http://43.155.210.25:8100/api/register \
  -d '{"name":"雪人后端","role":"backend","project":"mangersystem"}'
```

项目间数据完全隔离，壹元剧场的任务不会出现在开雁项目。

### 3. 多项目矩阵

```
                 Agent Hub (8100)
                /       |         \
           yiyuan    kaiyan    mangersystem
          /  |  \      |          |    \
       PM  BE  FE    BE  QA     BE    FE
```

每个项目可以有自己独立的角色组合，不互相干扰。

### 4. 自定义角色

不同项目可以用完全不同的角色体系：

| 项目 | 角色 |
|------|------|
| yiyuan | manager / frontend / backend / qa |
| kaiyan | backend / cms-frontend / reviewer |
| mangersystem | developer / tester / deployer |

角色只是标签，Agent Hub 不对角色名做任何校验。

---

## 九、典型工作流

### 场景一：PM 派任务 → 开发执行 → 验收

```
1. PM 注册并创建任务
   POST /api/tasks {to_role: "backend", title: "实现登录接口"}

2. 后端 Agent 轮询发现任务
   GET /api/tasks?assigned_role=backend&status=pending
   → 收到消息通知 "📋 新任务: 实现登录接口"

3. 后端标记进行中
   PUT /api/tasks/{id} {status: "in_progress"}

4. 后端执行（写代码、测试、部署）

5. 后端标记完成
   PUT /api/tasks/{id} {status: "completed", result: "接口完成 POST /api/login"}
   → PM 自动收到消息通知 "📦 任务状态更新: 实现登录接口 → completed"

6. PM 验收
   → 拉代码，抽查，验收通过
```

### 场景二：测试发现 Bug → 报告 → 修复

```
1. QA 注册并发现 Bug

2. QA 给后端发消息
   POST /api/send_message {to_role: "backend", content: "🐛 Bug: 密码错误返回500"}

3. QA 给 PM 同步
   POST /api/send_message {to_id: "pm的id", content: "登录流程发现Bug，已通知后端"}

4. 后端轮询收到消息
   GET /api/messages/{后端id}
   → "🐛 Bug: 密码错误返回500"

5. 后端修复，QA 验证通过

6. QA 标记测试任务完成
   PUT /api/tasks/{测试任务id} {status: "completed", result: "测试通过 ✅"}
```

### 场景三：Agent 热替换

```
1. 后端 Hermes (v1) 正在工作
   → agent_id: aaa-111, status: online

2. 更新代码后重启 Hermes
   → 重新注册，拿到新 agent_id: bbb-222

3. 同角色旧 Agent 自动下线
   → aaa-111: status → offline
   → bbb-222: status → online, 接管 backend 角色

4. 旧 Agent 的未读消息自动转移
   → 原本发给 aaa-111 的未读消息，现在发给 bbb-222

5. 无感知切换，零消息丢失
```

### 场景四：多人协作（同一角色多 Agent）

```
1. 前端 Agent A (白天班) 注册
   → agent_id: fe-day, role: frontend, status: online

2. 前端 Agent B (夜班) 注册
   → 同 project+role，A 自动下线，B 接管
   → A 的未读消息转移给 B

3. 次日 A 回来重新注册
   → B 自动下线，A 接管
   → 无缝交接
```

---

## 十、技术实现细节

### 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js 18+ | 轻量、高性能、生态丰富 |
| Web 框架 | Express 4 | 成熟稳定、中间件丰富 |
| 数据库 | SQLite (better-sqlite3) | 零配置、单文件、够用 |
| UUID | uuid v9 | 标准 ID 生成 |
| 进程管理 | PM2 | 自动重启、开机自启、日志 |

### 源码结构

```
agent-hub/
├── server.js              # 主服务（~450行，包含所有逻辑）
├── package.json           # 依赖声明
├── config.yaml            # 配置文件
├── ecosystem.config.js    # PM2 配置
├── db.sqlite              # SQLite 数据文件（自动生成）
├── public/                # 静态文件目录（文件下载用）
└── docs/
    └── opencode-接入指令.md
```

### 核心逻辑流程

**注册流程**：
```
register(name, role, project)
  → 生成 UUID
  → 查找同 project+role 的在线 Agent
  → 标记旧 Agent 为 offline
  → 插入新 Agent 记录
  → 转移旧 Agent 的未读消息给新 Agent
  → 返回 agent_id
```

**消息路由流程**：
```
send_message(from_id, to_id/to_role, content)
  → 查找发送者的 project
  → if to_id: 点对点发送，插入一条消息
  → if to_role: 查找该 project+role 的所有在线 Agent
    → 每个 Agent 插入一条消息
    → 如果没有在线 Agent：按 to_role 存储一条（等 Agent 上线后可查）
```

**任务通知机制**：
```
assign_task(to_role, title)
  → 创建任务
  → 找到该 role 的在线 Agent
  → 自动发一条消息通知 "📋 新任务: xxx"

update_task(status)
  → 更新任务状态
  → if status == completed: 通知创建者 "📦 任务完成: xxx"
```

**心跳清理**：
```
每 60 秒执行一次：
  → 查找 last_seen 超过 5 分钟的 online Agent
  → 标记为 offline
```

### MCP 协议兼容

Agent Hub 同时暴露 MCP 兼容端点：

```
GET /mcp/tools → 返回标准 MCP 工具 schema 数组
POST /mcp/tools/{name} → 调用工具，参数在 body
```

这让支持 MCP 协议的客户端（如 Hermes 的 `hermes mcp add`）可以直接接入。

---

## 十一、运维与监控

### 日志查看

```bash
# PM2 日志
pm2 logs agent-hub

# 日志级别（config.yaml 配置）
# debug: 所有请求
# info: 注册/任务变更/Agent上下线
# warn: 异常但不致命
# error: 错误
```

### 数据库维护

```bash
# 备份数据库
cp db.sqlite db.sqlite.bak

# 查看统计
sqlite3 db.sqlite "SELECT COUNT(*) FROM agents WHERE status='online';"
sqlite3 db.sqlite "SELECT project, COUNT(*) FROM tasks GROUP BY project;"
sqlite3 db.sqlite "SELECT project, COUNT(*) FROM messages GROUP BY project;"

# 清理30天前的消息
sqlite3 db.sqlite "DELETE FROM messages WHERE created_at < datetime('now', '-30 days');"

# 清理离线超过7天的agent
sqlite3 db.sqlite "DELETE FROM agents WHERE status='offline' AND offline_at < datetime('now', '-7 days');"
```

### 健康检查

```bash
# 简单检查
curl http://localhost:8100/health

# 监控脚本（可加入 crontab）
HEALTH=$(curl -s http://localhost:8100/health | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
if [ "$HEALTH" != "running" ]; then
  pm2 restart agent-hub
fi
```

### 升级

```bash
cd ~/agent-hub
# 备份
cp db.sqlite db.sqlite.bak
# 更新代码（替换 server.js）
# 重启
pm2 restart agent-hub
```

---

## 十二、FAQ

### Q: Agent 离线后的消息会丢吗？

**不会。** 消息存在数据库里。Agent 重新注册（同 project+role）后，旧 Agent 的未读消息自动转移给新 Agent。即使换了新的 agent_id，消息也不丢。

### Q: 能支持多少个 Agent 同时在线？

SQLite 的并发写入是瓶颈，但 Agent 通信不是高频场景。实测 50+ Agent、每分钟 100+ 消息完全没有压力。如果需要更大规模，换 PostgreSQL 即可（改 better-sqlite3 为 pg）。

### Q: 如何实现真正的实时推送（WebSocket）？

当前设计是轮询拉取（Agent 定时调 `get_messages`）。如果需要实时推送：
1. 在 server.js 加 `socket.io`
2. Agent 注册时建立 WebSocket 连接
3. 有消息时 server 主动推送

但在 AI Agent 场景中，轮询已经足够。AI Agent 本身就是"定时拉任务 → 执行 → 汇报"的循环。

### Q: 安全怎么保障？

1. **传输层**：建议用 Nginx 反向代理加 HTTPS
2. **应用层**：config.yaml 设置 `auth_token`，所有请求需带 `x-auth-token` 头
3. **网络层**：安全组/防火墙限制来源 IP

### Q: 如何在多个服务器之间同步？

当前是单机部署。如果需要多机：
- 方案 A：共享同一个数据库（SQLite 放 NFS/NAS 上）
- 方案 B：改用 PostgreSQL + 多实例无状态部署
- 方案 C：每台服务器部署一个实例，Agent 按需注册到不同实例

### Q: 和 MCP（Model Context Protocol）什么关系？

Agent Hub **兼容 MCP 协议**但不依赖它。它同时提供：
- REST API（最通用，任何程序可调）
- MCP 端点（MCP 客户端可直接发现和调用工具）

MCP 是 Agent <-> Tool 的协议，Agent Hub 是 Agent <-> Agent 的中间件。两者互补。

---

## 附录：项目实例

### 当前部署信息

| 项目 | 地址 | 角色 |
|------|------|------|
| Agent Hub Server | `http://43.155.210.25:8100` | 中心服务 |
| 壹元剧场 (yiyuan) | — | manager (CodeBuddy), backend (Hermes), frontend (待接入) |
| 开雁 (kaiyan) | — | 待接入 |

### 源码位置

```
服务器: /home/agentuser/agent-hub/
PM2 进程名: agent-hub
端口: 8100
```

---

*Agent Hub — 让每个 AI Agent 都能找到自己的队友。*
