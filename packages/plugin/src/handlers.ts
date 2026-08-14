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
  type DocContextParams,
  type DocContextResult,
  type DsComponentsParams,
  type DsComponentsResult,
  type DsStylesParams,
  type DsStylesResult,
  type DsVariablesParams,
  type DsVariablesResult,
  type NodeDetailParams,
  type NodeDetailResult,
  type NodeImageParams,
  type NodeImageResult,
  type NodeInfo,
  type NodeMatch,
  type NodeSearchParams,
  type NodeSearchResult,
  type NodeTextParams,
  type NodeTextResult,
  type NodeTreeParams,
  type NodeTreeResult,
  type ProtocolError,
  type TextItem,
} from '@figma-mcp/shared';
import { ResolveCache } from './collect/common.js';
import { collectComponents, collectStyles, collectVariables } from './collect/ds.js';
import { collectNode, type CollectOptions } from './collect/node.js';

const DEFAULT_TREE_DEPTH = 2;
const DEFAULT_MAX_NODES = 400;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_TEXT_LIMIT = 500;
const DEFAULT_VARIABLE_LIMIT = 800;
const DEFAULT_STYLE_LIMIT = 400;
const DEFAULT_COMPONENT_LIMIT = 200;

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
  const cache = new ResolveCache();
  const opts = options({
    detail: 'compact',
    depth,
    maxNodes,
    includeHidden: params?.includeHidden ?? false,
  });

  const roots: BaseNode[] = [];
  if (params?.rootId) {
    roots.push(await requireNode(params.rootId));
  } else if (figma.currentPage.selection.length > 0) {
    roots.push(...figma.currentPage.selection);
  } else {
    roots.push(figma.currentPage);
  }

  const out: NodeInfo[] = [];
  for (const root of roots) {
    opts.budget.remaining--;
    out.push(await collectNode(root, cache, opts));
  }

  const nodeCount = maxNodes - opts.budget.remaining;
  const result: NodeTreeResult = { roots: out, nodeCount };
  if (opts.budget.remaining <= 0) result.truncated = true;
  return result;
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

// ---------------------------------------------------------------- 设计系统

async function dsVariables(params: DsVariablesParams): Promise<DsVariablesResult> {
  const cache = new ResolveCache();
  const { collections, truncated } = await collectVariables(cache, {
    collectionId: params?.collectionId,
    expand: params?.expand ?? true,
    limit: params?.limit ?? DEFAULT_VARIABLE_LIMIT,
  });
  const result: DsVariablesResult = { collections };
  if (truncated) result.truncated = true;
  return result;
}

async function dsStyles(params: DsStylesParams): Promise<DsStylesResult> {
  const cache = new ResolveCache();
  const { styles, truncated } = await collectStyles(cache, {
    type: params?.type,
    limit: params?.limit ?? DEFAULT_STYLE_LIMIT,
  });
  const result: DsStylesResult = { styles };
  if (truncated) result.truncated = true;
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
}): CollectOptions {
  return {
    detail: o.detail,
    depth: o.depth,
    includeHidden: o.includeHidden ?? false,
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
