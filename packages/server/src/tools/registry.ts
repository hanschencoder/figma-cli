/**
 * Tool 注册表 —— 传输无关。
 *
 * MCP 和 CLI 只是两个前端，共用这里的定义：同一套参数 schema、同一套
 * 实现、同一套描述文本。CLI 的 --help 和 skill 文档都是从这里生成的，
 * 不会出现「文档说有这个参数、实现里没有」的漂移。
 *
 * 输出一律是 **YAML**，字段无意义时一律省略 —— 上下文预算是第一约束。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  IMAGE_REQUEST_TIMEOUT_MS,
  MAX_IMAGE_DIMENSION,
  Method,
  STATE_DIR,
  type ExportFormat,
  type ExportSpec,
  type ExportTarget,
  type NodeExportPlanResult,
  type NodeExportResult,
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
  yamlOf,
  type Entry,
} from '../yaml.js';

export const OUTPUT_LEGEND = `
输出是 YAML。节点的字段（无意义时一律省略）：
  type / name / id      节点类型、图层名、节点 id，id 可直接传给其它命令
  size: [w, h]          宽高；pos: [x, y] 仅在非 Auto Layout 流内出现
  layout: {mode, gap, padding, justify, align}   自身的 Auto Layout
  sizing: {w, h}        作为子元素的尺寸行为，fill / hug / fixed
  fill / color / stroke / effect / radius / font   外观
  component: {of, props}   实例指向的主组件与属性覆盖
  bind: {...}           节点属性绑定到变量（width、itemSpacing…）
  more: true            还有子节点没展开，用这一行的 id 单独取树即可
  children              子节点，同样的结构
值里的两个记号：
  $name   绑定的**变量**(variable)，生成代码时应映射为 design token
  @name   绑定的**样式**(style)，同样是设计系统引用
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
  /**
   * 值是文件路径的参数名。
   *
   * tool 跑在 daemon 里，daemon 的 cwd 是它被拉起来时那个目录，跟用户此刻在哪
   * 毫无关系。所以相对路径必须由**前端**（CLI / MCP）在自己的进程里解析成绝对
   * 路径再发出去，见 absolutizePathArgs。
   */
  pathArgs?: string[];
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

/** 前端调用：把 pathArgs 里的相对路径按**当前进程**的 cwd 解析成绝对路径。 */
export function absolutizePathArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!tool.pathArgs?.length) return args;
  const out = { ...args };
  for (const key of tool.pathArgs) {
    const value = out[key];
    if (typeof value === 'string' && value && !isAbsolute(value)) {
      out[key] = resolve(process.cwd(), value);
    }
  }
  return out;
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

/**
 * 附注写成 YAML 注释。
 *
 * 「已截断」「找不到这些 id」这类信息不属于数据本身，但模型必须看到。
 * 包成注释：输出整体仍是一份能解析的 YAML，注释行照样在模型眼里。
 * 比把整棵树套进 `nodes:` 再加个兄弟字段便宜 —— 那要给每一行多加一级缩进。
 */
