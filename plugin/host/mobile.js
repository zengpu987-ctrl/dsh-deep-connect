/**
 * Deep Connect — phone management over a QR code.
 *
 * The desktop panel is not reachable from a phone. This module starts a tiny
 * HTTP server inside the Host that serves one self-contained mobile page at
 * `/m/<token>/`, plus a JSON API behind the same token. The panel renders a QR
 * for that URL; scanning it with WeChat (or any camera) opens the page, and from
 * there the phone can watch devices, read task lists and send a command to any
 * machine on the station.
 *
 * Exposure rules:
 *   - The token is required in the path; without it every route is a 404.
 *   - The server binds 0.0.0.0 so a phone on the same Wi-Fi can reach it; when
 *     cloudflared is available a public tunnel is opened for it as well.
 *   - Nothing is served before the user switches phone access on.
 *
 * @module dsh-deep-connect/mobile
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** One mobile page, no external assets, works in WeChat's webview. */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Deep Connect 手机端</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f6f7f9;color:#1c1f23}
header{padding:14px 16px;background:#fff;border-bottom:1px solid #e6e8eb;display:flex;align-items:center;gap:8px}
header b{font-size:16px}
.dot{width:8px;height:8px;border-radius:99px;background:#1db954;display:inline-block}
main{padding:12px}
.card{background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:12px;margin-bottom:10px}
.card h3{margin:0 0 6px;font-size:14px}
.meta{color:#6b7280;font-size:12px}
.row{border-top:1px solid #f0f1f3;padding:8px 0}
.row:first-child{border-top:0}
.title{font-weight:500;word-break:break-word}
.chip{display:inline-block;margin:2px 4px 0 0;padding:1px 8px;border-radius:99px;background:#eef2ff;color:#3b5bdb;font-size:12px}
.task{color:#374151;font-size:13px;margin:2px 0 0}
.task.done{color:#9ca3af;text-decoration:line-through}
button{border:0;border-radius:10px;padding:8px 12px;font:inherit;background:#4d6bfe;color:#fff}
button.ghost{background:#eef1f5;color:#1c1f23}
input{width:100%;border:1px solid #d8dbe0;border-radius:10px;padding:9px 10px;font:inherit;margin:6px 0}
.send{display:flex;gap:8px;align-items:center}
.send input{flex:1}
.empty{color:#9ca3af;font-size:13px;padding:6px 0}
</style></head>
<body>
<header><span class="dot"></span><b>Deep Connect</b><span class="meta" id="who"></span></header>
<main>
  <div class="card"><h3>设备</h3><div id="devices"></div></div>
  <div class="card"><h3>任务 / 会话</h3><div id="sessions"></div></div>
  <div class="card"><h3>给设备发命令</h3>
    <div class="send"><input id="cmd" placeholder="例如：跑一下昨天那个统计"><button id="send">下发</button></div>
    <div class="meta" id="status"></div>
  </div>
</main>
<script>
const TOKEN = location.pathname.split('/')[2] || '';
const api = (q) => fetch('/m/' + TOKEN + '/api' + (q || '')).then((r) => r.json());
let devices = [];
let selected = '';
function esc(s){return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){
  try {
    const data = await api('?view=1');
    devices = data.devices || [];
    document.getElementById('who').textContent = data.self ? data.self.name : '';
    const dv = document.getElementById('devices');
    dv.innerHTML = devices.map((d) => '<div class="row" data-id="' + esc(d.deviceId) + '"><div class="title">' +
      (d.online ? '<span class="dot"></span> ' : '○ ') + esc(d.name) + '</div><div class="meta">' +
      (d.isSelf ? '本机' : (d.online ? '在线' : '离线')) + ' · ' + Number(d.sessionCount || 0) + ' 条会话' +
      (d.shareMemory === false ? ' · 未共享' : '') + '</div></div>').join('') || '<div class="empty">暂无设备</div>';
    dv.querySelectorAll('.row').forEach((row) => row.addEventListener('click', () => { selected = row.dataset.id; document.getElementById('status').textContent = '目标：' + (devices.find((d) => d.deviceId === selected) || {}).name; }));
    const ss = document.getElementById('sessions');
    const rows = (data.sessions || []).filter((s) => !selected || s.ownerId === selected).slice(0, 30);
    ss.innerHTML = rows.map((s) => {
      const tasks = (s.tasks && s.tasks.items) || [];
      return '<div class="row"><div class="title">' + esc(s.title || s.sessionId) + '</div><div class="meta">' + esc(s.ownerName || '') + ' · ' + Number(s.eventCount || 0) + ' 事件' +
        (s.live ? ' · 进行中' : '') + '</div>' + tasks.map((t) => '<div class="task ' + (t.status === 'done' ? 'done' : '') + '">• ' + esc(t.text) + '</div>').join('') + '</div>';
    }).join('') || '<div class="empty">暂无任务</div>';
  } catch (e) { document.getElementById('status').textContent = '连接失败：' + e.message; }
}
document.getElementById('send').addEventListener('click', async () => {
  const text = document.getElementById('cmd').value.trim();
  if (!text) return;
  const target = selected || (devices.find((d) => !d.isSelf && d.online) || {}).deviceId || '';
  if (!target) { document.getElementById('status').textContent = '没有在线的目标设备'; return; }
  document.getElementById('status').textContent = '下发中…';
  try {
    const r = await fetch('/m/' + TOKEN + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'task', deviceId: target, text }) });
    const out = await r.json();
    document.getElementById('status').textContent = out.ok ? '已下发，对方正在执行' : ('失败：' + (out.error || 'unknown'));
    document.getElementById('cmd').value = '';
  } catch (e) { document.getElementById('status').textContent = '下发失败：' + e.message; }
});
load();
setInterval(load, 3000);
</script>
</body></html>`;

/**
 * One phone-facing gateway. The Host owns list/command callbacks, so the page
 * always reflects this machine's merged view.
 */
export class MobileGateway {
  /**
   * @param {object} options - `{ token, onList, onCommand, log }`.
   */
  constructor(options = {}) {
    this.token = String(options.token ?? '') || randomUUID().replace(/-/g, '');
    this.onList = options.onList ?? (async () => ({}));
    this.onCommand = options.onCommand ?? (async () => ({ ok: false, error: 'unsupported' }));
    this.log = options.log ?? (() => {});
    this.server = undefined;
    this.port = 0;
    this.publicUrl = '';
    this.tunnel = undefined;
  }

  /** Start listening; returns the LAN origin. */
  async start() {
    if (this.server !== undefined) return this.origin;
    this.server = createServer((req, res) => {
      void this.#handle(req, res).catch((error) => {
        this.log('warn', `手机端请求失败：${error instanceof Error ? error.message : String(error)}`);
        try {
          res.statusCode = 500;
          res.end('internal error');
        } catch {
          /* already closed */
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    this.log('info', `手机管理页已启动：端口 ${this.port}`);
    return this.origin;
  }

  /** `http://127.0.0.1:<port>` — the page is shared through a LAN IP/tunnel. */
  get origin() {
    return this.port === 0 ? '' : `http://127.0.0.1:${this.port}`;
  }

  /** The URL encoded in the QR (public tunnel when present, else LAN). */
  link(lanAddress) {
    const base = this.publicUrl !== '' ? this.publicUrl : lanAddress;
    return base === '' ? '' : `${String(base).replace(/\/$/, '')}/m/${this.token}/`;
  }

  /** Adopt a public tunnel URL that already points at this port. */
  expose(publicUrl) {
    this.publicUrl = String(publicUrl ?? '').replace(/\/$/, '');
  }

  /** Route one request. Every path must carry the exact token. */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mobile');
    const prefix = `/m/${this.token}`;
    if (!url.pathname.startsWith(prefix)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    if (rest === '/' || rest === '') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(PAGE);
      return;
    }
    if (rest === '/api') {
      if (req.method === 'GET') {
        const view = await this.onList();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(view));
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          body = null;
        }
        const result = await this.onCommand(body ?? {});
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result));
        return;
      }
    }
    res.statusCode = 404;
    res.end('not found');
  }

  /** Stop listening (the tunnel is owned by the caller). */
  async stop() {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    this.publicUrl = '';
    if (server !== undefined) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

/** Read up to 64 KB of a request body. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
