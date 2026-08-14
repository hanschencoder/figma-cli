/**
 * Tool 注册表 —— 传输无关。
 *
 * MCP 和 CLI 只是两个前端，共用这里的定义：同一套参数 schema、同一套
 * 实现、同一套描述文本。CLI 的 --help 和 skill 文档都是从这里生成的，
 * 不会出现「文档说有这个参数、实现里没有」的漂移。
 *
 * 输出一律是**文本 DSL**而不是 JSON —— 同样的信息能省 5–10 倍 token。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IMAGE_REQUEST_TIMEOUT_MS,
  MAX_IMAGE_DIMENSION,
  Method,
  STATE_DIR,
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

export const DSL_LEGEND = `
输出是一种紧凑 DSL，每行一个节点，缩进表示层级：
  Frame "Card" #12:34  340x420  autoV gap=16 pad=20  fill=$surface/card  radius=8
字段含义：
  #12:34            节点 id，可直接传给其它命令
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

export interface ToolImage {
  path: string;
  mime: string;
  width: number;
  height: number;
  byteLength: number;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** 图像落盘后的信息。MCP 前端会额外内联 base64，CLI 前端只给路径。 */
  image?: ToolImage;
}

export interface ToolDef {
  /** 规范名，MCP 用这个 */
  name: string;
  /** CLI 子命令（短），CLI 也接受规范名 */
  cli: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  /** 可以按位置给出的参数名，依次对应 CLI 的位置参数 */
  positional?: string[];
  /** 最后一个位置参数是否可变长（收集成数组） */
  variadic?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolContext {
  hub: Hub;
  router: DocumentRouter;
}

const docIdArg = {
  docId: z
    .string()
    .optional()
    .describe('目标 Figma 文档。只连了一个文档时可省略；多文档时先用 docs 查看'),
};

function ok(text: string): ToolResult {
  return { text };
}

function failure(text: string): ToolResult {
  return { text, isError: true };
}

/** 把 BridgeError 转成对使用者可操作的文本，而不是抛成协议/进程错误。 */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
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

export function createTools(ctx: ToolContext): ToolDef[] {
  const { hub, router } = ctx;

  return [
    // ---------------------------------------------------------- 连接管理
    {
      name: 'list_documents',
      cli: 'docs',
      title: '列出已连接的 Figma 文档',
      description:
        '列出当前通过插件连接上来的所有 Figma 文档。' +
        '同时打开多个文档时，先用这个确认目标，再用 use 指定。',
      schema: {},
      run: async () =>
        guard(async () => {
          const docs = router.candidates();
          if (docs.length === 0) {
            return ok(
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
          return ok(`已连接 ${docs.length} 个文档（* 为当前目标）：\n${lines.join('\n')}`);
        }),
    },

    {
      name: 'select_document',
      cli: 'use',
      title: '指定后续操作的目标文档',
      description: '多文档同时连接时，指定后续命令默认作用于哪个文档。',
      schema: { docId: z.string().describe('docs 命令给出的 docId') },
      positional: ['docId'],
      run: async ({ docId }) =>
        guard(async () => {
          const doc = router.select(docId as string);
          return ok(`已切换到「${doc.name}」(${doc.docId})`);
        }),
    },

    // ---------------------------------------------------------- 定位与导航
    {
      name: 'get_current_context',
      cli: 'ctx',
      title: '获取当前 Figma 上下文',
      description:
        '读取文件名、页面列表、当前页和**当前选中的节点**。\n' +
        '这是所有设计稿相关任务的入口 —— 先跑这个搞清楚用户在看什么，再决定下一步。\n' +
        '节点部分的输出格式见 tree 的说明。',
      schema: {
        ...docIdArg,
        expandSelection: z.boolean().optional().describe('选中项额外展开一层子节点'),
      },
      run: async ({ docId, expandSelection }) =>
        guard(async () => {
          const target = router.resolve(docId as string | undefined);
          const { result } = await hub.request(target, Method.DocContext, {
            expandSelection: Boolean(expandSelection),
          });
          return ok(serializeContext(result, { detail: 'compact' }));
        }),
    },

    {
      name: 'get_node_tree',
      cli: 'tree',
      title: '读取节点结构树',
      description:
        '按层级读取设计稿结构，是「设计稿转代码」的主力命令。\n' +
        '不传 rootId 时读取当前选中项；没有选中项时读取当前页。\n' +
        'depth 默认 2，深层节点只给 id/name/type 并标注还有多少子节点，' +
        '需要时再指定 rootId 继续下钻 —— 不要一次性拉很深，会把上下文撑爆。\n' +
        '组件实例的内部结构默认不展开（那是设计系统的实现细节，展开会吃掉' +
        '绝大部分节点预算）；实例名 + props 通常就够了，要文案用 text 命令。\n\n' +
        DSL_LEGEND,
      schema: {
        ...docIdArg,
        rootId: z.string().optional().describe('起始节点 id，省略则用当前选中项'),
        depth: z.number().int().min(0).max(20).optional().describe('展开层数，默认 2'),
        includeHidden: z.boolean().optional().describe('包含隐藏图层'),
        expandInstances: z
          .boolean()
          .optional()
          .describe('展开组件实例内部。rootId 直接指向实例时总是展开'),
        maxNodes: z.number().int().min(1).max(3000).optional().describe('节点数上限，默认 400'),
      },
      positional: ['rootId'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.NodeTree, {
            rootId: args.rootId as string | undefined,
            depth: args.depth as number | undefined,
            includeHidden: args.includeHidden as boolean | undefined,
            expandInstances: args.expandInstances as boolean | undefined,
            maxNodes: args.maxNodes as number | undefined,
          });
          const body = serializeNodes(result.roots, { detail: 'compact' });
          const note = result.truncated
            ? `\n\n（已达节点上限 ${result.nodeCount}，输出被截断。缩小 depth 或对具体子节点单独取树）`
            : '';
          return ok(body + note);
        }),
    },

    {
      name: 'search_nodes',
      cli: 'find',
      title: '按名称或类型查找节点',
      description:
        '在页面里定位节点，避免把整棵树拉出来。query 和 types 至少给一个。\n' +
        '返回 id + 层级路径，拿到 id 后用 tree 或 node 继续。',
      schema: {
        ...docIdArg,
        query: z.string().optional().describe('图层名子串，大小写不敏感'),
        types: z
          .array(z.string())
          .optional()
          .describe('节点类型，逗号分隔，如 COMPONENT,INSTANCE,TEXT,FRAME'),
        pageId: z.string().optional().describe('限定页面，省略则搜当前页'),
        allPages: z.boolean().optional().describe('搜索全部页面（大文件较慢）'),
        limit: z.number().int().min(1).max(500).optional().describe('结果上限，默认 100'),
      },
      positional: ['query'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.NodeSearch, {
            query: args.query as string | undefined,
            types: args.types as string[] | undefined,
            pageId: args.pageId as string | undefined,
            allPages: args.allPages as boolean | undefined,
            limit: args.limit as number | undefined,
          });
          return ok(serializeMatches(result.matches, result.total));
        }),
    },

