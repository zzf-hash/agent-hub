/**
 * Agent Hub v2 - 多Agent协作工作流中间件
 * 
 * v2 新增:
 * 1. 任务状态机 (pending→in_progress→in_review→approved/rejected→testing→done)
 * 2. 任务依赖 (parent_id, depends_on)
 * 3. 审批流 (review_task, split_task)
 * 4. 编排引擎 (自动触发测试/修复)
 * 5. task_events 审计日志
 * 6. 角色权限
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// 简单读取yaml配置
// v2.1.2 A2 冷启动修复：config.yaml 不存在时回退 config.example.yaml，再回退空默认。
// 此前 fs.readFileSync(config.yaml) 硬依赖使新 clone 无法启动（env 覆盖在文件读取之后，救不了）。
// env 优先级不变（PORT/HUB_AUTH_TOKEN/HUB_DB 等仍可覆盖一切文件值）。
const CONFIG_FILES = ['config.yaml', 'config.example.yaml'];
let rawConfig = '';
for (const f of CONFIG_FILES) {
  try {
    rawConfig = fs.readFileSync(__dirname + '/' + f, 'utf8');
    break;
  } catch (e) { /* 尝试下一个回退文件 */ }
}
const config = {};
rawConfig.split('\n').forEach(line => {
  const m = line.match(/^(\w+):\s*(.*)$/);
  if (m && m[2].trim()) config[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
});

// v2.1: 支持环境变量覆盖（隔离测试实例用：PORT=8199 HUB_DB=/tmp/x.sqlite node server.js）
// v2.2: 支持 env 覆盖（测试隔离实例用 PORT/HUB_DB/HUB_WEBHOOK_URL，不设则与原行为完全一致）
const PORT = parseInt(process.env.PORT || config.port) || 8100;
const AUTH_TOKEN = process.env.HUB_AUTH_TOKEN || config.auth_token || '';
const DB_PATH = process.env.HUB_DB || config.db_path || './db.sqlite';
const LOG_LEVEL = process.env.HUB_LOG_LEVEL || config.log_level || 'info';
const HERMES_WEBHOOK_URL = process.env.HUB_WEBHOOK_URL !== undefined ? process.env.HUB_WEBHOOK_URL : (config.hermes_webhook_url || '');
const HERMES_WEBHOOK_SECRET = process.env.HUB_WEBHOOK_SECRET !== undefined ? process.env.HUB_WEBHOOK_SECRET : (config.hermes_webhook_secret || '');

// ---------- 日志 ----------
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, msg, data) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(data !== undefined ? `${line} ${JSON.stringify(data)}` : line);
}

// ---------- 数据库初始化 ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');


// v1 表（兼容已有数据）
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL,
    project     TEXT NOT NULL,
    capabilities TEXT DEFAULT '',
    status      TEXT DEFAULT 'online',
    online_at   TEXT DEFAULT (datetime('now')),
    offline_at  TEXT,
    last_seen   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    from_name   TEXT,
    to_id       TEXT,
    to_role     TEXT,
    content     TEXT NOT NULL,
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    project       TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    assigned_role TEXT,
    assigned_id   TEXT,
    status        TEXT DEFAULT 'pending',
    priority      TEXT DEFAULT 'normal',
    result        TEXT DEFAULT '',
    created_by    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    completed_at  TEXT
  );
`);

// v2 迁移：给 tasks 表加新字段（ALTER TABLE ADD COLUMN 幂等性靠 catch）
const newColumns = [
  'parent_id TEXT DEFAULT NULL',
  'depends_on TEXT DEFAULT NULL',
  'task_type TEXT DEFAULT "dev"',
  'review_status TEXT DEFAULT NULL',
  'reviewer_id TEXT DEFAULT NULL',
  'review_comment TEXT DEFAULT NULL',
  'reviewed_at TEXT DEFAULT NULL',
  'retry_of TEXT DEFAULT NULL',
  'retry_count INTEGER DEFAULT 0',
  'epic_id TEXT DEFAULT NULL'
];

for (const col of newColumns) {
  const colName = col.split(' ')[0];
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    log('info', `Migration: added column ${colName} to tasks`);
  } catch (e) {
    // 列已存在，跳过
  }
}

// v2 新表：task_events（审计日志）
db.exec(`
  CREATE TABLE IF NOT EXISTS task_events (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    event       TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    actor_id    TEXT,
    actor_name  TEXT,
    comment     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_events_project ON task_events(task_id);
`);

// v2 新表：epics（需求/大任务，PM拆解的根）
db.exec(`
  CREATE TABLE IF NOT EXISTS epics (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT DEFAULT 'open',
    created_by  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_msg_project ON messages(project);
  CREATE INDEX IF NOT EXISTS idx_msg_to_role ON messages(to_role);
  CREATE INDEX IF NOT EXISTS idx_msg_to_id ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_task_project ON tasks(project);
  CREATE INDEX IF NOT EXISTS idx_task_assigned ON tasks(assigned_role);
  CREATE INDEX IF NOT EXISTS idx_task_parent ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_task_epic ON tasks(epic_id);
  CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project);
`);

// v2.1 身份机制：agents 表加 replaced_at 列（replaced 墓碑时间戳，幂等迁移）
// 注意：必须在上面 CREATE TABLE agents 之后执行（全新库首启时表刚建好）
try {
  db.exec(`ALTER TABLE agents ADD COLUMN replaced_at TEXT`);
  log('info', `Migration: added column replaced_at to agents`);
} catch (e) { /* 列已存在，跳过 */ }

// v2.3 agent_work 工作追踪表（任务 933e16a3）：
// 记录 agent 正在执行的所有工作——两类来源：
//   source='hub'：update_task 推入 in_progress 时自动 INSERT（agent 零负担）
//   source='external'：老板在其它渠道派活，agent 通过 /api/agents/:id/work/start 上报
// 状态机：active → done（finish 或任务离开 in_progress）；active → stale（失联判定）→ active（复活拉回）
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_work (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    project      TEXT NOT NULL,
    title        TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'external',   -- 'hub' | 'external'
    hub_task_id  TEXT DEFAULT NULL,                  -- source='hub' 时对应的任务ID
    progress     INTEGER DEFAULT NULL,               -- 0-100，仅 external 使用（hub 不伪造百分比）
    status       TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'done' | 'stale'
    note         TEXT DEFAULT '',
    started_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    finished_at  TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_agent ON agent_work(agent_id);
  CREATE INDEX IF NOT EXISTS idx_work_project ON agent_work(project);
  CREATE INDEX IF NOT EXISTS idx_work_status ON agent_work(status);
  CREATE INDEX IF NOT EXISTS idx_work_hub_task ON agent_work(hub_task_id);
`);

// v2.5 需求清单表（监控面板「项目进度」侧栏）：progress 仅 PM(manager) 可改，status 由 progress 实时派生
db.exec(`
  CREATE TABLE IF NOT EXISTS requirements (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    progress    INTEGER NOT NULL DEFAULT 0,          -- 0-100，PM 维护
    task_id     TEXT DEFAULT NULL,                   -- 可选关联 hub 任务（显示实时任务状态）
    sort_order  INTEGER DEFAULT 0,
    created_by  TEXT DEFAULT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project);
  CREATE TABLE IF NOT EXISTS requirement_tasks (          -- v2.5.1 需求↔任务多对多关联
    req_id  TEXT NOT NULL,
    task_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (req_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reqtask_task ON requirement_tasks(task_id);
`);

// v2.6 项目注册表（多项目支持）：key=英文标识，name=中文显示名
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    key         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by  TEXT DEFAULT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ---------- 工具函数 ----------
function now() { return new Date().toISOString(); }

// ---------- 状态机 ----------
const VALID_TRANSITIONS = {
  'pending':      ['in_progress', 'cancelled'],
  'in_progress':  ['in_review', 'cancelled'],
  'in_review':    ['testing', 'rejected', 'in_progress'], // 审核通过直接进testing
  'rejected':     ['in_progress', 'cancelled'],            // 修复中
  'testing':      ['test_passed', 'test_failed'],
  'test_passed':  ['completed'],
  'test_failed':  ['in_progress'],                          // 回到开发修复
  'completed':    [],
  'cancelled':    []
};

// 终态
const TERMINAL_STATES = ['completed', 'cancelled'];

function canTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------- 鉴权 ----------
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- 角色权限 ----------
const ROLE_PERMISSIONS = {
  'manager': ['assign_task', 'review_task', 'split_task', 'create_epic', 'update_task', 'delete_task'],
  'backend': ['update_task', 'send_message', 'get_messages', 'get_tasks'],
  'frontend': ['update_task', 'send_message', 'get_messages', 'get_tasks'],
  'qa': ['update_task', 'get_tasks', 'send_message', 'get_messages'],
};

function getAgentRole(agentId) {
  const agent = db.prepare(`SELECT role FROM agents WHERE id = ?`).get(agentId);
  return agent ? agent.role : null;
}

function hasPermission(agentId, action) {
  const role = getAgentRole(agentId);
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return true; // 未知角色默认放开（向后兼容）
  return perms.includes(action);
}

// ---------- 统一响应 ----------
function ok(data) { return { code: 0, data }; }
function fail(msg, code = 1) { return { code, error: msg }; }

