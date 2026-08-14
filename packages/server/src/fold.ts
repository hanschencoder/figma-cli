/**
 * 结构折叠 —— 把「机械可消除的冗余」从输出里拿掉。
 *
 * 三种冗余，都不是靠调 depth 能躲开的：
 *   1. 图标的矢量几何（`18.1 × 16.01 @ (2.9, 3.8)`）—— 图标最终一律走 export
 *      出 SVG，这些数字在还原流程里零使用率。
 *   2. 系统状态栏 / Home Indicator —— 每张移动端稿都有，且不该由页面还原。
 *   3. 结构同构的相邻兄弟 —— 12 个一模一样的列表行逐个展开，既费上下文，
 *      又把「这是同一个组件」的信号摊平成了 12 段平行文本。
 *
 * 全部放在 server 侧：判定规则改一次就重启 daemon 生效，不用重载插件。
 * 三条都能关（--expand-icons / --expand-system / --no-dedupe）—— 折叠是有损的，
 * 必须留一条看原样的路。
 */

import type { NodeInfo, PaintInfo } from '@figma-cli/shared';

export interface FoldOptions {
  /** 原子图标折叠成 type: Icon 一行 */
  icons: boolean;
  /** 状态栏这类系统组件折叠成一行 */
  system: boolean;
  /** 结构同构的相邻兄弟折叠成 sameAs */
  dedupe: boolean;
  /** siblings：只折叠同父兄弟；document：整份输出内跨父折叠 */
  dedupeScope: 'siblings' | 'document';
  /** 判定为图标的尺寸上限 */
  iconMaxSize: number;
  /** 图层名是不是系统 chrome */
  isSystem: (name: string) => boolean;
}

export const DEFAULT_FOLD: FoldOptions = {
  icons: true,
  system: true,
  dedupe: true,
  dedupeScope: 'siblings',
  iconMaxSize: 64,
  isSystem: () => false,
};

// ================================================================ 图标

/** 纯绘图节点类型。出现别的类型（尤其 TEXT）就不是图标。 */
const DRAWING_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'RECTANGLE',
  'ELLIPSE',
  'LINE',
  'STAR',
  'POLYGON',
  'GROUP',
  'FRAME',
  'INSTANCE',
  'COMPONENT',
]);

export interface IconFold {
  name?: string;
  /** 方形时是标量 */
  size: number | [number, number];
  /** 主导色（只有一种时） */
  color?: string;
  /** 多色图标 */
  colors?: string[];
  of?: string;
  library?: boolean;
  /** 有裸色值：它决定了暗色模式下会不会出问题 */
  unbound?: boolean;
}

/**
 * 能折叠成一行 Icon 的条件（必须全部满足）：
 *   1. 后代全是绘图类型，2. 没有 TEXT，3. 自身两边都 ≤ iconMaxSize，
 *   4. 后代里没有 Auto Layout（有布局说明它是个容器，不是一张图）。
 *
 * 对 Frame / Group 同样生效，不只是 Instance —— 设计稿里的「环形进度提示」
 * 这类东西就是一个 Frame 套两个 Vector。
 */
export function foldIcon(
  node: NodeInfo,
  opts: FoldOptions,
  paintText: (paints: PaintInfo[] | undefined) => string | undefined,
): IconFold | undefined {
  if (!opts.icons) return undefined;
  if (!node.children?.length) return undefined;
  if (node.w === undefined || node.h === undefined) return undefined;
  if (node.w > opts.iconMaxSize || node.h > opts.iconMaxSize) return undefined;
  if (node.w <= 0 || node.h <= 0) return undefined;

  const colors: string[] = [];
  let unbound = false;
  let ok = true;

  const walk = (current: NodeInfo, depth: number): void => {
    if (!ok) return;
    if (depth > 0) {
      if (!DRAWING_TYPES.has(current.type) || current.text) {
        ok = false;
        return;
      }
      // 内部还有 Auto Layout —— 这是个排版容器，不是一张图
      if (current.layout) {
        ok = false;
        return;
      }
      // 折叠会让被截断的部分永远看不见，那就不是无损的省略了
      if (current.truncated) {
        ok = false;
        return;
      }
    }
    // 描边同样要看：「环形进度底环 stroke 未绑 token，暗色下不可见」这类问题
    // 正好都出在描边上，只扫 fills 就会漏掉
    for (const paint of [...(current.fills ?? []), ...(current.strokes ?? [])]) {
      if (paint.visible === false) continue;
      const text = paintText([paint]);
      if (!text) continue;
      if (!colors.includes(text)) colors.push(text);
      if (paint.kind === 'solid' && !paint.token) unbound = true;
    }
    for (const child of current.children ?? []) walk(child, depth + 1);
  };
  walk(node, 0);

  if (!ok) return undefined;

  const fold: IconFold = {
    size: node.w === node.h ? node.w : [node.w, node.h],
  };
  if (node.name) fold.name = node.name;
  if (colors.length === 1) fold.color = colors[0];
  else if (colors.length > 1) fold.colors = colors;
  if (node.component) {
    fold.of = node.component.componentSetName ?? node.component.mainComponentName;
    if (node.component.remote) fold.library = true;
  }
  // 裸色值必须显式标出来：文件有 Dark mode 时它就是个 bug
  if (unbound) fold.unbound = true;
  return fold;
}

