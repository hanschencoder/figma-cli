/**
 * Daemon —— 常驻进程，同时面向两侧：
 *   Figma 插件   ← WebSocket（Hub）
 *   figma-cli    ← HTTP POST /call
 *
 * 为什么必须有它：Figma 插件是 iframe，只能主动发起连接，做不了 server；
 * 而 CLI 是短命进程，等插件重新握手要好几秒。所以中间必须有个常驻的东西。
 * CLI 首次调用时会自动把它拉起来，之后一直复用。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { STATE_DIR } from '@figma-cli/shared';
import { Hub, SERVER_VERSION } from './hub.js';
import { log } from './logger.js';
import { DocumentRouter } from './router.js';
import { createTools, type ToolDef } from './tools/registry.js';

export const CALL_PATH = '/call';
export const SHUTDOWN_PATH = '/shutdown';

export interface Daemon {
  hub: Hub;
  tools: ToolDef[];
  port: number;
  stop(): Promise<void>;
}

export async function startDaemon(): Promise<Daemon> {
  const hub = new Hub();
  const port = await hub.start();
  const router = new DocumentRouter(hub);
  const tools = createTools({ hub, router });
  const byName = new Map(tools.flatMap((t) => [[t.name, t] as const, [t.cli, t] as const]));

  hub.addRoute('POST', CALL_PATH, async (_req, res, body) => {
    let payload: { tool?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }

    const tool = payload.tool ? byName.get(payload.tool) : undefined;
    if (!tool) {
      return json(res, 404, {
        ok: false,
        error: `未知命令 ${payload.tool}`,
        available: tools.map((t) => t.cli),
      });
    }

    const result = await tool.run(payload.args ?? {});
    return json(res, 200, {
      ok: !result.isError,
      text: result.text,
      image: result.image,
    });
  });

  hub.addRoute('POST', SHUTDOWN_PATH, async (_req, res) => {
    json(res, 200, { ok: true });
    log.info('收到关闭请求');
    // 先把响应发出去再退出
    setTimeout(() => void stop().finally(() => process.exit(0)), 50).unref();
  });

  advertise(port);

  const stop = async () => {
    await hub.stop();
    clearAdvertisement();
  };

  return { hub, tools, port, stop };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const advertisePath = () => join(homedir(), STATE_DIR, 'daemon.json');

/**
 * 把端口和 pid 落盘。CLI 优先读它，读不到再扫端口段 ——
 * 直接命中比扫 10 个端口快，也让 `figma-cli status` 能报出 pid。
 */
function advertise(port: number): void {
  try {
    mkdirSync(join(homedir(), STATE_DIR), { recursive: true });
    writeFileSync(
      advertisePath(),
      `${JSON.stringify({
        port,
        pid: process.pid,
        version: SERVER_VERSION,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch (err) {
    log.debug('写 daemon.json 失败（不影响主流程）:', String(err));
  }
}

function clearAdvertisement(): void {
  try {
    writeFileSync(advertisePath(), '');
  } catch {
    // 清不掉也无所谓，CLI 会用 /health 复核
  }
}
