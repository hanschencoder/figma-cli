/**
 * MCP Server ↔ Figma 插件 的 WebSocket 线协议。
 *
 * 方向约定：
 *   插件 → server: hello / res / chunk / event / pong
 *   server → 插件: hello-ack / req / ping
 *
 * method 用命名空间划分，为 v2 的写操作预留 `node.set*` / `ds.create*` 等。
 */

import type {
  ComponentSummary,
  DocumentContext,
  DocumentIdentity,
  NodeInfo,
  NodeMatch,
  StyleInfo,
  TextItem,
  VariableCollectionInfo,
} from './model.js';

// ---------------------------------------------------------------- 消息封装

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  doc: DocumentIdentity;
  pluginVersion: string;
}

export interface HelloAckMessage {
  type: 'hello-ack';
  ok: boolean;
  /** ok=false 时说明原因（协议版本不符） */
  error?: string;
  serverVersion: string;
  protocol: number;
}

export interface ReqMessage {
  type: 'req';
  id: string;
  method: Method;
  params: unknown;
}

export type ResMessage =
  | { type: 'res'; id: string; ok: true; result: unknown }
  | { type: 'res'; id: string; ok: false; error: ProtocolError };

/**
 * 大载荷分片。图像走这条路。
 * 顺序保证：所有 chunk 先于同 id 的 res 发出，server 收到 res 时分片已齐。
 */
export interface ChunkMessage {
  type: 'chunk';
  id: string;
  index: number;
  total: number;
  /** base64 片段 */
  data: string;
}

/** 插件主动推送。v1 只用于让 server 知道选中项变了，不做订阅语义。 */
export interface EventMessage {
  type: 'event';
  name: 'selectionchange' | 'currentpagechange' | 'documentchange';
  payload: unknown;
}

export interface PingMessage {
  type: 'ping';
  t: number;
}

export interface PongMessage {
  type: 'pong';
  t: number;
}

export type PluginToServerMessage =
  | HelloMessage
  | ResMessage
  | ChunkMessage
  | EventMessage
  | PongMessage;

export type ServerToPluginMessage = HelloAckMessage | ReqMessage | PingMessage;

export type AnyMessage = PluginToServerMessage | ServerToPluginMessage;

// ---------------------------------------------------------------- 错误

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED: 'UNSUPPORTED',
  TIMEOUT: 'TIMEOUT',
  DISCONNECTED: 'DISCONNECTED',
  AMBIGUOUS_DOCUMENT: 'AMBIGUOUS_DOCUMENT',
  NO_DOCUMENT: 'NO_DOCUMENT',
  AUTH: 'AUTH',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ProtocolError {
  code: ErrorCodeValue;
  message: string;
  /** 便于定位的补充信息，如候选文档列表 */
  detail?: unknown;
}

// ---------------------------------------------------------------- 方法

export const Method = {
  /** 文档上下文：文件名、页面、当前页、选中项 */
  DocContext: 'doc.context',
  /** 分层节点树 */
  NodeTree: 'node.tree',
  /** 节点完整属性 */
  NodeDetail: 'node.detail',
  /** 按名称/类型搜索 */
  NodeSearch: 'node.search',
  /** 抽取子树全部文案 */
  NodeText: 'node.text',
  /** 渲染节点为图片 */
  NodeImage: 'node.image',
  /** 变量集合 */
  DsVariables: 'ds.variables',
  /** 样式 */
  DsStyles: 'ds.styles',
  /** 组件清单 */
  DsComponents: 'ds.components',
} as const;

export type Method = (typeof Method)[keyof typeof Method];

// ------------------------------------------------ 各方法的 params / result

export interface DocContextParams {
  /** 选中项也一并展开一层子节点，方便一次看清结构 */
  expandSelection?: boolean;
}
export type DocContextResult = DocumentContext;

