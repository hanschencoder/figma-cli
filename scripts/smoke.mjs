#!/usr/bin/env node
/**
 * 端到端冒烟：真 daemon + 假 Figma 插件。
 *
 * 不需要打开 Figma —— 用一个 WebSocket 客户端伪装成插件，喂合成数据，
 * 验证 CLI/HTTP → Hub → 插件 → YAML 序列化 这条链路是通的，
 * 顺便肉眼检查输出长什么样。
 *
 *   node scripts/smoke.mjs
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
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
  abs: [0, 0],
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
    { id: '12:39', name: 'actions', type: 'FRAME', w: 300, h: 40, childCount: 3, descendants: 47, truncated: true },
    // 图标：应折叠成一行 type: Icon
    {
      id: '12:40', name: '图标 / 收藏', type: 'INSTANCE', w: 24, h: 24, abs: [20, 300],
      component: { mainComponentName: '图标 / 收藏', remote: true },
      children: [
        { id: '12:41', name: 'Vector', type: 'VECTOR', w: 18, h: 18, x: 3, y: 3,
          fills: [{ kind: 'solid', color: '#1E1E1E', token: { name: 'color/text-primary' } }] },
      ],
    },
    // 系统控件：应折叠成一行 type: SystemInset
    {
      id: '12:50', name: 'StatusBar 状态栏', type: 'INSTANCE', w: 340, h: 34, abs: [0, 0],
      layout: { mode: 'HORIZONTAL', padding: [8, 20, 7, 20], primaryAlign: 'SPACE_BETWEEN' },
      component: { mainComponentName: 'StatusBar 状态栏', remote: true },
      children: [
        { id: '12:51', name: '时间', type: 'TEXT', w: 40, h: 20, text: { characters: '18:30' } },
        { id: '12:52', name: '右侧图标组', type: 'FRAME', w: 66, h: 22,
          children: [{ id: '12:53', name: 'wifi', type: 'VECTOR', w: 16, h: 12 }] },
      ],
    },
    // 未绑 token 的描边：文件含 Dark mode 时这是 error 级问题，且 grep 抓不到
    {
      id: '12:70', name: '环形进度提示', type: 'FRAME', w: 24, h: 24, abs: [300, 20],
      strokes: [{ kind: 'solid', color: '#000000', opacity: 0.15 }], strokeWeight: 2,
      children: [
        { id: '12:71', name: 'Arc', type: 'VECTOR', w: 20, h: 20,
          fills: [{ kind: 'solid', color: '#0A84FF', token: { name: 'color/brand' } }] },
      ],
    },
    // 位图填充的图标：VectorDrawable 表达不了，assets 必须标出来，
    // 否则下游只能一张张导出来看图才敢决定 SVG 还是 PNG
    {
      id: '12:80', name: '金币', type: 'FRAME', w: 42, h: 42, abs: [260, 300],
      children: [
        { id: '12:81', name: 'coin', type: 'RECTANGLE', w: 42, h: 42,
          fills: [{ kind: 'solid', color: '#d9d9d9' }, { kind: 'image', scaleMode: 'FILL' }] },
      ],
    },
    // 旋转的分隔线：size 是旋转前的，视觉上是竖线
    { id: '12:90', name: 'Line 4', type: 'LINE', w: 42, h: 0, abs: [170, 300], rotation: -90,
      strokes: [{ kind: 'solid', color: '#e5e5e5' }] },
    // 叠加填充：混合模式不写出来，下游只能假设 NORMAL 自己算最终色
    {
      id: '12:95', name: '今天', type: 'FRAME', w: 40, h: 20, abs: [220, 300],
      fills: [
        { kind: 'solid', color: '#FFBE0A', token: { name: '主题色/Yellow/Primary' } },
        { kind: 'solid', color: '#000000', opacity: 0.2, blendMode: 'MULTIPLY' },
      ],
    },
    // 结构同构的相邻兄弟：第一个完整展开，其余折叠成 sameAs
    {
      id: '12:60', name: 'list', type: 'FRAME', w: 300, h: 144, abs: [20, 360],
      layout: { mode: 'VERTICAL', gap: 8 },
      children: [row('12:61', '工作', 320), row('12:62', '旅游', 368), row('12:63', '理财', 416)],
    },
  ],
};

/** 三个结构完全相同、只有文案不同的列表行 */
function row(id, text, y) {
  return {
    id, name: '侧边栏', type: 'INSTANCE', w: 300, h: 40, abs: [20, y],
    layout: { mode: 'HORIZONTAL', gap: 12, padding: [8, 12, 8, 12], counterAlign: 'CENTER' },
    layoutChild: { sizingH: 'FILL', sizingV: 'HUG' },
    component: { mainComponentName: '侧边栏', remote: true },
    children: [
      { id: `I${id};1`, name: 'icon', type: 'INSTANCE', w: 24, h: 24,
        component: { mainComponentName: 'icon', remote: true },
        children: [{ id: `I${id};2`, name: 'Vector', type: 'VECTOR', w: 20, h: 20,
          fills: [{ kind: 'solid', color: '#1E1E1E', token: { name: 'color/text-primary' } }] }] },
      { id: `I${id};3`, name: 'label', type: 'TEXT', w: 240, h: 21,
        layoutChild: { sizingH: 'FILL' },
        text: { characters: text, fontSize: 14, fontFamily: 'Inter', fontStyle: 'Medium', lineHeight: '21px' },
        fills: [{ kind: 'solid', color: '#1E1E1E', token: { name: 'color/text-primary' } }] },
    ],
  };
}

