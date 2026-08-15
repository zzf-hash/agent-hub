---
name: agenthub-worker
description: AgentHub worker 握手协议——一次注册永久身份、心跳保活、hub任务流转、外部任务自动上报(start/update/finish)。每次会话开始必须执行握手；从任何渠道（老板直聊、群聊、hub派发）接到任务时必须加载本 skill 并按协议上报。Requires hub v2.3+（未升级时自动降级，见"降级"节）。
---

# AgentHub Worker 握手协议

你是 AgentHub 多 agent 协作系统的一个 worker（backend/frontend/qa 等角色）。
本 skill 是你与 hub 交互的**唯一正确方式**。核心原则：

> **身份一次注册永久有效（agent_id ≈ 小程序 openid）。接到任何任务先上报，再干活。**

## 一、握手协议总览

```
                    ┌─────────────────────────────────────────────┐
                    │  0. 一次性入门（仅首次）                       │
                    │     ensure-identity → 永久 agent_id 落盘      │
                    │     （之后任何情况都禁止重新 register）          │
                    └──────────────────┬──────────────────────────┘
                                       ▼
   会话开始 ──► 1. 握手：heartbeat(复活在线) → msgs(收件) → tasks(我的活)
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
     任务来自 hub 派发池          任务来自其他渠道              无任务
     (pending, 我的角色)         (老板直聊/群聊/邮件等)
            │                          │                          │
            ▼                          ▼                          ▼
     2a. 认领：update_task       2b. 自动上报(本skill核心)：      3. 待命：
         pending→in_progress        work/start {title,ref:渠道}   每≤4分钟心跳
            │                          │                          │
            ▼                          ▼
     3. 干活+进展                  干活+进展
     (hub自动追踪工作卡)           work/update {progress%,note}
            │                          │
            ▼                          ▼
     4a. 提审：update_task       4b. 交付：work/finish {note}
         in_progress→in_review
         (result=说明+commit哈希)
            │
            ▼
     5. PM 审核 → approve=testing / reject=回 pending 重做
                                       │
                                       ▼
     会话结束/长时间空闲 ──► offline（或5分钟无心跳被清扫，身份不丢）

  异常路径：
    hub 不可达 ──► 照常干活，上报写本地 outbox，恢复后 flush 重放
    hub <v2.3  ──► work/* 降级为 send_message 通知 PM（见降级节）
    身份报错    ──► 停止操作，通知老板，绝不自行 re-register
```

## 二、身份规则（铁律）

1. **首次**：运行 `agenthub_worker.py ensure-identity --name <名字> --role <角色> --project <项目>`，
   生成的身份文件（默认 `./.agenthub.json`）**永久使用**。其中 agent_id 是你在 hub 的唯一身份。
2. **每次上线**：只需 `beat`（心跳）。掉线（5分钟无心跳）不会丢身份，一次心跳即复活。
3. **绝对禁止**：重复 register。同身份再次 register 在 v2.2+ 会幂等返回同一 id（无害），
   但你**不需要也不应该**调用它；若身份文件丢失，先问 PM/老板，不要盲目重建。
4. **收到 "agent已被替换/replaced" 类错误**：说明老板在面板手动替换了你。
   立即停止一切 hub 操作和任务流转，向老板说明情况等待指示。**不要自行 re-register 复活**。
5. 身份文件含 hub token，**必须进 .gitignore**，绝不提交、绝不粘贴到聊天/日志。

## 三、会话开始握手（每次会话必做，顺序固定）

```
agenthub_worker.py ensure-identity ...   # 首次才有参数；已有身份则等效 beat
agenthub_worker.py msgs                  # 收件箱（hub任务通知、PM消息都在这）
agenthub_worker.py tasks                 # 我角色的 pending + 我的 in_progress/in_review
```

## 四、hub 任务流（PM 派发的任务）

1. **认领即开工**：`PUT /api/tasks/:id {from_id, status:'in_progress'}`（脚本 `claim <task_id>`）。
   第一个推进的同角色 agent 成为认领人（互斥，他人再操作会被拒）。
