#!/usr/bin/env node
/**
 * MCP stdio 入口（可选前端）。
 *
 * 主推的用法是 `figma` CLI + skill —— MCP 的 tool 定义每个会话都常驻 context，
 * 用不用得上都得付这份开销。这个入口保留下来，是为了不能跑命令行的客户端，
 * 以及万一想换回去。
 *
 * 它复用同一个 daemon（Hub + tools + HTTP /call），所以启动 MCP server 的同时，
 * `figma` CLI 也能直接用这个进程，不会再多拉一个。
 */

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { startDaemon } from './daemon.js';
import { SERVER_VERSION } from './hub.js';
import { log } from './logger.js';
import { absolutizePathArgs, type ToolDef } from './tools/registry.js';

async function main(): Promise<void> {
  const daemon = await startDaemon();

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

  for (const tool of daemon.tools) register(server, tool);

  const shutdown = (signal: string) => {
    log.info(`收到 ${signal}，退出中`);
    void daemon.stop().finally(() => process.exit(0));
    // 优雅关闭卡住时也要退出，否则会变成占着端口的僵尸进程
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  log.info(`figma-mcp ${SERVER_VERSION} 已就绪（WS 端口 ${daemon.port}）`);
}

function register(server: McpServer, tool: ToolDef): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.schema },
    async (args: Record<string, unknown>) => {
      // 与 CLI 同理：相对路径按 MCP server 进程的 cwd 解析，不能留给 daemon
      const result = await tool.run(absolutizePathArgs(tool, args));
      const content: CallToolResult['content'] = [{ type: 'text', text: result.text }];

      // MCP 能直接内联图片，比 CLI 让模型自己去 Read 文件少一步
      if (result.image) {
        try {
          content.push({
            type: 'image',
            data: readFileSync(result.image.path).toString('base64'),
            mimeType: result.image.mime,
          });
        } catch (err) {
          log.warn('读取导出图片失败，仅返回路径:', String(err));
        }
      }

      return result.isError ? { content, isError: true } : { content };
    },
  );
}

main().catch((err) => {
  log.error('启动失败:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