/** 一张 1x1 的透明 PNG，用来验证分片与 image content 通路 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const TINY_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">\n' +
    '  <path d="M1 1h4v4H1z" fill="#1E1E1E"/>\n' +
    '  <path d="M8 8h4v4H8z" fill="red"/>\n' +
    '</svg>',
  'utf8',
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
  'node.tree': (params) =>
    params?.stat
      ? {
          roots: [],
          nodeCount: 0,
          origin: { id: '12:34', name: 'ProductCard' },
          stats: (CARD.children ?? []).map((c) => ({
            id: c.id, name: c.name, type: c.type,
            descendants: c.descendants ?? (c.children?.length ?? 0), depth: 2,
            ...(c.type === 'INSTANCE' ? { instance: true } : {}),
          })),
        }
      : { roots: [CARD], nodeCount: 6, origin: { id: '12:34', name: 'ProductCard' } },
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
    total: 5,
    truncated: true,
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

// ---------------------------------------------------------------- daemon HTTP 客户端

/**
 * 直连 daemon 的 HTTP /call，等价于 CLI 前端走的那条路。
 *
 * 为了让主流程沿用原来 `client.request('tools/call', {name, arguments})` 的写法，
 * 这里把结果包装成 { content:[{type:'text', text}], isError } —— 与 extractText 期望一致。
 */
function makeClient(port) {
  return {
    async callTool(tool, args = {}) {
      const res = await fetch(`http://localhost:${port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args }),
      });
      const body = await res.json();
      if (res.status !== 200) throw new Error(`/call ${tool} → HTTP ${res.status}: ${body.error ?? ''}`);
      return { content: [{ type: 'text', text: String(body.text ?? '') }], image: body.image, isError: body.ok === false };
    },
    // 兼容旧主流程：只认 tools/call
    request(method, params) {
      if (method === 'tools/call') return this.callTool(params.name, params.arguments ?? {});
      throw new Error(`smoke client 不支持 ${method}`);
    },
    /** /call 一个不存在的 tool，daemon 会回 available 列表 —— 用来数 tool 数量。 */
    async toolNames() {
      const res = await fetch(`http://localhost:${port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: '__nonexistent__', args: {} }),
      });
      return (await res.json()).available ?? [];
    },
  };
}

/** 轮询 /health 直到 daemon 起来。 */
async function waitForDaemon(port, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = await res.json();
      if (body.service === 'figma-cli') return body;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error('daemon 启动超时');
    await delay(200);
  }
}

// ---------------------------------------------------------------- 假插件

