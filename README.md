# Agent Hub - 通用多Agent通信中间件

任何项目、任何 agent 接入即用的消息/任务通信枢纽。

## 快速开始

### 服务端
```bash
cd ~/agent-hub
npm install
npm start          # 或 pm2 start ecosystem.config.js
```

默认端口 `8100`，修改 `config.yaml` 调整。

### Agent 接入（任何语言、任何框架）

所有交互都是 HTTP REST，两种调用方式：

**方式一：REST API（推荐，最通用）**

```bash
# 1. 注册
curl -X POST http://你的服务器:8100/api/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"后端Hermes","role":"backend","project":"yiyuan","capabilities":"Node.js,API"}'
# → 返回 { "code":0, "data":{ "agent_id":"xxx" } }
# 存下 agent_id，后续所有调用都用它

# 2. 拉取消息
curl http://你的服务器:8100/api/messages/你的agent_id

# 3. 发消息给前端
curl -X POST http://你的服务器:8100/api/send_message \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的agent_id","to_role":"frontend","content":"接口好了"}'

# 4. 查分配给自己的任务
curl "http://你的服务器:8100/api/tasks?project=yiyuan&assigned_role=backend"

# 5. 更新任务状态
curl -X PUT http://你的服务器:8100/api/tasks/任务id \
  -H 'Content-Type: application/json' \
  -d '{"from_id":"你的agent_id","status":"completed","result":"已实现，接口地址/api/member/info"}'

# 6. 查看所有在线agent
curl http://你的服务器:8100/api/agents
```

**方式二：MCP 协议（Hermes 等支持 MCP 的客户端）**

```
GET  /mcp/tools              # 列出所有工具
POST /mcp/tools/{tool_name}  # 调用工具，body 传参数
```

## API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/register | 注册/上线 |
| GET | /api/messages/:agent_id | 拉取消息(?all=true含已读) |
| POST | /api/send_message | 发消息(to_id或to_role) |
| POST | /api/tasks | 创建分配任务 |
| GET | /api/tasks | 查任务(可过滤) |
| PUT | /api/tasks/:task_id | 更新任务状态 |
| GET | /api/agents | 查在线agent(?project=xxx) |
| POST | /api/offline/:agent_id | 下线 |
| GET | /health | 健康检查 |

## 角色设计

角色完全自由，常见角色：

| role | 职责 |
|---|---|
| manager | 项目经理，分配任务 |
| frontend | 前端开发 |
| backend | 后端开发 |
| qa | 测试 |

**可自定义任何角色**，如 devops/designer/reviewer 等。

## 项目隔离

注册时指定 `project`，消息和任务按 project 隔离。不同项目的数据互不干扰。

## Agent 替换机制

同 project + role 的 agent 重新注册时：
1. 旧 agent 自动下线
2. 旧 agent 的未读消息自动转移给新 agent
3. 新 agent 立即接管该角色

## 心跳保活

Agent 应定期（建议30秒~1分钟）调用：
```
POST /mcp/tools/heartbeat { "from_id": "你的agent_id" }
```
超过5分钟未心跳自动标记 offline。

## 典型工作流

```
项目经理 → assign_task(to_role="backend", "实现登录接口")
后端     ← 收到消息通知 + 任务出现在任务列表
后端     → update_task(status="completed", result="接口好了")
前端     ← 收到消息通知（如果PM同时通知了前端）
前端     → 开始对接接口
测试     → assign_task(to_role="qa", "测试登录流程")
测试     → update_task(status="completed", result="通过")
```

## 安全

生产环境在 `config.yaml` 设置 `auth_token`，所有请求需带 `x-auth-token` 头。


## 备份说明（v2.0.0 起）

本仓库是生产服务器(43.155.210.25)部署目录的备份镜像。**真实密钥只存在于服务器上的 `config.yaml` 与 `.agenthub_token`**，仓库中仅提供脱敏模板 `config.example.yaml`。数据库文件(db.sqlite等)不入库。

- 线上运行：pm2 `agent-hub`，部署路径 `/home/agentuser/agent-hub`，端口 8100
- v2.0.0 多Agent审批流工作流引擎源码于 2026-08-15 从该部署目录同步