// ================================================================ 系统 chrome

export interface SystemFold {
  of: string;
  size?: [number, number];
  padding?: [number, number, number, number];
  justify?: string;
  opacity?: number;
  texts: string[];
  /** 直接子级里值得整体切图的图标簇 */
  exportable: { name: string; id: string; size?: [number, number] }[];
}

/** 名字或主组件名命中系统 chrome 名单。 */
export function isSystemChrome(node: NodeInfo, opts: FoldOptions): boolean {
  if (!opts.system) return false;
  const names = [node.name, node.component?.componentSetName, node.component?.mainComponentName];
  return names.some((name) => name !== undefined && opts.isSystem(name));
}

/**
 * 状态栏折叠。
 *
 * 保留的四件事正好是从原来那两百行里真正提取到的：容器尺寸、padding、
 * 文案、以及右侧图标组的可导出 id。其余（wifi 的每一段弧）一概不要。
 */
export function foldSystem(node: NodeInfo): SystemFold {
  const fold: SystemFold = {
    of: node.component?.componentSetName ?? node.component?.mainComponentName ?? node.name,
    texts: [],
    exportable: [],
  };
  if (node.w !== undefined && node.h !== undefined) fold.size = [node.w, node.h];
  if (node.layout?.padding) fold.padding = node.layout.padding;
  if (node.layout?.primaryAlign) fold.justify = node.layout.primaryAlign;
  if (node.opacity !== undefined) fold.opacity = node.opacity;

  const collectText = (current: NodeInfo): void => {
    if (current.text) fold.texts.push(current.text.characters);
    for (const child of current.children ?? []) collectText(child);
  };
  collectText(node);

  // 直接子级里不含文本的那些就是图标簇 —— 给出 id，免得为了拿它还得展开一次
  for (const child of node.children ?? []) {
    if (hasText(child)) continue;
    const item: { name: string; id: string; size?: [number, number] } = {
      name: child.name,
      id: child.id,
    };
    if (child.w !== undefined && child.h !== undefined) item.size = [child.w, child.h];
    fold.exportable.push(item);
  }

  return fold;
}

function hasText(node: NodeInfo): boolean {
  if (node.text) return true;
  return (node.children ?? []).some(hasText);
}

// ================================================================ 同构折叠

/**
 * 结构哈希。
 *
 * 纳入：type / name / layout / sizing / 有没有 fill·stroke·effect / radius /
 *       clip / opacity / blend / rotate / component.of / props 的键 / 子节点哈希。
 * 排除：id / pos / abs / size / text 内容 / 颜色值 / props 的值 —— 这些都是
 *       「同一个组件的不同一份数据」，正是要进 diff 的东西。
 */
export function structureHash(node: NodeInfo, opts: FoldOptions): string {
  const parts: string[] = [node.type];

  // 图标叶子的名字和主组件名本来就该不同（文件2 / 小 增加），算进哈希就永远折叠不了
  const isIcon = opts.icons && node.children?.length !== undefined && looksLikeIcon(node, opts);
  if (!isIcon) {
    parts.push(node.name);
    parts.push(node.component?.componentSetName ?? node.component?.mainComponentName ?? '');
  }

  if (node.layout) {
    const l = node.layout;
    parts.push(
      `L${l.mode}:${l.gap ?? ''}:${(l.padding ?? []).join(',')}:${l.primaryAlign ?? ''}:${l.counterAlign ?? ''}:${l.wrap ? 'w' : ''}`,
    );
  }
  if (node.layoutChild) {
    const c = node.layoutChild;
    parts.push(`C${c.sizingH ?? ''}:${c.sizingV ?? ''}:${c.positioning ?? ''}`);
  }
  if (node.constraints) parts.push(`K${node.constraints.h}:${node.constraints.v}`);
  if (node.fills?.length) parts.push('f');
  if (node.strokes?.length) parts.push('s');
  if (node.effects?.length) parts.push('e');
  if (node.cornerRadius !== undefined) {
    parts.push(`r${Array.isArray(node.cornerRadius) ? node.cornerRadius.join(',') : node.cornerRadius}`);
  }
  if (node.clipsContent) parts.push('clip');
  if (node.opacity !== undefined) parts.push(`o${node.opacity}`);
  if (node.blendMode) parts.push(`b${node.blendMode}`);
  if (node.rotation !== undefined) parts.push(`t${node.rotation}`);
  if (node.text) parts.push(`T${node.text.fontSize ?? ''}:${node.text.autoResize ?? ''}`);
  if (node.styles) {
    parts.push(
      `S${node.styles.fill?.name ?? ''}:${node.styles.text?.name ?? ''}:${node.styles.effect?.name ?? ''}`,
    );
  }
  if (node.component?.properties) parts.push(`P${Object.keys(node.component.properties).sort().join(',')}`);
  if (node.truncated) parts.push(`M${node.childCount ?? ''}`);

  const children = (node.children ?? []).map((child) => structureHash(child, opts));
  return `${parts.join('|')}(${children.join(';')})`;
}