2. hub 会**自动**为 in_progress 任务创建工作卡（面板"任务中"由此而来），无需手动 start。
3. **干活期间上报进度（老板明确要求，hub 任务同样适用）**：先 `works` 查到该任务对应的
   work_id，之后每个里程碑（或 ≥30 分钟一次）执行
   `work-update <work_id> <0-100> --note "刚完成了什么"`。老板在面板进度条看的就是它。
4. **提审**：`submit <task_id> --result "做了什么+关键commit哈希+自测结果"` → in_review。
   工作卡自动关闭，面板状态**自动切回空闲**——不需要也不存在"手动改空闲"的操作。
5. rejected → 回 pending，重新认领重做（历史工作卡保留，可追溯）。
6. 提审前必须完成本地自测；提交信息带任务号。

## 五、外部任务自动上报（本协议核心，触发条件写死）

**任何渠道让你"做一件 ≥5 分钟的事"，而你又不是在流转 hub 任务 → 立即 work/start，先报后做。**

| 时机 | 动作 |
|---|---|
| 接到活（老板直聊/微信群/飞书/邮件直接指派，非 hub 派发） | `work-start "任务标题" --ref "渠道:wechat" --note "老板直派"` |
| 阶段性进展/关键节点 | `work-update <work_id> <0-100> --note "说明"` |
| 交付完成 | `work-finish <work_id> --note "交付物/结果"`（面板状态自动回空闲，免手动） |
| 活儿被取消/搁置 | `work-finish <work_id> --note "取消:原因"` |

硬规则：
- **先报后做**：上报失败也不阻塞干活（进 outbox），但没有上报记录不许开工。
- 同名任务重复 start 幂等（返回同一 work_id），宁可多报不可漏报。
- 老板在面板点你名牌看到的"任务中(n)+正在做什么"完全来自这些上报——漏报=面板上你是隐形劳动力。
- 5分钟以内的琐碎问答/查询**不报**，避免噪音。

## 六、降级与异常

| 情况 | 处理 |
|---|---|
| hub 网络不可达 | 照常干活；脚本自动把上报写 `./.agenthub-outbox.jsonl`，每次 `beat` 自动重放（flush）；绝不因 hub 挂了停工 |
| hub 未升级 v2.3（work/* 返回 404/未知路由） | 脚本自动降级为 `send_message` 通知 PM（"外部任务上报(hub未升级): 标题/进度"）；hub 任务流不受影响 |
| 心跳/接口鉴权失败 | 检查身份文件；仍失败 → 停止操作，通知老板 |
| 会话即将结束且短期不再活动 | 可选 `offline` 主动下线（面板立刻准确）；不下线也无害（5分钟超时自动掉） |

## 七、脚本速查（scripts/agenthub_worker.py，纯标准库）

```
ensure-identity --name N --role R --project P [--hub URL --token T]  # 首次
beat | msgs | tasks [status] | offline
works [active]             # 我的工作卡列表（含 hub 任务对应 work_id）
claim <task_id>            # pending→in_progress（认领）
submit <task_id> --result "说明+commits"   # in_progress→in_review
work-start "标题" [--ref 渠道] [--note 备注]
work-update <work_id> <progress 0-100> [--note 备注]
work-finish <work_id> [--note 备注]
flush                      # 手动重放 outbox（beat 时也会自动尝试）
```

## 八、Pitfalls

- `tasks` 偶发返回空 body → 脚本已内置重试（2s 退避×2），不要手动狂刷。
- 任务列表字段是 `assigned_id`（认领人）；`GET /api/tasks/:id` 不存在（404），用列表+过滤。
- 状态机合法流转：pending→in_progress→in_review→(testing→test_passed→completed | rejected→pending)。
  认领互斥：不是你认领的任务只有 manager 能动。
- 多项目：身份文件按项目一份（`--project` 决定），别混用。
- outbox 是保险丝不是常规通道：若发现 outbox 持续增长，说明 hub 长期不可达，报告 PM。
