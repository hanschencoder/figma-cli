/**
 * 沙箱侧的方法实现。每个 Method 一个 handler。
 *
 * documentAccess: "dynamic-page" 下所有跨页访问都必须显式 loadAsync，
 * 同步的 getNodeById / 直接遍历其它页的 children 会抛错。
 */

import {
  ErrorCode,
  MAX_IMAGE_DIMENSION,
  Method,
  systemChromeMatcher,
  type DocContextParams,
  type DocContextResult,
  type DsComponentsParams,
  type DsComponentsResult,
  type DsStylesParams,
  type DsStylesResult,
  type DsVariablesParams,
  type DsVariablesResult,
  type ExportSpec,
  type ExportTarget,
  type NodeDetailParams,
  type NodeDetailResult,
  type NodeExportParams,
  type NodeExportPlanParams,
  type NodeExportPlanResult,
  type NodeExportResult,
  type NodeImageParams,
  type NodeImageResult,
  type NodeInfo,
  type NodeMatch,
  type NodeSearchParams,
  type NodeSearchResult,
  type NodeTextParams,
  type NodeTextResult,
  type NodeStat,
  type NodeTreeParams,
  type NodeTreeResult,
  type ProtocolError,
  type TextItem,
} from '@figma-mcp/shared';
import { ResolveCache, mapPaints } from './collect/common.js';
import { collectComponents, collectStyles, collectVariables } from './collect/ds.js';
import { absoluteXY, collectNode, collectStats, type CollectOptions } from './collect/node.js';

const DEFAULT_TREE_DEPTH = 2;
const DEFAULT_MAX_NODES = 400;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_TEXT_LIMIT = 500;
const DEFAULT_VARIABLE_LIMIT = 800;
const DEFAULT_STYLE_LIMIT = 400;
const DEFAULT_COMPONENT_LIMIT = 200;
/** 递归清点切图目标时的上限，防止在大页面上扫出几千个节点 */
const DEFAULT_EXPORT_PLAN_LIMIT = 300;

export class HandlerError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = 'HandlerError';
  }
}

function fail(code: ProtocolError['code'], message: string, detail?: unknown): never {
  throw new HandlerError(detail === undefined ? { code, message } : { code, message, detail });
}

export interface HandlerResult {
  result: unknown;
  /** 二进制载荷，由 UI 侧 base64 分片后发出 */
  bytes?: Uint8Array;
}

export async function dispatch(method: string, params: unknown): Promise<HandlerResult> {
  switch (method) {
    case Method.DocContext:
      return { result: await docContext(params as DocContextParams) };
    case Method.NodeTree:
      return { result: await nodeTree(params as NodeTreeParams) };
    case Method.NodeDetail:
      return { result: await nodeDetail(params as NodeDetailParams) };
    case Method.NodeSearch:
      return { result: await nodeSearch(params as NodeSearchParams) };
    case Method.NodeText:
      return { result: await nodeText(params as NodeTextParams) };
    case Method.NodeImage:
      return nodeImage(params as NodeImageParams);
    case Method.NodeExportPlan:
      return { result: await nodeExportPlan(params as NodeExportPlanParams) };
    case Method.NodeExport:
      return nodeExport(params as NodeExportParams);
    case Method.DsVariables:
      return { result: await dsVariables(params as DsVariablesParams) };
    case Method.DsStyles:
      return { result: await dsStyles(params as DsStylesParams) };
    case Method.DsComponents:
      return { result: await dsComponents(params as DsComponentsParams) };
    default:
      fail(ErrorCode.UNSUPPORTED, `未知方法 ${method}`);
  }
}

// ---------------------------------------------------------------- 文档

export function documentIdentity() {
  let fileKey: string | undefined;
  try {
    // 需要 manifest 的 enablePrivatePluginApi，拿不到就退化用 root.id
    fileKey = figma.fileKey ?? undefined;
  } catch {
    fileKey = undefined;
  }
  return {
    docId: fileKey ?? figma.root.id,
    fileKey,
    name: figma.root.name,
    editorType: figma.editorType,
  };
}

async function docContext(params: DocContextParams): Promise<DocContextResult> {
  const cache = new ResolveCache();
  const depth = params?.expandSelection ? 1 : 0;

  const selection: NodeInfo[] = [];
  for (const node of figma.currentPage.selection) {
    selection.push(
      await collectNode(node, cache, options({ detail: 'compact', depth, maxNodes: 60 })),
    );
  }

  return {
    ...documentIdentity(),
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
    selection,
  };
}