    // ---------------------------------------------------------- 读取细节
    {
      name: 'get_node_detail',
      cli: 'node',
      title: '读取节点完整属性',
      description:
        '拿单个或少量节点的全部属性：描边、阴影、约束、富文本分段、组件属性、' +
        '以及绑定变量的解析值（$name(值) 形式）。\n' +
        '适合在 tree 之后对关键节点做精读。输出格式见 tree。',
      schema: {
        ...docIdArg,
        ids: z.array(z.string()).min(1).describe('节点 id，可给多个'),
        withChildren: z.boolean().optional().describe('连带一层子节点'),
      },
      positional: ['ids'],
      variadic: true,
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.NodeDetail, {
            ids: args.ids as string[],
            withChildren: args.withChildren as boolean | undefined,
          });
          const body = serializeNodes(result.nodes, { detail: 'full' });
          const missing = result.missing?.length
            ? `\n\n找不到的 id: ${result.missing.join(', ')}`
            : '';
          return ok((body || '没有可显示的节点。') + missing);
        }),
    },

    {
      name: 'get_text_content',
      cli: 'text',
      title: '抽取子树全部文案',
      description:
        '一次性取出某个节点下所有文本图层的内容（含图层名）。\n' +
        '适合文案核对、i18n 提取，比读整棵树便宜得多；也是取组件实例内部文案的正确方式。',
      schema: {
        ...docIdArg,
        rootId: z.string().optional().describe('起始节点，省略则整页'),
        includeHidden: z.boolean().optional().describe('包含隐藏图层'),
        limit: z.number().int().min(1).max(2000).optional().describe('条数上限，默认 500'),
      },
      positional: ['rootId'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.NodeText, {
            rootId: args.rootId as string | undefined,
            includeHidden: args.includeHidden as boolean | undefined,
            limit: args.limit as number | undefined,
          });
          return ok(serializeTextItems(result.items, result.truncated ?? false));
        }),
    },

    {
      name: 'get_node_image',
      cli: 'image',
      title: '渲染节点为图片',
      description:
        '把节点导出成 PNG 落到本地并返回路径，用于确认视觉效果、' +
        '以及生成代码后对照还原度。\n' +
        `长边超过 ${MAX_IMAGE_DIMENSION}px 会自动降倍率 —— 更大的图不会提升识别效果，只会更慢。`,
      schema: {
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
      positional: ['id'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const id = args.id as string;
          const { result, data } = await hub.request(
            target,
            Method.NodeImage,
            {
              id,
              scale: args.scale as number | undefined,
              format: args.format as 'PNG' | 'JPG' | undefined,
              maxDimension: args.maxDimension as number | undefined,
            },
            { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS },
          );
          if (!data) return failure('插件没有回传图像数据');

          const path = saveExport(id, result.mime, data);
          if (!path) return failure('图像落盘失败，无法交付');

          return {
            text:
              `#${id} 导出成功  ${result.width}x${result.height}  ` +
              `scale=${result.scale}  ${(result.byteLength / 1024).toFixed(0)}KB\n${path}`,
            image: {
              path,
              mime: result.mime,
              width: result.width,
              height: result.height,
              byteLength: result.byteLength,
            },
          };
        }),
    },

    // ---------------------------------------------------------- 设计系统
    {
      name: 'get_variables',
      cli: 'vars',
      title: '导出设计变量',
      description:
        '导出本文件的变量集合与各 mode 的值，用于同步成代码里的 design token。\n' +
        '注意：只能拿到**本地**集合。如果 token 定义在独立的 Library 文件里，' +
        '需要在那个文件里运行插件；本文件中被引用的远端变量会在节点输出里以 $name 出现。\n' +
        '输出中 `→$other` 表示该变量别名指向另一个变量。',
      schema: {
        ...docIdArg,
        collectionId: z.string().optional().describe('只导出某个集合'),
        expand: z.boolean().optional().describe('展开变量明细，默认 true'),
        limit: z.number().int().min(1).max(5000).optional().describe('每集合变量上限，默认 800'),
      },
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.DsVariables, {
            collectionId: args.collectionId as string | undefined,
            expand: args.expand as boolean | undefined,
            limit: args.limit as number | undefined,
          });
          const note = result.truncated ? '\n\n（变量数量超过上限，已截断）' : '';
          return ok(serializeVariables(result.collections) + note);
        }),
    },

    {
      name: 'get_styles',
      cli: 'styles',
      title: '导出本地样式',
      description: '导出 Paint / Text / Effect / Grid 样式。节点输出里的 @name 就是这些样式。',
      schema: {
        ...docIdArg,
        type: z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']).optional().describe('只导出某一类'),
        limit: z.number().int().min(1).max(2000).optional().describe('上限，默认 400'),
      },
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.DsStyles, {
            type: args.type as 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID' | undefined,
            limit: args.limit as number | undefined,
          });
          const note = result.truncated ? '\n\n（样式数量超过上限，已截断）' : '';
          return ok(serializeStyles(result.styles) + note);
        }),
    },

    {
      name: 'get_components',
      cli: 'components',
      title: '列出组件与变体',
      description:
        '列出文件里的组件和组件集，含变体属性定义和描述。\n' +
        '用于了解可复用的 UI 单元，把设计稿里的实例对应到代码组件。',
      schema: {
        ...docIdArg,
        query: z.string().optional().describe('组件名子串过滤'),
        allPages: z.boolean().optional().describe('扫描全部页面，默认只扫当前页'),
        limit: z.number().int().min(1).max(1000).optional().describe('上限，默认 200'),
      },
      positional: ['query'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.DsComponents, {
            query: args.query as string | undefined,
            allPages: args.allPages as boolean | undefined,
            limit: args.limit as number | undefined,
          });
          return ok(serializeComponents(result.components, result.total));
        }),
    },
  ];
}

/**
 * 导出的图片落到 ~/.figma-mcp/exports/。
 *
 * 对 CLI 来说这不是"调试副本"而是唯一的交付方式 —— 命令行没法把图片
 * 直接塞给模型，只能给路径让它自己去读。
 */
function saveExport(nodeId: string, mime: string, data: Buffer): string | undefined {
  try {
    const dir = join(homedir(), STATE_DIR, 'exports');
    mkdirSync(dir, { recursive: true });
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const safeId = nodeId.replace(/[^\w-]/g, '_');
    const path = join(dir, `${safeId}-${Date.now()}.${ext}`);
    writeFileSync(path, data);
    return path;
  } catch (err) {
    log.error('图片落盘失败:', String(err));
    return undefined;
  }
}
