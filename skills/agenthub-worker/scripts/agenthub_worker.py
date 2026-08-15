#!/usr/bin/env python3
"""agenthub_worker.py — AgentHub worker 握手协议客户端（纯标准库，零依赖）。

协议见 ../SKILL.md。需要 hub v2.2+（身份幂等）/ v2.3+（work API，旧版自动降级）。
用法示例：
  agenthub_worker.py ensure-identity --name 前端小张 --role frontend --project yiyuan --hub http://x:8100 --token T
  agenthub_worker.py beat && agenthub_worker.py msgs && agenthub_worker.py tasks
  agenthub_worker.py claim <task_id>
  agenthub_worker.py works                 # 查我的工作卡（含hub任务work_id）
  agenthub_worker.py work-update <work_id> 40 --note "接口联调完"
  agenthub_worker.py work-start "老板直派的活" --ref "渠道:feishu"
  agenthub_worker.py work-finish <work_id> --note "已交付"
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEF_IDENTITY = os.environ.get("AGENTHUB_IDENTITY", "./.agenthub.json")
DEF_OUTBOX = os.environ.get("AGENTHUB_OUTBOX", "./.agenthub-outbox.jsonl")
TIMEOUT = 20
RETRIES = 3          # 含首次
BACKOFF = 2          # 秒


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def load_identity():
    if not os.path.exists(DEF_IDENTITY):
        die("身份文件不存在: %s。首次请先 ensure-identity（拿不到地址/token 就问 PM，不要盲目注册）" % DEF_IDENTITY)
    with open(DEF_IDENTITY) as f:
        return json.load(f)


class Hub:
    def __init__(self, base_url, token):
        self.base = base_url.rstrip("/")
        self.token = token

    def call(self, method, path, body=None, retries=RETRIES):
        last = None
        for i in range(retries):
            if i:
                time.sleep(BACKOFF)
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(
                self.base + path, data=data, method=method,
                headers={"Content-Type": "application/json", "x-auth-token": self.token})
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    raw = r.read().decode()
                    try:
                        return json.loads(raw) if raw.strip() else {"code": 0, "data": {}}
                    except json.JSONDecodeError:      # 偶发空/坏 body → 重试
                        last = {"error": "bad_json", "raw": raw[:120]}
            except urllib.error.HTTPError as e:
                try:
                    payload = json.loads(e.read().decode() or "{}")
                except Exception:
                    payload = {}
                return {"http_error": e.code, **payload}   # 4xx/5xx 不重试，直接交上层判断
            except (urllib.error.URLError, OSError) as e:
                last = {"network_error": str(e)}
        return last or {"error": "unknown"}


# ---------- outbox：hub 不可达时的保险丝 ----------

def outbox_add(op, payload):
    with open(DEF_OUTBOX, "a") as f:
        f.write(json.dumps({"op": op, "payload": payload, "ts": time.strftime("%FT%T")}, ensure_ascii=False) + "\n")


def outbox_len():
    if not os.path.exists(DEF_OUTBOX):
        return 0
    with open(DEF_OUTBOX) as f:
        return sum(1 for _ in f)


def outbox_flush(hub):
    if not os.path.exists(DEF_OUTBOX):
        return
    with open(DEF_OUTBOX) as f:
        lines = [l for l in f.read().splitlines() if l.strip()]
    kept, sent = [], 0
    for line in lines:
        rec = json.loads(line)
        ok = _do_work_op(hub, rec["op"], rec["payload"], degraded=False) if rec["op"].startswith("work-") \
            else False
        if ok:
            sent += 1
        else:
            kept.append(line)
    with open(DEF_OUTBOX, "w") as f:
        f.write("\n".join(kept) + ("\n" if kept else ""))
    print("outbox: 已重放 %d 条, 滞留 %d 条" % (sent, len(kept)))


def _do_work_op(hub, op, payload, degraded=True):
    """执行 work-* 操作。hub 未升级(404/未知路由) → 降级为发消息给 manager；网络不可达 → 进 outbox。"""
    if op == "work-start":
        res = hub.call("POST", "/api/agents/%s/work/start" % payload["from_id"], payload)
    elif op == "work-update":
        res = hub.call("POST", "/api/work/%s/update" % payload["work_id"],
                       {k: v for k, v in payload.items() if k != "work_id"})
    elif op == "work-finish":
        res = hub.call("POST", "/api/work/%s/finish" % payload["work_id"],
                       {k: v for k, v in payload.items() if k != "work_id"})
    else:
        return False

    if res.get("code") == 0:
        print(json.dumps(res.get("data") or {}, ensure_ascii=False))
        return True

    if res.get("network_error"):
        outbox_add(op, payload)
        print("hub 不可达，已写入本地 outbox（恢复后自动重放）: %s" % json.dumps(res, ensure_ascii=False))
        return False

    if res.get("http_error") in (404, 400) or "无法" in str(res.get("error", "")) or "not" in str(res.get("error", "")).lower():
        if degraded:
            summary = "%s | title=%s progress=%s note=%s" % (
                op, payload.get("title", ""), payload.get("progress", ""), payload.get("note", ""))
            msg = hub.call("POST", "/api/send_message", {
                "from_id": payload["from_id"], "to_role": "manager",
                "content": "[外部任务上报·hub未升级v2.3降级] " + summary[:400]})
            print("降级通知PM: %s" % ("ok" if msg.get("code") == 0 else json.dumps(msg, ensure_ascii=False)))
        return False

    print("hub 拒绝: %s" % json.dumps(res, ensure_ascii=False), file=sys.stderr)
    return False


# ---------- 子命令 ----------

def cmd_ensure_identity(a):
    if os.path.exists(DEF_IDENTITY):
        ident = json.load(open(DEF_IDENTITY))
        res = Hub(ident["base_url"], ident["token"]).call("POST", "/api/heartbeat", {"from_id": ident["agent_id"]})
        if res.get("code") == 0:
            print("身份已存在并心跳成功: %s (%s/%s/%s)" % (ident["agent_id"], ident["name"], ident["role"], ident["project"]))
            print("提示: 身份永久有效, 禁止再次 register。")
            return
        die("身份文件存在但心跳失败: %s —— 停止操作，报告老板/PM，不要自行重建身份" % json.dumps(res, ensure_ascii=False))
    if not (a.hub and a.token):
        die("首次注册需要 --hub 和 --token（找 PM 领取）。切勿凭空猜测注册。")
    hub = Hub(a.hub, a.token)
    res = hub.call("POST", "/api/register", {"name": a.name, "role": a.role, "project": a.project})
    if res.get("code") != 0:
        die("register 失败: %s" % json.dumps(res, ensure_ascii=False))
    agent_id = (res.get("data") or {}).get("agent_id")
    ident = {"base_url": a.hub, "token": a.token, "agent_id": agent_id,
             "name": a.name, "role": a.role, "project": a.project}
    with open(DEF_IDENTITY, "w") as f:
        json.dump(ident, f, ensure_ascii=False, indent=2)
    # 提醒 gitignore
    gi = ".gitignore"
    entry = DEF_IDENTITY.lstrip("./")
    if os.path.exists(gi):
        if entry not in open(gi).read():
            with open(gi, "a") as f:
                f.write("\n# agenthub 身份文件(含token,勿提交)\n%s\n%s\n" % (entry, os.path.basename(DEF_OUTBOX)))
    else:
        with open(gi, "w") as f:
            f.write("# agenthub 身份文件(含token,勿提交)\n%s\n%s\n" % (entry, os.path.basename(DEF_OUTBOX)))
    print("注册成功(仅此一次): %s  身份已写入 %s（已加 .gitignore）" % (agent_id, DEF_IDENTITY))


def with_hub(fn):
    ident = load_identity()
    hub = Hub(ident["base_url"], ident["token"])
    fn(ident, hub)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("ensure-identity", help="首次注册身份(仅一次)")
    sp.add_argument("--name", required=True)
    sp.add_argument("--role", required=True, choices=["backend", "frontend", "qa"])
    sp.add_argument("--project", required=True)
    sp.add_argument("--hub")
    sp.add_argument("--token")

    sub.add_parser("beat", help="心跳(复活在线)")
    sub.add_parser("msgs", help="拉未读消息")
    tp = sub.add_parser("tasks", help="任务列表")
    tp.add_argument("status", nargs="?", help="pending|in_progress|in_review|...")
    sub.add_parser("works", help="我的工作卡")
    wp = sub.add_parser("works-active", help="仅进行中工作卡")
    sub.add_parser("offline", help="主动下线")
    sub.add_parser("flush", help="手动重放 outbox")

    cp = sub.add_parser("claim", help="认领任务 pending→in_progress")
    cp.add_argument("task_id")
    sp2 = sub.add_parser("submit", help="提审 in_progress→in_review")
    sp2.add_argument("task_id")
    sp2.add_argument("--result", required=True)

    wsp = sub.add_parser("work-start", help="上报外部任务开始")
    wsp.add_argument("title")
    wsp.add_argument("--ref", help="来源渠道, 如 渠道:feishu")
    wsp.add_argument("--note")
    wup = sub.add_parser("work-update", help="上报进度(0-100, hub任务也适用)")
    wup.add_argument("work_id")
    wup.add_argument("progress", type=int)
    wup.add_argument("--note")
    wfp = sub.add_parser("work-finish", help="上报完成(状态自动回空闲)")
    wfp.add_argument("work_id")
    wfp.add_argument("--note")

    a = p.parse_args()

    if a.cmd == "ensure-identity":
        return cmd_ensure_identity(a)

    ident = load_identity()
    hub = Hub(ident["base_url"], ident["token"])

    if a.cmd == "beat":
        res = hub.call("POST", "/api/heartbeat", {"from_id": ident["agent_id"]})
        print(json.dumps(res, ensure_ascii=False))
        outbox_flush(hub) if outbox_len() else None
        return
    if a.cmd == "offline":
        print(json.dumps(hub.call("POST", "/api/offline/%s" % ident["agent_id"]), ensure_ascii=False))
        return
    if a.cmd == "flush":
        return outbox_flush(hub)
    if a.cmd == "msgs":
        res = hub.call("GET", "/api/messages/%s" % ident["agent_id"])
        msgs = ((res.get("data") or {}).get("messages")) or []
        for m in msgs:
            print("[%s] %s: %s" % (m.get("created_at", "")[:19], m.get("from_name"), m.get("content")))
        if not msgs:
            print("(无未读)")
        return
    if a.cmd in ("tasks", "works", "works-active"):
        if a.cmd == "tasks":
            q = "&status=" + a.status if a.status else ""
            res = hub.call("GET", "/api/tasks?project=%s%s" % (ident["project"], q))
            ts = ((res.get("data") or {}).get("tasks")) or (res.get("data") if isinstance(res.get("data"), list) else []) or []
            for t in ts:
                print("%s [%s] %s (assigned=%s)" % (t["id"][:8], t.get("status"), t.get("title"),
                                                     (t.get("assigned_id") or "-")[:8]))
            if not ts:
                print("(空)")
        else:
            res = hub.call("GET", "/api/agents/%s/work" % ident["agent_id"])
            ws = ((res.get("data") or {}).get("works")) or []
            if a.cmd == "works-active":
                ws = [w for w in ws if w.get("status") == "active"]
            for w in ws:
                print("%s [%s|%s] %d%% %s (hub_task=%s)" % (
                    w["id"][:8], w.get("source"), w.get("status"), w.get("progress", 0) or 0,
                    w.get("title"), (w.get("hub_task_id") or "-")[:8]))
            if not ws:
                print("(空)")
        return
    if a.cmd == "claim":
        res = hub.call("PUT", "/api/tasks/%s" % a.task_id, {"from_id": ident["agent_id"], "status": "in_progress"})
        print(json.dumps(res, ensure_ascii=False))
        return
    if a.cmd == "submit":
        res = hub.call("PUT", "/api/tasks/%s" % a.task_id,
                       {"from_id": ident["agent_id"], "status": "in_review", "result": a.result})
        print(json.dumps(res, ensure_ascii=False))
        return

    # work-* 三兄弟
    payload = {"from_id": ident["agent_id"]}
    if a.cmd == "work-start":
        payload.update({"title": a.title, "ref": a.ref, "note": a.note})
    elif a.cmd == "work-update":
        if not 0 <= a.progress <= 100:
            die("progress 必须在 0-100")
        payload.update({"work_id": a.work_id, "progress": a.progress, "note": a.note})
    elif a.cmd == "work-finish":
        payload.update({"work_id": a.work_id, "note": a.note})
    _do_work_op(hub, a.cmd, payload)


if __name__ == "__main__":
    main()