export interface NodeTreeParams {
  /** 省略时用当前选中项；选中为空时用当前页 */
  rootId?: string;
  /** 展开层数，0 表示只要根节点自身 */
  depth?: number;
  includeHidden?: boolean;
  /**
   * 是否展开组件实例的内部结构。默认 false。
   * 实例内部（状态栏、图标组…）通常是设计系统的实现细节，展开会吃掉
   * 绝大部分节点预算，对生成代码几乎没有帮助 —— 实例名 + props 才是有用的。
   */
  expandInstances?: boolean;
  /** 单次返回的节点数上限，防止大文件把 context 撑爆 */
  maxNodes?: number;
}
export interface NodeTreeResult {
  roots: NodeInfo[];
  /** 因 maxNodes 截断 */
  truncated?: boolean;
  nodeCount: number;
}

export interface NodeDetailParams {
  ids: string[];
  /** 是否连带一层子节点摘要 */
  withChildren?: boolean;
}
export interface NodeDetailResult {
  nodes: NodeInfo[];
  /** 查不到的 id */
  missing?: string[];
}

export interface NodeSearchParams {
  /** 名称子串匹配，大小写不敏感 */
  query?: string;
  /** 节点类型过滤，如 ["COMPONENT", "INSTANCE"] */
  types?: string[];
  /** 限定页面；省略时只搜当前页 */
  pageId?: string;
  /** 搜全部页面（会触发 loadAllPagesAsync，大文件较慢） */
  allPages?: boolean;
  limit?: number;
}
export interface NodeSearchResult {
  matches: NodeMatch[];
  total: number;
  truncated?: boolean;
}

export interface NodeTextParams {
  rootId?: string;
  includeHidden?: boolean;
  limit?: number;
}
export interface NodeTextResult {
  items: TextItem[];
  truncated?: boolean;
}

export interface NodeImageParams {
  id: string;
  format?: 'PNG' | 'JPG';
  /** 导出倍率，默认 1 */
  scale?: number;
  /** 长边上限，超出自动降倍率 */
  maxDimension?: number;
}
export interface NodeImageResult {
  mime: string;
  width: number;
  height: number;
  /** 实际使用的倍率（可能因 maxDimension 被下调） */
  scale: number;
  byteLength: number;
  /** 数据通过同 id 的 chunk 消息传输 */
  chunkCount: number;
}

export interface DsVariablesParams {
  /** 只取某个集合 */
  collectionId?: string;
  /** 是否展开变量明细；false 时只返回集合摘要 */
  expand?: boolean;
  limit?: number;
}
export interface DsVariablesResult {
  collections: VariableCollectionInfo[];
  truncated?: boolean;
}

export interface DsStylesParams {
  type?: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  limit?: number;
}
export interface DsStylesResult {
  styles: StyleInfo[];
  truncated?: boolean;
}

export interface DsComponentsParams {
  /** 名称过滤 */
  query?: string;
  /** 搜全部页面 */
  allPages?: boolean;
  limit?: number;
}
export interface DsComponentsResult {
  components: ComponentSummary[];
  total: number;
  truncated?: boolean;
}

/** method → [params, result] 的映射，两端共用做类型收敛。 */
export interface MethodContract {
  [Method.DocContext]: [DocContextParams, DocContextResult];
  [Method.NodeTree]: [NodeTreeParams, NodeTreeResult];
  [Method.NodeDetail]: [NodeDetailParams, NodeDetailResult];
  [Method.NodeSearch]: [NodeSearchParams, NodeSearchResult];
  [Method.NodeText]: [NodeTextParams, NodeTextResult];
  [Method.NodeImage]: [NodeImageParams, NodeImageResult];
  [Method.DsVariables]: [DsVariablesParams, DsVariablesResult];
  [Method.DsStyles]: [DsStylesParams, DsStylesResult];
  [Method.DsComponents]: [DsComponentsParams, DsComponentsResult];
}

export type ParamsOf<M extends Method> = MethodContract[M][0];
export type ResultOf<M extends Method> = MethodContract[M][1];
