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
const rawConfig = fs.readFileSync(__dirname + '/config.yaml', 'utf8');
const config = {};
rawConfig.split('\n').forEach(line => {
  const m = line.match(/^(\w+):\s*(.*)$/);
  if (m && m[2].trim()) config[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
});

const PORT = parseInt(config.port) || 8100;
const AUTH_TOKEN = config.auth_token || '';
const DB_PATH = config.db_path || './db.sqlite';
const LOG_LEVEL = config.log_level || 'info';
const HERMES_WEBHOOK_URL = config.hermes_webhook_url || '';
const HERMES_WEBHOOK_SECRET = config.hermes_webhook_secret || '';

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

// ---------- 系统消息通知 ----------
function notifyAgent(agentId, project, content) {
  if (!agentId) return;
  db.prepare(
    `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
     VALUES (?, ?, 'system', 'AgentHub', ?, ?)`
  ).run(uuidv4(), project, agentId, content);
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
      db.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE epic_id = ? AND task_type = 'dev' AND status != 'completed'`
      ).run(now(), now(), task.epic_id);
    }
  }
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
  register({ name, role, project, capabilities = '' }) {
    const id = uuidv4();
    
    const oldAgents = db.prepare(
      `SELECT id FROM agents WHERE project = ? AND role = ? AND status = 'online'`
    ).all(project, role);
    
    for (const old of oldAgents) {
      db.prepare(`UPDATE agents SET status = 'offline', offline_at = ? WHERE id = ?`)
        .run(now(), old.id);
    }

    db.prepare(
      `INSERT INTO agents (id, name, role, project, capabilities, status, online_at, last_seen)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`
    ).run(id, name, role, project, capabilities, now(), now());

    for (const old of oldAgents) {
      db.prepare(
        `UPDATE messages SET to_id = ? WHERE to_id = ? AND is_read = 0`
      ).run(id, old.id);
    }

    log('info', `Agent registered`, { id, name, role, project });
    return { agent_id: id, replaced: oldAgents.length };
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
    } else {
      const recipients = db.prepare(
        `SELECT id, project FROM agents WHERE role = ? AND status = 'online' AND project = ?`
      ).all(to_role, project || '%');
      
      if (recipients.length === 0) {
        db.prepare(
          `INSERT INTO messages (id, project, from_id, from_name, to_role, content)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(msgId, project || 'unknown', from_id || 'system', fromName || 'System', to_role, content);
      } else {
        for (const r of recipients) {
          const mid = recipients.indexOf(r) === 0 ? msgId : uuidv4();
          db.prepare(
            `INSERT INTO messages (id, project, from_id, from_name, to_id, to_role, content)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(mid, r.project, from_id || 'system', fromName || 'System', r.id, to_role, content);
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

  update_task({ task_id, from_id, status, result = '' }) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
    if (!task) return fail('任务不存在');

    // v2: 状态机校验
    if (!canTransition(task.status, status)) {
      return fail(`状态流转不合法: ${task.status} → ${status}。允许的流转: ${(VALID_TRANSITIONS[task.status] || []).join(', ') || '终态，不可变更'}`);
    }

    const updates = { status, updated_at: now() };
    if (status === 'completed') updates.completed_at = now();
    if (result) updates.result = result;

    db.prepare(
      `UPDATE tasks SET status = @status, updated_at = @updated_at, 
       completed_at = @completedAt, result = @result WHERE id = @id`
    ).run({
      status: updates.status,
      updated_at: updates.updated_at,
      completedAt: updates.completed_at || null,
      result: updates.result || task.result,
      id: task_id
    });

    // 获取操作者名称
    let actorName = null;
    if (from_id) {
      const agent = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(from_id);
      if (agent) actorName = agent.name;
    }

    // 记录事件
    logEvent(task_id, 'status_change', task.status, status, from_id, actorName, result);

    // 通知创建者
    if (task.created_by && from_id !== task.created_by) {
      notifyAgent(task.created_by, task.project, `📦 任务状态: ${task.title} → ${status}${result ? ' | ' + result : ''}`);
    }

    log('info', `Task updated`, { task_id, from: task.status, to: status });

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
    return { agents: rows };
  },

  offline({ from_id }) {
    db.prepare(`UPDATE agents SET status = 'offline', offline_at = ? WHERE id = ?`)
      .run(now(), from_id);
    log('info', `Agent offline`, { id: from_id });
    return ok({});
  },

  heartbeat({ from_id }) {
    db.prepare(`UPDATE agents SET last_seen = ?, status = 'online' WHERE id = ?`)
      .run(now(), from_id);
    return ok({});
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
  res.json(ok({ status: 'running', version: '2.0.0', uptime: process.uptime(), ...counts }));
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

app.get('/api/messages/:agent_id', authMiddleware, (req, res) => {
  try {
    res.json(ok(tools.get_messages({ from_id: req.params.agent_id, all: req.query.all === 'true' })));
  }
  catch (err) { res.status(500).json(fail(err.message)); }
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
app.post('/api/tasks/:task_id/review', authMiddleware, (req, res) => {
  try {
    const result = tools.review_task({
      task_id: req.params.task_id,
      ...req.body
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

app.get('/api/agents', authMiddleware, (req, res) => {
  try { res.json(ok(tools.list_agents(req.query))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.post('/api/offline/:agent_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.offline({ from_id: req.params.agent_id }))); }
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
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(`UPDATE agents SET status = 'offline', offline_at = ? WHERE status = 'online' AND last_seen < ?`)
    .run(now(), cutoff);
  log('debug', 'Heartbeat check completed');
}, 60 * 1000);

// ---------- 启动 ----------
app.listen(PORT, '0.0.0.0', () => {
  log('info', `Agent Hub v2.0.0 running on port ${PORT}`);
  log('info', `Health: http://localhost:${PORT}/health`);
  log('info', `MCP Tools: http://localhost:${PORT}/mcp/tools`);
  log('info', `State Machine: http://localhost:${PORT}/api/state-machine`);
});
