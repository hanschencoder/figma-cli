/**
 * 插件 UI（iframe）—— 网络这一侧。
 *
 * 职责：
 *   1. 扫描端口段找到本机 MCP server（先 HTTP 探活再建 WS，避免在空端口上
 *      等 TCP 超时），连上所有活着的 server
 *   2. 断线后持续重连 —— 插件常常先于 server 打开，不能要求用户手动重启插件
 *   3. 把 server 的 req 转给沙箱，把沙箱的 res 转回**发起请求的那个** server
 *   4. 把沙箱编码好的 base64 载荷分片发出
 */

import {
  CHUNK_SIZE,
  CLIENT_HOST,
  HEALTH_PATH,
  PORTS,
  PROTOCOL_VERSION,
  WS_PATH,
  type ChunkMessage,
  type DocumentIdentity,
  type HelloAckMessage,
  type PluginToServerMessage,
  type ReqMessage,
  type ServerToPluginMessage,
} from '@figma-mcp/shared';
import type { SandboxToUi, UiToSandbox } from './bridge-types.js';

const PLUGIN_VERSION = '0.1.0';
const SCAN_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 800;

interface Conn {
  port: number;
  ws: WebSocket;
  ready: boolean;
}

const conns = new Map<number, Conn>();
/** requestId → 发起请求的连接。响应必须回到同一个 server。 */
const requestOrigin = new Map<string, Conn>();

let doc: DocumentIdentity | undefined;
let pageName = '—';
let token: string | null = null;
let authFailed = false;
let scanning = false;

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  dot: $('dot'),
  status: $('status'),
  file: $('file'),
  page: $('page'),
  server: $('server'),
  auth: $('auth'),
  tokenInput: $<HTMLInputElement>('tokenInput'),
  tokenSave: $('tokenSave'),
  log: $('log'),
  logBtn: $('logBtn'),
  reconnectBtn: $('reconnectBtn'),
};

function logLine(text: string, isError = false): void {
  const div = document.createElement('div');
  if (isError) div.className = 'err';
  div.textContent = `${new Date().toTimeString().slice(0, 8)} ${text}`;
  els.log.appendChild(div);
  while (els.log.childElementCount > 60) els.log.removeChild(els.log.firstChild!);
  els.log.scrollTop = els.log.scrollHeight;
}

function render(): void {
  const ready = [...conns.values()].filter((c) => c.ready);

  if (authFailed) {
    els.dot.className = 'dot err';
    els.status.textContent = 'TOKEN 无效';
  } else if (ready.length > 0) {
    els.dot.className = 'dot ok';
    els.status.textContent = '已连接';
  } else if (conns.size > 0) {
    els.dot.className = 'dot warn';
    els.status.textContent = '连接中';
  } else {
    els.dot.className = 'dot';
    els.status.textContent = '等待 SERVER';
  }

  els.file.textContent = doc?.name ?? '—';
  els.page.textContent = pageName;
  els.server.textContent =
    ready.length > 0 ? ready.map((c) => `:${c.port}`).join(' ') : '未连接';
  els.auth.classList.toggle('hidden', !authFailed);
}

els.logBtn.onclick = () => els.log.classList.toggle('hidden');
els.reconnectBtn.onclick = () => {
  logLine('手动重连');
  authFailed = false;
  for (const conn of conns.values()) conn.ws.close();
  conns.clear();
  render();
  void scan();
};
els.tokenSave.onclick = () => {
  const value = els.tokenInput.value.trim();
  if (!value) return;
  token = value;
  authFailed = false;
  post({ kind: 'set-token', token: value });
  els.tokenInput.value = '';
  logLine('token 已保存，重新连接');
  for (const conn of conns.values()) conn.ws.close();
  conns.clear();
  render();
  void scan();
};

// ------------------------------------------------------- 沙箱通信

function post(msg: UiToSandbox): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

window.onmessage = (event: MessageEvent) => {
  const msg = (event.data as { pluginMessage?: SandboxToUi }).pluginMessage;
  if (!msg) return;

  switch (msg.kind) {
    case 'doc':
      doc = msg.doc;
      pageName = msg.page.name;
      render();
      // 文档身份是握手的前提，拿到后才开始扫描
      void scan();
      return;

    case 'token':
      token = msg.token;
      return;

    case 'res': {
      const conn = requestOrigin.get(msg.id);
      requestOrigin.delete(msg.id);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

      if (!msg.ok) {
        send(conn, { type: 'res', id: msg.id, ok: false, error: msg.error });
        return;
      }

      if (msg.base64) {
        const chunks = splitChunks(msg.base64);
        for (let i = 0; i < chunks.length; i++) {
          const chunk: ChunkMessage = {
            type: 'chunk',
            id: msg.id,
            index: i,
            total: chunks.length,
            data: chunks[i]!,
          };
          send(conn, chunk);
        }
        send(conn, {
          type: 'res',
          id: msg.id,
          ok: true,
          result: { ...(msg.result as object), chunkCount: chunks.length },
        });
        return;
      }

      send(conn, { type: 'res', id: msg.id, ok: true, result: msg.result });
      return;
    }

    case 'event': {
      if (msg.name === 'currentpagechange') {
        pageName = (msg.payload as { name?: string })?.name ?? pageName;
        render();
      }
      for (const conn of conns.values()) {
        if (conn.ready) send(conn, { type: 'event', name: msg.name, payload: msg.payload });
      }
      return;
    }

    case 'log':
      logLine(msg.text, msg.level === 'error');
      return;
  }
};