// ---------------------------------------------------------------- 节点

async function nodeTree(params: NodeTreeParams): Promise<NodeTreeResult> {
  const depth = params?.depth ?? DEFAULT_TREE_DEPTH;
  const maxNodes = params?.maxNodes ?? DEFAULT_MAX_NODES;
  const includeHidden = params?.includeHidden ?? false;

  const roots: BaseNode[] = [];
  const ids = params?.rootIds?.length ? params.rootIds : params?.rootId ? [params.rootId] : [];
  if (ids.length > 0) {
    for (const id of ids) roots.push(await requireNode(id));
  } else if (figma.currentPage.selection.length > 0) {
    roots.push(...figma.currentPage.selection);
  } else {
    roots.push(figma.currentPage);
  }

  // --stat 不进采集流程：它的全部意义就是「不把内容读进来也能判断规模」
  if (params?.stat) {
    const stats: NodeStat[] = [];
    const isSystem = systemChromeMatcher();
    for (const root of roots) stats.push(...collectStats(root, includeHidden, isSystem));
    return { roots: [], nodeCount: 0, stats, origin: originOf(roots[0]) };
  }

  const cache = new ResolveCache();
  const opts = options({
    detail: params?.detail ?? 'compact',
    depth,
    maxNodes,
    includeHidden,
    expandInstances: params?.expandInstances ?? false,
  });

  // 多个 root 共用第一个 root 的原点：三个区块各自为原点的话，
  // 区块之间的相对位置就又要手算了
  if (params?.abs !== false) {
    const xy = absoluteXY(roots[0]!);
    if (xy) opts.origin = { x: xy[0], y: xy[1] };
  }

  const out: NodeInfo[] = [];
  for (const root of roots) {
    opts.budget.remaining--;
    out.push(await collectNode(root, cache, opts));
  }

  const nodeCount = maxNodes - opts.budget.remaining;
  const result: NodeTreeResult = { roots: out, nodeCount };
  if (opts.budget.remaining <= 0) result.truncated = true;
  if (opts.origin) result.origin = originOf(roots[0]);
  return result;
}

function originOf(node: BaseNode | undefined): { id: string; name: string } | undefined {
  return node ? { id: node.id, name: node.name } : undefined;
}

async function nodeDetail(params: NodeDetailParams): Promise<NodeDetailResult> {
  const ids = params?.ids ?? [];
  if (ids.length === 0) fail(ErrorCode.BAD_REQUEST, 'ids 不能为空');

  const cache = new ResolveCache();
  const opts = options({
    detail: 'full',
    depth: params?.withChildren ? 1 : 0,
    maxNodes: 200,
  });

  const nodes: NodeInfo[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id).catch(() => null);
    if (!node) {
      missing.push(id);
      continue;
    }
    nodes.push(await collectNode(node, cache, opts));
  }

  const result: NodeDetailResult = { nodes };
  if (missing.length > 0) result.missing = missing;
  return result;
}

async function nodeSearch(params: NodeSearchParams): Promise<NodeSearchResult> {
  const needle = params?.query?.trim().toLowerCase();
  const types = params?.types?.length ? params.types : undefined;
  if (!needle && !types) {
    fail(ErrorCode.BAD_REQUEST, 'query 和 types 至少要给一个，否则会把整页节点全部倒出来');
  }

  const limit = params?.limit ?? DEFAULT_SEARCH_LIMIT;
  const pages = await resolvePages(params?.pageId, params?.allPages);

  const matches: NodeMatch[] = [];
  let total = 0;

  for (const page of pages) {
    await page.loadAsync();
    const found = types
      ? page.findAllWithCriteria({ types: types as SceneNode['type'][] })
      : page.findAll((n) => n.name.toLowerCase().includes(needle!));

    for (const node of found) {
      if (needle && !node.name.toLowerCase().includes(needle)) continue;
      total++;
      if (matches.length >= limit) continue;
      matches.push({
        id: node.id,
        name: node.name,
        type: node.type,
        path: nodePath(node),
        pageId: page.id,
        pageName: page.name,
      });
    }
  }

  const result: NodeSearchResult = { matches, total };
  if (total > matches.length) result.truncated = true;
  return result;
}