function note(text: string): string {
  return `\n# ${text}`;
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
      return failure(
        yamlOf([
          ['error', code],
          ['message', message],
          ...(detail ? ([['candidates', JSON.stringify(detail)]] as [string, string][]) : []),
        ]),
      );
    }
    log.error('tool 执行失败:', err);
    return failure(
      yamlOf([
        ['error', 'INTERNAL'],
        ['message', err instanceof Error ? err.message : String(err)],
      ]),
    );
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
              yamlOf([
                ['documents', []],
                [
                  'hint',
                  '没有任何 Figma 插件连接。请在 Figma 桌面版打开设计文件，运行 ' +
                    'Plugins → Development → Figma MCP Bridge，等插件面板显示「已连接」后重试',
                ],
              ]),
            );
          }
          const active = router.active;
          return ok(
            yamlOf([
              [
                'documents',
                docs.map((d) => {
                  const fields: [string, string | number | boolean][] = [
                    ['name', d.name],
                    ['docId', d.docId],
                  ];
                  if (d.currentPage) fields.push(['page', d.currentPage]);
                  if (d.selection) fields.push(['selection', d.selection]);
                  if (d.plugin) fields.push(['plugin', d.plugin]);
                  if (d.docId === active) fields.push(['active', true]);
                  return fields;
                }),
              ],
            ]),
          );
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
          return ok(
            yamlOf([
              ['selected', doc.name],
              ['docId', doc.docId],
            ]),
          );
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
        OUTPUT_LEGEND,
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
          return ok(
            result.truncated
              ? body +
                  note(
                    `已达节点上限 ${result.nodeCount}，输出被截断。` +
                      '缩小 depth，或对具体子节点单独取树',
                  )
              : body,
          );
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
          return ok(
            result.missing?.length
              ? body + note(`找不到这些 id：${result.missing.join(', ')}`)
              : body,
          );
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
            text: yamlOf([
              ['id', id],
              ['path', path],
              ['size', [result.width, result.height]],
              ['scale', result.scale],
              ['kb', Math.round(result.byteLength / 1024)],
            ]),
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

    {
      name: 'export_assets',
      cli: 'export',
      title: '切图导出',
      description:
        '把节点导出成可以直接进项目的资源文件：PNG / JPG / SVG / PDF，支持多倍率。\n' +
        '与 get_node_image 的区别：那个是**给模型看**的截图（有长边上限、落在临时目录），' +
        '这个是**给工程用**的切图（原始尺寸、按图层名命名、落到 --out 指定的目录）。\n' +
        '不指定 --format 时，优先按设计师在 Figma 里配好的导出设置来 —— ' +
        '格式、倍率、文件名后缀都听设计稿的。\n' +
        '典型用法：\n' +
        '  export 12:34 --format SVG --out ./src/assets/icons\n' +
        '  export 12:34 --format PNG --scales 1,2,3 --out ./assets\n' +
        '  export 8:12 --recursive --out ./assets   # 一个 Frame 下配了导出设置的图标全切出来',
      schema: {
        ...docIdArg,
        ids: z.array(z.string()).min(1).describe('要导出的节点 id，可给多个'),
        out: z
          .string()
          .default('figma-exports')
          .describe('输出目录，相对路径按当前工作目录解析；默认 ./figma-exports'),
        format: z
          .enum(['PNG', 'JPG', 'SVG', 'PDF'])
          .optional()
          .describe('覆盖节点自带的导出设置。省略且节点没配设置时用 PNG'),
        scales: z
          .array(z.number().min(0.1).max(4))
          .optional()
          .describe('导出倍率，逗号分隔如 1,2,3；仅 PNG/JPG 有意义，默认 1'),
        recursive: z
          .boolean()
          .optional()
          .describe('递归收集子孙节点里配了导出设置的和 SLICE —— 一次切整套图标'),
        useSettings: z
          .boolean()
          .optional()
          .describe('是否采用节点自带的导出设置，默认 true；给了 --format 时自动失效'),
        svgOutlineText: z
          .boolean()
          .optional()
          .describe('SVG 文字转曲，默认 true。要在代码里改文案就 --no-svg-outline-text'),
        svgIdAttribute: z.boolean().optional().describe('SVG 图层带 id 属性，便于 CSS 命中'),
        svgSimplifyStroke: z.boolean().optional().describe('SVG 简化描边，默认 true'),
      },
      positional: ['ids'],
      variadic: true,
      pathArgs: ['out'],
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const ids = args.ids as string[];
          const format = args.format as ExportFormat | undefined;
          const scales = (args.scales as number[] | undefined) ?? [1];
          const useSettings = format ? false : (args.useSettings as boolean | undefined) ?? true;

          const { result: plan } = await hub.request(
            target,
            Method.NodeExportPlan,
            { ids, recursive: args.recursive as boolean | undefined },
            { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS },
          );

          const planned = plan as NodeExportPlanResult;
          if (planned.targets.length === 0) {
            return failure(
              yamlOf([
                ['error', 'NOT_FOUND'],
                ['message', '没有可导出的节点。如果给的是 Frame 且想切它内部的图标，加 --recursive'],
                ['missing', planned.missing ?? []],
              ]),
            );
          }

          const dir = outputDir(args.out as string | undefined);
          const files: Entry[][] = [];
          const failed: string[] = [];
          const used = new Set<string>();
          let total = 0;
          let bytes = 0;

          for (const item of planned.targets) {
            for (const spec of specsFor(item, { format, scales, useSettings })) {
              if (total >= MAX_EXPORT_JOBS) {
                failed.push(`达到单次 ${MAX_EXPORT_JOBS} 个文件的上限，其余未导出`);
                break;
              }

              const { result, data } = await hub.request(
                target,
                Method.NodeExport,
                {
                  id: item.id,
                  format: spec.format,
                  scale: spec.scale,
                  svgOutlineText: args.svgOutlineText as boolean | undefined,
                  svgIdAttribute: args.svgIdAttribute as boolean | undefined,
                  svgSimplifyStroke: args.svgSimplifyStroke as boolean | undefined,
                },
                { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS },
              );
              if (!data) {
                failed.push(`${item.name} (${spec.format})：插件没有回传数据`);
                continue;
              }

              const exported = result as NodeExportResult;
              const path = writeAsset(dir, assetName(item, spec, exported, used), data);
              if (!path) {
                failed.push(`${item.name} (${spec.format})：落盘失败`);
                continue;
              }

              total++;
              bytes += data.byteLength;
              files.push([
                ['path', path],
                ['format', exported.format],
                ['size', [exported.width, exported.height]],
                ['kb', Math.round((data.byteLength / 1024) * 10) / 10],
              ]);
            }
          }

          const summary: Entry[] = [
            ['out', dir],
            ['count', total],
            ['kb', Math.round((bytes / 1024) * 10) / 10],
            ['files', files],
          ];
          if (failed.length > 0) summary.push(['failed', failed]);
          if (planned.missing?.length) summary.push(['missing', planned.missing]);
          if (planned.truncated) summary.push(['truncated', '清点结果被截断，建议缩小范围']);

          const text = yamlOf(summary);
          return total === 0 ? failure(text) : ok(text);
        }),
    },

    // ---------------------------------------------------------- 设计系统
    {
      name: 'get_variables',
      cli: 'vars',
      title: '导出设计变量',
      description:
        '导出变量集合，用于同步成代码里的 design token。\n' +
        '**本地集合**给出各 mode 的完整值；**外部 Library 的集合**默认只给清单' +
        '（集合名 / 变量名 / 类型）—— 那是 teamLibrary API 的上限。\n' +
        '要 Library 变量的具体值就加 values：会逐个 import 变量，几百个变量会明显变慢，' +
        '所以默认关闭。设计稿里的 $name 靠清单就能对上号，多数时候不需要值。\n' +
        '输出中 `→$other` 表示该变量别名指向另一个变量。',
      schema: {
        ...docIdArg,
        collectionId: z.string().optional().describe('只导出某个集合（本地集合的 id）'),
        expand: z.boolean().optional().describe('展开变量明细，默认 true'),
        limit: z.number().int().min(1).max(5000).optional().describe('每集合变量上限，默认 800'),
        library: z.boolean().optional().describe('连带列出外部 Library 的集合，默认 true'),
        values: z
          .boolean()
          .optional()
          .describe('解析 Library 变量各 mode 的值（逐个 import，慢），默认 false'),
        scan: z
          .boolean()
          .optional()
          .describe('扫当前页，从实际引用到的变量反查它所属的集合，默认 true'),
      },
      run: async (args) =>
        guard(async () => {
          const target = router.resolve(args.docId as string | undefined);
          const { result } = await hub.request(target, Method.DsVariables, {
            collectionId: args.collectionId as string | undefined,
            expand: args.expand as boolean | undefined,
            limit: args.limit as number | undefined,
            library: args.library as boolean | undefined,
            values: args.values as boolean | undefined,
            scan: args.scan as boolean | undefined,
          });
          let body = serializeVariables(result.collections);
          if (result.truncated) body += note('变量数量超过上限，已截断');

          // 只在**一个集合都没拿到**时解释原因。拿到了就别废话 ——
          // teamLibrary 那条路空不空是实现细节，集合上的 source 字段已经说明来源
          if (result.collections.length === 0) {
            if (result.libraryError) {
              body += note(`读不到外部 Library 的变量：${result.libraryError}`);
            } else if (args.library !== false && result.libraryCount === undefined) {
              body += note(
                '插件没有返回 Library 信息 —— Figma 里跑的多半还是旧版插件，' +
                  '关掉插件窗口重开（figma docs 可以看插件版本）',
              );
            }
          } else if (!args.values && result.collections.some((c) => c.libraryName !== undefined)) {
            body += note('Library 变量只列了清单，要各 mode 的具体值加 --values（较慢）');
          }
          return ok(body);
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
          const body = serializeStyles(result.styles);
          return ok(result.truncated ? body + note('样式数量超过上限，已截断') : body);
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
/** 单次切图的文件数上限。防止在整页上误用 --recursive 刷出几百个文件。 */
const MAX_EXPORT_JOBS = 200;

const EXTENSION: Record<ExportFormat, string> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf',
};

/**
 * 决定一个节点要导出哪几份。
 *
 * 优先级：显式 --format > 节点自带的导出设置 > PNG。
 * 「节点自带的设置」排在默认值前面，是因为那是设计师明确表达过的意图 ——
 * 他配了 SVG + @2x PNG，就说明这个图标两种都要。
 */
function specsFor(
  target: ExportTarget,
  opts: { format?: ExportFormat; scales: number[]; useSettings: boolean },
): ExportSpec[] {
  if (opts.format) {
    // 矢量格式没有倍率概念，出一份就够
    if (opts.format === 'SVG' || opts.format === 'PDF') return [{ format: opts.format }];
    return opts.scales.map((scale) => ({ format: opts.format!, scale }));
  }
  if (opts.useSettings && target.settings.length > 0) return target.settings;
  return opts.scales.map((scale) => ({ format: 'PNG' as const, scale }));
}

/**
 * 文件名：图层名 + 后缀 + 扩展名。
 *
 * 后缀优先用 Figma 里配的（设计师写了 "@2x" / "-dark" 就照抄），
 * 没配则按倍率补 @2x。重名时加序号，绝不静默覆盖。
 */
function assetName(
  target: ExportTarget,
  spec: ExportSpec,
  exported: NodeExportResult,
  used: Set<string>,
): string {
  const base = sanitizeName(target.name) || sanitizeName(target.id) || 'asset';
  const scale = spec.scale ?? exported.scale;
  const suffix = spec.suffix ?? (scale && scale !== 1 ? `@${trimNumber(scale)}x` : '');
  const ext = EXTENSION[exported.format];

  // 去重序号插在倍率后缀之前，让同一个资源的各倍率仍然连在一起：
  // icon-search-2.png / icon-search-2@2x.png，而不是 icon-search@2x-2.png
  let name = `${base}${suffix}.${ext}`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}${suffix}.${ext}`;
  used.add(name);
  return name;
}

/** 图层名直接当文件名不安全：可能有斜杠、空格、emoji、以及 Icon/Search 这种路径式命名。 */
function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[\/\\]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\w.@-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * 输出目录。相对路径本该由前端解析掉（见 absolutizePathArgs）；
 * 万一还是相对的（比如有人直接 curl /call），退回到状态目录，
 * 绝不拿 daemon 那个不可预期的 cwd 去写文件。
 */
function outputDir(out: string | undefined): string {
  if (out && isAbsolute(out)) return out;
  // 相对路径本该由前端解析掉，走到这里说明调用方绕过了前端
  const fallback = join(homedir(), STATE_DIR, 'exports');
  return out ? join(fallback, out) : fallback;
}

function writeAsset(dir: string, name: string, data: Buffer): string | undefined {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, data);
    return path;
  } catch (err) {
    log.error('切图落盘失败:', String(err));
    return undefined;
  }
}

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