// ---------- 事件记录 ----------
function logEvent(taskId, event, fromStatus, toStatus, actorId, actorName, comment) {
  db.prepare(
    `INSERT INTO task_events (id, task_id, event, from_status, to_status, actor_id, actor_name, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), taskId, event, fromStatus || null, toStatus || null, actorId || null, actorName || null, comment || '');
}

// ---------- [Phase1] 实时推送基础设施（长轮询 + SSE） ----------
// 设计说明：
//   - 事件总线 hubEvents 承载两类事件：
//       EVT_MESSAGE: 新消息落库后触发（含系统通知），唤醒长轮询 + 推送SSE
//       EVT_TASK:    任务创建/状态变化后触发，推送SSE
//   - 不改数据库表结构，不改现有API请求/响应格式，纯增量。
const EventEmitter = require('events');
const hubEvents = new EventEmitter();
hubEvents.setMaxListeners(0); // SSE/长轮询并发连接数不定，解除监听器数量告警限制

const EVT_MESSAGE = 'hub:message';
const EVT_TASK = 'hub:task';

// SSE 连接注册表：agent_id -> Set<client>（同一agent允许多连接）
const sseClients = new Map();

// 消息落库后调用：唤醒该收件人挂起的长轮询，并推送其SSE连接
function emitNewMessage(toId, payload) {
  if (!toId) return;
  hubEvents.emit(EVT_MESSAGE, { to_id: toId, message: payload || null });
}

// 任务创建/状态变化后调用：推送给关注该任务的SSE连接
function emitTaskEvent(type, taskRow) {
  if (!taskRow) return;
  hubEvents.emit(EVT_TASK, { type, task: taskRow });
}

// 向单个SSE客户端写事件（写失败由 close 处理器兜底清理，这里只吞异常）
function sseSend(client, eventName, data) {
  try {
    client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    log('debug', `SSE write failed (will be cleaned on close)`, { error: e.message });
  }
}

// 关闭指定agent的全部SSE连接（agent显式下线/被替换/心跳超时时调用，防泄漏）
function closeSseForAgent(agentId) {
  const set = sseClients.get(agentId);
  if (!set) return;
  for (const client of set) {
    if (client.pingTimer) clearInterval(client.pingTimer);
    try { client.res.end(); } catch (e) { /* 已断开则忽略 */ }
  }
  sseClients.delete(agentId);
  log('debug', `SSE: closed all connections for agent`, { agent_id: agentId, count: set.size });
}

// [Phase1] 长轮询辅助：取未读 / 标记已读（与 tools.get_messages 行为一致）
function fetchUnreadMessages(agentId) {
  return db.prepare(
    `SELECT * FROM messages WHERE to_id = ? AND is_read = 0 ORDER BY created_at ASC LIMIT 100`
  ).all(agentId);
}
function markMessagesRead(agentId) {
  db.prepare(`UPDATE messages SET is_read = 1 WHERE to_id = ? AND is_read = 0`).run(agentId);
}

// ---------- 系统消息通知 ----------
function notifyAgent(agentId, project, content) {
  if (!agentId) return;
  const msgId = uuidv4();
  db.prepare(
    `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
     VALUES (?, ?, 'system', 'AgentHub', ?, ?)`
  ).run(msgId, project, agentId, content);
  // [Phase1] 唤醒该agent的长轮询 + 推送SSE
  emitNewMessage(agentId, { id: msgId, project, from_id: 'system', from_name: 'AgentHub', to_id: agentId, content });
}

function notifyRole(role, project, content) {
  const agents = db.prepare(
    `SELECT id FROM agents WHERE project = ? AND role = ? AND status = 'online'`
  ).all(project, role);
  for (const a of agents) {
    notifyAgent(a.id, project, content);
  }
  if (agents.length === 0) {
    // 存一条悬空消息，等该角色上线时能看到（虽然 get_messages 按 to_id 查，所以也存一条 to_role 的）
    db.prepare(
      `INSERT INTO messages (id, project, from_id, from_name, to_role, content)
       VALUES (?, ?, 'system', 'AgentHub', ?, ?)`
    ).run(uuidv4(), project, role, content);
  }
}

// ---------- v2.3 agent_work 工作追踪（任务 933e16a3） ----------
// hub 任务自动追踪 + 外部任务上报 + stale 失联判定 共用的底层操作。
// 设计要点：
//   - hub 工作项锚定 (hub_task_id, agent_id)：任务进入 in_progress 建 active 项，
//     离开 in_progress 关项置 done；rejected 退回后重新认领会生成新工作项（历史保留可追溯）。
//   - external 工作项锚定 (agent_id, title) 幂等：同 agent 同 title 已有 active → 复用更新。
//   - 失联判定不新建定时器，搭 60s 心跳清扫器的车（见文件底部）。

// 任务进入 in_progress：无该任务 active 工作项则自动 INSERT（幂等）
function startHubWork(agentId, project, taskId, title) {
  if (!agentId || !taskId) return;
  const exist = db.prepare(
    `SELECT id FROM agent_work WHERE hub_task_id = ? AND agent_id = ? AND status = 'active'`
  ).get(taskId, agentId);
  if (exist) return;
  db.prepare(
    `INSERT INTO agent_work (id, agent_id, project, title, source, hub_task_id, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, 'hub', ?, 'active', ?, ?)`
  ).run(uuidv4(), agentId, project, title, taskId, now(), now());
  log('info', `agent_work: hub work started`, { agent_id: agentId, hub_task_id: taskId });
}

// 任务离开 in_progress：该任务全部 active hub 工作项置 done（含接管重绑后的旧认领人项）
function finishHubWork(taskId) {
  if (!taskId) return;
  const r = db.prepare(
    `UPDATE agent_work SET status = 'done', finished_at = ?, updated_at = ? WHERE hub_task_id = ? AND source = 'hub' AND status = 'active'`
  ).run(now(), now(), taskId);
  if (r.changes > 0) log('info', `agent_work: hub work finished`, { hub_task_id: taskId, closed: r.changes });
}

// external 工作项幂等锚点：同 agent 同 title 的 active 项
function findActiveExternalByTitle(agentId, title) {
  return db.prepare(
    `SELECT * FROM agent_work WHERE agent_id = ? AND source = 'external' AND title = ? AND status IN ('active','stale')`
  ).get(agentId, title);
}

// agent 复活（心跳/拉消息/update 上报）时拉回其全部 stale 工作项
function reviveStaleWorks(agentId) {
  const r = db.prepare(
    `UPDATE agent_work SET status = 'active', updated_at = ? WHERE agent_id = ? AND status = 'stale'`
  ).run(now(), agentId);
  if (r.changes > 0) log('info', `agent_work: stale works revived`, { agent_id: agentId, revived: r.changes });
}

// SSE 工作项事件推送（dashboard 实时刷新用，Phase1 简化：随 EVT_TASK 全局广播）
function emitWorkEvent(type, workRow) {
  if (!workRow) return;
  hubEvents.emit(EVT_TASK, { type, work: workRow });
}

// ---------- 老板通知 (通过 Hermes webhook → 微信) ----------
const http = require('http');
const crypto = require('crypto');

function notifyBoss(eventType, message) {
  if (!HERMES_WEBHOOK_URL) {
    log('warn', 'notifyBoss: HERMES_WEBHOOK_URL not configured, skip');
    return;
  }

  // 必须用 agenthub.task 事件（订阅只监听这个）
  // message 放到 task.description 里，这样 Hermes 会话能收到
  const payload = JSON.stringify({
    event_type: 'agenthub.task',
    task: {
      id: 'notify-' + Date.now(),
      title: message.split('\n')[0] || '通知',
      description: message,
      priority: 'normal',
      assigned_role: 'notify',
      _notify_type: eventType
    }
  });

  // 解析 URL
  const urlObj = new URL(HERMES_WEBHOOK_URL);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  // HMAC 签名（订阅级别 secret）
  if (HERMES_WEBHOOK_SECRET) {
    const sig = crypto.createHmac('sha256', HERMES_WEBHOOK_SECRET).update(payload).digest('hex');
    options.headers['X-Hub-Signature-256'] = `sha256=${sig}`;
  }

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      log('info', `notifyBoss webhook: ${res.statusCode} ${body.slice(0, 100)}`);
    });
  });
  req.on('error', (e) => {
    log('error', `notifyBoss webhook failed: ${e.message}`);
  });
  req.write(payload);
  req.end();
}

// ---------- 编排引擎 ----------
// 当任务状态变更时，检查是否需要自动触发后续动作
function orchestrate(taskId, newStatus, actorId) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
  if (!task) return;

  // 场景1: 一个开发任务变成 approved，检查同 epic 下是否所有子任务都 approved
  if (newStatus === 'approved' && task.epic_id) {
    const siblings = db.prepare(
      `SELECT * FROM tasks WHERE epic_id = ? AND id != ? AND task_type = 'dev'`
    ).all(task.epic_id, taskId);

    const allApproved = siblings.every(s => s.status === 'approved' || s.status === 'completed' || s.status === 'testing' || s.status === 'test_passed');
    
    // 如果有同 epic 的其他 dev 任务都 approved/completed 了，检查是否已有测试任务
    if (allApproved && siblings.length > 0) {
      // 检查是否已存在测试任务
      const existingTest = db.prepare(
        `SELECT id FROM tasks WHERE epic_id = ? AND task_type = 'test' AND status NOT IN ('completed', 'cancelled')`
      ).get(task.epic_id);

      if (!existingTest) {
        // 自动创建测试任务
        const epic = db.prepare(`SELECT * FROM epics WHERE id = ?`).get(task.epic_id);
        if (epic) {
          const testTaskId = uuidv4();
          db.prepare(
            `INSERT INTO tasks (id, project, title, description, assigned_role, status, priority, created_by, task_type, epic_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'qa', 'testing', ?, ?, 'test', ?, ?, ?)`
          ).run(
            testTaskId, task.project,
            `[测试] ${epic.title}`,
            `自动生成的测试任务。\n原始需求: ${epic.description || epic.title}`,
            task.priority,
            actorId || task.created_by,
            task.epic_id,
            now(), now()
          );

          logEvent(testTaskId, 'auto_created', null, 'testing', 'system', 'AgentHub-Orchestrator', `Epic ${task.epic_id} 所有开发任务已审核通过，自动创建测试任务`);

          // 通知 QA
          notifyRole('qa', task.project, `🧪 新测试任务: [测试] ${epic.title}`);
          
          // 通知 PM
          notifyRole('manager', task.project, `✅ Epic "${epic.title}" 所有开发任务审核通过，已自动派发测试任务`);

          log('info', `Orchestrate: auto-created test task for epic ${task.epic_id}`, { test_task_id: testTaskId });
        }
      }
    }
  }

  // 场景2: 测试失败，自动生成修复任务
  if (newStatus === 'test_failed' && task.task_type === 'test') {
    // 找到同 epic 下的原开发任务，生成修复版本
    const epic = db.prepare(`SELECT * FROM epics WHERE id = ?`).get(task.epic_id);
    if (epic) {
      const devTasks = db.prepare(
        `SELECT * FROM tasks WHERE epic_id = ? AND task_type = 'dev'`
      ).all(task.epic_id);

      for (const devTask of devTasks) {
        const fixTaskId = uuidv4();
        db.prepare(
          `INSERT INTO tasks (id, project, title, description, assigned_role, status, priority, created_by, task_type, epic_id, retry_of, retry_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'dev', ?, ?, ?, ?, ?)`
        ).run(
          fixTaskId, task.project,
          `[修复] ${devTask.title}`,
          `测试失败，需要修复。\n测试结果: ${task.result || '未提供详情'}\n原始任务: ${devTask.title}`,
          devTask.assigned_role,
          'urgent',
          actorId || task.created_by,
          task.epic_id,
          devTask.id,
          (devTask.retry_count || 0) + 1,
          now(), now()
        );

        logEvent(fixTaskId, 'auto_created_fiX', null, 'pending', 'system', 'AgentHub-Orchestrator', `测试失败自动生成修复任务，源任务: ${devTask.id}`);
        notifyRole(devTask.assigned_role, task.project, `🐛 修复任务: [修复] ${devTask.title} (测试失败)`);
      }

      notifyRole('manager', task.project, `❌ Epic "${epic.title}" 测试失败，已自动生成 ${devTasks.length} 个修复任务`);
      notifyBoss('agenthub.test', `❌ 测试失败\n\n📋 需求: ${epic.title}\n📝 原因: ${task.result || '未说明'}\n→ 已自动生成 ${devTasks.length} 个修复任务，打回开发`);
      log('info', `Orchestrate: auto-created ${devTasks.length} fix tasks for epic ${task.epic_id}`);
    }
  }

  // 场景3: 测试通过，通知 PM + 老板
  if (newStatus === 'test_passed' && task.task_type === 'test') {
    const epic = db.prepare(`SELECT * FROM epics WHERE id = ?`).get(task.epic_id);
    if (epic) {
      notifyRole('manager', task.project, `🎉 Epic "${epic.title}" 测试通过！可以推进下一步了`);
      notifyBoss('agenthub.test', `🎉 测试通过\n\n📋 需求: ${epic.title}\n→ 全部子任务完成，可以推进下一阶段`);
      // 把同 epic 的所有 dev 任务也标记为 completed
      const closed = db.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE epic_id = ? AND task_type = 'dev' AND status != 'completed'`
      ).run(now(), now(), task.epic_id);
      if (closed.changes > 0) {
        // v2.3：编排旁路批量完成的任务，hub 工作项一并收口
        const tids = db.prepare(
          `SELECT id FROM tasks WHERE epic_id = ? AND task_type = 'dev' AND status = 'completed'`
        ).all(task.epic_id).map((r) => r.id);
        finishHubWorkForTasks(tids);
      }
    }
  }
}

// ---------- v2.3 编排旁路：orchestrate 场景3 直接 UPDATE tasks 绕过 update_task ----------
// 该路径把 dev 任务批量置 completed 但不经过 update_task，hub 工作项会滞留 active。
// 这里补一个收口：凡被批量完成的任务，其 active hub 工作项一并关闭。
function finishHubWorkForTasks(taskIds) {
  if (!taskIds || !taskIds.length) return;
  const stmt = db.prepare(
    `UPDATE agent_work SET status = 'done', finished_at = ?, updated_at = ? WHERE hub_task_id = ? AND source = 'hub' AND status = 'active'`
  );
  for (const tid of taskIds) stmt.run(now(), now(), tid);
}