async function nodeText(params: NodeTextParams): Promise<NodeTextResult> {
  const limit = params?.limit ?? DEFAULT_TEXT_LIMIT;
  const root = params?.rootId ? await requireNode(params.rootId) : figma.currentPage;

  const textNodes: TextNode[] = [];
  if (root.type === 'TEXT') {
    textNodes.push(root);
  } else if ('findAllWithCriteria' in root) {
    textNodes.push(
      ...(root as PageNode | FrameNode).findAllWithCriteria({ types: ['TEXT'] }),
    );
  }

  const items: TextItem[] = [];
  for (const node of textNodes) {
    if (!params?.includeHidden && !isVisibleInTree(node)) continue;
    if (items.length >= limit) break;
    items.push({ id: node.id, name: node.name, text: node.characters });
  }

  const result: NodeTextResult = { items };
  if (textNodes.length > items.length) result.truncated = true;
  return result;
}

async function nodeImage(params: NodeImageParams): Promise<HandlerResult> {
  const node = await requireNode(params.id);
  if (!('exportAsync' in node)) {
    fail(ErrorCode.UNSUPPORTED, `节点 ${params.id} (${node.type}) 不支持导出`);
  }

  const exportable = node as SceneNode & { exportAsync: SceneNode['exportAsync'] };
  const width = 'width' in exportable ? exportable.width : 0;
  const height = 'height' in exportable ? exportable.height : 0;
  if (width <= 0 || height <= 0) {
    fail(ErrorCode.UNSUPPORTED, `节点 ${params.id} 尺寸为 0，无法导出`);
  }

  const format = params.format ?? 'PNG';
  const maxDimension = params.maxDimension ?? MAX_IMAGE_DIMENSION;
  let scale = params.scale ?? 1;

  // 超过长边上限就自动降倍率。Claude 会把图缩到约 1.15M 像素，
  // 传更大纯粹浪费 token 和传输时间。
  const longest = Math.max(width, height);
  if (longest * scale > maxDimension) scale = maxDimension / longest;
  scale = Math.max(0.01, Math.min(4, scale));

  const bytes = await exportable.exportAsync({
    format,
    constraint: { type: 'SCALE', value: scale },
  });

  const result: NodeImageResult = {
    mime: format === 'PNG' ? 'image/png' : 'image/jpeg',
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    scale: Math.round(scale * 1000) / 1000,
    byteLength: bytes.byteLength,
    chunkCount: 0, // 由 UI 侧分片后填入
  };

  return { result, bytes };
}

// ---------------------------------------------------------------- 切图

/**
 * 把 Figma 的导出设置翻译成 ExportSpec。
 *
 * WIDTH / HEIGHT 约束换算成等效倍率：下游只需要处理倍率一种东西，
 * 而且倍率能直接写进文件名（@2x），像素约束不能。
 */
function toExportSpec(setting: ExportSettings, width: number, height: number): ExportSpec {
  const spec: ExportSpec = { format: setting.format };
  if (setting.suffix) spec.suffix = setting.suffix;

  const constraint = 'constraint' in setting ? setting.constraint : undefined;
  if (constraint) {
    if (constraint.type === 'SCALE') spec.scale = constraint.value;
    else if (constraint.type === 'WIDTH' && width > 0) spec.scale = constraint.value / width;
    else if (constraint.type === 'HEIGHT' && height > 0) spec.scale = constraint.value / height;
  }
  return spec;
}

async function exportTargetOf(node: SceneNode, cache: ResolveCache): Promise<ExportTarget> {
  const width = 'width' in node ? node.width : 0;
  const height = 'height' in node ? node.height : 0;
  const settings = 'exportSettings' in node ? node.exportSettings : [];
  const target: ExportTarget = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    settings: settings.map((setting) => toExportSpec(setting, width, height)),
  };

  const component = await nearestComponentName(node);
  if (component) target.component = component;

  const paints = await subtreePaints(node, cache);
  if (paints.length > 0) target.paints = paints;

  return target;
}

/**
 * 自身或最近的实例祖先对应的主组件名。
 *
 * 实例内部节点的图层名基本没用（"Vector"、"Frame 2147223744"），拿它当文件名
 * 产出的是 `2.svg` 这种进不了项目的东西。主组件名才是设计师给这个图标起的名字。
 */
async function nearestComponentName(node: SceneNode): Promise<string | undefined> {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'INSTANCE') {
      try {
        const main = await (current as InstanceNode).getMainComponentAsync();
        if (main) {
          return main.parent?.type === 'COMPONENT_SET' ? main.parent.name : main.name;
        }
      } catch {
        // 主组件在未加载的远端库里，退回去看更外层的实例
      }
    }
    if (current.type === 'COMPONENT') return current.name;
    current = current.parent;
  }
  return undefined;
}

/** 一个图标子树里出现的纯色，最多看这么多节点。 */
const PAINT_SCAN_LIMIT = 200;

