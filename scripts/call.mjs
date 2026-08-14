#!/usr/bin/env node
/**
 * 对**真实 Figma 文档**调用 tool 的调试入口。
 *
 * 自己起一个 server 实例（会落在端口段里的空位），等插件的 watchdog 扫到并
 * 连上来，然后依次执行指定的 tool 并打印结果。用来在不接 AI 客户端的情况下
 * 看真实设计稿上的输出长什么样。
 *
 *   node scripts/call.mjs get_current_context
 *   node scripts/call.mjs 'get_node_tree={"depth":3}' get_variables
 *
 * 参数形式：`tool` 或 `tool={json 参数}`。
 */

import { spawn } from 'node:child_process';

const WAIT_PLUGIN_MS = 40_000;

class StdioClient {
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;

  constructor(child) {
    this.#child = child;
    child.stdout.on('data', (chunk) => this.#onData(chunk));
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.#pending.get(msg.id);
      if (!pending) continue;
      this.#pending.delete(msg.id);
      msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs = 90_000) {
    const id = this.#nextId++;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} 超时`));
      }, timeoutMs).unref?.();
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

function render(result) {
  return (result.content ?? [])
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') {
        return `<image ${c.mimeType} ${(c.data.length * 0.75 / 1024).toFixed(0)}KB base64 已省略>`;
      }
      return `<${c.type}>`;
    })
    .join('\n');
}

function parseArg(arg) {
  const eq = arg.indexOf('=');
  if (eq < 0) return { name: arg, args: {} };
  return { name: arg.slice(0, eq), args: JSON.parse(arg.slice(eq + 1)) };
}

async function main() {
  const calls = process.argv.slice(2).map(parseArg);
  if (calls.length === 0) {
    console.error('用法: node scripts/call.mjs <tool>[={json}] ...');
    process.exit(2);
  }

  const child = spawn('node', ['packages/server/dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FIGMA_MCP_LOG_LEVEL: 'warn' },
  });
  const client = new StdioClient(child);

  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'call', version: '0' },
    });
    client.notify('notifications/initialized', {});

    // 插件每 5 秒扫一次端口段，等它发现这个新实例
    const deadline = Date.now() + WAIT_PLUGIN_MS;
    let docs = '';
    process.stderr.write('等待 Figma 插件连接');
    for (;;) {
      const res = await client.request('tools/call', { name: 'list_documents', arguments: {} });
      docs = render(res);
      if (!docs.includes('没有任何 Figma 插件连接')) break;
      if (Date.now() > deadline) {
        process.stderr.write('\n');
        throw new Error('插件一直没有连上来。确认 Figma 里插件在运行，必要时点面板的「重连」');
      }
      process.stderr.write('.');
      await new Promise((r) => setTimeout(r, 1500));
    }
    process.stderr.write('\n');
    console.log(`${docs}\n`);

    for (const call of calls) {
      const started = Date.now();
      const res = await client.request('tools/call', { name: call.name, arguments: call.args });
      const body = render(res);
      console.log('='.repeat(72));
      console.log(
        `${call.name}${Object.keys(call.args).length ? ` ${JSON.stringify(call.args)}` : ''}` +
          `   ${Date.now() - started}ms  ${body.length} 字符${res.isError ? '  [错误]' : ''}`,
      );
      console.log('='.repeat(72));
      console.log(body);
      console.log();
    }
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