// ---------- MCP 工具定义 ----------
const MCP_TOOLS = [
  {
    name: 'register',
    description: '注册/上线agent。返回agent_id。同project+role的旧agent自动下线，未读消息转移给新agent。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent名称' },
        role: { type: 'string', description: '角色: manager/frontend/backend/qa 等' },
        project: { type: 'string', description: '项目名' },
        capabilities: { type: 'string', description: '能力声明，逗号分隔' }
      },
      required: ['name', 'role', 'project']
    }
  },
  {
    name: 'send_message',
    description: '发送消息给指定agent(按id)或角色(按role)。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' },
        to_id: { type: 'string' },
        to_role: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['content']
    }
  },
  {
    name: 'get_messages',
    description: '获取自己的未读消息。读取即标记已读。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' },
        all: { type: 'boolean', description: 'true=包含已读' }
      },
      required: ['from_id']
    }
  },
  {
    name: 'assign_task',
    description: '创建并分配任务。PM创建需求时可指定epic_id关联一组子任务。',
    inputSchema: {
      type: 'object',
      properties: {
        created_by: { type: 'string' },
        project: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        to_role: { type: 'string' },
        to_id: { type: 'string' },
        priority: { type: 'string', description: 'urgent/high/normal/low' },
        epic_id: { type: 'string', description: '关联的Epic ID（PM拆解时用）' },
        task_type: { type: 'string', description: 'dev(开发)/test(测试)/fix(修复)，默认dev' },
        depends_on: { type: 'string', description: '依赖的任务ID，逗号分隔' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'get_tasks',
    description: '查询任务。可按项目、角色、状态、epic过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', description: 'pending/in_progress/in_review/approved/rejected/testing/test_passed/test_failed/completed/cancelled' },
        assigned_role: { type: 'string' },
        assigned_id: { type: 'string' },
        epic_id: { type: 'string' }
      }
    }
  },
  {
    name: 'update_task',
    description: '更新任务状态。状态机校验：pending→in_progress→in_review→approved/rejected→testing→test_passed/test_failed→completed',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        from_id: { type: 'string', description: '操作者agent_id' },
        status: { type: 'string' },
        result: { type: 'string', description: '任务结果/备注' }
      },
      required: ['task_id', 'status']
    }
  },
  {
    name: 'review_task',
    description: '【PM专用】审核任务。approve=审核通过，reject=打回重做。审核通过后若同epic所有dev任务都通过，自动创建测试任务。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reviewer_id: { type: 'string', description: '审核者agent_id（必须是manager角色）' },
        decision: { type: 'string', enum: ['approve', 'reject'], description: 'approve或reject' },
        comment: { type: 'string', description: '审核意见' }
      },
      required: ['task_id', 'reviewer_id', 'decision']
    }
  },
  {
    name: 'split_task',
    description: '【PM专用】将一个大任务拆解为子任务。自动创建epic并关联所有子任务。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string', description: 'Epic标题' },
        description: { type: 'string', description: '需求描述' },
        created_by: { type: 'string', description: 'PM的agent_id' },
        subtasks: { type: 'array', description: '子任务列表', items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            to_role: { type: 'string', description: 'frontend/backend/qa' },
            priority: { type: 'string' }
          }
        }}
      },
      required: ['project', 'title', 'subtasks']
    }
  },
  {
    name: 'create_epic',
    description: '【PM专用】创建一个需求/Epic，后续可拆解为子任务关联。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        created_by: { type: 'string' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'req_add',
    description: '【PM专用】向项目进度需求清单添加一条开发需求（监控面板右侧「项目进度」栏展示）。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        task_id: { type: 'string', description: '可选，关联的hub任务ID（侧栏显示该任务实时状态）' },
        task_ids: { type: 'array', items: { type: 'string' }, description: '可选，批量关联多个hub任务ID（点击需求展开显示任务明细）' },
        sort_order: { type: 'number', description: '排序权重，小的在前' },
        from_id: { type: 'string', description: 'PM的agent_id（必须是manager角色）' }
      },
      required: ['project', 'title', 'from_id']
    }
  },
  {
    name: 'req_link_tasks',
    description: '【PM专用】给需求批量关联hub任务（多对多）。关联后监控面板点击该需求可展开看到每个任务的实时状态明细。',
    inputSchema: {
      type: 'object',
      properties: {
        req_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'hub任务ID数组' },
        from_id: { type: 'string', description: 'PM的agent_id（必须是manager角色）' }
      },
      required: ['req_id', 'task_ids', 'from_id']
    }
  },
  {
    name: 'req_unlink_task',
    description: '【PM专用】解除需求与某个hub任务的关联。',
    inputSchema: {
      type: 'object',
      properties: {
        req_id: { type: 'string' },
        task_id: { type: 'string' },
        from_id: { type: 'string', description: 'PM的agent_id（必须是manager角色）' }
      },
      required: ['req_id', 'task_id', 'from_id']
    }
  },
  {
    name: 'req_update',
    description: '【PM专用】更新需求（改进度/标题/关联任务）。progress 0-100：0=未开始，1-99=开发中，100=已完成（状态自动派生）。',
    inputSchema: {
      type: 'object',
      properties: {
        req_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        progress: { type: 'number', description: '0-100' },
        task_id: { type: 'string' },
        sort_order: { type: 'number' },
        from_id: { type: 'string', description: 'PM的agent_id（必须是manager角色）' }
      },
      required: ['req_id', 'from_id']
    }
  },
  {
    name: 'req_delete',
    description: '【PM专用】删除需求清单中的一条需求。',
    inputSchema: {
      type: 'object',
      properties: {
        req_id: { type: 'string' },
        from_id: { type: 'string', description: 'PM的agent_id（必须是manager角色）' }
      },
      required: ['req_id', 'from_id']
    }
  },
  {
    name: 'list_requirements',
    description: '查询需求清单（含派生状态与关联任务实时状态）。progress 仅 PM 可改。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' }
      },
      required: ['project']
    }
  },
  {
    name: 'get_task_events',
    description: '获取任务的状态流转历史（审计日志）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'list_agents',
    description: '查看在线agent列表。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        online_only: { type: 'boolean' }
      }
    }
  },
  {
    name: 'offline',
    description: 'agent下线。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' }
      },
      required: ['from_id']
    }
  },
  {
    name: 'heartbeat',
    description: '心跳保活。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' }
      },
      required: ['from_id']
    }
  }
];