function connectFakePlugin(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/bridge`);
    const timer = setTimeout(() => reject(new Error('插件握手超时')), 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
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

      if (msg.method === 'node.exportPlan') {
        // 一个配了导出设置（SVG + @2x PNG）的图标，一个什么都没配的
        ws.send(JSON.stringify({
          type: 'res', id: msg.id, ok: true,
          result: {
            targets: [
              {
                id: '12:35', name: 'icon / search', type: 'FRAME', width: 24, height: 24,
                settings: [{ format: 'SVG' }, { format: 'PNG', scale: 2, suffix: '@2x' }],
                paints: [{ color: '#1e1e1e', token: 'color/text-primary' }],
              },
              // 同名图层：文件名必须自动去重，不能互相覆盖
              { id: '12:36', name: 'icon / search', type: 'FRAME', width: 24, height: 24, settings: [{ format: 'SVG' }] },
              // 没配导出设置：走默认 PNG @1x
              { id: '12:39', name: 'Plain Frame', type: 'FRAME', width: 48, height: 48, settings: [], hasText: true },
              // 实例内部节点：图层名没意义，文件名必须回退到主组件名（中文要保住）
              { id: 'I12:40;64:2356', name: 'Vector', type: 'VECTOR', width: 24, height: 24,
                component: '文件2', settings: [{ format: 'SVG' }],
                paints: [{ color: '#1e1e1e', token: 'color/text-primary' }, { color: '#ff0000' }] },
            ],
          },
        }));
        return;
      }

      if (msg.method === 'node.export') {
        const svg = msg.params.format === 'SVG';
        const payload = svg ? TINY_SVG : TINY_PNG;
        ws.send(JSON.stringify({
          type: 'chunk', id: msg.id, index: 0, total: 1, data: payload.toString('base64'),
        }));
        ws.send(JSON.stringify({
          type: 'res', id: msg.id, ok: true,
          result: {
            mime: svg ? 'image/svg+xml' : 'image/png',
            format: msg.params.format,
            width: 24, height: 24,
            scale: svg ? 1 : (msg.params.scale ?? 1),
            byteLength: payload.byteLength,
            chunkCount: 1,
          },
        }));
        return;
      }

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
          ? { type: 'res', id: msg.id, ok: true, result: make(msg.params) }
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
  const child = spawn('node', ['packages/server/dist/daemon-entry.js'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, FIGMA_CLI_LOG_LEVEL: 'warn', FIGMA_CLI_PORT: String(PORT) },
  });

  const client = makeClient(PORT);

  try {
    const health = await waitForDaemon(PORT);
    check('daemon 就绪', health.service === 'figma-cli', health.version);

    const toolNames = await client.toolNames();
    check('tool 注册表', toolNames.length === 15, `${toolNames.length} 个 tool`);

    // 目标文档不存在时应给出可操作的提示，而不是崩掉。
    // 不用「没有任何连接」来断言 —— Figma 开着时真实插件可能已经连上来了。
    const missing = await client.request('tools/call', {
      name: 'get_current_context',
      arguments: { docId: 'no-such-doc' },
    });
    check('未知 docId 报 NOT_FOUND', extractText(missing).includes('NOT_FOUND'));

    const ws = await connectFakePlugin(PORT);
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

    // ---- 输出压缩与防错（规格第 8 节的回归断言）
    const treeBody = extractText(
      await client.request('tools/call', { name: 'get_node_tree', arguments: { docId: DOC_ID } }),
    );
    check('tree 带 abs 绝对坐标', treeBody.includes('abs: [20, 300]'), '12:40');
    check('tree 标注 abs 原点', treeBody.includes('# abs 坐标原点：12:34'));
    check('more 带 descendants 计数', treeBody.includes('descendants: 47'));
    check(
      '图标折叠成一行 Icon',
      treeBody.includes('{type: Icon, name: 图标 / 收藏, id: "12:40"') &&
        !treeBody.includes('12:41'),
    );
    check(
      '系统控件折叠成一行',
      treeBody.includes('type: SystemInset') &&
        treeBody.includes('exportable: [{name: 右侧图标组, id: "12:52"') &&
        !treeBody.includes('12:53'),
    );
    check(
      '同构兄弟折叠成 sameAs',
      treeBody.includes('{sameAs: "12:61", id: "12:62"') &&
        treeBody.includes('diff: {text: 旅游}'),
    );
    check('折叠后每个原始 id 仍可检索', ['12:40', '12:50', '12:61', '12:62', '12:63'].every((id) => treeBody.includes(id)));

    const rawBody = extractText(
      await client.request('tools/call', {
        name: 'get_node_tree',
        arguments: { docId: DOC_ID, expandIcons: true, expandSystem: true, dedupe: false },
      }),
    );
    check(
      '关掉折叠后能看到原样',
      rawBody.includes('12:41') && rawBody.includes('12:53') && rawBody.length > treeBody.length,
      `${rawBody.split('\n').length} 行 → ${treeBody.split('\n').length} 行`,
    );

    const statBody = extractText(
      await client.request('tools/call', {
        name: 'get_node_tree',
        arguments: { docId: DOC_ID, stat: true },
      }),
    );
    check(
      '旋转节点给出视觉包围盒',
      treeBody.includes('rotate: -90') && treeBody.includes('visual: [0, 42]'),
    );
    check(
      '叠加填充带上混合模式',
      treeBody.includes('$主题色/Yellow/Primary + #000000@0.2(multiply)'),
    );
    check('--stat 只出结构统计', statBody.includes('descendants: 47') && !statBody.includes('AirPods'));

    const styleBody = extractText(
      await client.request('tools/call', { name: 'get_styles', arguments: { docId: DOC_ID } }),
    );
    check('styles 解析字重与行高', styleBody.includes('weight: 600') && styleBody.includes('lineHeight: 24'));
    check('styles 输出不含 auto', !styleBody.includes('auto'));

    const cssBody = extractText(
      await client.request('tools/call', {
        name: 'get_node_css',
        arguments: { docId: DOC_ID, id: '12:34' },
      }),
    );
    check(
      'css 机械翻译布局',
      cssBody.includes('flex-direction: column') &&
        cssBody.includes('gap: 16px') &&
        cssBody.includes('padding: 20px'),
    );
    check('css 保留 token 而不是字面值', cssBody.includes('var(--surface-card)'));

    const lintBody = extractText(
      await client.request('tools/call', {
        name: 'lint_design',
        arguments: { docId: DOC_ID, rootId: '12:34' },
      }),
    );
    check(
      'lint 抓到 grep 抓不到的描边裸色值',
      lintBody.includes('dark-mode-hazard') && lintBody.includes('12:70'),
    );
    check('lint 抓到未绑样式的裸字号', lintBody.includes('unbound-font'));
    check('lint 给出可读层级路径', lintBody.includes('path: ProductCard › '));

    const textBody = extractText(
      await client.request('tools/call', { name: 'get_text_content', arguments: { docId: DOC_ID } }),
    );
    check('text 截断时说清差了几条', textBody.includes('共 5 条，只出了 2 条'));

    const planBody = extractText(
      await client.request('tools/call', { name: 'plan_page', arguments: { docId: DOC_ID } }),
    );
    check(
      'plan 一次给全调研信息',
      ['target:', 'structure:', 'components:', 'tokens:', 'assets:', 'text:'].every((k) =>
        planBody.includes(k),
      ),
      `${planBody.split('\n').length} 行`,
    );
    check('plan 聚合组件复用信号', planBody.includes('{of: 侧边栏') && planBody.includes('count: 3'));
    check('plan 行数在预算内', planBody.split('\n').length <= 150);
    check(
      'plan 标出不可矢量化的切图',
      planBody.includes('kind: raster') && planBody.includes('vector: false') &&
        planBody.includes('why: image-fill'),
    );
    check('plan 标出可矢量化图标的形状数', planBody.includes('kind: glyph') && planBody.includes('shapes: 1'));
    // structure 段里状态栏折叠成一行是对的（那是「这里要留 inset」的信号）；
    // 但它不该再出现在 components / assets / text —— 那三段是「我要写哪些代码」
    const planTextLine = planBody.split('\n').find((line) => line.startsWith('text: ')) ?? '';
    check(
      'plan 不把状态栏内部件算进 components / text',
      !planBody.includes('{of: StatusBar') && !planTextLine.includes('18:30'),
      planTextLine,
    );
    if (process.env.SMOKE_SHOW_PLAN) console.log(indent(planBody));

    // CLI 前端走同一个 daemon 的 HTTP /call，验证两个前端结果一致。
    // 必须异步 —— 假插件就跑在本进程里，execFileSync 会把事件循环堵死，
    // 插件回不了消息，请求只能等到超时。
    const cli = async (args) => {
      const { stdout } = await run('node', ['packages/server/dist/cli.js', ...args], {
        env: { ...process.env, FIGMA_CLI_PORT: String(PORT) },
      });
      return stdout;
    };
    check('CLI docs', (await cli(['docs'])).includes('Smoke Test File'));
    check('CLI tree 与 HTTP /call 同源', (await cli(['tree', '--doc-id', DOC_ID])).includes('ProductCard'));
    check('CLI --help 不依赖 daemon', (await cli(['tree', '--help'])).includes('--expand-instances'));

    // 切图：--out 用相对路径，验证它是按 CLI 的 cwd 解析而不是 daemon 的
    const outA = mkdtempSync(join(tmpdir(), 'figma-smoke-'));
    const bySettings = await cli([
      'export', '12:35', '--recursive', '--out', relative(process.cwd(), outA), '--doc-id', DOC_ID,
    ]);
    check(
      'CLI export 默认按节点自带的导出设置切图',
      readdirSync(outA).sort().join(' ') ===
        'Plain-Frame.png icon-search-2.svg icon-search.svg icon-search@2x.png 文件2.svg',
      readdirSync(outA).sort().join(' '),
    );
    check('CLI export 同名图层自动去重', readdirSync(outA).includes('icon-search-2.svg'));
    check('CLI export 输出落在 CLI 的 cwd 下而不是 daemon 的', bySettings.includes(outA));

    const outB = mkdtempSync(join(tmpdir(), 'figma-smoke-'));
    await cli([
      'export', '12:35', '--format', 'PNG', '--scales', '1,2,3',
      '--out', relative(process.cwd(), outB), '--doc-id', DOC_ID,
    ]);
    check(
      'CLI export --format/--scales 覆盖设置',
      readdirSync(outB).sort().join(' ') ===
        'Plain-Frame.png Plain-Frame@2x.png Plain-Frame@3x.png ' +
        'icon-search-2.png icon-search-2@2x.png icon-search-2@3x.png ' +
        'icon-search.png icon-search@2x.png icon-search@3x.png ' +
        '文件2.png 文件2@2x.png 文件2@3x.png',
      readdirSync(outB).sort().join(' '),
    );

    const outC = mkdtempSync(join(tmpdir(), 'figma-smoke-'));
    await cli([
      'export', '12:35', '--recursive', '--format', 'SVG',
      '--out', relative(process.cwd(), outC), '--doc-id', DOC_ID,
    ]);
    check(
      'CLI export 文件名回退到主组件名（中文不被削掉）',
      readdirSync(outC).includes('文件2.svg'),
      readdirSync(outC).sort().join(' '),
    );

    const stdout = await cli([
      'export', '12:35', '--recursive', '--format', 'SVG', '--stdout', '--currentcolor',
      '--doc-id', DOC_ID,
    ]);
    check('CLI export --stdout 直接给出 SVG 源码', stdout.includes('svg: |') && stdout.includes('<path'));
    check(
      'CLI export --currentcolor 只换绑了 token 的颜色',
      stdout.includes('fill="currentColor"') && stdout.includes('fill="red"'),
    );
    check('CLI export --stdout 给出该设哪个 token', stdout.includes('token: $color/text-primary'));
    check('CLI export 对含文字的切图目标报警', bySettings.includes('含文本子节点'));

    const outD = mkdtempSync(join(tmpdir(), 'figma-smoke-'));
    await cli([
      'export', '12:39=ic_plain', '--format', 'SVG',
      '--out', relative(process.cwd(), outD), '--doc-id', DOC_ID,
    ]);
    check(
      'CLI export <id>=<名字> 直接定文件名（下划线不被削掉）',
      readdirSync(outD).includes('ic_plain.svg'),
      readdirSync(outD).sort().join(' '),
    );

    rmSync(outA, { recursive: true, force: true });
    rmSync(outB, { recursive: true, force: true });
    rmSync(outC, { recursive: true, force: true });
    rmSync(outD, { recursive: true, force: true });

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
