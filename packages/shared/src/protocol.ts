/**
 * daemon ↔ Figma 插件 的 WebSocket 线协议。
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
  NodeStat,
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
  /** 切图前的清点：节点尺寸 + 设计师配好的导出设置 */
  NodeExportPlan: 'node.exportPlan',
  /** 按指定格式导出一份资源 */
  NodeExport: 'node.export',
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
  /** 一次取多棵树。给了就忽略 rootId —— 三个区块各来一条命令纯属浪费往返 */
  rootIds?: string[];
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
  /** full 会带上 stroke / effect 细节和节点级变量绑定，走查（lint）需要 */
  detail?: 'compact' | 'full';
  /**
   * 给每个节点补 abs 绝对坐标（相对本次根节点），默认 true。
   * 大树上想省这一行可以关掉。
   */
  abs?: boolean;
  /** 只出结构规模统计，不出内容。用来决定「这棵树该不该展开」 */
  stat?: boolean;
}
export interface NodeTreeResult {
  roots: NodeInfo[];
  /** 因 maxNodes 截断 */
  truncated?: boolean;
  nodeCount: number;
  /** stat 模式下的结构统计，此时 roots 为空 */
  stats?: NodeStat[];
  /** abs 坐标的原点，用来在输出里标注坐标系 */
  origin?: { id: string; name: string };
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

/**
 * 切图支持的格式。PNG/JPG 走倍率，SVG/PDF 是矢量，倍率无意义。
 */
export type ExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF';

/** 一次导出任务：出什么格式、什么倍率、文件名带什么后缀。 */
export interface ExportSpec {
  format: ExportFormat;
  /** 仅 PNG/JPG。Figma 里配的 WIDTH/HEIGHT 约束会先换算成等效倍率 */
  scale?: number;
  /** 设计师在 Figma 导出设置里写的后缀，如 "@2x" / "-dark" */
  suffix?: string;
}

export interface NodeExportPlanParams {
  ids: string[];
  /**
   * 递归收集子孙节点里**配了导出设置的**和 SLICE。
   * 设计稿里图标通常挂在某个 Frame 下面，这样一次就能把整套切出来。
   */
  recursive?: boolean;
  limit?: number;
}

export interface ExportTarget {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  /** 节点自带的导出设置，没配就是空数组 */
  settings: ExportSpec[];
  /**
   * 主组件名（自身是实例，或最近的实例祖先）。
   * 实例内部的节点图层名多半是 "Vector"，甚至只有 id —— 那种文件名进不了项目。
   */
  component?: string;
  /**
   * 子树里出现的纯色填充/描边。用于 --currentcolor：
   * 绑了 token 的色值可以安全换成 currentColor，裸色值不行（可能是有意的多色图标）。
   */
  paints?: { color: string; token?: string }[];
}

export interface NodeExportPlanResult {
  targets: ExportTarget[];
  missing?: string[];
  truncated?: boolean;
}

export interface NodeExportParams {
  id: string;
  format: ExportFormat;
  /** 仅 PNG/JPG 生效 */
  scale?: number;
  /** SVG：文字转曲，默认 true（Figma 默认值）。要在代码里改文案就设 false */
  svgOutlineText?: boolean;
  /** SVG：给图层加 id 属性，方便 CSS 命中 */
  svgIdAttribute?: boolean;
  /** SVG：简化描边，默认 true */
  svgSimplifyStroke?: boolean;
}

export interface NodeExportResult {
  mime: string;
  format: ExportFormat;
  /** 矢量格式下就是节点自身尺寸 */
  width: number;
  height: number;
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
  /** 是否连带列出外部 Library 的变量集合，默认 true */
  library?: boolean;
  /**
   * 解析 Library 变量各 mode 的值。
   *
   * 需要逐个 importVariableByKeyAsync，一个变量一次调用，几百个变量会很慢，
   * 所以默认关闭 —— 只列清单（名字 + 类型）已经够把设计稿里的 $name 对上号了。
   */
  values?: boolean;
  /**
   * 从当前页实际引用到的变量反查集合，默认 true。
   * teamLibrary 只认「在本文件启用了的库」，而业务稿常常只是引用了别人的组件 ——
   * 那条路是空的，这条路才拿得到设计稿真正在用的那套 token。
   */
  scan?: boolean;
  /**
   * 只返回这个子树实际引用到的变量，并给出每个变量的引用次数。
   * 给了它就不再列本地集合和 teamLibrary 清单 —— 那些是「文件里有什么」，
   * 而写这一页代码需要的是「这一页用了什么」。
   */
  usedBy?: string;
}
export interface DsVariablesResult {
  collections: VariableCollectionInfo[];
  truncated?: boolean;
  /** teamLibrary 读不到时的原因（个人文件、权限、组织策略…），不影响本地集合 */
  libraryError?: string;
  /**
   * teamLibrary 报告的可用集合数。
   * 字段缺失 = 插件根本没查（十有八九是 Figma 里跑的还是旧版插件），
   * 0 = 查了但 Figma 说这个文件没有可用的 Library 变量集合。两者要能分清。
   */
  libraryCount?: number;
  /** 为了反查引用扫描过的节点数；字段缺失说明插件没做这一步（旧版插件） */
  scanned?: number;
}

export interface DsStylesParams {
  type?: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  limit?: number;
  /** 从当前页实际引用到的 styleId 反查样式定义，默认 true。理由同 DsVariablesParams.scan */
  scan?: boolean;
  /** 只返回这个子树实际引用到的样式，并给出引用次数。理由同 DsVariablesParams.usedBy */
  usedBy?: string;
}
export interface DsStylesResult {
  styles: StyleInfo[];
  truncated?: boolean;
  /** 反查时扫过的节点数；字段缺失说明插件没做这一步（旧版插件） */
  scanned?: number;
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
  [Method.NodeExportPlan]: [NodeExportPlanParams, NodeExportPlanResult];
  [Method.NodeExport]: [NodeExportParams, NodeExportResult];
  [Method.DsVariables]: [DsVariablesParams, DsVariablesResult];
  [Method.DsStyles]: [DsStylesParams, DsStylesResult];
  [Method.DsComponents]: [DsComponentsParams, DsComponentsResult];
}

export type ParamsOf<M extends Method> = MethodContract[M][0];
export type ResultOf<M extends Method> = MethodContract[M][1];
