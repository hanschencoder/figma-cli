/**
 * 中间数据模型 —— 插件侧裁剪后回传的形状。
 *
 * 分工：插件侧只做字段白名单裁剪（省 WS 带宽、避开大对象序列化），
 * server 侧负责把这些结构转成 YAML 文本。输出格式是最需要反复调试的部分，
 * 放在 server 侧改完重启即可生效，不用重载插件。
 *
 * 约定：**可选字段在"无意义"时一律省略**（比如 opacity=1、visible=true），
 * 序列化端按缺省值处理。这是控制 token 成本的第一道闸。
 */

/** 变量引用还原结果。`value` 是在消费者节点 mode 上下文里的解析值。 */
export interface TokenRef {
  /** 变量名，如 "color/brand"。远端 Library 变量同样能拿到。 */
  name: string;
  /** 解析后的字面值，如 "#0A84FF" / 16 / "Inter"。 */
  value?: string | number | boolean;
  /** 来自远端 Library（非本文件定义）。 */
  remote?: boolean;
}

/** 样式引用（Paint/Text/Effect/Grid Style）。 */
export interface StyleRef {
  id: string;
  name: string;
  remote?: boolean;
}

export type PaintKind = 'solid' | 'gradient' | 'image' | 'video' | 'pattern' | 'unknown';

export interface GradientStop {
  /** #RRGGBB 或 #RRGGBBAA */
  color: string;
  /** 0..1 */
  pos: number;
}

export interface PaintInfo {
  kind: PaintKind;
  /** solid: #RRGGBB 或 #RRGGBBAA（alpha < 1 时带 AA） */
  color?: string;
  /** 图层不透明度，仅在 !== 1 时出现 */
  opacity?: number;
  blendMode?: string;
  /** 仅在 visible === false 时出现 */
  visible?: false;
  gradientType?: string;
  stops?: GradientStop[];
  scaleMode?: string;
  imageHash?: string;
  /** boundVariables 还原出的 token */
  token?: TokenRef;
}

export interface EffectInfo {
  type: string;
  color?: string;
  offset?: [number, number];
  radius?: number;
  spread?: number;
  visible?: false;
  token?: TokenRef;
}

/** Auto Layout 容器自身的布局属性。 */
export interface LayoutInfo {
  mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  wrap?: boolean;
  /** itemSpacing。SPACE_BETWEEN 时不给，由 primaryAlign 表达 */
  gap?: number;
  /** counterAxisSpacing，仅 wrap 时有意义 */
  gapCross?: number;
  /** [top, right, bottom, left] */
  padding?: [number, number, number, number];
  primaryAlign?: string;
  counterAlign?: string;
  /** 主轴尺寸：FIXED / AUTO(hug) */
  primarySizing?: string;
  counterSizing?: string;
  itemReverseZIndex?: boolean;
}

/** 节点作为 Auto Layout 子元素的属性。 */
export interface LayoutChildInfo {
  /** layoutGrow，1 表示 fill */
  grow?: number;
  align?: string;
  /** ABSOLUTE 表示脱离流式布局 */
  positioning?: string;
  sizingH?: string;
  sizingV?: string;
}

export interface TextSegment {
  text: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  fills?: PaintInfo[];
  textStyle?: StyleRef;
  textDecoration?: string;
  hyperlink?: string;
}

export interface TextInfo {
  characters: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  /** 归一化成 "24px" / "150%" / "auto" */
  lineHeight?: string;
  /** 归一化成 "0.5px" / "2%" */
  letterSpacing?: string;
  textAlignH?: string;
  textAlignV?: string;
  textCase?: string;
  textDecoration?: string;
  /** NONE / WIDTH_AND_HEIGHT / HEIGHT / TRUNCATE */
  autoResize?: string;
  /** 富文本：属性在段间不一致时，列出哪些属性是 mixed */
  mixed?: string[];
  /** 仅在 detail 且确实富文本时给出 */
  segments?: TextSegment[];
}

export interface ComponentPropertyInfo {
  type: string;
  value: string | number | boolean;
  /** VARIANT 类型的可选值 */
  options?: string[];
}

export interface ComponentInfo {
  /** INSTANCE 指向的主组件 */
  mainComponentId?: string;
  mainComponentName?: string;
  /** 已发布组件的 key */
  key?: string;
  /** 主组件来自远端 Library */
  remote?: boolean;
  componentSetName?: string;
  description?: string;
  /** 实例的属性覆盖 / 组件的变体属性 */
  properties?: Record<string, ComponentPropertyInfo>;
}

