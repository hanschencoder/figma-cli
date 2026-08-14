/**
 * WS Hub —— server 侧与 Figma 插件通信的全部机制。
 *
 * 同一个端口上同时提供：
 *   GET /health   插件先探活再建 WS。比直接连 WS 试错快得多，
 *                 端口段扫描才不会在每个空端口上卡住 TCP 超时。
 *   WS  /bridge   实际的双向通道。
 *
 * 端口从 3055 起逐个尝试，占用则降级到 3064。manifest 里整段都放行了，
 * 所以换端口不需要重新 Import 插件。
 *
 * 每个端口会绑两次（127.0.0.1 和 ::1），共用同一个 WebSocketServer，
 * 这样插件连 localhost 时无论解析到哪个协议栈都能连上。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BIND_HOSTS,
  CHUNK_SIZE,
  CLIENT_HOST,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ErrorCode,
  HEALTH_PATH,
  Method,
  PORTS,
  PROTOCOL_VERSION,
  WS_PATH,
  type DocumentIdentity,
  type NodeInfo,
  type ParamsOf,
  type PluginToServerMessage,
  type ProtocolError,
  type ResultOf,
  type ServerToPluginMessage,
} from '@figma-cli/shared';
import { log } from './logger.js';

export const SERVER_VERSION = '0.1.0';

const HEARTBEAT_INTERVAL_MS = 20_000;
/** 超过这个时间没有任何消息（含 pong）就判定连接已死。 */
const HEARTBEAT_TIMEOUT_MS = 60_000;

export class BridgeError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = 'BridgeError';
  }
}

interface PendingRequest {
  resolve(value: { result: unknown; data?: Buffer }): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  /** 先于 res 到达的分片 */
  chunks: (string | undefined)[];
  chunksReceived: number;
}

export interface BridgeConnection {
  /** 内部连接 id（同一文档重连会换） */
  connId: string;
  doc: DocumentIdentity;
  connectedAt: number;
  lastSeenAt: number;
  pluginVersion: string;
  /** 由插件的 selectionchange 事件更新，仅用于 list_documents 展示 */
  selectionHint?: { count: number; names: string[] };
  currentPageName?: string;
}

interface Client extends BridgeConnection {
  socket: WebSocket;
  ready: boolean;
  pending: Map<string, PendingRequest>;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  body: string,
) => Promise<void> | void;

export class Hub {
  /** 同一端口上的多个监听（IPv4 / IPv6 回环），共用一个 WebSocketServer */
  private servers: Server[] = [];
  /** 上层注册的额外路由，键是 "METHOD /path" */
  private routes = new Map<string, RouteHandler>();
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  /** docId → client。同一文档重连时替换旧连接。 */
  private clients = new Map<string, Client>();
  private _port = 0;

  get port(): number {
    return this._port;
  }

  /** 注册额外 HTTP 路由。daemon 的 /call、/shutdown 走这里，Hub 本身不关心。 */
  addRoute(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  async start(): Promise<number> {
    const preferred = Number(process.env.FIGMA_CLI_PORT) || 0;
    const candidates = preferred
      ? [preferred, ...PORTS.filter((p) => p !== preferred)]
      : [...PORTS];

    const [primaryHost, ...extraHosts] = BIND_HOSTS;

    for (const port of candidates) {
      // 主协议栈绑不上就换端口；能绑上就认定这个端口归我们
      const primary = await this.tryListen(port, primaryHost!);
      if (!primary) continue;

      this.servers.push(primary);
      this._port = port;

      for (const host of extraHosts) {
        const extra = await this.tryListen(port, host);
        if (extra) this.servers.push(extra);
        else log.warn(`未能在 ${host}:${port} 上监听；若插件的 localhost 解析到该地址会连不上`);
      }
      break;
    }

    if (this.servers.length === 0) {
      throw new Error(
        `端口段 ${PORTS[0]}-${PORTS[PORTS.length - 1]} 全部被占用，无法启动 WS Hub`,
      );
    }

    // noServer 模式：多个监听共用一个 WebSocketServer，各自转交 upgrade
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));
    for (const server of this.servers) {
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    }

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();

