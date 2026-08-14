#!/usr/bin/env node
/**
 * 端到端冒烟：真 MCP server + 假 Figma 插件。
 *
 * 不需要打开 Figma —— 用一个 WebSocket 客户端伪装成插件，喂合成数据，
 * 验证 stdio MCP → Hub → 插件 → DSL 序列化 这条链路是通的，
 * 顺便肉眼检查 DSL 输出长什么样。
 *
 *   node scripts/smoke.mjs
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const run = promisify(execFile);

const PROTOCOL = 1;
const DOC_ID = 'smoke-doc-1';

// ---------------------------------------------------------------- 合成数据

const CARD = {
  id: '12:34',
  name: 'ProductCard',
  type: 'FRAME',
  w: 340,
  h: 420,
  layout: { mode: 'VERTICAL', gap: 16, padding: [20, 20, 20, 20] },
  fills: [{ kind: 'solid', color: '#FFFFFF', token: { name: 'surface/card', value: '#FFFFFF' } }],
  cornerRadius: 12,
  effects: [
    {
      type: 'DROP_SHADOW',
      color: '#0000001a',
      offset: [0, 2],
      radius: 8,
      token: { name: 'elevation/1' },
    },
  ],
  children: [
    {
      id: '12:35',
      name: 'cover',
      type: 'RECTANGLE',
      w: 300,
      h: 180,
      cornerRadius: 8,
      fills: [{ kind: 'image', scaleMode: 'FILL' }],
    },
    {
      id: '12:36',
      name: 'info',
      type: 'FRAME',
      w: 300,
      h: 60,
      layout: { mode: 'VERTICAL', gap: 8 },
      layoutChild: { sizingH: 'FILL' },
      children: [
        {
          id: '12:37',
          name: 'title',
          type: 'TEXT',
          w: 300,
          h: 24,
          text: { characters: 'AirPods Pro', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontSize: 16, lineHeight: '24px' },
          styles: { text: { id: 'S:1', name: 'text/heading-sm' } },
          fills: [{ kind: 'solid', color: '#1E1E1E', token: { name: 'color/text-primary', value: '#1E1E1E' } }],
        },
        {
          id: '12:38',
          name: 'price',
          type: 'TEXT',
          w: 300,
          h: 20,
          text: { characters: '¥1,899', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 14, lineHeight: '20px' },
          fills: [{ kind: 'solid', color: '#0A84FF', token: { name: 'color/brand', value: '#0A84FF' } }],
        },
      ],
    },
    { id: '12:39', name: 'actions', type: 'FRAME', w: 300, h: 40, childCount: 3, truncated: true },
  ],
};

/** 一张 1x1 的透明 PNG，用来验证分片与 image content 通路 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const RESPONSES = {
  'doc.context': () => ({
    docId: DOC_ID,
    fileKey: 'smokeFileKey',
    name: 'Smoke Test File',
    editorType: 'figma',
    currentPage: { id: '0:1', name: 'Page 1' },
    pages: [{ id: '0:1', name: 'Page 1' }],
    selection: [{ ...CARD, children: undefined }],
  }),
  'node.tree': () => ({ roots: [CARD], nodeCount: 6 }),
  'node.detail': () => ({ nodes: [CARD] }),
  'node.search': () => ({
    matches: [
      { id: '12:34', name: 'ProductCard', type: 'FRAME', path: 'Page 1 / ProductCard', pageId: '0:1', pageName: 'Page 1' },
    ],
    total: 1,
  }),
  'node.text': () => ({
    items: [
      { id: '12:37', name: 'title', text: 'AirPods Pro' },
      { id: '12:38', name: 'price', text: '¥1,899' },
    ],
  }),
  'ds.variables': () => ({
    collections: [
      {
        id: 'VC:1',
        name: 'Primitives',
        modes: [{ id: 'm1', name: 'Light' }, { id: 'm2', name: 'Dark' }],
        defaultModeId: 'm1',
        variableCount: 2,
        variables: [
          {
            id: 'V:1',
            name: 'color/brand',
            type: 'COLOR',
            valuesByMode: { Light: { kind: 'raw', value: '#0A84FF' }, Dark: { kind: 'raw', value: '#409CFF' } },
          },
          {
            id: 'V:2',
            name: 'color/text-primary',
            type: 'COLOR',
            description: '正文主色',
            valuesByMode: { Light: { kind: 'alias', name: 'palette/gray-900', resolved: '#1E1E1E' }, Dark: { kind: 'raw', value: '#FFFFFF' } },
          },
        ],
      },
    ],
  }),
  'ds.styles': () => ({
    styles: [
      { id: 'S:1', name: 'text/heading-sm', type: 'TEXT', text: { characters: '', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontSize: 16, lineHeight: '24px' } },
      { id: 'S:2', name: 'surface/card', type: 'PAINT', paints: [{ kind: 'solid', color: '#FFFFFF' }] },
    ],
  }),
  'ds.components': () => ({
    components: [
      { id: '9:1', name: 'Button', type: 'COMPONENT_SET', variantProperties: { size: ['sm', 'md'], state: ['default', 'hover'] }, variantCount: 4, pageName: 'Page 1' },
    ],
    total: 1,
  }),
};

// ---------------------------------------------------------------- MCP 客户端

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
      if (pending) {
        this.#pending.delete(msg.id);
        msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.#nextId++;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error(`${method} 超时`)), 15000).unref?.();
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

// ---------------------------------------------------------------- 假插件

function connectFakePlugin(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/bridge`);
    const timer = setTimeout(() => reject(new Error('插件握手超时')), 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        token,
        doc: { docId: DOC_ID, fileKey: 'smokeFileKey', name: 'Smoke Test File', editorType: 'figma' },
        pluginVersion: 'smoke',
      }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'hello-ack') {
        clearTimeout(timer);
        msg.ok ? resolve(ws) : reject(new Error(`握手被拒: ${msg.error}`));
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        return;
      }

      if (msg.type !== 'req') return;

      if (msg.method === 'node.image') {
        const base64 = TINY_PNG.toString('base64');
        ws.send(JSON.stringify({ type: 'chunk', id: msg.id, index: 0, total: 1, data: base64 }));
        ws.send(JSON.stringify({
          type: 'res', id: msg.id, ok: true,
          result: { mime: 'image/png', width: 1, height: 1, scale: 1, byteLength: TINY_PNG.byteLength, chunkCount: 1 },
        }));
        return;
      }

      const make = RESPONSES[msg.method];
      ws.send(JSON.stringify(
        make
          ? { type: 'res', id: msg.id, ok: true, result: make() }
          : { type: 'res', id: msg.id, ok: false, error: { code: 'UNSUPPORTED', message: `假插件未实现 ${msg.method}` } },
      ));
    });

    ws.on('error', reject);
  });
}

// ---------------------------------------------------------------- 主流程

function extractText(result) {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : `<${c.type} ${c.mimeType ?? ''} ${c.data?.length ?? 0}B>`))
    .join('\n');
}

let failures = 0;

function check(name, ok, detail = '') {
  const mark = ok ? '  ✓' : '  ✗';
  if (!ok) failures++;
  console.log(`${mark} ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  // 固定端口，避免连到真实的常驻 daemon 上
  const PORT = 3064;
  const child = spawn('node', ['packages/server/dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FIGMA_MCP_LOG_LEVEL: 'warn', FIGMA_MCP_PORT: String(PORT) },
  });

  const client = new StdioClient(child);

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    client.notify('notifications/initialized', {});
    check('initialize', init.serverInfo?.name === 'figma-mcp', init.serverInfo?.version);

    const { tools } = await client.request('tools/list', {});
    check('tools/list', tools.length === 11, `${tools.length} 个 tool`);

    // 目标文档不存在时应给出可操作的提示，而不是崩掉。
    // 不用「没有任何连接」来断言 —— Figma 开着时真实插件可能已经连上来了。
    const missing = await client.request('tools/call', {
      name: 'get_current_context',
      arguments: { docId: 'no-such-doc' },
    });
    check('未知 docId 报 NOT_FOUND', extractText(missing).includes('NOT_FOUND'));

    const token = readFileSync(join(homedir(), '.figma-mcp', 'token'), 'utf8').trim();
    const ws = await connectFakePlugin(PORT, token);
    await delay(150);
    check('假插件握手成功', ws.readyState === WebSocket.OPEN);

    const docs = await client.request('tools/call', { name: 'list_documents', arguments: {} });
    check('list_documents', extractText(docs).includes('Smoke Test File'));

    const cases = [
      ['get_current_context', {}],
      ['get_node_tree', {}],
      ['get_node_detail', { ids: ['12:34'] }],
      ['search_nodes', { query: 'Card' }],
      ['get_text_content', {}],
      ['get_variables', {}],
      ['get_styles', {}],
      ['get_components', {}],
      ['get_node_image', { id: '12:34' }],
    ];

    // 必须显式锁定假文档：Figma 开着时真实插件的 watchdog 也会连上这个
    // server 实例，两个文档并存会让路由（正确地）拒绝猜测目标。
    for (const [name, args] of cases) {
      const res = await client.request('tools/call', {
        name,
        arguments: { ...args, docId: DOC_ID },
      });
      const body = extractText(res);
      check(name, !res.isError, `${body.length} 字符`);
      console.log(indent(body));
    }

    // CLI 前端走同一个 daemon 的 HTTP /call，验证两个前端结果一致。
    // 必须异步 —— 假插件就跑在本进程里，execFileSync 会把事件循环堵死，
    // 插件回不了消息，请求只能等到超时。
    const cli = async (args) => {
      const { stdout } = await run('node', ['packages/server/dist/cli.js', ...args], {
        env: { ...process.env, FIGMA_MCP_PORT: String(PORT) },
      });
      return stdout;
    };
    check('CLI docs', (await cli(['docs'])).includes('Smoke Test File'));
    check('CLI tree 与 MCP 同源', (await cli(['tree', '--doc-id', DOC_ID])).includes('ProductCard'));
    check('CLI --help 不依赖 daemon', (await cli(['tree', '--help'])).includes('--expand-instances'));

    ws.close();
  } finally {
    child.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

function indent(body) {
  return body
    .split('\n')
    .map((line) => `      │ ${line}`)
    .join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
