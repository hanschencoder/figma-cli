#!/usr/bin/env node
/**
 * MCP server 入口。
 *
 * 单进程同时承担两件事：
 *   - 对 AI 客户端：stdio 上的 MCP server
 *   - 对 Figma 插件：内嵌的 WS Hub（端口段 3055–3064）
 *
 * 之所以不拆独立 relay 守护进程，是因为目标场景是单 MCP 客户端。
 * 多个 Figma 文档并行由 Hub 的连接注册表解决，不需要额外进程。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOKEN_DIR } from '@figma-mcp/shared';
import { loadOrCreateAuth } from './auth.js';
import { Hub, SERVER_VERSION } from './hub.js';
import { log } from './logger.js';
import { DocumentRouter } from './router.js';
import { registerTools } from './tools/index.js';

async function main(): Promise<void> {
  const auth = loadOrCreateAuth();
  const hub = new Hub(auth);
  const port = await hub.start();

  if (auth.enabled) {
    log.info(`配对 token: ${auth.token}（也在 ${auth.tokenPath}）`);
  } else {
    log.warn('已通过 FIGMA_MCP_NO_AUTH=1 关闭配对校验');
  }

  advertisePort(port);

  const router = new DocumentRouter(hub);
  const server = new McpServer(
    { name: 'figma-mcp', version: SERVER_VERSION },
    {
      instructions:
        '通过 Figma 插件直接读取本地打开的设计文档，没有 REST API 的速率限制。\n' +
        '典型流程：get_current_context 看用户在做什么 → get_node_tree 读结构 → ' +
        '对关键节点 get_node_detail / get_node_image → 需要 design token 时 ' +
        'get_variables / get_styles。\n' +
        '前提是 Figma 桌面版开着且「Figma MCP Bridge」插件在运行；' +
        '报 NO_DOCUMENT 时提示用户去启动插件。',
    },
  );

  registerTools(server, { hub, router });

  const shutdown = (signal: string) => {
    log.info(`收到 ${signal}，退出中`);
    void hub.stop().finally(() => process.exit(0));
    // 兜底：优雅关闭卡住时也要退出，否则会变成占着端口的僵尸进程
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  log.info(`figma-mcp ${SERVER_VERSION} 已就绪（WS 端口 ${port}）`);
}

/**
 * 把实际绑定的端口写到 ~/.figma-mcp/last-port。
 * 插件自己会扫描端口段，这份文件是给人和调试脚本看的 ——
 * 端口降级后知道 server 到底落在哪个端口上。
 */
function advertisePort(port: number): void {
  try {
    const dir = join(homedir(), TOKEN_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'last-port'),
      `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
  } catch (err) {
    log.debug('写 last-port 失败（不影响主流程）:', String(err));
  }
}

main().catch((err) => {
  log.error('启动失败:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