/**
 * 统一的节点结构，按详细程度填充不同字段。
 * tree 模式只填 id/name/type/尺寸/布局摘要；detail 模式填满。
 */
export interface NodeInfo {
  id: string;
  name: string;
  type: string;
  /** 仅在 false 时出现 */
  visible?: false;
  locked?: true;

  /** 相对父节点 */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  /** 仅在 !== 1 时出现 */
  opacity?: number;
  blendMode?: string;
  isMask?: true;

  layout?: LayoutInfo;
  layoutChild?: LayoutChildInfo;
  /** 非 Auto Layout 父级下的约束 */
  constraints?: { h: string; v: string };
  clipsContent?: boolean;

  fills?: PaintInfo[];
  strokes?: PaintInfo[];
  strokeWeight?: number | { top: number; right: number; bottom: number; left: number };
  strokeAlign?: string;
  dashPattern?: number[];
  /** 单值或 [tl, tr, br, bl] */
  cornerRadius?: number | [number, number, number, number];
  effects?: EffectInfo[];

  styles?: {
    fill?: StyleRef;
    stroke?: StyleRef;
    text?: StyleRef;
    effect?: StyleRef;
    grid?: StyleRef;
  };
  /** 直接绑定在节点级属性上的变量（如 width、cornerRadius、padding） */
  tokens?: Record<string, TokenRef>;

  text?: TextInfo;
  component?: ComponentInfo;

  /** 该节点有导出设置，通常意味着它是一张切图资源 */
  exportable?: true;

  children?: NodeInfo[];
  /** children 被截断时给出总数，提示可以继续下钻 */
  childCount?: number;
  truncated?: true;
  /** 截断原因。instance 需要给出和 depth/budget 不同的下一步建议 */
  truncatedBy?: 'depth' | 'budget' | 'instance';
}

export interface NodeMatch {
  id: string;
  name: string;
  type: string;
  /** 从页面到该节点的名称路径，如 "Page 1 / Home / Header" */
  path: string;
  pageId: string;
  pageName: string;
}

export interface TextItem {
  id: string;
  /** 图层名，通常有语义（如 "title" / "price"） */
  name: string;
  text: string;
}

// ---------------------------------------------------------------- 设计系统

export type VariableResolvedType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

export type VariableValue =
  | { kind: 'raw'; value: string | number | boolean }
  | { kind: 'alias'; name: string; resolved?: string | number | boolean };

export interface VariableInfo {
  id: string;
  name: string;
  type: VariableResolvedType;
  description?: string;
  /** 按 mode 名索引 */
  valuesByMode: Record<string, VariableValue>;
  scopes?: string[];
  remote?: boolean;
}

export interface VariableCollectionInfo {
  id: string;
  name: string;
  remote?: boolean;
  modes: { id: string; name: string }[];
  defaultModeId: string;
  variableCount: number;
  /** 未展开时省略 */
  variables?: VariableInfo[];
}

/**
 * 远端 Library 变量：v1 不导出其完整定义，只在被本文件引用时
 * 以「名字 + 当前解析值」出现。
 */
export interface RemoteVariableRef {
  id: string;
  name: string;
  type: VariableResolvedType;
  /** 在引用它的节点 mode 上下文中的解析值 */
  resolved?: string | number | boolean;
}

export interface StyleInfo {
  id: string;
  name: string;
  type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  description?: string;
  remote?: boolean;
  paints?: PaintInfo[];
  text?: TextInfo;
  effects?: EffectInfo[];
}

export interface ComponentSummary {
  id: string;
  name: string;
  type: 'COMPONENT' | 'COMPONENT_SET';
  key?: string;
  description?: string;
  remote?: boolean;
  pageName?: string;
  /** COMPONENT_SET 的变体属性定义 */
  variantProperties?: Record<string, string[]>;
  /** COMPONENT_SET 下的变体数量 */
  variantCount?: number;
}

// ---------------------------------------------------------------- 文档

export interface DocumentIdentity {
  /** 稳定标识：优先 fileKey，取不到时退化为 figma.root.id */
  docId: string;
  fileKey?: string;
  name: string;
  editorType: string;
}

export interface DocumentContext extends DocumentIdentity {
  currentPage: { id: string; name: string };
  pages: { id: string; name: string }[];
  /** 当前选中节点的浅层摘要 */
  selection: NodeInfo[];
}