/**
 * 子树里用到的纯色填充/描边，按色值去重。
 *
 * `--currentcolor` 靠它区分「绑了 token 的色值」（可以安全换成 currentColor，
 * 由容器的 CSS 变量决定）和「裸色值」（可能是有意的多色图标，动不得）。
 */
async function subtreePaints(
  node: SceneNode,
  cache: ResolveCache,
): Promise<{ color: string; token?: string }[]> {
  const byColor = new Map<string, { color: string; token?: string }>();
  const queue: SceneNode[] = [node];
  let seen = 0;

  while (queue.length > 0 && seen < PAINT_SCAN_LIMIT) {
    const current = queue.shift()!;
    seen++;
    for (const field of ['fills', 'strokes'] as const) {
      if (!(field in current)) continue;
      const bound = (current as { boundVariables?: Record<string, unknown> }).boundVariables;
      const mapped = await mapPaints(
        (current as unknown as Record<string, readonly Paint[]>)[field],
        current,
        cache,
        bound?.[field] as VariableAlias[] | undefined,
      );
      for (const paint of mapped ?? []) {
        if (paint.kind !== 'solid' || !paint.color || paint.visible === false) continue;
        const existing = byColor.get(paint.color);
        // 同一个色值在别处绑了 token 就以有 token 的那次为准
        if (!existing || (existing.token === undefined && paint.token)) {
          byColor.set(
            paint.color,
            paint.token ? { color: paint.color, token: paint.token.name } : { color: paint.color },
          );
        }
      }
    }
    if ('children' in current) queue.push(...(current as ChildrenMixin).children);
  }

  return [...byColor.values()];
}

/** 配了导出设置的节点、以及切片节点，都是设计师明确标出来「这个要切」的。 */
function isExportMarked(node: SceneNode): boolean {
  if (node.type === 'SLICE') return true;
  return 'exportSettings' in node && node.exportSettings.length > 0;
}

async function nodeExportPlan(params: NodeExportPlanParams): Promise<NodeExportPlanResult> {
  const ids = params?.ids ?? [];
  if (ids.length === 0) {
    fail(ErrorCode.BAD_REQUEST, '至少要给一个节点 id');
  }
  const limit = params?.limit ?? DEFAULT_EXPORT_PLAN_LIMIT;

  const targets: ExportTarget[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const cache = new ResolveCache();
  let truncated = false;

  const push = async (node: SceneNode): Promise<void> => {
    if (seen.has(node.id)) return;
    if (targets.length >= limit) {
      truncated = true;
      return;
    }
    seen.add(node.id);
    targets.push(await exportTargetOf(node, cache));
  };

  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || !('type' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') {
      // 页面本身不是切图对象，但递归时它的子孙可能是
      if (params?.recursive && node && 'findAll' in node) {
        for (const child of (node as PageNode).findAll(isExportMarked)) await push(child);
        continue;
      }
      missing.push(id);
      continue;
    }

    const scene = node as SceneNode;
    if (params?.recursive && 'findAll' in scene) {
      // 根节点自己配了导出设置也要算上 —— findAll 不含自身
      if (isExportMarked(scene)) await push(scene);
      for (const child of (scene as FrameNode).findAll(isExportMarked)) await push(child);
      // 一个都没标记时，退回到「就导这个节点本身」，避免静默返回空
      if (targets.length === 0) await push(scene);
    } else {
      await push(scene);
    }
  }

  const result: NodeExportPlanResult = { targets };
  if (missing.length > 0) result.missing = missing;
  if (truncated) result.truncated = true;
  return result;
}