/** 便宜版图标判定，只给哈希用（不需要算颜色）。 */
function looksLikeIcon(node: NodeInfo, opts: FoldOptions): boolean {
  if (!node.children?.length) return false;
  if (node.w === undefined || node.h === undefined) return false;
  if (node.w > opts.iconMaxSize || node.h > opts.iconMaxSize) return false;
  let ok = true;
  const walk = (current: NodeInfo, depth: number): void => {
    if (!ok) return;
    if (depth > 0 && (!DRAWING_TYPES.has(current.type) || current.text || current.layout)) {
      ok = false;
      return;
    }
    for (const child of current.children ?? []) walk(child, depth + 1);
  };
  walk(node, 0);
  return ok;
}

export interface NodeDiff {
  /** 文案差异，按出现顺序 */
  text: string[];
  /** 图标差异：主组件名 + 可导出 id */
  icon: { of: string; id: string }[];
  /** 颜色差异（fill / 文字 color） */
  color: string[];
  /** 组件属性覆盖差异 */
  props: [string, string][];
  /** 顶层尺寸差异 */
  size?: [number, number];
}

/**
 * 两棵同构子树的差异。
 *
 * 只走一遍，按语义名归类 —— 用节点路径当 key（`children[1].children[0].text`）
 * 的话，读的人还得在脑子里回放一遍树才知道说的是哪儿。
 */
export function diffNodes(base: NodeInfo, other: NodeInfo, opts: FoldOptions): NodeDiff {
  const diff: NodeDiff = { text: [], icon: [], color: [], props: [] };

  if (base.w !== other.w || base.h !== other.h) {
    if (other.w !== undefined && other.h !== undefined) diff.size = [other.w, other.h];
  }

  const walk = (a: NodeInfo, b: NodeInfo): void => {
    if (a.text && b.text && a.text.characters !== b.text.characters) {
      diff.text.push(b.text.characters);
    }
    const aOf = a.component?.componentSetName ?? a.component?.mainComponentName;
    const bOf = b.component?.componentSetName ?? b.component?.mainComponentName;
    if (aOf !== bOf && bOf) diff.icon.push({ of: bOf, id: b.id });

    const aProps = a.component?.properties ?? {};
    const bProps = b.component?.properties ?? {};
    for (const [key, prop] of Object.entries(bProps)) {
      if (String(aProps[key]?.value) !== String(prop.value)) {
        diff.props.push([key, String(prop.value)]);
      }
    }

    const aChildren = a.children ?? [];
    const bChildren = b.children ?? [];
    for (let i = 0; i < Math.min(aChildren.length, bChildren.length); i++) {
      walk(aChildren[i]!, bChildren[i]!);
    }
  };
  walk(base, other);

  return diff;
}

/** 颜色差异要用 yaml 侧的 paint 格式化，所以单独一步。 */
export function diffColors(
  base: NodeInfo,
  other: NodeInfo,
  paintText: (node: NodeInfo) => string | undefined,
): string[] {
  const out: string[] = [];
  const walk = (a: NodeInfo, b: NodeInfo): void => {
    const aText = paintText(a);
    const bText = paintText(b);
    if (aText !== bText && bText !== undefined && !out.includes(bText)) out.push(bText);
    const aChildren = a.children ?? [];
    const bChildren = b.children ?? [];
    for (let i = 0; i < Math.min(aChildren.length, bChildren.length); i++) {
      walk(aChildren[i]!, bChildren[i]!);
    }
  };
  walk(base, other);
  return out;
}

export function isEmptyDiff(diff: NodeDiff): boolean {
  return (
    diff.text.length === 0 &&
    diff.icon.length === 0 &&
    diff.color.length === 0 &&
    diff.props.length === 0 &&
    diff.size === undefined
  );
}