// ---------- 工具实现 ----------
const tools = {
  // v2.2 幂等注册（老板定案：agent_id 类比 openid，一次注册永久身份）：
  // - 同 name+role+project 且 status IN ('online','offline') 已存在 → 复用该 agent_id（revived:true），
  //   置 online 刷新 last_seen；不迁移消息、不关 SSE（身份没变，无需迁移）。
  // - 不存在或旧身份已是 replaced（手动替换产物）→ 插入新行（revived:false）。
  // - 废除 v2.1 的"register 自动墓碑同 project+role 旧 agent"——替换改为面板手动操作（POST /api/agents/:id/replace）。
  register({ name, role, project, capabilities = '' }) {
    const existing = db.prepare(
      `SELECT id FROM agents WHERE name = ? AND role = ? AND project = ? AND status IN ('online','offline') ORDER BY online_at DESC LIMIT 1`
    ).get(name, role, project);

    if (existing) {
      db.prepare(`UPDATE agents SET status = 'online', last_seen = ?, capabilities = ? WHERE id = ?`)
        .run(now(), capabilities, existing.id);
      log('info', `Agent revived (idempotent register)`, { id: existing.id, name, role, project });
      return { agent_id: existing.id, revived: true };
    }

    const id = uuidv4();
    db.prepare(
      `INSERT INTO agents (id, name, role, project, capabilities, status, online_at, last_seen)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`
    ).run(id, name, role, project, capabilities, now(), now());
    log('info', `Agent registered`, { id, name, role, project });
    return { agent_id: id, revived: false };
  },

  send_message({ from_id, to_id, to_role, content }) {
    if (!to_id && !to_role) return fail('需要指定 to_id 或 to_role');
    if (to_id && to_role) return fail('to_id 和 to_role 不能同时指定');

    let fromName = null;
    let project = null;
    if (from_id) {
      const sender = db.prepare(`SELECT name, project FROM agents WHERE id = ?`).get(from_id);
      if (sender) { fromName = sender.name; project = sender.project; }
    }

    const msgId = uuidv4();

    if (to_id) {
      const recv = db.prepare(`SELECT project FROM agents WHERE id = ?`).get(to_id);
      if (!recv) return fail('接收者不存在');
      project = project || recv.project;
      db.prepare(
        `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(msgId, project, from_id || 'system', fromName || 'System', to_id, content);
      // [Phase1] 唤醒收件人长轮询 + 推送SSE
      emitNewMessage(to_id, { id: msgId, project, from_id: from_id || 'system', from_name: fromName || 'System', to_id, content });
    } else {
      // v2.3.1（任务 3485f9b7）：收件人不再限定 status='online'——深度干活的 agent 会被 5min 清扫
      //   误置 offline（或依赖清扫豁免保持 online），to_role 广播若只达 online 会漏达干活 agent。
      //   改为排除 replaced 墓碑（终态不可投递），offline 但 60min 内活跃的 agent 照常投递。
      const recipients = db.prepare(
        `SELECT id, project FROM agents WHERE role = ? AND status != 'replaced' AND project = ? AND last_seen >= ?`
      ).all(to_role, project || '%', new Date(Date.now() - 60 * 60 * 1000).toISOString());
      
      if (recipients.length === 0) {
        db.prepare(
          `INSERT INTO messages (id, project, from_id, from_name, to_role, content)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(msgId, project || 'unknown', from_id || 'system', fromName || 'System', to_role, content);
        // [Phase1] to_role 悬空消息无具体收件人，不触发长轮询/SSE（等该角色上线拉取）
      } else {
        for (const r of recipients) {
          const mid = recipients.indexOf(r) === 0 ? msgId : uuidv4();
          db.prepare(
            `INSERT INTO messages (id, project, from_id, from_name, to_id, to_role, content)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(mid, r.project, from_id || 'system', fromName || 'System', r.id, to_role, content);
          // [Phase1] 唤醒每个在线收件人
          emitNewMessage(r.id, { id: mid, project: r.project, from_id: from_id || 'system', from_name: fromName || 'System', to_id: r.id, to_role, content });
        }
      }
    }

    log('debug', `Message sent`, { from: from_id, to_id, to_role });
    return { message_id: msgId };
  },

  get_messages({ from_id, all = false }) {
    const agent = db.prepare(`SELECT project, role FROM agents WHERE id = ?`).get(from_id);
    if (!agent) return fail('agent不存在，请先register');

    let rows;
    if (all) {
      rows = db.prepare(
        `SELECT * FROM messages WHERE to_id = ? ORDER BY created_at DESC LIMIT 100`
      ).all(from_id);
    } else {
      rows = db.prepare(
        `SELECT * FROM messages WHERE to_id = ? AND is_read = 0 ORDER BY created_at ASC LIMIT 100`
      ).all(from_id);
    }

    db.prepare(`UPDATE messages SET is_read = 1 WHERE to_id = ? AND is_read = 0`).run(from_id);
    return { messages: rows };
  },

  assign_task({ created_by, project, title, description = '', to_role, to_id, priority = 'normal', epic_id, task_type = 'dev', depends_on }) {
    // v2: 权限检查（assign_task 只允许 manager）
    // 但向后兼容：如果没传 created_by，跳过权限检查（老调用方式）
    if (created_by && !hasPermission(created_by, 'assign_task')) {
      return fail('权限不足：只有 manager 角色可以分配任务');
    }

    const taskId = uuidv4();
    let assignedId = to_id || null;

    if (!assignedId && to_role) {
      const agent = db.prepare(
        `SELECT id FROM agents WHERE project = ? AND role = ? AND status = 'online' LIMIT 1`
      ).get(project, to_role);
      if (agent) assignedId = agent.id;
    }

    db.prepare(
      `INSERT INTO tasks (id, project, title, description, assigned_role, assigned_id, status, priority, created_by, task_type, epic_id, depends_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    ).run(taskId, project, title, description, to_role || null, assignedId, priority, created_by || null, task_type, epic_id || null, depends_on || null, now(), now());

    if (assignedId) {
      notifyAgent(assignedId, project, `📋 新任务: ${title}`);
    }

    logEvent(taskId, 'created', null, 'pending', created_by, null, title);
    log('info', `Task assigned`, { task_id: taskId, project, to_role, task_type });
    // [Phase1] SSE 推送新任务事件（给 assignee / 该角色 / 全部在线连接）
    emitTaskEvent('task_created', {
      id: taskId, project, title, assigned_role: to_role || null,
      assigned_id: assignedId, status: 'pending', priority
    });
    return { task_id: taskId };
  },

  get_tasks({ project, status, assigned_role, assigned_id, epic_id }) {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params = [];

    if (project) { sql += ` AND project = ?`; params.push(project); }
    if (status) { sql += ` AND status = ?`; params.push(status); }
    if (assigned_role) { sql += ` AND assigned_role = ?`; params.push(assigned_role); }
    if (assigned_id) { sql += ` AND assigned_id = ?`; params.push(assigned_id); }
    if (epic_id) { sql += ` AND epic_id = ?`; params.push(epic_id); }

    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const rows = db.prepare(sql).all(...params);
    return { tasks: rows };
  },

  update_task({ task_id, from_id, status, result = '', override }) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
    if (!task) return fail('任务不存在');

    // v2: 状态机校验
    if (!canTransition(task.status, status)) {
      return fail(`状态流转不合法: ${task.status} → ${status}。允许的流转: ${(VALID_TRANSITIONS[task.status] || []).join(', ') || '终态，不可变更'}`);
    }

    // v2.1 身份机制：任务认领绑定 + 认领互斥
    let actor = null;
    let actorRole = null;
    if (from_id) {
      actor = db.prepare(`SELECT id, name, role, project, status FROM agents WHERE id = ?`).get(from_id);
      actorRole = actor ? actor.role : null;
      // v2.1.1 僵尸守卫：被替换（replaced）的旧身份不得再操作任务（残留进程自我复活的最后一道闸）
      if (actor && actor.status === 'replaced') {
        return fail(`身份已被新会话替换（replaced），请重新 register 获取新 agent_id`);
      }
    }

    // 🔴 v2.4 审核闸门（四色任务 3485f9b7 教训：backend 9秒内自审自批 in_review→testing→test_passed→completed）
    // in_review 之后的推进流转（testing/test_passed/test_failed/completed）只允许：
    //   1. manager（PM 审核职责）
    //   2. QA 对 task_type=test 的任务（testing→test_passed/test_failed 本就是 QA 的活）
    //   3. override==='boss'：老板明确授权跳过 QA/代行审核时使用（result 里注明授权来源）
    // 普通认领互斥仍然先行：manager 本来就不受认领互斥限制。
    if (task.status === 'in_review' || task.status === 'testing' || task.status === 'test_passed') {
      const FORWARD_STATES = ['testing', 'test_passed', 'test_failed', 'completed'];
      if (FORWARD_STATES.includes(status) && actorRole !== 'manager') {
        const isQaTestFlow = actorRole === 'qa' && task.task_type === 'test';
        if (!isQaTestFlow && override !== 'boss') {
          return fail(`权限不足：in_review 后的推进流转（${task.status} → ${status}）只允许 manager 操作${task.task_type === 'test' ? '（QA 限 test 任务）' : ''}。dev 任务请在 in_review 停手等待 PM 审核；老板授权时传 override:'boss' 并在 result 注明`);
        }
        if (isQaTestFlow || override === 'boss') {
          logEvent(task_id, 'gate_pass', task.status, status, from_id, actor ? actor.name : null,
            override === 'boss' ? `审核闸门放行：老板授权（override:boss），操作者 ${actor ? actor.name : from_id}` : `审核闸门放行：QA test 任务流转`);
        }
      }
    }

    // b) 认领互斥：任务已被他人认领，非认领者且非 manager 不得操作。
    // v2.1.1 接管语义：assignee 仍 online 时严格拒（防撞车）；
    // assignee 已死（offline/replaced/不存在）时放行同项目同角色接管重绑——
    // 生产实证：agent 每次会话重新 register（新 uuid，旧身份 replaced），
    // 严格比对会让历史任务绑死的旧身份永远无人能推进（QA/前端任务受害最深）。
    let takeoverFrom = null;
    if (task.assigned_id && from_id && from_id !== task.assigned_id && actorRole !== 'manager') {
      const assignee = db.prepare(`SELECT id, name, status FROM agents WHERE id = ?`).get(task.assigned_id);
      const assigneeAlive = assignee && assignee.status === 'online';
      if (assigneeAlive) {
        return fail(`任务已由 ${assignee.name} 认领，无权操作`);
      }
      // assignee 已死：同项目同角色可接管并重绑
      if (actorRole === task.assigned_role && actor && actor.project === task.project) {
        takeoverFrom = task.assigned_id;
      } else {
        return fail(`任务已由 ${assignee ? assignee.name : task.assigned_id} 认领（已离线），仅 ${task.assigned_role || '同角色'} 可接管`);
      }
    }

    // a) 认领绑定：pending 未指定人 → 第一个把它推入 in_progress 的同角色 agent 成为认领人
    let claimedBy = null;
    if (!task.assigned_id && status === 'in_progress' && from_id && actorRole === task.assigned_role) {
      claimedBy = from_id;
    }

    const updates = { status, updated_at: now() };
    if (status === 'completed') updates.completed_at = now();
    if (result) updates.result = result;

    if (claimedBy) {
      db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?, result = ?, assigned_id = ? WHERE id = ?`
      ).run(updates.status, updates.updated_at, updates.completed_at || null, updates.result || task.result, claimedBy, task_id);
      logEvent(task_id, 'claimed', task.status, status, from_id, actor ? actor.name : null, '任务认领绑定');
    } else if (takeoverFrom) {
      // v2.1.1 死亡身份接管：assignee 已死，重绑到当前同角色操作者
      db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?, result = ?, assigned_id = ? WHERE id = ?`
      ).run(updates.status, updates.updated_at, updates.completed_at || null, updates.result || task.result, from_id, task_id);
      const prev = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(takeoverFrom);
      logEvent(task_id, 'takeover', task.status, status, from_id, actor ? actor.name : null,
        `接管已离线认领人 ${prev ? prev.name : takeoverFrom}，assigned_id 重绑`);
    } else {
      db.prepare(
        `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?, result = ? WHERE id = ?`
      ).run(updates.status, updates.updated_at, updates.completed_at || null, updates.result || task.result, task_id);
    }

    // 获取操作者名称
    let actorName = null;
    if (from_id) {
      const agent = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(from_id);
      if (agent) actorName = agent.name;
    }

    // 记录事件
    logEvent(task_id, 'status_change', task.status, status, from_id, actorName, result);

    // 🔴 v2.4 交付必达（四色任务教训：submit 只写库不叫人，PM 收件箱 0 条，老板不看面板不知道）
    // dev 任务提交 in_review = 等人审，必须主动叫 PM + 老板；completed 同理（防 QA/manager 完结后无人知晓）。
    // PM 站内信走 notifyRole('manager')（在线即时+离线存悬空消息）。
    if (status === 'in_review') {
      notifyRole('manager', task.project,
        `📨 待审核: ${task.title}\n提交人: ${actorName || task.assigned_id || '未知'}\n任务ID: ${task_id.slice(0, 8)}\n${result ? '交付摘要: ' + String(result).slice(0, 200) : '（无 result）'}\n→ 请 PM 审核（approve 进 testing / reject 打回）`);
      notifyBoss('agenthub.task',
        `📨 任务待审核\n\n📋 ${task.title}\n👤 提交人: ${actorName || '未知'}\n📝 ${result ? String(result).slice(0, 300) : '无交付摘要'}\n→ 等 PM 审核，审核结果会另行通知`);
    } else if (status === 'completed') {
      notifyBoss('agenthub.task',
        `🏁 任务完结\n\n📋 ${task.title}\n👤 操作人: ${actorName || '未知'}\n→ 已进入 completed 终态`);
    }

    // 通知创建者
    if (task.created_by && from_id !== task.created_by) {
      notifyAgent(task.created_by, task.project, `📦 任务状态: ${task.title} → ${status}${result ? ' | ' + result : ''}`);
    }

    log('info', `Task updated`, { task_id, from: task.status, to: status });

    // v2.3 hub 任务自动追踪（agent 零负担）：
    //   进入 in_progress → 为当前持有人（重绑后的 assigned_id）建 active 工作项
    //   离开 in_progress → 关闭该任务全部 active hub 工作项（rejected 重新认领会生成新工作项）
    const holder = claimedBy || (takeoverFrom ? from_id : task.assigned_id);
    if (status === 'in_progress') {
      startHubWork(holder, task.project, task_id, task.title);
    } else if (task.status === 'in_progress') {
      finishHubWork(task_id);
    }

    // [Phase1] SSE 推送任务状态变化
    emitTaskEvent('task_status_changed', {
      id: task_id, project: task.project, title: task.title,
      assigned_role: task.assigned_role, assigned_id: task.assigned_id,
      from_status: task.status, to_status: status
    });

    // v2: 编排引擎 - 触发自动动作
    orchestrate(task_id, status, from_id);

    return ok({});
  },

  // v2 新增: 审核任务
  review_task({ task_id, reviewer_id, decision, comment = '' }) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
    if (!task) return fail('任务不存在');

    // 权限检查：只有 manager 可以审核
    if (!hasPermission(reviewer_id, 'review_task')) {
      return fail('权限不足：只有 manager 角色可以审核任务');
    }

    // 状态校验：只有 in_review 状态的任务可以审核
    if (task.status !== 'in_review') {
      return fail(`只有 in_review 状态的任务可以审核，当前状态: ${task.status}`);
    }

    // 审核通过→直接进testing（跳过approved），驳回→rejected
    const newStatus = decision === 'approve' ? 'testing' : 'rejected';
    
    // 获取审核者名称
    const reviewer = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(reviewer_id);
    const reviewerName = reviewer ? reviewer.name : 'Unknown';

    db.prepare(
      `UPDATE tasks SET status = ?, review_status = ?, reviewer_id = ?, review_comment = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(newStatus, decision, reviewer_id, comment, now(), now(), task_id);

    logEvent(task_id, decision === 'approve' ? 'approved' : 'rejected', task.status, newStatus, reviewer_id, reviewerName, comment);

    // 通知任务执行者
    if (task.assigned_id) {
      const emoji = decision === 'approve' ? '✅' : '❌';
      notifyAgent(task.assigned_id, task.project, 
        `${emoji} 审核结果: ${task.title}\n审核人: ${reviewerName}\n结果: ${decision === 'approve' ? '通过，进入测试' : '驳回'}${comment ? '\n意见: ' + comment : ''}`
      );
    }

    // 审核结果发老板微信
    const bossMsg = decision === 'approve'
      ? `✅ 审核通过\n\n📋 任务: ${task.title}\n👤 审核人: ${reviewerName}\n📝 意见: ${comment || '无'}\n→ 已自动进入测试阶段`
      : `❌ 审核驳回\n\n📋 任务: ${task.title}\n👤 审核人: ${reviewerName}\n📝 驳回原因: ${comment || '未说明'}\n→ 已打回重做`;
    notifyBoss('agenthub.review', bossMsg);

    log('info', `Task reviewed`, { task_id, decision, reviewer: reviewerName });

    // [Phase1] SSE 推送审核结果（任务状态已变为 testing/rejected）
    emitTaskEvent('task_reviewed', {
      id: task_id, project: task.project, title: task.title,
      assigned_role: task.assigned_role, assigned_id: task.assigned_id,
      decision, comment,
      from_status: task.status, to_status: newStatus
    });

    // 编排：审核通过时检查是否需要自动创建测试任务
    if (decision === 'approve') {
      // 因为直接进 testing，手动触发编排（检查同epic其他任务）
      orchestrate(task_id, 'approved', reviewer_id);
    }

    return ok({ task_id, new_status: newStatus });
  },

  // v2 新增: 拆解任务
  split_task({ project, title, description = '', created_by, subtasks }) {
    if (!subtasks || subtasks.length === 0) {
      return fail('至少需要一个子任务');
    }

    // 权限检查
    if (created_by && !hasPermission(created_by, 'split_task')) {
      return fail('权限不足：只有 manager 角色可以拆解任务');
    }

    // 创建 Epic
    const epicId = uuidv4();
    db.prepare(
      `INSERT INTO epics (id, project, title, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
    ).run(epicId, project, title, description, created_by || null, now(), now());

    log('info', `Epic created`, { epic_id: epicId, title });

    // 创建子任务
    const taskIds = [];
    for (const sub of subtasks) {
      const taskId = uuidv4();
      let assignedId = null;
      
      if (sub.to_role) {
        const agent = db.prepare(
          `SELECT id FROM agents WHERE project = ? AND role = ? AND status = 'online' LIMIT 1`
        ).get(project, sub.to_role);
        if (agent) assignedId = agent.id;
      }

      db.prepare(
        `INSERT INTO tasks (id, project, title, description, assigned_role, assigned_id, status, priority, created_by, task_type, epic_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'dev', ?, ?, ?)`
      ).run(taskId, project, sub.title, sub.description || '', sub.to_role || null, assignedId, sub.priority || 'normal', created_by || null, epicId, now(), now());

      if (assignedId) {
        notifyAgent(assignedId, project, `📋 新任务: ${sub.title}`);
      }

      logEvent(taskId, 'created', null, 'pending', created_by, null, `Epic: ${title}`);
      // [Phase1] SSE 推送子任务创建
      emitTaskEvent('task_created', {
        id: taskId, project, title: sub.title, assigned_role: sub.to_role || null,
        assigned_id: assignedId, status: 'pending', priority: sub.priority || 'normal', epic_id: epicId
      });
      taskIds.push(taskId);
    }

    log('info', `Epic split into ${taskIds.length} subtasks`, { epic_id: epicId, tasks: taskIds });
    return { epic_id: epicId, task_ids: taskIds };
  },

  // v2 新增: 创建 Epic
  create_epic({ project, title, description = '', created_by }) {
    const epicId = uuidv4();
    db.prepare(
      `INSERT INTO epics (id, project, title, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
    ).run(epicId, project, title, description, created_by || null, now(), now());

    log('info', `Epic created`, { epic_id: epicId, title });
    return { epic_id: epicId };
  },

  // v2.5 需求清单（监控面板「项目进度」侧栏）：progress 仅 manager 可写，status 由 progress 实时派生
  //   派生规则：0=未开始 / 1-99=开发中 / 100=已完成
  req_add({ project, title, description = '', task_id = null, sort_order = 0, from_id }) {
    const actor = from_id ? db.prepare(`SELECT role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor || actor.role !== 'manager') return fail(`权限不足：需求清单仅 PM(manager) 可维护`);
    if (!project || !title) return fail('project 和 title 必填');

    const id = uuidv4();
    db.prepare(
      `INSERT INTO requirements (id, project, title, description, progress, task_id, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(id, project, title, description || '', task_id || null, sort_order || 0, from_id || null, now(), now());
    // v2.5.1 批量关联任务
    const taskIds = Array.isArray(task_ids) ? task_ids.filter(Boolean) : [];
    for (const tid of taskIds) {
      if (tid === task_id) continue;
      db.prepare(`INSERT OR IGNORE INTO requirement_tasks (req_id, task_id) VALUES (?, ?)`).run(id, tid);
    }
    log('info', `Requirement added`, { req_id: id, title, project });
    return { req_id: id };
  },

  req_link_tasks({ req_id, task_ids, from_id }) {
    const actor = from_id ? db.prepare(`SELECT role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor || actor.role !== 'manager') return fail(`权限不足：需求清单仅 PM(manager) 可维护`);
    const row = db.prepare(`SELECT id FROM requirements WHERE id = ?`).get(req_id);
    if (!row) return fail('需求不存在');
    let n = 0;
    for (const tid of (Array.isArray(task_ids) ? task_ids : []).filter(Boolean)) {
      const t = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(tid);
      if (!t) continue; // 静默跳过不存在的任务，幂等
      n += db.prepare(`INSERT OR IGNORE INTO requirement_tasks (req_id, task_id) VALUES (?, ?)`).run(req_id, tid).changes;
    }
    db.prepare(`UPDATE requirements SET updated_at = ? WHERE id = ?`).run(now(), req_id);
    return { req_id, linked: n };
  },

  req_unlink_task({ req_id, task_id, from_id }) {
    const actor = from_id ? db.prepare(`SELECT role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor || actor.role !== 'manager') return fail(`权限不足：需求清单仅 PM(manager) 可维护`);
    const r = db.prepare(`DELETE FROM requirement_tasks WHERE req_id = ? AND task_id = ?`).run(req_id, task_id);
    if (!r.changes) return fail('关联不存在');
    return { req_id, unlinked: task_id };
  },

  req_update({ req_id, title, description, progress, task_id, sort_order, from_id }) {
    const actor = from_id ? db.prepare(`SELECT role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor || actor.role !== 'manager') return fail(`权限不足：需求进度仅 PM(manager) 可修改`);
    const row = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(req_id);
    if (!row) return fail('需求不存在');

    const p = progress === undefined || progress === null ? row.progress : Math.max(0, Math.min(100, parseInt(progress, 10) || 0));
    db.prepare(
      `UPDATE requirements SET title = ?, description = ?, progress = ?, task_id = ?, sort_order = ?, updated_at = ? WHERE id = ?`
    ).run(
      title !== undefined ? title : row.title,
      description !== undefined ? description : row.description,
      p,
      task_id !== undefined ? task_id : row.task_id,
      sort_order !== undefined ? sort_order : row.sort_order,
      now(), req_id
    );
    log('info', `Requirement updated`, { req_id, progress: p });
    return { req_id, progress: p };
  },

  req_delete({ req_id, from_id }) {
    const actor = from_id ? db.prepare(`SELECT role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor || actor.role !== 'manager') return fail(`权限不足：需求清单仅 PM(manager) 可维护`);
    db.prepare(`DELETE FROM requirement_tasks WHERE req_id = ?`).run(req_id);
    const r = db.prepare(`DELETE FROM requirements WHERE id = ?`).run(req_id);
    if (!r.changes) return fail('需求不存在');
    log('info', `Requirement deleted`, { req_id });
    return { deleted: req_id };
  },

  list_requirements({ project }) {
    const rows = db.prepare(
      `SELECT r.*, t.title AS task_title, t.status AS task_status
       FROM requirements r
       LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.project = ?
       ORDER BY r.sort_order ASC, r.created_at ASC`
    ).all(project || '');
    // status 派生：0=未开始 / 1-99=开发中 / 100=已完成
    const stmtTasks = db.prepare(
      `SELECT rt.task_id, t.title AS task_title, t.status AS task_status, t.task_type, t.updated_at
       FROM requirement_tasks rt LEFT JOIN tasks t ON t.id = rt.task_id
       WHERE rt.req_id = ? ORDER BY rt.sort_order ASC, rt.added_at ASC`
    );
    for (const row of rows) {
      row.status = row.progress >= 100 ? 'done' : row.progress > 0 ? 'doing' : 'todo';
      row.tasks = stmtTasks.all(row.id); // v2.5.1 关联任务明细（含已删除任务的悬空引用，前端跳转时兜底）
    }
    return { requirements: rows };
  },

  // v2 新增: 获取任务事件
  get_task_events({ task_id }) {
    const rows = db.prepare(
      `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`
    ).all(task_id);
    return { events: rows };
  },

  list_agents({ project, online_only = true }) {
    let sql = online_only 
      ? `SELECT id, name, role, project, capabilities, online_at, last_seen FROM agents WHERE status = 'online'`
      : `SELECT id, name, role, project, capabilities, status, online_at, offline_at, last_seen FROM agents WHERE 1=1`;
    const params = [];

    if (project) { sql += ` AND project = ?`; params.push(project); }
    sql += ` ORDER BY online_at DESC`;

    const rows = db.prepare(sql).all(...params);

    // v2.2 四态派生字段（仅 online_only=false 全量查询时附加，兼容现有调用方）：
    // v2.3 修订（任务 933e16a3）：任务中 = status='online' 且 active 工作项>0（hub 或 external 均算）。
    //   active_task_count: 该 agent 认领的 in_progress 任务数（保留：任务视角）
    //   active_work_count / hub_active_count / external_active_count: 工作项视角（busy 派生用）
    //   pending_task_count: 直接指派待接取(pending+assigned_id) + 角色队列(assigned_id IS NULL 且 assigned_role 匹配)
    //   display_state: offline | online_idle | online_busy（replaced 行照常返回，display_state 置 'replaced'）
    // v2.3.1（任务 3485f9b7）：busy 优先——存在进行中工作（in_progress hub 任务 或 agent_work active 项）
    //   即显示 online_busy，不因 last_seen 超时被清扫置 offline 而降级显示「离线」。
    //   超时失联（超60min被置 offline）后 active 工作项被标 stale、任务离开 in_progress，busy 自然解除。
    if (!online_only) {
      const activeMap = new Map();
      db.prepare(
        `SELECT assigned_id, COUNT(*) as c FROM tasks WHERE status = 'in_progress' AND assigned_id IS NOT NULL GROUP BY assigned_id`
      ).all().forEach((r) => activeMap.set(r.assigned_id, r.c));
      const assignedPendingMap = new Map();
      db.prepare(
        `SELECT assigned_id, COUNT(*) as c FROM tasks WHERE status = 'pending' AND assigned_id IS NOT NULL GROUP BY assigned_id`
      ).all().forEach((r) => assignedPendingMap.set(r.assigned_id, r.c));
      // 角色队列：任务未指定人且角色匹配（dashboard 需按 project 过滤后自行匹配角色）
      const rolePendingRows = db.prepare(
        `SELECT assigned_role, project, COUNT(*) as c FROM tasks WHERE status = 'pending' AND assigned_id IS NULL AND assigned_role IS NOT NULL GROUP BY assigned_role, project`
      ).all();
      // v2.3：active 工作项计数（hub / external 分开）
      const hubWorkMap = new Map();
      const extWorkMap = new Map();
      db.prepare(
        `SELECT agent_id, source, COUNT(*) as c FROM agent_work WHERE status = 'active' GROUP BY agent_id, source`
      ).all().forEach((r) => {
        const m = r.source === 'hub' ? hubWorkMap : extWorkMap;
        m.set(r.agent_id, (m.get(r.agent_id) || 0) + r.c);
      });

      for (const row of rows) {
        const active = activeMap.get(row.id) || 0;
        const pendingAssigned = assignedPendingMap.get(row.id) || 0;
        const pendingQueue = rolePendingRows
          .filter((r) => r.project === row.project && r.assigned_role === row.role)
          .reduce((s, r) => s + r.c, 0);
        const hubActive = hubWorkMap.get(row.id) || 0;
        const extActive = extWorkMap.get(row.id) || 0;
        const activeWork = hubActive + extActive;
        row.active_task_count = active;
        row.active_work_count = activeWork;
        row.hub_active_count = hubActive;
        row.external_active_count = extActive;
        row.pending_task_count = pendingAssigned + pendingQueue;
        // v2.3.1（任务 3485f9b7）：busy 优先判定——replaced > 有进行中工作(online_busy，即使 status 已被超时清扫置 offline) > 常规四态
        const busy = activeWork > 0 || active > 0;
        row.display_state = row.status === 'replaced'
          ? 'replaced'
          : busy
            ? 'online_busy'
            : row.status === 'online'
              ? 'online_idle'
              : 'offline';
      }
    }
    return { agents: rows };
  },

  offline({ from_id }) {
    // v2.1.2 A1 旁路修复：offline 不得降级 replaced 墓碑——被替换身份若被置 offline，
    // 可借轮询/心跳复活（2cfe52d 语义），等于绕过墓碑防线。只允许 online→offline。
    const r = db.prepare(
      `UPDATE agents SET status = 'offline', offline_at = ? WHERE id = ? AND status != 'replaced'`
    ).run(now(), from_id);
    if (r.changes === 0) {
      const ag = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(from_id);
      if (ag && ag.status === 'replaced') {
        log('warn', `offline rejected: agent is replaced (tombstone)`, { id: from_id });
        return fail(`身份已被替换（replaced 终态），不可置 offline`);
      }
    }
    // [Phase1] agent下线，关闭其全部SSE连接（防泄漏）
    closeSseForAgent(from_id);
    log('info', `Agent offline`, { id: from_id });
    return ok({});
  },

  heartbeat({ from_id, agent_id }) {
    // [2026-08-15] 兼容 agent_id 参数：部分客户端用 agent_id 调心跳，此前静默无效（code:0 但不刷新）
    const id = from_id || agent_id;
    if (!id) return fail('需要 from_id');
    // v2.1 身份机制：replaced 墓碑不可复活（last_seen 照常刷新无害）；
    // offline（心跳超时被清扫）的 agent 允许复活为 online（保留 2cfe52d 语义）
    const r = db.prepare(
      `UPDATE agents SET last_seen = ?, status = CASE WHEN status = 'replaced' THEN status ELSE 'online' END WHERE id = ?`
    ).run(now(), id);
    if (r.changes === 0) return fail('agent不存在，请先register');
    // v2.3：心跳复活时拉回其全部 stale 工作项（失联判定解除）
    reviveStaleWorks(id);
    return ok({});
  },

  // ============ v2.3 外部任务上报（任务 933e16a3）============
  // 语义：agent 在 hub 之外的任何渠道接活（老板直聊、群派活等），也必须上报到 hub，
  // 让面板 busy 状态与真实工作一致。生命周期：start → update → finish。

  // POST /api/agents/:id/work/start {from_id, title, note?, ref?}
  work_start({ agent_id, from_id, title, note, ref }) {
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agent_id);
    if (!agent) return fail('agent 不存在');
    if (!title || !String(title).trim()) return fail('需要 title（工作标题）');

    // 鉴权：from_id 必须是该 agent 本人或 manager
    const actor = from_id ? db.prepare(`SELECT id, role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor) return fail('需要 from_id（操作者身份）');
    if (from_id !== agent_id && actor.role !== 'manager') {
      return fail('越权：只有 agent 本人或 manager 可以上报该 agent 的工作');
    }
    // replaced 僵尸守卫：被替换身份不得再上报工作
    if (agent.status === 'replaced') return fail('该身份已被替换（replaced 终态），不可上报工作');

    const t = String(title).trim();
    // 幂等：同 agent 同 title 已有 active/stale external 项 → 复用并更新（拉回 active）
    const exist = findActiveExternalByTitle(agent_id, t);
    if (exist) {
      db.prepare(
        `UPDATE agent_work SET status = 'active', note = ?, updated_at = ? WHERE id = ?`
      ).run(note != null ? String(note) : exist.note, now(), exist.id);
      const row = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(exist.id);
      emitWorkEvent('work_updated', row);
      return { work_id: exist.id, reused: true };
    }

    const id = uuidv4();
    db.prepare(
      `INSERT INTO agent_work (id, agent_id, project, title, source, hub_task_id, progress, status, note, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'external', NULL, NULL, 'active', ?, ?, ?)`
    ).run(id, agent_id, agent.project, t, ref ? `ref: ${ref}` : (note || ''), now(), now());
    const row = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(id);
    emitWorkEvent('work_started', row);
    log('info', `agent_work: external work started`, { agent_id, work_id: id, title: t });
    return { work_id: id, reused: false };
  },

  // POST /api/work/:work_id/update {from_id, progress?, note?}
  work_update({ work_id, from_id, progress, note }) {
    const work = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(work_id);
    if (!work) return fail('work 不存在');

    const actor = from_id ? db.prepare(`SELECT id, role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor) return fail('需要 from_id（操作者身份）');
    if (from_id !== work.agent_id && actor.role !== 'manager') {
      return fail('越权：只有 agent 本人或 manager 可以更新该工作');
    }
    // replaced 僵尸守卫：被替换身份不得更新工作（含把 stale 拉回 active）
    const workAgent = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(work.agent_id);
    if (workAgent && workAgent.status === 'replaced') return fail('该身份已被替换（replaced 终态），不可更新工作');
    // done 是终态：不可再改（note/progress 都不行，防止完成后倒灌状态）
    if (work.status === 'done') return fail('该工作已完成（done 终态），不可更新');

    const updates = [];
    const params = [];
    if (progress !== undefined && progress !== null) {
      const p = parseInt(progress, 10);
      if (isNaN(p) || p < 0 || p > 100) return fail(`progress 必须是 0-100 整数（收到: ${progress}）`);
      if (work.source !== 'external') return fail('hub 工作项不接收 progress（显示任务状态时间线，不伪造百分比）');
      updates.push('progress = ?'); params.push(p);
    }
    if (note !== undefined && note !== null) {
      updates.push('note = ?'); params.push(String(note));
    }
    if (!updates.length) return fail('无可更新字段（progress/note 至少其一）');

    // stale 项借此拉回 active（agent 复活语义）
    updates.push("status = 'active'", 'updated_at = ?');
    params.push(now(), work_id);
    db.prepare(`UPDATE agent_work SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const row = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(work_id);
    emitWorkEvent('work_updated', row);
    return { work_id, status: row.status, progress: row.progress };
  },

  // POST /api/work/:work_id/finish {from_id, note?}
  work_finish({ work_id, from_id, note }) {
    const work = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(work_id);
    if (!work) return fail('work 不存在');

    const actor = from_id ? db.prepare(`SELECT id, role FROM agents WHERE id = ?`).get(from_id) : null;
    if (!actor) return fail('需要 from_id（操作者身份）');
    if (from_id !== work.agent_id && actor.role !== 'manager') {
      return fail('越权：只有 agent 本人或 manager 可以结束该工作');
    }
    if (work.status === 'done') return { work_id, status: 'done', already: true };

    db.prepare(
      `UPDATE agent_work SET status = 'done', finished_at = ?, updated_at = ?, note = COALESCE(?, note) WHERE id = ?`
    ).run(now(), now(), note != null ? String(note) : null, work_id);
    const row = db.prepare(`SELECT * FROM agent_work WHERE id = ?`).get(work_id);
    emitWorkEvent('work_finished', row);
    log('info', `agent_work: work finished`, { work_id, agent_id: work.agent_id, source: work.source });

    // 🔴 v2.4 交付必达：external 工作完结主动通知老板（hub 任务走任务状态流转，已有 in_review/completed 通知，不重复）
    if (work.source === 'external') {
      const wAgent = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(work.agent_id);
      notifyBoss('agenthub.task',
        `🏁 外部工作完结\n\n📋 ${work.title}\n👤 执行者: ${wAgent ? wAgent.name : work.agent_id}\n📝 ${note ? String(note).slice(0, 200) : '无备注'}\n→ 该工作经 work/finish 上报完结（非 hub 任务）`);
    }
    return { work_id, status: 'done' };
  },

  // GET /api/works?project=&agent_id=&include_done=  /  GET /api/agents/:id/work
  // dashboard 聚合用（避免 N+1）；include_done=false 时仅返回 active/stale
  get_works({ project, agent_id, include_done }) {
    let sql = `SELECT * FROM agent_work WHERE 1=1`;
    const params = [];
    if (project) { sql += ` AND project = ?`; params.push(project); }
    if (agent_id) { sql += ` AND agent_id = ?`; params.push(agent_id); }
    if (!include_done || include_done === 'false' || include_done === '0') {
      sql += ` AND status != 'done'`;
    }
    sql += ` ORDER BY updated_at DESC LIMIT 500`;
    return { works: db.prepare(sql).all(...params) };
  }
};

// ---------- Express App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/download', express.static(__dirname + '/public'));

// 健康检查 (无需鉴权)
app.get('/health', (req, res) => {
  const counts = {
    agents: db.prepare(`SELECT COUNT(*) as c FROM agents WHERE status = 'online'`).get().c,
    messages: db.prepare(`SELECT COUNT(*) as c FROM messages`).get().c,
    tasks: db.prepare(`SELECT COUNT(*) as c FROM tasks`).get().c,
    epics: db.prepare(`SELECT COUNT(*) as c FROM epics`).get().c,
    projects: db.prepare(`SELECT COUNT(DISTINCT project) as c FROM agents WHERE status = 'online'`).get().c
  };
  res.json(ok({ status: 'running', version: '2.4.0', uptime: process.uptime(), ...counts }));
});

// MCP 协议: 列出工具
app.get('/mcp/tools', authMiddleware, (req, res) => {
  res.json(ok(MCP_TOOLS));
});

// MCP 协议: 调用工具
app.post('/mcp/tools/:name', authMiddleware, (req, res) => {
  const toolName = req.params.name;
  const tool = tools[toolName];
  
  if (!tool) {
    return res.status(404).json(fail(`工具不存在: ${toolName}`));
  }

  try {
    const params = { ...req.body, ...req.query };
    const result = tool(params);
    log('debug', `Tool called`, { tool: toolName });
    res.json(typeof result === 'object' && result.error ? result : ok(result));
  } catch (err) {
    log('error', `Tool error`, { tool: toolName, error: err.message });
    res.status(500).json(fail(`工具执行错误: ${err.message}`));
  }
});

// REST API 快捷路由
app.post('/api/register', authMiddleware, (req, res) => {
  try { res.json(ok(tools.register(req.body))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.post('/api/send_message', authMiddleware, (req, res) => {
  try {
    const result = tools.send_message(req.body);
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// [Phase1] GET /api/messages/:agent_id
//   不带 wait 参数 → 行为与改造前完全一致（立即返回，读取即标记已读）
//   带 wait=<秒>   → 长轮询：有未读立即返回；无未读挂起最多 wait 秒，
//                    期间有新消息到达立即唤醒返回；超时返回空列表。
//                    挂起期间不标记已读；返回前统一标记（与旧行为一致）。
app.get('/api/messages/:agent_id', authMiddleware, (req, res) => {
  try {
    const agentId = req.params.agent_id;
    // [2026-08-15] 拉消息视同心跳：agent 持续轮询收件箱 = 存活证据，刷新 last_seen 防止被5分钟清扫误判掉线
    // v2.1 身份机制：被替换（replaced 墓碑）的旧身份不可借轮询复活；offline（超时）仍可复活（保留 2cfe52d 语义）
    db.prepare(
      `UPDATE agents SET last_seen = ?, status = CASE WHEN status = 'replaced' THEN status ELSE 'online' END WHERE id = ?`
    ).run(now(), agentId);
    // v2.3：轮询复活（offline→online）时拉回 stale 工作项；replaced 墓碑身份不拉回（身份未复活）
    const wasRevived = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId);
    if (wasRevived && wasRevived.status === 'online') reviveStaleWorks(agentId);
    const all = req.query.all === 'true';

    // 向后兼容：无 wait 参数，走原有同步逻辑
    const waitRaw = parseFloat(req.query.wait);
    if (!waitRaw || !(waitRaw > 0)) {
      return res.json(ok(tools.get_messages({ from_id: agentId, all })));
    }

    // [Phase1] 长轮询分支
    const agent = db.prepare(`SELECT project, role FROM agents WHERE id = ?`).get(agentId);
    if (!agent) return res.status(400).json(fail('agent不存在，请先register'));

    // 上限 60 秒，防客户端传超大值长期占用连接
    const waitSec = Math.min(waitRaw, 60);

    // 挂起期间有新消息到达时被调用
    const onMessage = (evt) => {
      if (evt.to_id !== agentId) return;
      finish();
    };

    let finished = false;
    const cleanupAndRespond = () => {
      const rows = fetchUnreadMessages(agentId);
      if (rows.length > 0) markMessagesRead(agentId);
      res.json(ok({ messages: rows }));
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      hubEvents.removeListener(EVT_MESSAGE, onMessage);
      cleanupAndRespond();
    };

    // 超时兜底
    const timer = setTimeout(finish, waitSec * 1000);
    // 客户端提前断开时清理监听器，防止泄漏
    res.on('close', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        hubEvents.removeListener(EVT_MESSAGE, onMessage);
      }
    });

    // 先查一次已有未读（有则立即返回，不挂起）
    const existing = fetchUnreadMessages(agentId);
    if (existing.length > 0) {
      markMessagesRead(agentId);
      finished = true;
      clearTimeout(timer);
      return res.json(ok({ messages: existing }));
    }

    // 无未读 → 挂起等待新消息事件
    hubEvents.on(EVT_MESSAGE, onMessage);
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// [Phase1] GET /api/stream/:agent_id — SSE 实时推送端点
//   响应 Content-Type: text/event-stream。
//   有新消息/新任务/任务状态变化时推 event: message，data 为 JSON：
//     { type: 'message' | 'task_created' | 'task_status_changed' | 'task_reviewed', ... }
//   心跳：每 20 秒推一行 :ping 注释保持连接。
//   客户端断开时必须清理（监听器 + 定时器 + 注册表），防内存泄漏。
app.get('/api/stream/:agent_id', authMiddleware, (req, res) => {
  const agentId = req.params.agent_id;
  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(400).json(fail('agent不存在，请先register'));

  // SSE 响应头（禁用 nginx 等反代缓冲由部署侧处理，这里先 flush 头）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':connected\n\n');

  const client = { res, agentId };

  // 注册到连接表（同 agent 多连接允许）
  let set = sseClients.get(agentId);
  if (!set) { set = new Set(); sseClients.set(agentId, set); }
  set.add(client);

  // 新消息 → 推给该 agent 的所有连接
  const onMessage = (evt) => {
    if (evt.to_id !== agentId) return;
    sseSend(client, 'message', { type: 'message', message: evt.message });
  };
  // 任务事件 → 推给所有已连接 agent（Phase1 简化路由：任务事件全局广播，
  // 客户端可按 assigned_role/assigned_id 自行过滤）
  const onTask = (evt) => {
    sseSend(client, 'message', { type: evt.type, task: evt.task });
  };
  hubEvents.on(EVT_MESSAGE, onMessage);
  hubEvents.on(EVT_TASK, onTask);

  // 心跳：每 20 秒推一行注释，保持连接不被中间层掐断
  client.pingTimer = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (e) { /* ignore */ }
  }, 20 * 1000);

  // 客户端断开 / PM2 重启连接断开 → 全量清理，防泄漏
  res.on('close', () => {
    clearInterval(client.pingTimer);
    hubEvents.removeListener(EVT_MESSAGE, onMessage);
    hubEvents.removeListener(EVT_TASK, onTask);
    const s = sseClients.get(agentId);
    if (s) {
      s.delete(client);
      if (s.size === 0) sseClients.delete(agentId);
    }
    log('debug', `SSE client disconnected`, { agent_id: agentId, remaining: s ? s.size : 0 });
  });

  log('debug', `SSE client connected`, { agent_id: agentId, total_agents_streaming: sseClients.size });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  try { res.json(ok(tools.assign_task(req.body))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  try { res.json(ok(tools.get_tasks(req.query))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.put('/api/tasks/:task_id', authMiddleware, (req, res) => {
  try {
    res.json(ok(tools.update_task({ task_id: req.params.task_id, ...req.body })));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增路由: 审核任务
// B8 修3: 兼容两种审核入参——
//   形式A: {decision: "approve"|"reject", reviewer_id, comment}
//   形式B: {approve: true|false, reviewer_id, comment}（PM 实际使用，2026-08-14 复现）
// 此前只认 decision 字段，approve:true 被忽略 → decision=undefined → 永远 rejected
app.post('/api/tasks/:task_id/review', authMiddleware, (req, res) => {
  try {
    const body = { ...req.body };
    if (body.decision === undefined && body.approve !== undefined) {
      body.decision = body.approve === true || body.approve === 'true' ? 'approve' : 'reject';
    }
    const result = tools.review_task({
      task_id: req.params.task_id,
      ...body
    });
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增路由: 拆解任务
app.post('/api/tasks/split', authMiddleware, (req, res) => {
  try {
    const result = tools.split_task(req.body);
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增路由: 获取任务事件
app.get('/api/tasks/:task_id/events', authMiddleware, (req, res) => {
  try {
    res.json(ok(tools.get_task_events({ task_id: req.params.task_id })));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增路由: 创建 Epic
app.post('/api/epics', authMiddleware, (req, res) => {
  try { res.json(ok(tools.create_epic(req.body))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增路由: 查询 Epics
app.get('/api/epics', authMiddleware, (req, res) => {
  try {
    let sql = `SELECT * FROM epics WHERE 1=1`;
    const params = [];
    if (req.query.project) { sql += ` AND project = ?`; params.push(req.query.project); }
    if (req.query.status) { sql += ` AND status = ?`; params.push(req.query.status); }
    sql += ` ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all(...params);
    res.json(ok({ epics: rows }));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2.6 项目注册路由
// 注册项目（幂等：key 已存在则更新 name/description 并标记 existed:true）
app.post('/api/projects', authMiddleware, (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const name = (req.body.name || key).trim();
    if (!/^[a-z][a-z0-9_-]{1,31}$/i.test(key)) {
      return res.status(400).json(fail('项目 key 必须是 2-32 位字母开头的英文标识（字母/数字/-/_）'));
    }
    const existed = !!db.prepare(`SELECT 1 FROM projects WHERE key = ?`).get(key);
    db.prepare(`INSERT INTO projects (key, name, description, created_by) VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description`)
      .run(key, name, req.body.description || '', req.body.from_id || req.body.created_by || null);
    res.json(ok({ key, name, existed }));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// 项目列表（含实时统计：agent 数 / 在线数 / 各状态任务数；未注册但有数据的项目也列出，标 unregistered:true）
app.get('/api/projects', authMiddleware, (req, res) => {
  try {
    const registered = db.prepare(`SELECT * FROM projects ORDER BY created_at ASC`).all();
    const regMap = new Map(registered.map(p => [p.key, { ...p, agents: 0, online: 0, tasks: 0, activeTasks: 0, unregistered: false }]));
    // 聚合 agents（排除 replaced 墓碑）
    for (const r of db.prepare(`SELECT project, COUNT(*) n, SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) onl
                                FROM agents WHERE status != 'replaced' GROUP BY project`).all()) {
      if (!regMap.has(r.project)) regMap.set(r.project, { key: r.project, name: r.project, description: '', created_at: null, created_by: null, agents: 0, online: 0, tasks: 0, activeTasks: 0, unregistered: true });
      const e = regMap.get(r.project); e.agents = r.n; e.online = r.onl || 0;
    }
    // 聚合任务
    for (const r of db.prepare(`SELECT project, COUNT(*) n,
                                SUM(CASE WHEN status IN ('pending','in_progress','in_review','testing') THEN 1 ELSE 0 END) act
                                FROM tasks GROUP BY project`).all()) {
      if (!regMap.has(r.project)) regMap.set(r.project, { key: r.project, name: r.project, description: '', created_at: null, created_by: null, agents: 0, online: 0, tasks: 0, activeTasks: 0, unregistered: true });
      const e = regMap.get(r.project); e.tasks = r.n; e.activeTasks = r.act || 0;
    }
    res.json(ok({ projects: [...regMap.values()] }));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2.5 需求清单路由（监控面板「项目进度」侧栏数据源）
app.get('/api/requirements', authMiddleware, (req, res) => {
  try { res.json(ok(tools.list_requirements({ project: req.query.project }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.post('/api/requirements', authMiddleware, (req, res) => {
  try { res.json(ok(tools.req_add(req.body))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.put('/api/requirements/:req_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.req_update({ req_id: req.params.req_id, ...req.body }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.delete('/api/requirements/:req_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.req_delete({ req_id: req.params.req_id, from_id: req.body.from_id }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2.5.1 需求↔任务多对多关联
app.post('/api/requirements/:req_id/tasks', authMiddleware, (req, res) => {
  try { res.json(ok(tools.req_link_tasks({ req_id: req.params.req_id, ...req.body }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.delete('/api/requirements/:req_id/tasks/:task_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.req_unlink_task({ req_id: req.params.req_id, task_id: req.params.task_id, from_id: req.body.from_id }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.get('/api/agents', authMiddleware, (req, res) => {
  try {
    // query参数是字符串：'false'字符串为truthy会导致online_only永远生效，这里显式转布尔
    const q = { ...req.query };
    if (q.online_only !== undefined) q.online_only = String(q.online_only) !== 'false';
    res.json(ok(tools.list_agents(q)));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2.2 手动替换（老板面板操作）：POST /api/agents/:id/replace {reason?, successor_id?}
//   - 置 status='replaced' + replaced_at，关 SSE
//   - successor_id 存在 → 在途任务(pending/in_progress/in_review) assigned_id 改指 successor、未读消息迁移、双方通知
//   - 无 successor → 在途任务 assigned_id 置 NULL 回 pending 待重认领，按 to_role 通知
//   - 鉴权走全局 authMiddleware token（调用方是 dashboard 服务端，无 agent 身份）
app.post('/api/agents/:id/replace', authMiddleware, (req, res) => {
  try {
    const id = req.params.id;
    const { reason, successor_id } = req.body || {};
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    if (!agent) return res.status(404).json(fail('agent 不存在'));
    if (agent.status === 'replaced') return res.status(400).json(fail('该身份已是 replaced 终态'));

    let successor = null;
    if (successor_id) {
      successor = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(successor_id);
      if (!successor) return res.status(400).json(fail('后继 agent 不存在'));
      if (successor.id === agent.id) return res.status(400).json(fail('后继不能是被替换者本人'));
      if (successor.role !== agent.role || successor.project !== agent.project) {
        return res.status(400).json(fail(`后继须同角色同项目（期望 ${agent.role}/${agent.project}，实际 ${successor.role}/${successor.project}）`));
      }
      if (successor.status === 'replaced') return res.status(400).json(fail('后继身份已是 replaced 终态'));
    }

    const IN_FLIGHT = "('pending','in_progress','in_review')";
    const tasksToMove = db.prepare(
      `SELECT id, title FROM tasks WHERE assigned_id = ? AND status IN ${IN_FLIGHT}`
    ).all(id);

    db.prepare(`UPDATE agents SET status = 'replaced', replaced_at = ?, offline_at = ? WHERE id = ?`)
      .run(now(), now(), id);
    closeSseForAgent(id);

    let movedTasks = 0;
    if (successor) {
      const moved = db.prepare(
        `UPDATE tasks SET assigned_id = ? WHERE assigned_id = ? AND status IN ${IN_FLIGHT}`
      ).run(successor.id, id);
      movedTasks = moved.changes;
      db.prepare(`UPDATE messages SET to_id = ? WHERE to_id = ? AND is_read = 0`).run(successor.id, id);
      for (const t of tasksToMove) {
        logEvent(t.id, 'transfer', 'in_flight', 'in_flight', successor.id, successor.name,
          `替换移交：${agent.name} → ${successor.name}${reason ? '（' + reason + '）' : ''}`);
      }
      notifyAgent(successor.id, agent.project,
        `🔄 替换移交：${agent.name} 的 ${moved.changes} 个在途任务已移交给你${reason ? '（原因：' + reason + '）' : ''}`);
      notifyAgent(id, agent.project,
        `⛔ 你的身份已被手动替换（后继 ${successor.name}）${reason ? '，原因：' + reason : ''}`);
    } else {
      const cleared = db.prepare(
        `UPDATE tasks SET assigned_id = NULL WHERE assigned_id = ? AND status IN ${IN_FLIGHT}`
      ).run(id);
      movedTasks = -cleared.changes; // 负数表示"回池待认领"而非移交
      for (const t of tasksToMove) {
        // assigned_id 置 NULL 的任务若在 in_progress 需回 pending 待重认领
        const cur = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(t.id);
        if (cur && cur.status !== 'pending') {
          db.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`).run(now(), t.id);
          logEvent(t.id, 'status_change', cur.status, 'pending', null, null,
            `认领人 ${agent.name} 被替换（无后继），任务回池待认领${reason ? '（' + reason + '）' : ''}`);
        }
      }
      notifyRole(agent.role, agent.project,
        `♻️ ${agent.name} 已被手动替换（无后继），其 ${cleared.changes} 个在途任务已回池待认领`);
      notifyAgent(id, agent.project, `⛔ 你的身份已被手动替换${reason ? '（原因：' + reason + '）' : ''}`);
    }

    log('info', `Agent replaced (manual)`, { id, name: agent.name, successor: successor ? successor.name : null, reason });
    res.json(ok({
      replaced: agent.name,
      successor: successor ? successor.name : null,
      tasks_affected: Math.abs(movedTasks),
      disposition: successor ? 'transferred' : 'returned_to_pool'
    }));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2.2 手动移交（老板面板操作）：POST /api/tasks/:id/transfer {to_id}
//   目标须存在且 assigned_role 与其角色一致（manager 例外）；仅 pending/in_progress/in_review 可移交
app.post('/api/tasks/:id/transfer', authMiddleware, (req, res) => {
  try {
    const taskId = req.params.id;
    const toId = (req.body || {}).to_id;
    if (!toId) return res.status(400).json(fail('需要 to_id'));
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!task) return res.status(404).json(fail('任务不存在'));
    const TRANSFERABLE = ['pending', 'in_progress', 'in_review'];
    if (!TRANSFERABLE.includes(task.status)) {
      return res.status(400).json(fail(`状态 ${task.status} 不可移交（仅 ${TRANSFERABLE.join('/')}）`));
    }
    const target = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(toId);
    if (!target) return res.status(400).json(fail('目标 agent 不存在'));
    if (target.status === 'replaced') return res.status(400).json(fail('目标身份已是 replaced 终态'));
    if (target.role !== task.assigned_role && target.role !== 'manager') {
      return res.status(400).json(fail(`目标角色 ${target.role} 与任务角色 ${task.assigned_role} 不匹配`));
    }
    if (task.assigned_id === toId) return res.status(400).json(fail('任务已由目标 agent 持有'));

    const prevId = task.assigned_id;
    const prev = prevId ? db.prepare(`SELECT name FROM agents WHERE id = ?`).get(prevId) : null;

    db.prepare(`UPDATE tasks SET assigned_id = ?, updated_at = ? WHERE id = ?`).run(toId, now(), taskId);
    logEvent(taskId, 'transferred', task.status, task.status, toId, target.name,
      `手动移交${prev ? `：${prev.name} → ${target.name}` : `（此前无人认领）→ ${target.name}`}`);
    notifyAgent(toId, task.project, `📥 任务移交给你：${task.title}（来自 ${prev ? prev.name : '任务池'}）`);
    if (prevId && prevId !== toId) {
      notifyAgent(prevId, task.project, `📤 你的任务已被移交：${task.title} → ${target.name}`);
    }

    log('info', `Task transferred (manual)`, { task_id: taskId, from: prevId, to: toId });
    res.json(ok({ task_id: taskId, from: prevId, to: toId, to_name: target.name }));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.post('/api/offline/:agent_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.offline({ from_id: req.params.agent_id }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// ============ v2.3 外部任务上报路由（任务 933e16a3）============

// POST /api/agents/:id/work/start {from_id, title, note?, ref?}
app.post('/api/agents/:agent_id/work/start', authMiddleware, (req, res) => {
  try {
    const result = tools.work_start({ agent_id: req.params.agent_id, ...req.body });
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// POST /api/work/:work_id/update {from_id, progress?, note?}
app.post('/api/work/:work_id/update', authMiddleware, (req, res) => {
  try {
    const result = tools.work_update({ work_id: req.params.work_id, ...req.body });
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// POST /api/work/:work_id/finish {from_id, note?}
app.post('/api/work/:work_id/finish', authMiddleware, (req, res) => {
  try {
    const result = tools.work_finish({ work_id: req.params.work_id, ...req.body });
    res.json(result.error ? result : ok(result));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// GET /api/works?project=&agent_id=&include_done=true —— 批量查询（dashboard 聚合用）
app.get('/api/works', authMiddleware, (req, res) => {
  try { res.json(ok(tools.get_works(req.query))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// GET /api/agents/:id/work —— 单 agent 查询（含 done，倒序）
app.get('/api/agents/:agent_id/work', authMiddleware, (req, res) => {
  try {
    res.json(ok(tools.get_works({
      agent_id: req.params.agent_id,
      project: req.query.project || undefined,
      include_done: req.query.include_done !== undefined ? req.query.include_done : true
    })));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增: 心跳路由
app.post('/api/heartbeat', authMiddleware, (req, res) => {
  try { res.json(ok(tools.heartbeat(req.body))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

// v2 新增: 状态机查询（给agent参考合法流转）
app.get('/api/state-machine', authMiddleware, (req, res) => {
  res.json(ok({ transitions: VALID_TRANSITIONS, terminal: TERMINAL_STATES }));
});

// ---------- 定时清理离线agent ----------
setInterval(() => {
  // v2.3.1（任务 3485f9b7）清扫豁免：agent 深度干活期间不发请求（不心跳/不轮询），
  //   5min 窗口一刀切会把正在干活的 agent 误判离线（老板 2026-08-15 实测反馈根因）。
  //   分层超时：有进行中工作的 agent 豁免 5min 清扫，60min 内有任何 API 活动就不置 offline；
  //   超 60min 才置 offline，同时把其 active 工作项标 stale（面板灰显）并把 in_progress 任务放回 pending。
  //   无进行中工作的 agent 维持 5min 现状。replaced 墓碑不参与豁免（终态不可逆）。
  const softCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const hardCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // [Phase1] 找出心跳超时的agent，关闭其SSE连接（防泄漏）
  const stale = db.prepare(
    `SELECT id FROM agents WHERE status = 'online' AND last_seen < ?`
  ).all(softCutoff);
  for (const a of stale) closeSseForAgent(a.id);

  // v2.1 身份机制：不碰 replaced 墓碑（终态）。
  // v2.3.1：有进行中工作且 60min 内有 API 活动 → 豁免（保持 online）；其余超 5min 照旧置 offline。
  const sweep = db.prepare(
    `UPDATE agents SET status = 'offline', offline_at = ?
     WHERE status = 'online' AND last_seen < ?
       AND NOT (last_seen >= ? AND id IN (SELECT assigned_id FROM tasks WHERE status = 'in_progress' AND assigned_id IS NOT NULL
                    UNION SELECT agent_id FROM agent_work WHERE status = 'active'))`
  ).run(now(), softCutoff, hardCutoff);
  if (sweep.changes > 0) {
    log('info', `sweeper: ${sweep.changes} agent(s) marked offline (busy agents with activity<60min exempted)`);
  }

  // v2.3.1：豁免失效（超60min无API活动）被置 offline 的 working agent——
  //   ① active 工作项标 stale（面板灰显，复用 v2.3 stale 概念）
  //   ② 其 in_progress 任务放回 pending（assigned_id 清空，角色队列可重新接取）
  //      同时关掉对应 hub 工作项（防 stale 项永久挂着），放回的任务被重新认领会生成新工作项。
  const forsaken = db.prepare(
    `SELECT id FROM agents WHERE status = 'offline' AND last_seen < ?
       AND (id IN (SELECT assigned_id FROM tasks WHERE status = 'in_progress' AND assigned_id IS NOT NULL)
            OR id IN (SELECT agent_id FROM agent_work WHERE status = 'active'))`
  ).all(hardCutoff);
  for (const ag of forsaken) {
    const dropped = db.prepare(
      `UPDATE agent_work SET status = 'stale', updated_at = ? WHERE agent_id = ? AND status = 'active'`
    ).run(now(), ag.id);
    const backToPending = db.prepare(
      `UPDATE tasks SET status = 'pending', assigned_id = NULL, updated_at = ? WHERE assigned_id = ? AND status = 'in_progress'`
    ).run(now(), ag.id);
    if (dropped.changes > 0 || backToPending.changes > 0) {
      log('info', `sweeper: working agent lost >60min → offline`, {
        agent_id: ag.id, works_stale: dropped.changes, tasks_back_to_pending: backToPending.changes
      });
    }
  }

  // v2.3 失联判定（任务 933e16a3，顺带处理不新建定时器）：
  //   active 工作项 且所属 agent 已 offline/replaced 且 updated_at 超过30分钟 → 置 'stale'；
  //   该 agent 心跳复活或 update 上报时自动拉回 active（见 heartbeat / work_update / 拉消息路径）。
  //   v2.3.1 注：上面的 60min 强制收尾已把 forsaken agent 的工作项即时置 stale（比30min窗口先手），
  //   此条继续兜底其余 offline/replaced 场景（如手动 offline、替换移交后的旧身份残留项）。
  const workCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const orphaned = db.prepare(
    `UPDATE agent_work SET status = 'stale', updated_at = ?
     WHERE status = 'active'
       AND agent_id IN (SELECT id FROM agents WHERE status IN ('offline','replaced'))
       AND updated_at < ?`
  ).run(now(), workCutoff);
  if (orphaned.changes > 0) {
    log('info', `agent_work: stale check marked ${orphaned.changes} work item(s) stale`);
  }

  log('debug', 'Heartbeat check completed');
}, 60 * 1000);

// ---------- 启动 ----------
app.listen(PORT, '0.0.0.0', () => {
  log('info', `Agent Hub v2.3.1 running on port ${PORT}`);
  log('info', `Health: http://localhost:${PORT}/health`);
  log('info', `MCP Tools: http://localhost:${PORT}/mcp/tools`);
  log('info', `State Machine: http://localhost:${PORT}/api/state-machine`);
});
