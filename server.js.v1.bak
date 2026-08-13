/**
 * Agent Hub - 通用多Agent通信中间件
 * 
 * 设计原则:
 * 1. 动态注册 - 任何agent随时上线/下线/替换
 * 2. 多项目隔离 - project字段隔离不同项目的消息和任务
 * 3. 角色自由 - role是自由文本，不写死
 * 4. 能力声明 - agent声明capabilities，PM据此分配任务
 * 
 * 两种接入方式:
 * A) MCP Client (Hermes等): 直接调用HTTP API
 * B) 轮询Agent: 定时调 get_messages / get_tasks
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

  CREATE INDEX IF NOT EXISTS idx_msg_project ON messages(project);
  CREATE INDEX IF NOT EXISTS idx_msg_to_role ON messages(to_role);
  CREATE INDEX IF NOT EXISTS idx_msg_to_id ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_task_project ON tasks(project);
  CREATE INDEX IF NOT EXISTS idx_task_assigned ON tasks(assigned_role);
  CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project);
`);

// ---------- 工具函数 ----------
function now() {
  return new Date().toISOString();
}

// 鉴权中间件
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 统一响应
function ok(data) {
  return { code: 0, data };
}
function fail(msg, code = 1) {
  return { code, error: msg };
}

// ---------- MCP 工具定义 ----------
const MCP_TOOLS = [
  {
    name: 'register',
    description: '注册/上线agent。返回agent_id。同project+role的旧agent自动下线，未读消息转移给新agent。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent名称，如"后端Hermes"' },
        role: { type: 'string', description: '角色，自由文本，如 manager/frontend/backend/qa' },
        project: { type: 'string', description: '项目名，如 yiyuan/kaiyan/mangersystem' },
        capabilities: { type: 'string', description: '能力声明，逗号分隔，如 "Node.js,API,数据库"' }
      },
      required: ['name', 'role', 'project']
    }
  },
  {
    name: 'send_message',
    description: '发送消息给指定agent(按id)或角色(按role)。同project内路由。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: '发送者agent_id' },
        to_id: { type: 'string', description: '接收者agent_id（与to_role二选一）' },
        to_role: { type: 'string', description: '接收角色（与to_id二选一，发给该角色所有在线agent）' },
        content: { type: 'string', description: '消息内容' }
      },
      required: ['content']
    }
  },
  {
    name: 'get_messages',
    description: '获取自己的未读消息。自动按project隔离。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: '自己的agent_id' },
        all: { type: 'boolean', description: 'true=包含已读消息，默认false只看未读' }
      },
      required: ['from_id']
    }
  },
  {
    name: 'assign_task',
    description: '创建并分配任务给指定角色或agent。',
    inputSchema: {
      type: 'object',
      properties: {
        created_by: { type: 'string', description: '创建者agent_id' },
        project: { type: 'string', description: '项目名' },
        title: { type: 'string', description: '任务标题' },
        description: { type: 'string', description: '任务详细描述' },
        to_role: { type: 'string', description: '分配给哪个角色' },
        to_id: { type: 'string', description: '分配给指定agent（与to_role二选一）' },
        priority: { type: 'string', description: '优先级: urgent/high/normal/low，默认normal' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'get_tasks',
    description: '查询任务。可按项目、角色、状态过滤。agent查分配给自己角色的任务。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', description: 'pending/in_progress/completed/cancelled' },
        assigned_role: { type: 'string', description: '按角色查' },
        assigned_id: { type: 'string', description: '按agent查' }
      }
    }
  },
  {
    name: 'update_task',
    description: '更新任务状态和结果。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务ID' },
        from_id: { type: 'string', description: '操作者agent_id' },
        status: { type: 'string', description: 'pending/in_progress/completed/cancelled' },
        result: { type: 'string', description: '任务结果/备注' }
      },
      required: ['task_id', 'status']
    }
  },
  {
    name: 'list_agents',
    description: '查看当前在线的agent列表。可按project过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '按项目过滤' },
        online_only: { type: 'boolean', description: 'true=只看在线的，默认true' }
      }
    }
  },
  {
    name: 'offline',
    description: 'agent下线。',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: '要下线的agent_id' }
      },
      required: ['from_id']
    }
  },
  {
    name: 'heartbeat',
    description: '心跳保活。agent定期调用更新last_seen。超过5分钟未心跳自动标记offline。',
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
    
    // 同project+role的旧agent下线
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

    // 转移未读消息给新agent
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
      // 发给指定agent
      const recv = db.prepare(`SELECT project FROM agents WHERE id = ?`).get(to_id);
      if (!recv) return fail('接收者不存在');
      project = project || recv.project;
      db.prepare(
        `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(msgId, project, from_id || 'system', fromName || 'System', to_id, content);
    } else {
      // 发给角色下所有在线agent
      const recipients = db.prepare(
        `SELECT id, project FROM agents WHERE role = ? AND status = 'online' AND project = ?`
      ).all(to_role, project || '%');
      
      if (recipients.length === 0) {
        // 没有在线agent也存一条，标记to_role
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

    // 标记为已读
    db.prepare(`UPDATE messages SET is_read = 1 WHERE to_id = ? AND is_read = 0`).run(from_id);

    return { messages: rows };
  },

  assign_task({ created_by, project, title, description = '', to_role, to_id, priority = 'normal' }) {
    const taskId = uuidv4();
    let assignedId = to_id || null;

    // 如果指定to_role但没指定to_id，找到该角色在线agent
    if (!assignedId && to_role) {
      const agent = db.prepare(
        `SELECT id FROM agents WHERE project = ? AND role = ? AND status = 'online' LIMIT 1`
      ).get(project, to_role);
      if (agent) assignedId = agent.id;
    }

    db.prepare(
      `INSERT INTO tasks (id, project, title, description, assigned_role, assigned_id, status, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(taskId, project, title, description, to_role || null, assignedId, priority, created_by || null, now(), now());

    // 给被分配的agent发一条消息通知
    if (assignedId) {
      const msgId = uuidv4();
      db.prepare(
        `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
         VALUES (?, ?, 'system', 'AgentHub', ?, ?)`
      ).run(msgId, project, assignedId, `📋 新任务: ${title}`);
    }

    log('info', `Task assigned`, { task_id: taskId, project, to_role });
    return { task_id: taskId };
  },

  get_tasks({ project, status, assigned_role, assigned_id }) {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params = [];

    if (project) { sql += ` AND project = ?`; params.push(project); }
    if (status) { sql += ` AND status = ?`; params.push(status); }
    if (assigned_role) { sql += ` AND assigned_role = ?`; params.push(assigned_role); }
    if (assigned_id) { sql += ` AND assigned_id = ?`; params.push(assigned_id); }

    sql += ` ORDER BY created_at DESC LIMIT 200`;

    const rows = db.prepare(sql).all(...params);
    return { tasks: rows };
  },

  update_task({ task_id, from_id, status, result = '' }) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
    if (!task) return fail('任务不存在');

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

    // 通知创建者任务状态变更
    if (task.created_by && from_id !== task.created_by) {
      const msgId = uuidv4();
      db.prepare(
        `INSERT INTO messages (id, project, from_id, from_name, to_id, content)
         VALUES (?, ?, 'system', 'AgentHub', ?, ?)`
      ).run(msgId, task.project, task.created_by, `📦 任务状态更新: ${task.title} → ${status}${result ? ' | ' + result : ''}`);
    }

    log('info', `Task updated`, { task_id, status });
    return ok({});
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
    projects: db.prepare(`SELECT COUNT(DISTINCT project) as c FROM agents WHERE status = 'online'`).get().c
  };
  res.json(ok({ status: 'running', uptime: process.uptime(), ...counts }));
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

app.get('/api/agents', authMiddleware, (req, res) => {
  try { res.json(ok(tools.list_agents(req.query))); }
  catch (err) { res.status(500).json(fail(err.message)); }
});

app.post('/api/offline/:agent_id', authMiddleware, (req, res) => {
  try { res.json(ok(tools.offline({ from_id: req.params.agent_id }))); }
  catch (err) { res.status(500).json(fail(err.message)); }
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
  log('info', `Agent Hub running on port ${PORT}`);
  log('info', `Health: http://localhost:${PORT}/health`);
  log('info', `MCP Tools: http://localhost:${PORT}/mcp/tools`);
});
