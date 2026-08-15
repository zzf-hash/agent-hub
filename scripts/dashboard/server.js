#!/usr/bin/env node
/**
 * AgentHub 实时监控面板 - 零依赖独立服务
 * 数据源：AgentHub API（只读），不改动任何业务代码
 * 启动：AGENTHUB_TOKEN=xxx node scripts/dashboard/server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const PORT = parseInt(process.env.PORT || '3004', 10);
const HUB_BASE = (process.env.AGENTHUB_BASE || 'http://43.155.210.25:8100').replace(/\/+$/, '');
const HUB_TOKEN = process.env.AGENTHUB_TOKEN;

if (!HUB_TOKEN) {
  console.error('[FATAL] 缺少环境变量 AGENTHUB_TOKEN（AgentHub 访问凭证）。用法：AGENTHUB_TOKEN=xxx node scripts/dashboard/server.js');
  process.exit(1);
}

const CACHE_TTL = 5000;      // hub 请求 5s 内存缓存
const HUB_TIMEOUT = 5000;    // hub 请求超时 5s
const HISTORY_LIMIT = 100;   // 终态任务最多保留条数

const ACTIVE_STATUSES = ['pending', 'in_progress', 'in_review', 'testing', 'test_failed'];
const FINAL_STATUSES = ['completed', 'test_passed', 'rejected', 'cancelled'];
const ALL_STATUSES = [...ACTIVE_STATUSES, ...FINAL_STATUSES];

// ---------- hub 请求（5s 缓存 + 并发去重） ----------
const cache = new Map(); // key -> { ts, promise }

function hubGet(apiPath) {
  const entry = cache.get(apiPath);
  const now = Date.now();
  if (entry && now - entry.ts < CACHE_TTL) return entry.promise;

  const promise = new Promise((resolve, reject) => {
    const url = new URL(apiPath, HUB_BASE);
    const req = http.request(url, { method: 'GET', headers: { 'x-auth-token': HUB_TOKEN }, timeout: HUB_TIMEOUT }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`hub ${apiPath} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`hub ${apiPath} 非JSON`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`hub ${apiPath} 超时`)); });
    req.on('error', reject);
    req.end();
  });

  // 失败不缓存，成功缓存 5s
  promise.catch(() => cache.delete(apiPath));
  cache.set(apiPath, { ts: now, promise });
  return promise;
}

// ---------- agent 名映射（agents 列表 + 本进程历史） ----------
const agentNameHistory = new Map(); // id -> name

function buildAgentNameMap(agents) {
  for (const a of agents || []) {
    if (a.id && a.name) agentNameHistory.set(a.id, a.name);
  }
  return agentNameHistory;
}

function agentName(id) {
  if (!id) return '';
  return agentNameHistory.get(id) || id.slice(0, 8);
}

// ---------- overview 聚合 ----------
let lastGood = null;
let lastGoodAt = null;

async function buildOverview() {
  const [healthRes, agentsRes, ...taskResList] = await Promise.all([
    hubGet('/health').catch(() => null),
    hubGet('/api/agents?project=yiyuan').catch(() => null),
    ...ALL_STATUSES.map((s) => hubGet(`/api/tasks?project=yiyuan&status=${s}`).catch(() => null)),
  ]);

  const agents = (agentsRes && agentsRes.data && agentsRes.data.agents) || [];
  const nameMap = buildAgentNameMap(agents);

  const byStatus = {};
  ALL_STATUSES.forEach((s, i) => {
    const r = taskResList[i];
    byStatus[s] = (r && r.data && r.data.tasks) || [];
  });

  const activeTasks = [];
  const historyTasks = [];
  const taskStats = {};
  for (const s of ALL_STATUSES) {
    const list = byStatus[s] || [];
    taskStats[s] = list.length;
    if (ACTIVE_STATUSES.includes(s)) activeTasks.push(...list);
    else historyTasks.push(...list);
  }
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  activeTasks.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || String(b.updated_at).localeCompare(String(a.updated_at)));
  historyTasks.sort((a, b) => String(b.updated_at || b.completed_at || '').localeCompare(String(a.updated_at || a.completed_at || '')));
  historyTasks.length = Math.min(historyTasks.length, HISTORY_LIMIT);

  const health = healthRes && healthRes.data ? healthRes.data : null;

  // 任务执行者名映射（含 events actor 由前端惰性拉取时用 nameMap）
  const overview = {
    serverTime: new Date().toISOString(),
    hubBase: HUB_BASE,
    health,
    agents,
    activeTasks,
    historyTasks,
    taskStats,
    agentNames: Object.fromEntries(nameMap),
  };
  lastGood = overview;
  lastGoodAt = Date.now();
  return overview;
}

// ---------- 静态文件 ----------
let indexHtmlCache = null;
function getIndexHtml() {
  if (!indexHtmlCache) {
    indexHtmlCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  }
  return indexHtmlCache;
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (req.method !== 'GET') return send(405, { code: 405, error: 'method_not_allowed' });

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { return send(200, getIndexHtml(), 'text/html; charset=utf-8'); }
    catch (e) { return send(500, { code: 500, error: 'index.html missing' }); }
  }

  if (url.pathname === '/api/overview') {
    buildOverview()
      .then((ov) => send(200, { code: 0, data: ov }))
      .catch((e) => {
        if (lastGood) {
          return send(200, { code: 0, data: lastGood, error: 'hub_unreachable', lastGoodAt: new Date(lastGoodAt).toISOString() });
        }
        return send(502, { code: 502, error: 'hub_unreachable', message: String(e.message || e) });
      });
    return;
  }

  const evMatch = url.pathname.match(/^\/api\/task\/([0-9a-fA-F-]+)\/events$/);
  if (evMatch) {
    hubGet(`/api/tasks/${evMatch[1]}/events`)
      .then((r) => {
        const events = (r && r.data && r.data.events) || [];
        for (const ev of events) {
          if (ev.actor_id && !ev.actor_name) ev.actor_name = agentName(ev.actor_id);
        }
        send(200, { code: 0, data: { events } });
      })
      .catch((e) => send(502, { code: 502, error: 'hub_unreachable', message: String(e.message || e) }));
    return;
  }

  send(404, { code: 404, error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[dashboard] listening on http://localhost:${PORT}  (hub: ${HUB_BASE})`);
});

process.on('SIGINT', () => { console.log('\n[dashboard] bye'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
