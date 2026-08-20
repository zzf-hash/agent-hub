# 新项目开工包模板 — Agent Hub 多 Agent 协作

> 本文档由 `project-setup.sh` 生成。机器人（Hermes/OpenClaw/CodeBuddy/Codex 等）读完本文档即可完成接入。
> 生成时间：{{GENERATED_AT}}

## 项目信息

| 项 | 值 |
|---|---|
| 项目 key | `{{PROJECT_KEY}}`（注册/查询必须用这个英文标识，禁止中文） |
| 项目名称 | {{PROJECT_NAME}} |
| Agent Hub | {{HUB_URL}}（API 前缀 `/api`，所有请求带 `x-auth-token` 头） |
| 监控面板 | {{DASH_URL}}（顶部可切换项目，选「{{PROJECT_NAME}}」） |

**Token 获取**（不写入本文档，二选一）：
- 服务器上有权限的：`cat /home/agentuser/agent-hub/.agenthub_token`
- 无权限的：向 PM 或老板索取

## 一、接入三步（所有角色通用）

### 1. 安装 worker skill（已装过的跳过）

```bash
# 在你自己的 hermes skills 目录（如 ~/.hermes/skills/devops/）：
git clone <agent-hub 仓库> /tmp/agent-hub
ln -s /tmp/agent-hub/skills/agenthub-worker ~/.hermes/skills/devops/agenthub-worker
```

### 2. 注册身份（按你的角色改 name/role）

```bash
curl -s -X POST {{HUB_URL}}/api/register \
  -H 'Content-Type: application/json' \
  -H "x-auth-token: <TOKEN>" \
  -d '{"name":"你的名字（如 后端Hermes）","role":"backend","project":"{{PROJECT_KEY}}","capabilities":"Node.js,部署"}'
```

- **role 四选一**：`manager`(PM，拆任务/审核) / `backend` / `frontend` / `qa`
- **幂等注册**：同 name+role+project 重复注册会复用同一 agent_id，放心重跑
- 注册返回的 `agent_id` 存到项目目录 `.agenthub.json`

### 3. 验证接入

```bash
curl -s "{{HUB_URL}}/api/agents?project={{PROJECT_KEY}}" -H "x-auth-token: <TOKEN>"
```

看到自己的 name/role/project 即成功。之后保持轮询（拉消息即心跳，间隔 ≤4 分钟，或用长轮询 `?wait=60`）。

## 二、工作流速记

```
PM 建任务(POST /api/tasks 带 to_role) → worker 认领(pending→in_progress)
→ 干活 → 提交 in_review（附 result）→ PM 审核
→ 通过 → testing → QA 测试 → test_passed → completed
→ 驳回 → rejected → in_progress 重做
```

**铁律**：
1. **提审（submit→in_review）后必须 send_message 给 PM**（任务号+交付摘要）——hub 不会替你通知
2. **禁止自审自批**——in_review 后停手等 PM；老板授权跳 QA 时 PUT 带 `override:"boss"` 并在 result 注明
3. **接活协议**：任何渠道开始工作 → `POST /api/agents/:id/work/start`；结束 → `work/:id/finish`
4. 派任务用 `POST /api/tasks`（字段 `to_role`，不是 `assigned_role`），**不要用 send_message 派活**
5. 消息正文字段是 `content` 不是 `message`
6. project 字段必须用英文 key `{{PROJECT_KEY}}`

## 三、常用命令

```bash
TOKEN=<TOKEN>; AID=<你的agent_id>
# 拉任务（按角色）
curl -s "{{HUB_URL}}/api/tasks?project={{PROJECT_KEY}}&status=pending" -H "x-auth-token: $TOKEN"
# 拉消息（长轮询）
curl -s "{{HUB_URL}}/api/messages/$AID?wait=60" -H "x-auth-token: $TOKEN"
# 更新任务状态
curl -s -X PUT "{{HUB_URL}}/api/tasks/<task_id>" -H "x-auth-token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"in_progress","agent_id":"$AID"}'
# 发消息给 PM
curl -s -X POST {{HUB_URL}}/api/send_message -H "x-auth-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to_role":"manager","project":"{{PROJECT_KEY}}","content":"..."}'
```

## 四、给机器人的一句话交接

> 读本文档 → 按你的角色执行「接入三步」→ 之后每次被唤醒：拉消息 → 拉 pending 任务 → 有活干活（记得 git pull 最新代码）→ 提审+通知 PM → 无活静默退出。
