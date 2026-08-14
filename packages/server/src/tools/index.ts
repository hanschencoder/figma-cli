/**
 * MCP tool 注册。
 *
 * 所有 tool 都返回**文本 DSL**而不是 JSON —— 同样的信息能省 5–10 倍 token。
 * DSL 的图例只在 get_node_tree 的描述里写一次，其它 tool 引用它，
 * 避免图例在 tools 列表里重复 N 遍。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  IMAGE_REQUEST_TIMEOUT_MS,
  MAX_IMAGE_DIMENSION,
  Method,
  TOKEN_DIR,
} from '@figma-mcp/shared';
import { BridgeError, type Hub } from '../hub.js';
import { log } from '../logger.js';
import type { DocumentRouter } from '../router.js';
import {
  serializeComponents,
  serializeContext,
  serializeMatches,
  serializeNodes,
  serializeStyles,
  serializeTextItems,
  serializeVariables,
} from '../dsl.js';

const DSL_LEGEND = `
输出是一种紧凑 DSL，每行一个节点，缩进表示层级：
  Frame "Card" #12:34  340x420  autoV gap=16 pad=20  fill=$surface/card  radius=8
字段含义：
  #12:34            节点 id，可直接传给其它 tool
  340x420           宽x高；@x,y 仅在非 Auto Layout 流内出现
  autoV / autoH     Auto Layout 方向；gap 间距；pad 内边距(CSS 顺序)
  w=fill / h=hug    该节点作为子元素的尺寸行为
  justify= / align= 主轴 / 交叉轴对齐
  $name             绑定的**变量**(variable)，生成代码时应映射为 design token
  @name             绑定的**样式**(style)，同样是设计系统引用
  fill= stroke= effect= radius= font=   外观属性
  → "Set/Variant"   实例指向的主组件；props{...} 是实例属性覆盖
关键：出现 $ 或 @ 时，生成的代码必须引用对应 token / 样式，不要硬编码字面值。
`.trim();

interface Ctx {
  hub: Hub;
  router: DocumentRouter;
}

const docIdArg = {
  docId: z
    .string()
    .optional()
    .describe('目标 Figma 文档。只连了一个文档时可省略；多文档时用 list_documents 查看'),
};

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 统一把 BridgeError 转成对模型友好的错误文本，而不是抛出去变成协议错误。 */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeError) {
      const { code, message, detail } = err.protocolError;
      const extra = detail ? `\n候选：${JSON.stringify(detail)}` : '';
      return failure(`[${code}] ${message}${extra}`);
    }
    log.error('tool 执行失败:', err);
    return failure(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { hub, router } = ctx;

  // ------------------------------------------------------------ 连接管理

  server.registerTool(
    'list_documents',
    {
      title: '列出已连接的 Figma 文档',
      description:
        '列出当前通过插件连接上来的所有 Figma 文档。' +
        '同时打开多个文档时，先用这个确认目标，再用 select_document 指定。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const docs = router.candidates();
        if (docs.length === 0) {
          return text(
            '没有任何 Figma 插件连接。\n' +
              '请在 Figma 桌面版打开设计文件，运行 Plugins → Development → Figma MCP Bridge，' +
              '等插件面板状态变为「已连接」后重试。',
          );
        }
        const active = router.active;
        const lines = docs.map((d) => {
          const mark = d.docId === active ? '* ' : '  ';
          const bits = [`${mark}${d.name}  docId=${d.docId}`];
          if (d.currentPage) bits.push(`page=${d.currentPage}`);
          if (d.selection) bits.push(`选中 ${d.selection} 个节点`);
          return bits.join('  ');
        });
        return text(`已连接 ${docs.length} 个文档（* 为当前目标）：\n${lines.join('\n')}`);
      }),
  );

  server.registerTool(
    'select_document',
    {
      title: '指定后续操作的目标文档',
      description: '多文档同时连接时，指定后续 tool 默认作用于哪个文档。',
      inputSchema: { docId: z.string().describe('list_documents 给出的 docId') },
    },
    async ({ docId }) =>
      guard(async () => {
        const doc = router.select(docId);
        return text(`已切换到「${doc.name}」(${doc.docId})`);
      }),
  );

  // ------------------------------------------------------------ 定位与导航

  server.registerTool(
    'get_current_context',
    {
      title: '获取当前 Figma 上下文',
      description:
        '读取文件名、页面列表、当前页和**当前选中的节点**。\n' +
        '这是所有设计稿相关任务的入口 —— 先调这个搞清楚用户在看什么，再决定下一步。\n' +
        '节点部分的输出格式见 get_node_tree 的说明。',
      inputSchema: {
        ...docIdArg,
        expandSelection: z
          .boolean()
          .optional()
          .describe('选中项额外展开一层子节点，默认 false'),
      },
    },
    async ({ docId, expandSelection }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.DocContext, {
          expandSelection: expandSelection ?? false,
        });
        return text(serializeContext(result, { detail: 'compact' }));
      }),
  );

  server.registerTool(
    'get_node_tree',
    {
      title: '读取节点结构树',
      description:
        '按层级读取设计稿结构，是「设计稿转代码」的主力 tool。\n' +
        '不传 rootId 时读取当前选中项；没有选中项时读取当前页。\n' +
        'depth 默认 2，深层节点只给 id/name/type 并标注还有多少子节点，' +
        '需要时再指定 rootId 继续下钻 —— 不要一次性拉很深，会把上下文撑爆。\n' +
        '组件实例的内部结构默认不展开（那是设计系统的实现细节，展开会吃掉' +
        '绝大部分节点预算）；实例名 + props 通常就够了，要文案用 get_text_content。\n\n' +
        DSL_LEGEND,
      inputSchema: {
        ...docIdArg,
        rootId: z.string().optional().describe('起始节点 id，省略则用当前选中项'),
        depth: z.number().int().min(0).max(20).optional().describe('展开层数，默认 2'),
        includeHidden: z.boolean().optional().describe('包含隐藏图层，默认 false'),
        expandInstances: z
          .boolean()
          .optional()
          .describe('展开组件实例内部，默认 false。rootId 直接指向实例时总是展开'),
        maxNodes: z.number().int().min(1).max(3000).optional().describe('节点数上限，默认 400'),
      },
    },
    async ({ docId, rootId, depth, includeHidden, expandInstances, maxNodes }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.NodeTree, {
          rootId,
          depth,
          includeHidden,
          expandInstances,
          maxNodes,
        });
        const body = serializeNodes(result.roots, { detail: 'compact' });
        const note = result.truncated
          ? `\n\n（已达节点上限 ${result.nodeCount}，输出被截断。缩小 depth 或对具体子节点单独取树）`
          : '';
        return text(body + note);
      }),
  );

  server.registerTool(
    'search_nodes',
    {
      title: '按名称或类型查找节点',
      description:
        '在页面里定位节点，避免把整棵树拉出来。query 和 types 至少给一个。\n' +
        '返回 id + 层级路径，拿到 id 后用 get_node_tree 或 get_node_detail 继续。',
      inputSchema: {
        ...docIdArg,
        query: z.string().optional().describe('图层名子串，大小写不敏感'),
        types: z
          .array(z.string())
          .optional()
          .describe('节点类型，如 ["COMPONENT","INSTANCE","TEXT","FRAME"]'),
        pageId: z.string().optional().describe('限定页面，省略则搜当前页'),
        allPages: z.boolean().optional().describe('搜索全部页面（大文件较慢）'),
        limit: z.number().int().min(1).max(500).optional().describe('结果上限，默认 100'),
      },
    },
    async ({ docId, query, types, pageId, allPages, limit }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.NodeSearch, {
          query,
          types,
          pageId,
          allPages,
          limit,
        });
        return text(serializeMatches(result.matches, result.total));
      }),
  );

  // ------------------------------------------------------------ 读取细节

  server.registerTool(
    'get_node_detail',
    {
      title: '读取节点完整属性',
      description:
        '拿单个或少量节点的全部属性：描边、阴影、约束、富文本分段、组件属性、' +
        '以及绑定变量的解析值（$name(值) 形式）。\n' +
        '适合在 get_node_tree 之后对关键节点做精读。输出格式见 get_node_tree。',
      inputSchema: {
        ...docIdArg,
        ids: z.array(z.string()).min(1).describe('节点 id 列表'),
        withChildren: z.boolean().optional().describe('连带一层子节点，默认 false'),
      },
    },
    async ({ docId, ids, withChildren }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.NodeDetail, {
          ids,
          withChildren,
        });
        const body = serializeNodes(result.nodes, { detail: 'full' });
        const missing = result.missing?.length
          ? `\n\n找不到的 id: ${result.missing.join(', ')}`
          : '';
        return text((body || '没有可显示的节点。') + missing);
      }),
  );

  server.registerTool(
    'get_text_content',
    {
      title: '抽取子树全部文案',
      description:
        '一次性取出某个节点下所有文本图层的内容（含图层名）。\n' +
        '适合文案核对、i18n 提取，比读整棵树便宜得多。',
      inputSchema: {
        ...docIdArg,
        rootId: z.string().optional().describe('起始节点，省略则整页'),
        includeHidden: z.boolean().optional().describe('包含隐藏图层，默认 false'),
        limit: z.number().int().min(1).max(2000).optional().describe('条数上限，默认 500'),
      },
    },
    async ({ docId, rootId, includeHidden, limit }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.NodeText, {
          rootId,
          includeHidden,
          limit,
        });
        return text(serializeTextItems(result.items, result.truncated ?? false));
      }),
  );

  server.registerTool(
    'get_node_image',
    {
      title: '渲染节点为图片',
      description:
        '把节点导出成图片直接看。用于确认视觉效果，以及生成代码后对照还原度。\n' +
        `长边超过 ${MAX_IMAGE_DIMENSION}px 会自动降倍率 —— 更大的图不会提升识别效果，只会更慢。`,
      inputSchema: {
        ...docIdArg,
        id: z.string().describe('要导出的节点 id'),
        scale: z.number().min(0.1).max(4).optional().describe('导出倍率，默认 1'),
        format: z.enum(['PNG', 'JPG']).optional().describe('默认 PNG'),
        maxDimension: z
          .number()
          .int()
          .min(64)
          .max(4096)
          .optional()
          .describe(`长边上限，默认 ${MAX_IMAGE_DIMENSION}`),
      },
    },
    async ({ docId, id, scale, format, maxDimension }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result, data } = await hub.request(
          target,
          Method.NodeImage,
          { id, scale, format, maxDimension },
          { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS },
        );
        if (!data) return failure('插件没有回传图像数据');

        const path = saveDebugCopy(id, result.mime, data);
        return {
          content: [
            {
              type: 'text',
              text:
                `#${id} 导出成功  ${result.width}x${result.height}  ` +
                `scale=${result.scale}  ${(result.byteLength / 1024).toFixed(0)}KB` +
                (path ? `\n本地副本: ${path}` : ''),
            },
            { type: 'image', data: data.toString('base64'), mimeType: result.mime },
          ],
        } satisfies CallToolResult;
      }),
  );

  // ------------------------------------------------------------ 设计系统

  server.registerTool(
    'get_variables',
    {
      title: '导出设计变量',
      description:
        '导出本文件的变量集合与各 mode 的值，用于同步成代码里的 design token。\n' +
        '注意：只能拿到**本地**集合。如果 token 定义在独立的 Library 文件里，' +
        '需要在那个文件里运行插件；本文件中被引用的远端变量会在节点输出里以 $name 出现。\n' +
        '输出中 `→$other` 表示该变量别名指向另一个变量。',
      inputSchema: {
        ...docIdArg,
        collectionId: z.string().optional().describe('只导出某个集合'),
        expand: z.boolean().optional().describe('展开变量明细，默认 true；false 只给集合摘要'),
        limit: z.number().int().min(1).max(5000).optional().describe('每个集合的变量上限，默认 800'),
      },
    },
    async ({ docId, collectionId, expand, limit }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.DsVariables, {
          collectionId,
          expand,
          limit,
        });
        const note = result.truncated ? '\n\n（变量数量超过上限，已截断）' : '';
        return text(serializeVariables(result.collections) + note);
      }),
  );

  server.registerTool(
    'get_styles',
    {
      title: '导出本地样式',
      description:
        '导出 Paint / Text / Effect / Grid 样式。节点输出里的 @name 就是这些样式。',
      inputSchema: {
        ...docIdArg,
        type: z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']).optional().describe('只导出某一类'),
        limit: z.number().int().min(1).max(2000).optional().describe('上限，默认 400'),
      },
    },
    async ({ docId, type, limit }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.DsStyles, { type, limit });
        const note = result.truncated ? '\n\n（样式数量超过上限，已截断）' : '';
        return text(serializeStyles(result.styles) + note);
      }),
  );

  server.registerTool(
    'get_components',
    {
      title: '列出组件与变体',
      description:
        '列出文件里的组件和组件集，含变体属性定义和描述。\n' +
        '用于了解可复用的 UI 单元，把设计稿里的实例对应到代码组件。',
      inputSchema: {
        ...docIdArg,
        query: z.string().optional().describe('组件名子串过滤'),
        allPages: z.boolean().optional().describe('扫描全部页面，默认只扫当前页'),
        limit: z.number().int().min(1).max(1000).optional().describe('上限，默认 200'),
      },
    },
    async ({ docId, query, allPages, limit }) =>
      guard(async () => {
        const target = router.resolve(docId);
        const { result } = await hub.request(target, Method.DsComponents, {
          query,
          allPages,
          limit,
        });
        return text(serializeComponents(result.components, result.total));
      }),
  );
}

/**
 * 把导出的图片同时落一份到本地，方便开发时肉眼核对模型「看到」的是什么。
 * 失败不影响主流程。
 */
function saveDebugCopy(nodeId: string, mime: string, data: Buffer): string | undefined {
  try {
    const dir = join(homedir(), TOKEN_DIR, 'exports');
    mkdirSync(dir, { recursive: true });
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const safeId = nodeId.replace(/[^\w-]/g, '_');
    const path = join(dir, `${safeId}-${Date.now()}.${ext}`);
    writeFileSync(path, data);
    return path;
  } catch (err) {
    log.debug('图片落盘失败（不影响主流程）:', String(err));
    return undefined;
  }
}