async function nodeExport(params: NodeExportParams): Promise<HandlerResult> {
  const node = await requireNode(params.id);
  if (!('exportAsync' in node)) {
    fail(ErrorCode.UNSUPPORTED, `节点 ${params.id} (${node.type}) 不支持导出`);
  }

  const exportable = node as SceneNode & { exportAsync: SceneNode['exportAsync'] };
  const width = 'width' in exportable ? exportable.width : 0;
  const height = 'height' in exportable ? exportable.height : 0;
  const format = params.format ?? 'PNG';

  if ((format === 'PNG' || format === 'JPG') && (width <= 0 || height <= 0)) {
    fail(ErrorCode.UNSUPPORTED, `节点 ${params.id} 尺寸为 0，无法导出位图`);
  }

  // 切图不套 MAX_IMAGE_DIMENSION —— 那是「给模型看」的省流上限，
  // 用在切图上会把 @3x 悄悄降成别的倍率，产出尺寸不对的资源。
  const scale = Math.max(0.01, Math.min(4, params.scale ?? 1));

  let bytes: Uint8Array;
  let mime: string;

  if (format === 'SVG') {
    bytes = await exportable.exportAsync({
      format: 'SVG',
      svgOutlineText: params.svgOutlineText ?? true,
      svgIdAttribute: params.svgIdAttribute ?? false,
      svgSimplifyStroke: params.svgSimplifyStroke ?? true,
    });
    mime = 'image/svg+xml';
  } else if (format === 'PDF') {
    bytes = await exportable.exportAsync({ format: 'PDF' });
    mime = 'application/pdf';
  } else {
    bytes = await exportable.exportAsync({
      format,
      constraint: { type: 'SCALE', value: scale },
    });
    mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
  }

  const vector = format === 'SVG' || format === 'PDF';
  const result: NodeExportResult = {
    mime,
    format,
    width: Math.round(width * (vector ? 1 : scale)),
    height: Math.round(height * (vector ? 1 : scale)),
    scale: vector ? 1 : Math.round(scale * 1000) / 1000,
    byteLength: bytes.byteLength,
    chunkCount: 0, // 由 UI 侧分片后填入
  };

  return { result, bytes };
}

// ---------------------------------------------------------------- 设计系统

async function dsVariables(params: DsVariablesParams): Promise<DsVariablesResult> {
  const cache = new ResolveCache();
  const { collections, truncated, libraryError, libraryCount, scanned } = await collectVariables(cache, {
    collectionId: params?.collectionId,
    expand: params?.expand ?? true,
    limit: params?.limit ?? DEFAULT_VARIABLE_LIMIT,
    library: params?.library,
    values: params?.values,
    scan: params?.scan,
    usedBy: params?.usedBy,
  });
  const result: DsVariablesResult = { collections };
  if (truncated) result.truncated = true;
  if (libraryError) result.libraryError = libraryError;
  if (libraryCount !== undefined) result.libraryCount = libraryCount;
  if (scanned !== undefined) result.scanned = scanned;
  return result;
}

async function dsStyles(params: DsStylesParams): Promise<DsStylesResult> {
  const cache = new ResolveCache();
  const { styles, truncated, scanned } = await collectStyles(cache, {
    type: params?.type,
    limit: params?.limit ?? DEFAULT_STYLE_LIMIT,
    scan: params?.scan,
    usedBy: params?.usedBy,
  });
  const result: DsStylesResult = { styles };
  if (truncated) result.truncated = true;
  if (scanned !== undefined) result.scanned = scanned;
  return result;
}

async function dsComponents(params: DsComponentsParams): Promise<DsComponentsResult> {
  const pages = await resolvePages(undefined, params?.allPages);
  const { components, total, truncated } = await collectComponents(pages, {
    query: params?.query,
    limit: params?.limit ?? DEFAULT_COMPONENT_LIMIT,
  });
  const result: DsComponentsResult = { components, total };
  if (truncated) result.truncated = true;
  return result;
}

// ---------------------------------------------------------------- 工具

function options(o: {
  detail: CollectOptions['detail'];
  depth: number;
  maxNodes: number;
  includeHidden?: boolean;
  expandInstances?: boolean;
}): CollectOptions {
  return {
    detail: o.detail,
    depth: o.depth,
    includeHidden: o.includeHidden ?? false,
    expandInstances: o.expandInstances ?? false,
    atRoot: true,
    budget: { remaining: o.maxNodes },
  };
}

async function requireNode(id: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(id).catch(() => null);
  if (!node) fail(ErrorCode.NOT_FOUND, `找不到节点 ${id}`);
  return node;
}

async function resolvePages(
  pageId: string | undefined,
  allPages: boolean | undefined,
): Promise<PageNode[]> {
  if (pageId) {
    const page = await figma.getNodeByIdAsync(pageId).catch(() => null);
    if (!page || page.type !== 'PAGE') fail(ErrorCode.NOT_FOUND, `找不到页面 ${pageId}`);
    return [page];
  }
  if (allPages) {
    await figma.loadAllPagesAsync();
    return [...figma.root.children];
  }
  return [figma.currentPage];
}

function nodePath(node: BaseNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== 'DOCUMENT') {
    parts.unshift(current.name);
    current = current.parent;
  }
  return parts.join(' / ');
}

function isVisibleInTree(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if ('visible' in current && !(current as SceneNode).visible) return false;
    current = current.parent;
  }
  return true;
}