// ------------------------------------------------------- 端口扫描与连接

type ProbeResult = { ok: true } | { ok: false; reason: string };

async function probe(port: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${CLIENT_HOST}:${port}${HEALTH_PATH}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const body = (await res.json()) as { service?: string; protocol?: number };
    if (body.service !== 'figma-mcp') return { ok: false, reason: '端口被其它服务占用' };
    if (body.protocol !== PROTOCOL_VERSION) {
      return { ok: false, reason: `协议版本 ${body.protocol} ≠ ${PROTOCOL_VERSION}，需重新构建` };
    }
    return { ok: true };
  } catch (err) {
    // 连接被拒和被 CSP 拦截在 Chromium 里都是 "Failed to fetch"，区分不了，
    // 但把原文带出来至少能看出是不是超时
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 扫描结果只在**发生变化时**记一行日志。
 * 每 5 秒刷屏一次会把日志面板冲垮，而一直静默又让人分不清
 * 「server 没起」和「插件挂了」。
 */
let lastScanReport = '';

async function scan(): Promise<void> {
  if (scanning || !doc || authFailed) return;
  scanning = true;
  try {
    const results = await Promise.all(
      PORTS.map(async (port) =>
        conns.has(port) ? ({ ok: false, reason: 'already connected' } as ProbeResult) : probe(port),
      ),
    );

    let found = 0;
    PORTS.forEach((port, i) => {
      if (results[i]!.ok) {
        found++;
        connect(port);
      }
    });

    if (found === 0 && conns.size === 0) {
      // 汇总出现过的失败原因，去重
      const reasons = [
        ...new Set(results.map((r) => (r.ok ? '' : r.reason)).filter(Boolean)),
      ];
      const notable = reasons.filter((r) => !/Failed to fetch|NetworkError|aborted/i.test(r));
      const report =
        notable.length > 0
          ? `扫描 ${PORTS[0]}-${PORTS[PORTS.length - 1]}：${notable.join('; ')}`
          : `扫描 ${PORTS[0]}-${PORTS[PORTS.length - 1]} 无响应 —— MCP server 未启动？` +
            `（它由 MCP 客户端拉起；单独调试可跑 npm run server）`;
      if (report !== lastScanReport) {
        lastScanReport = report;
        logLine(report);
      }
    } else if (found > 0) {
      lastScanReport = '';
    }
  } finally {
    scanning = false;
    render();
  }
}

function connect(port: number): void {
  if (conns.has(port) || !doc) return;

  const ws = new WebSocket(`ws://${CLIENT_HOST}:${port}${WS_PATH}`);
  const conn: Conn = { port, ws, ready: false };
  conns.set(port, conn);
  render();

  ws.onopen = () => {
    send(conn, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: token ?? undefined,
      doc: doc!,
      pluginVersion: PLUGIN_VERSION,
    });
  };

  ws.onmessage = (event) => {
    let msg: ServerToPluginMessage;
    try {
      msg = JSON.parse(String(event.data)) as ServerToPluginMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello-ack':
        onHelloAck(conn, msg);
        return;
      case 'req':
        onReq(conn, msg);
        return;
      case 'ping':
        send(conn, { type: 'pong', t: msg.t });
        return;
    }
  };

  ws.onclose = () => {
    conns.delete(port);
    // 清掉这条连接上还没回复的请求，避免 requestOrigin 泄漏
    for (const [id, origin] of requestOrigin) {
      if (origin === conn) requestOrigin.delete(id);
    }
    if (conn.ready) logLine(`:${port} 断开`);
    render();
  };

  ws.onerror = () => {
    /* onclose 会紧随其后，这里不重复处理 */
  };
}

function onHelloAck(conn: Conn, msg: HelloAckMessage): void {
  if (!msg.ok) {
    logLine(`:${conn.port} 握手失败 — ${msg.error ?? '未知原因'}`, true);
    if (msg.error?.includes('token')) authFailed = true;
    conn.ws.close();
    render();
    return;
  }
  conn.ready = true;
  logLine(`:${conn.port} 已连接 (server ${msg.serverVersion})`);
  render();
}

function onReq(conn: Conn, msg: ReqMessage): void {
  requestOrigin.set(msg.id, conn);
  post({ kind: 'req', id: msg.id, method: msg.method, params: msg.params });
}

function send(conn: Conn, msg: PluginToServerMessage): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  conn.ws.send(JSON.stringify(msg));
}

// ------------------------------------------------------- 工具

function splitChunks(base64: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    out.push(base64.slice(i, i + CHUNK_SIZE));
  }
  return out.length > 0 ? out : [''];
}

// ------------------------------------------------------- 启动

post({ kind: 'ui-ready' });
post({ kind: 'get-token' });
render();
// 插件常常先于 server 打开，watchdog 持续探测，不需要用户手动重启插件
setInterval(() => void scan(), SCAN_INTERVAL_MS);