    log.info(
      `WS Hub 就绪  ws://${CLIENT_HOST}:${this._port}${WS_PATH}` +
        `  (监听 ${this.servers.length} 个回环地址)`,
    );
    return this._port;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.values()) {
      client.socket.close(1001, 'server shutting down');
    }
    this.clients.clear();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            // 已建立的 keep-alive 连接会拖住 close，直接强制
            server.closeAllConnections?.();
          }),
      ),
    );
    this.servers = [];
  }

  listDocuments(): BridgeConnection[] {
    return [...this.clients.values()]
      .filter((c) => c.ready)
      .map(({ socket: _socket, pending: _pending, ready: _ready, ...rest }) => rest);
  }

  hasDocument(docId: string): boolean {
    return this.clients.get(docId)?.ready === true;
  }

  /** 向指定文档的插件发一个请求，等待响应。 */
  async request<M extends Method>(
    docId: string,
    method: M,
    params: ParamsOf<M>,
    opts: RequestOptions = {},
  ): Promise<{ result: ResultOf<M>; data?: Buffer }> {
    const client = this.clients.get(docId);
    if (!client || !client.ready || client.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError({
        code: ErrorCode.DISCONNECTED,
        message: `文档 ${docId} 的插件连接已断开，请确认 Figma 里插件仍在运行`,
      });
    }

    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(id);
        reject(
          new BridgeError({
            code: ErrorCode.TIMEOUT,
            message: `插件在 ${timeoutMs}ms 内未响应 ${method}。大文件上这可能是正常的，可以缩小 depth / limit 后重试`,
          }),
        );
      }, timeoutMs);
      timer.unref();

      client.pending.set(id, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
        timer,
        chunks: [],
        chunksReceived: 0,
      });

      this.send(client, { type: 'req', id, method, params });
    }) as Promise<{ result: ResultOf<M>; data?: Buffer }>;
  }

  // ------------------------------------------------------------ 内部

  /** 绑定失败返回 null（端口占用、协议栈不可用等），由调用方决定换端口还是跳过。 */
  private tryListen(port: number, host: string): Promise<Server | null> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.onHttp(req, res));
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        log.debug(`绑定 ${host}:${port} 失败（${err.code ?? err.message}）`);
        resolve(null);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH || !this.wss) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss!.emit('connection', ws, req);
    });
  }

  private onHttp(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    // 插件 iframe 的 origin 是 null，探活请求属于跨源，必须放行 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const path = (req.url ?? '').split('?')[0];

    const route = this.routes.get(`${req.method ?? 'GET'} ${path}`);
    if (route) {
      readBody(req)
        .then((body) => route(req, res, body))
        .catch((err) => {
          log.error('路由处理失败:', err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        });
      return;
    }

    if (path === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'figma-cli',
          version: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
          port: this._port,
          pid: process.pid,
          documents: this.listDocuments().map((d) => ({
            docId: d.doc.docId,
            name: d.doc.name,
          })),
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const connId = randomUUID();
    log.debug(`WS 连接建立 ${connId} from ${req.socket.remoteAddress}`);

    // 握手前的临时状态：只接受 hello
    let client: Client | undefined;

    const closeWith = (reason: string) => {
      this.sendRaw(socket, {
        type: 'hello-ack',
        ok: false,
        error: reason,
        serverVersion: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
      });
      setTimeout(() => socket.close(4001, reason), 50);
    };

    socket.on('message', (raw) => {
      let msg: PluginToServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as PluginToServerMessage;
      } catch {
        log.warn('收到无法解析的消息，忽略');
        return;
      }

      if (!client) {
        if (msg.type !== 'hello') {
          closeWith('握手前只接受 hello 消息');
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          closeWith(
            `协议版本不匹配：插件 ${msg.protocol} / server ${PROTOCOL_VERSION}。请重新构建并在 Figma 里重新 Import 插件`,
          );
          return;
        }
        client = {
          connId,
          socket,
          ready: true,
          pending: new Map(),
          doc: msg.doc,
          pluginVersion: msg.pluginVersion,
          connectedAt: Date.now(),
          lastSeenAt: Date.now(),
        };

        const previous = this.clients.get(msg.doc.docId);
        if (previous && previous.connId !== connId) {
          log.debug(`文档 ${msg.doc.name} 已有连接，替换旧连接 ${previous.connId}`);
          previous.socket.close(4000, 'replaced by newer connection');
          this.failAllPending(previous, '连接已被同文档的新连接替换');
        }
        this.clients.set(msg.doc.docId, client);

        this.sendRaw(socket, {
          type: 'hello-ack',
          ok: true,
          serverVersion: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
        });
        log.info(`插件已连接：${msg.doc.name} (${msg.doc.docId})`);
        return;
      }

      client.lastSeenAt = Date.now();
      this.handleMessage(client, msg);
    });

    socket.on('close', () => {
      if (!client) return;
      // 只有当注册表里还是这条连接时才移除，避免替换后误删新连接
      if (this.clients.get(client.doc.docId)?.connId === client.connId) {
        this.clients.delete(client.doc.docId);
        log.info(`插件已断开：${client.doc.name}`);
      }
      this.failAllPending(client, '插件连接已断开');
    });

    socket.on('error', (err) => log.warn('WS 错误:', String(err)));
  }

  private handleMessage(client: Client, msg: PluginToServerMessage): void {
    switch (msg.type) {
      case 'chunk': {
        const pending = client.pending.get(msg.id);
        if (!pending) return; // 请求已超时，丢弃
        if (pending.chunks[msg.index] === undefined) pending.chunksReceived++;
        pending.chunks[msg.index] = msg.data;
        return;
      }
      case 'res': {
        const pending = client.pending.get(msg.id);
        if (!pending) return;
        client.pending.delete(msg.id);
        clearTimeout(pending.timer);

        if (!msg.ok) {
          pending.reject(new BridgeError(msg.error));
          return;
        }

        const chunkCount = (msg.result as { chunkCount?: number } | null)?.chunkCount;
        if (typeof chunkCount === 'number' && chunkCount > 0) {
          if (pending.chunksReceived !== chunkCount) {
            pending.reject(
              new BridgeError({
                code: ErrorCode.INTERNAL,
                message: `分片不完整：期望 ${chunkCount} 片，实际收到 ${pending.chunksReceived} 片`,
              }),
            );
            return;
          }
          const base64 = pending.chunks.join('');
          pending.resolve({ result: msg.result, data: Buffer.from(base64, 'base64') });
          return;
        }

        pending.resolve({ result: msg.result });
        return;
      }
      case 'event': {
        this.handleEvent(client, msg.name, msg.payload);
        return;
      }
      case 'pong':
        return;
      case 'hello':
        // 重复 hello（插件重连但复用了 socket）—— 忽略，握手已完成
        return;
      default:
        log.debug('未知消息类型，忽略');
    }
  }

  private handleEvent(client: Client, name: string, payload: unknown): void {
    if (name === 'selectionchange') {
      const nodes = (payload as { selection?: NodeInfo[] } | null)?.selection ?? [];
      client.selectionHint = {
        count: nodes.length,
        names: nodes.slice(0, 5).map((n) => n.name),
      };
      return;
    }
    if (name === 'currentpagechange') {
      const page = (payload as { name?: string } | null)?.name;
      if (page) client.currentPageName = page;
    }
  }

  private failAllPending(client: Client, reason: string): void {
    for (const [, pending] of client.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError({ code: ErrorCode.DISCONNECTED, message: reason }));
    }
    client.pending.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (now - client.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        log.warn(`心跳超时，断开 ${client.doc.name}`);
        client.socket.terminate();
        continue;
      }
      this.send(client, { type: 'ping', t: now });
    }
  }

  private send(client: Client, msg: ServerToPluginMessage): void {
    this.sendRaw(client.socket, msg);
  }

  private sendRaw(socket: WebSocket, msg: ServerToPluginMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 供插件侧复用的分片大小（这里导出只是为了让 server 侧断言一致）。 */
export { CHUNK_SIZE };
