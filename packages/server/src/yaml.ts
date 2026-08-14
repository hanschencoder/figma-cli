/**
 * YAML 序列化。
 *
 * 放在 server 侧而不是插件侧，是因为输出格式最需要反复调试 —— 改完重启
 * daemon 就生效，不用重载插件。
 *
 * 核心规则：**能还原成 token 引用的，绝不输出原始值。**
 * 记号约定：`$name` = 变量（variable），`@name` = 样式（style）。
 *
 * 省 token 的手段只剩两个，都要用足：
 *   1. 无意义的字段一律不写（默认值、Auto Layout 流内的坐标、与内容重复的图层名…）
 *   2. 短小的结构走 flow 风格（`{mode: vertical, gap: 16}`），只有节点、变量这种
 *      需要逐项阅读的才用 block 风格
 */

import type {
  ComponentSummary,
  DocumentContext,
  EffectInfo,
  NodeInfo,
  NodeMatch,
  NodeStat,
  PaintInfo,
  StyleInfo,
  TextInfo,
  TextItem,
  TokenRef,
  VariableCollectionInfo,
  VariableInfo,
} from '@figma-mcp/shared';
import { lineHeightPx, parseFontStyle } from './font.js';
import type { LintFinding } from './lint.js';
import type {
  AssetItem,
  ComponentUse,
  PlanSection,
  SpacingSummary,
  TextStyleSummary,
} from './plan.js';
import {
  DEFAULT_FOLD,
  diffColors,
  diffNodes,
  foldIcon,
  foldSystem,
  isEmptyDiff,
  isSystemChrome,
  structureHash,
  type FoldOptions,
  type IconFold,
  type NodeDiff,
} from './fold.js';

export interface SerializeOptions {
  /** full 会带上 token 的解析值、stroke、effect 细节 */
  detail: 'compact' | 'full';
  /** 结构折叠开关，省略时用默认（图标 / 系统 chrome / 同构兄弟全折叠） */
  fold?: Partial<FoldOptions>;
}

/**
 * 渲染上下文 = 序列化选项 + 折叠配置 + 跨父折叠的已见结构表。
 * 继承 SerializeOptions，各个 format* 函数不用改签名。
 */
interface Ctx extends SerializeOptions {
  fold: FoldOptions;
  /** 结构哈希 → 已经完整输出过的那个节点 */
  seen: Map<string, { node: NodeInfo; lines: number }>;
}

function contextOf(opts: SerializeOptions): Ctx {
  return { ...opts, fold: { ...DEFAULT_FOLD, ...opts.fold }, seen: new Map() };
}

/**
 * 低于这个行数不折叠。
 *
 * 为省两行引入一层 `sameAs` 间接，读的人要来回跳，不划算。
 */
const MIN_FOLD_LINES = 6;

const TYPE_ALIAS: Record<string, string> = {
  FRAME: 'Frame',
  GROUP: 'Group',
  TEXT: 'Text',
  RECTANGLE: 'Rect',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  VECTOR: 'Vector',
  POLYGON: 'Polygon',
  STAR: 'Star',
  INSTANCE: 'Instance',
  COMPONENT: 'Component',
  COMPONENT_SET: 'ComponentSet',
  SECTION: 'Section',
  PAGE: 'Page',
  BOOLEAN_OPERATION: 'Bool',
  SLICE: 'Slice',
};

// ================================================================ YAML 输出

/** 有序的键值对。用数组而不是对象，因为字段顺序是可读性的一部分。 */
export type Entry = [string, YamlValue];
export type YamlValue = string | number | boolean | Flow | Block | Entry[] | YamlValue[];

/** 包一层表示「这个结构走 flow 风格」，如 `{mode: vertical, gap: 16}`。 */
class Flow {
  constructor(readonly value: Entry[] | YamlValue[]) {}
}

function flow(value: Entry[] | YamlValue[]): Flow {
  return new Flow(value);
}

/**
 * 字面量块（`|`）。SVG 源码这种「一整块文本、里面什么字符都可能有」的东西，
 * 用引号转义会变成一行看不懂的反斜杠；块标量原样保留，还省掉转义字节。
 */
class Block {
  constructor(readonly text: string) {}
}

export function block(text: string): Block {
  return new Block(text);
}

function isEntries(value: unknown): value is Entry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.isArray(value[0]) &&
    (value[0] as unknown[]).length === 2 &&
    typeof (value[0] as unknown[])[0] === 'string'
  );
}

/**
 * 标量的引号规则：**能不加就不加，拿不准就加**。
 *
 * 设计稿里到处是 YAML 的保留字符 —— 颜色 `#0A84FF` 是注释起手、样式引用
 * `@text/x` 里的 `@` 是保留指示符、别名 `*` 和锚点 `&` 也一样。判错一次就
 * 是一份解析不了的输出，所以这里宁可多加引号。
 */
function scalar(value: string | number | boolean, inFlow: boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = value;

  if (text === '') return '""';
  if (needsQuote(text, inFlow)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return text;
}

const RESERVED_WORDS = new Set([
  'true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~',
  'True', 'False', 'Null', 'Yes', 'No', 'On', 'Off',
]);

function needsQuote(text: string, inFlow: boolean): boolean {
  if (RESERVED_WORDS.has(text)) return true;
  // 数字样的字符串必须加引号，否则读回来类型就变了
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return true;
  // 行首指示符、控制字符、首尾空白
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true;
  if (/^\s|\s$/.test(text)) return true;
  if (/[\n\r\t\x00-\x1f]/.test(text)) return true;
  // 冒号一律加引号：`: ` 是键值分隔符，而 `12:34` 这种在 YAML 1.1 解析器里
  // 会被当成六十进制数字（PyYAML 读出来是 754）—— 节点 id 全长这样
  if (text.includes(':')) return true;
  if (text.includes(' #')) return true;
  if (inFlow && /[,[\]{}]/.test(text)) return true;
  return false;
}

/**
 * 纯标量的短数组自动走 flow：`size: [340, 420]` 比拆成三行省得多，
 * 调用方就不用到处手写 flow()。太长的还是拆行，不然反而难读。
 */
const AUTO_FLOW_MAX = 60;

function autoFlow(value: YamlValue): string | undefined {
  if (value instanceof Flow || value instanceof Block) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (isEntries(value)) return undefined;
  if (!(value as YamlValue[]).every((v) => typeof v !== 'object')) return undefined;
  const text = emitFlow(flow(value as YamlValue[]));
  return text.length <= AUTO_FLOW_MAX ? text : undefined;
}

function emit(value: YamlValue, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);

  if (value instanceof Block) {
    lines.push(`${pad}|`);
    emitBlockBody(value, indent + 1, lines);
    return;
  }

  if (value instanceof Flow) {
    lines.push(pad + emitFlow(value));
    return;
  }

  const inline = autoFlow(value);
  if (inline !== undefined) {
    lines.push(pad + inline);
    return;
  }

  if (isEntries(value)) {
    for (const [key, child] of value) emitEntry(key, child, indent, lines);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value as YamlValue[]) {
      if (item instanceof Block) {
        lines.push(`${pad}- |`);
        emitBlockBody(item, indent + 1, lines);
      } else if (item instanceof Flow) {
        lines.push(`${pad}- ${emitFlow(item)}`);
      } else if (isEntries(item) || Array.isArray(item)) {
        const nested: string[] = [];
        emit(item, indent + 1, nested);
        // 第一行接在 "- " 后面，其余行保持缩进
        lines.push(`${pad}- ${nested[0]!.trimStart()}`);
        lines.push(...nested.slice(1));
      } else {
        lines.push(`${pad}- ${scalar(item, false)}`);
      }
    }
    return;
  }

  lines.push(pad + scalar(value, false));
}

function emitBlockBody(value: Block, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);
  for (const line of value.text.replace(/\s+$/, '').split('\n')) lines.push(pad + line);
}

function emitEntry(key: string, value: YamlValue, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);

  if (value instanceof Block) {
    lines.push(`${pad}${scalar(key, false)}: |`);
    emitBlockBody(value, indent + 1, lines);
    return;
  }

  if (value instanceof Flow) {
    lines.push(`${pad}${scalar(key, false)}: ${emitFlow(value)}`);
    return;
  }
  if (isEntries(value) || Array.isArray(value)) {
    if (Array.isArray(value) && value.length === 0) {
      lines.push(`${pad}${scalar(key, false)}: []`);
      return;
    }
    const inline = autoFlow(value);
    if (inline !== undefined) {
      lines.push(`${pad}${scalar(key, false)}: ${inline}`);
      return;
    }
    lines.push(`${pad}${scalar(key, false)}:`);
    // 数组和它的键同级缩进，YAML 允许，还能省一层
    emit(value, isEntries(value) ? indent + 1 : indent + 1, lines);
    return;
  }
  lines.push(`${pad}${scalar(key, false)}: ${scalar(value, false)}`);
}

function emitFlow(node: Flow): string {
  const value = node.value;
  if (isEntries(value)) {
    const body = value
      .map(([k, v]) => `${scalar(k, true)}: ${flowValue(v)}`)
      .join(', ');
    return `{${body}}`;
  }
  return `[${(value as YamlValue[]).map(flowValue).join(', ')}]`;
}

function flowValue(value: YamlValue): string {
  // 块标量没法进 flow —— 真出现说明调用方用错了结构，退化成一行安全的引号串
  if (value instanceof Block) return scalar(value.text.replace(/\n/g, ' '), true);
  if (value instanceof Flow) return emitFlow(value);
  if (isEntries(value) || Array.isArray(value)) return emitFlow(flow(value as Entry[]));
  return scalar(value, true);
}

/** 给 registry 里那些一次性小结构用：直接把键值对列表渲染成 YAML。 */
export function yamlOf(value: YamlValue): string {
  return toYaml(value);
}

function toYaml(value: YamlValue): string {
  const lines: string[] = [];
  emit(value, 0, lines);
  return lines.join('\n');
}

/** 收集键值对时统一过滤 undefined，省得每处都写 if。 */
class Fields {
  private readonly entries: Entry[] = [];

  set(key: string, value: YamlValue | undefined): this {
    if (value !== undefined) this.entries.push([key, value]);
    return this;
  }

  get length(): number {
    return this.entries.length;
  }

  build(): Entry[] {
    return this.entries;
  }
}

// ================================================================ 节点树

export function serializeNodes(roots: NodeInfo[], opts: SerializeOptions): string {
  const ctx = contextOf(opts);
  return toYaml(roots.map((root) => renderNode(root, undefined, ctx)));
}

/**
 * 一个节点渲染成什么：折叠成一行，还是完整展开。
 *
 * 系统 chrome 排在最前面 —— 即使 rootId 直指状态栏本身也照样折叠，
 * 想看内部结构就显式加 --expand-system。这和实例「直指就展开」的规则不同，
 * 因为对状态栏来说，展开几乎总是错的选择。
 */
function renderNode(node: NodeInfo, parent: NodeInfo | undefined, ctx: Ctx): YamlValue {
  if (isSystemChrome(node, ctx.fold)) return flow(systemFields(node, parent, ctx));
  const icon = foldIcon(node, ctx.fold, (paints) => formatPaints(paints, ctx));
  if (icon) return flow(iconFields(node, icon, parent, ctx));
  return nodeValue(node, parent, ctx);
}

/** 图标：可导出的 id、尺寸、颜色 token —— 展开矢量几何只多这三件事之外的噪音。 */
function iconFields(
  node: NodeInfo,
  icon: IconFold,
  parent: NodeInfo | undefined,
  ctx: Ctx,
): Entry[] {
  const f = new Fields();
  f.set('type', 'Icon');
  f.set('name', icon.name);
  f.set('id', node.id);
  f.set('size', Array.isArray(icon.size) ? flow(icon.size) : icon.size);
  if (node.abs) f.set('abs', flow(node.abs));
  if (!inFlowOf(node, parent) && node.x !== undefined && node.y !== undefined && (node.x || node.y)) {
    f.set('pos', flow([node.x, node.y]));
  }
  f.set('color', icon.color);
  if (icon.colors) f.set('colors', flow(icon.colors));
  f.set('of', icon.of);
  if (icon.library) f.set('library', true);
  f.set('opacity', node.opacity);
  // 没绑 token 的色值：文件里有 Dark mode 的话，这就是暗色下会出问题的地方
  if (icon.unbound) f.set('warn', 'unbound-color');
  return f.build();
}

/** 状态栏这类：只留还原容器需要的最小信息，外加可直接喂给 export 的 id。 */
function systemFields(node: NodeInfo, parent: NodeInfo | undefined, ctx: Ctx): Entry[] {
  const fold = foldSystem(node);
  const f = new Fields();
  f.set('type', 'SystemChrome');
  f.set('of', fold.of);
  f.set('id', node.id);
  if (fold.size) f.set('size', flow(fold.size));
  if (node.abs) f.set('abs', flow(node.abs));
  if (fold.padding) f.set('padding', formatPadding(fold.padding));
  if (fold.justify) f.set('justify', short(fold.justify));
  f.set('opacity', fold.opacity);
  if (fold.texts.length > 0) f.set('text', flow(fold.texts));
  if (fold.exportable.length > 0) {
    f.set(
      'exportable',
      flow(
        fold.exportable.map((item) =>
          flow([
            ['name', item.name],
            ['id', item.id],
            ...(item.size ? ([['size', flow(item.size)]] as Entry[]) : []),
          ]),
        ),
      ),
    );
  }
  f.set('hint', '系统组件，建议整体切图或交给系统，不要逐节点还原');
  return f.build();
}

/** 折叠成 `sameAs` 的那一行。 */
function sameAsFields(leader: NodeInfo, node: NodeInfo, ctx: Ctx): Entry[] {
  const f = new Fields();
  f.set('sameAs', leader.id);
  f.set('id', node.id);
  // abs 是它和首节点的真实差异之一，而且正是「这一行落在哪」的答案
  if (node.abs) f.set('abs', flow(node.abs));

  const diff = diffNodes(leader, node, ctx.fold);
  diff.color = diffColors(leader, node, (n) =>
    n.styles?.fill ? `@${n.styles.fill.name}` : formatPaints(n.fills, ctx),
  );

  if (!isEmptyDiff(diff)) f.set('diff', flow(diffFields(diff)));
  return f.build();
}

function diffFields(diff: NodeDiff): Entry[] {
  const f = new Fields();
  if (diff.size) f.set('size', flow(diff.size));
  if (diff.text.length === 1) f.set('text', diff.text[0]!);
  else if (diff.text.length > 1) f.set('text', flow(diff.text));
  if (diff.icon.length === 1) {
    f.set('icon', flow([['of', diff.icon[0]!.of], ['id', diff.icon[0]!.id]]));
  } else if (diff.icon.length > 1) {
    f.set('icon', flow(diff.icon.map((i) => flow([['of', i.of], ['id', i.id]]))));
  }
  if (diff.color.length === 1) f.set('color', diff.color[0]!);
  else if (diff.color.length > 1) f.set('color', flow(diff.color));
  if (diff.props.length > 0) f.set('props', flow(diff.props.map(([k, v]) => [k, v] as Entry)));
  return f.build();
}

/**
 * 子节点列表：先折叠图标 / 系统 chrome，再折叠结构同构的相邻兄弟。
 *
 * 折叠后每个原始 id 仍然在输出里 —— `sameAs` 行带着自己的 id，
 * 拿去 export / node 照样能用。
 */
function renderChildren(children: NodeInfo[], parent: NodeInfo, ctx: Ctx): YamlValue[] {
  const out: YamlValue[] = [];
  const dedupe = ctx.fold.dedupe;
  const hashes = dedupe ? children.map((child) => structureHash(child, ctx.fold)) : undefined;

  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    const hash = hashes?.[i];

    // 跨父折叠：前文已经完整展开过同构子树，这里直接指过去
    if (hash && ctx.fold.dedupeScope === 'document') {
      const leader = ctx.seen.get(hash);
      if (leader && leader.lines >= MIN_FOLD_LINES) {
        out.push(flow(sameAsFields(leader.node, child, ctx)));
        i++;
        continue;
      }
    }

    const rendered = renderNode(child, parent, ctx);
    out.push(rendered);
    const lines = countLines(rendered);
    if (hash && ctx.fold.dedupeScope === 'document' && !ctx.seen.has(hash)) {
      ctx.seen.set(hash, { node: child, lines });
    }

    // 同父相邻兄弟
    let run = 1;
    if (hash) {
      while (i + run < children.length && hashes![i + run] === hash) run++;
    }
    if (hash && run >= 2 && lines >= MIN_FOLD_LINES) {
      for (let j = i + 1; j < i + run; j++) {
        out.push(flow(sameAsFields(child, children[j]!, ctx)));
      }
      i += run;
      continue;
    }
    i++;
  }
  return out;
}

function countLines(value: YamlValue): number {
  const lines: string[] = [];
  emit(value, 0, lines);
  return lines.length;
}

/** Auto Layout 流内：位置由布局决定，写坐标是噪音。 */
function inFlowOf(node: NodeInfo, parent: NodeInfo | undefined): boolean {
  return parent?.layout !== undefined && node.layoutChild?.positioning !== 'ABSOLUTE';
}

function layoutMode(mode: string): string {
  return mode === 'HORIZONTAL' ? 'horizontal' : mode === 'VERTICAL' ? 'vertical' : 'grid';
}

function nodeValue(node: NodeInfo, parent: NodeInfo | undefined, opts: Ctx): Entry[] {
  const f = new Fields();

  f.set('type', TYPE_ALIAS[node.type] ?? node.type);
  // Figma 默认拿内容给文本图层命名，名字和内容一样时只写一遍
  const nameIsContent =
    node.text !== undefined && squash(node.name) === squash(node.text.characters);
  if (!nameIsContent) f.set('name', node.name);
  f.set('id', node.id);
  if (node.text) f.set('text', node.text.characters);

  if (node.visible === false) f.set('hidden', true);
  if (node.locked) f.set('locked', true);

  if (node.w !== undefined && node.h !== undefined) f.set('size', flow([node.w, node.h]));

  // 相对本次 root 的绝对坐标。跨四层累加 pos 去算「这个红点贴在哪一行」
  // 是这套流程里最容易静默出错的一步，而 Figma 本来就知道答案
  if (node.abs) f.set('abs', flow(node.abs));

  // 坐标：Auto Layout 流内的子节点位置由布局决定，写出来是噪音
  const inFlow = inFlowOf(node, parent);
  if (!inFlow && node.x !== undefined && node.y !== undefined && (node.x || node.y)) {
    f.set('pos', flow([node.x, node.y]));
  }
  if (node.layoutChild?.positioning === 'ABSOLUTE') f.set('absolute', true);

  // 自身布局
  if (node.layout) {
    const l = node.layout;
    const layout = new Fields();
    layout.set('mode', layoutMode(l.mode));
    if (l.wrap) layout.set('wrap', true);
    layout.set('gap', l.gap);
    layout.set('gapCross', l.gapCross);
    if (l.padding) layout.set('padding', formatPadding(l.padding));
    if (l.primaryAlign) layout.set('justify', short(l.primaryAlign));
    if (l.counterAlign) layout.set('align', short(l.counterAlign));
    f.set('layout', flow(layout.build()));
  }

  // 作为子元素的尺寸行为
  const sizing = new Fields();
  if (node.layoutChild?.sizingH) sizing.set('w', short(node.layoutChild.sizingH));
  if (node.layoutChild?.sizingV) sizing.set('h', short(node.layoutChild.sizingV));
  if (node.constraints) {
    sizing.set('pin', flow([short(node.constraints.h), short(node.constraints.v)]));
  }
  if (sizing.length > 0) f.set('sizing', flow(sizing.build()));
  if (node.clipsContent) f.set('clip', true);

  // 填充：样式引用 > 变量 > 原始值。TEXT 节点的填充就是文字颜色，换个更直白的名字
  const fill = node.styles?.fill ? `@${node.styles.fill.name}` : formatPaints(node.fills, opts);
  if (fill) f.set(node.text ? 'color' : 'fill', fill);

  if (node.cornerRadius !== undefined) {
    f.set(
      'radius',
      Array.isArray(node.cornerRadius) ? flow(node.cornerRadius) : node.cornerRadius,
    );
  }
  f.set('opacity', node.opacity);
  f.set('rotate', node.rotation);
  if (node.blendMode) f.set('blend', node.blendMode);
  if (node.isMask) f.set('mask', true);

  // 描边
  if (node.strokes?.length) {
    const stroke = new Fields();
    stroke.set(
      'paint',
      node.styles?.stroke ? `@${node.styles.stroke.name}` : formatPaints(node.strokes, opts),
    );
    if (typeof node.strokeWeight === 'number') {
      stroke.set('weight', node.strokeWeight);
    } else if (node.strokeWeight) {
      const w = node.strokeWeight;
      stroke.set('weight', flow([w.top, w.right, w.bottom, w.left]));
    }
    if (node.strokeAlign) stroke.set('align', node.strokeAlign);
    if (node.dashPattern?.length) stroke.set('dash', flow(node.dashPattern));
    if (stroke.length > 0) f.set('stroke', flow(stroke.build()));
  }

  // 效果
  if (node.effects?.length) {
    const effects = node.styles?.effect
      ? `@${node.styles.effect.name}`
      : node.effects
          .filter((e) => e.visible !== false)
          .map((e) => formatEffect(e, opts))
          .join(' + ');
    if (effects) f.set('effect', effects);
  }

  // 文本排版（内容本身已经在上面写过了）
  if (node.text) {
    const text = textFields(node.text, node, opts);
    if (text.length > 0) f.set('font', flow(text));
  }

  // 组件
  if (node.component) {
    const c = node.component;
    const comp = new Fields();
    // 变体的 mainComponentName 形如 "样式=文字按钮"，和 props 完全重复，
    // 这种情况只保留组件集名
    comp.set('of', c.componentSetName ?? c.mainComponentName);
    if (c.key && !c.mainComponentName) comp.set('key', c.key);
    if (c.remote) comp.set('library', true);
    if (c.properties && Object.keys(c.properties).length > 0) {
      comp.set(
        'props',
        flow(Object.entries(c.properties).map(([k, v]) => [k, String(v.value)] as Entry)),
      );
    }
    if (c.description && opts.detail === 'full') comp.set('desc', c.description);
    if (comp.length > 0) f.set('component', flow(comp.build()));
  }

  // 节点级变量绑定（width / itemSpacing / padding…）
  if (node.tokens) {
    const bind = Object.entries(node.tokens).map(
      ([k, v]) => [k, formatToken(v, opts)] as Entry,
    );
    if (bind.length > 0) f.set('bind', flow(bind));
  }

  if (node.exportable) f.set('exportable', true);

  if (node.children?.length) {
    f.set('children', renderChildren(node.children, node, opts));
  }
  // 只标记「还有东西没展开」。具体差几个、为什么没展开，都不值得逐行重复 ——
  // 下钻用的 rootId 就是同一行的 id，截断原因在文档末尾的注释里
  if (node.truncated) {
    f.set('more', true);
    // 没有这个数就只能靠猜：保守地一层层试，或者赌一把深度然后被几百行淹没
    f.set('descendants', node.descendants);
  }

  return f.build();
}

function textFields(text: TextInfo, node: NodeInfo, opts: SerializeOptions): Entry[] {
  const f = new Fields();

  if (node.styles?.text) {
    f.set('style', `@${node.styles.text.name}`);
  } else {
    // 没绑样式的裸字号：把 CSS 真正需要的三个值（字号 / 行高 / 字重）都给全，
    // 不要让使用者拿 style 名去猜 font-weight
    const family =
      text.fontFamily && text.fontStyle ? `${text.fontFamily} ${text.fontStyle}` : text.fontFamily;
    f.set('face', family);
    if (text.fontSize !== undefined) {
      f.set(
        'size',
        text.lineHeight && text.lineHeight !== 'auto'
          ? `${text.fontSize}/${text.lineHeight}`
          : text.fontSize,
      );
    }
    const { weight, italic } = parseFontStyle(text.fontStyle);
    f.set('weight', weight);
    if (italic) f.set('italic', true);
    // 行高是从渲染高度实测的，不是设计师显式给的值
    if (text.lineHeightAuto) f.set('lineHeightFrom', 'measured');
  }

  if (text.letterSpacing) f.set('tracking', text.letterSpacing);
  if (text.textAlignH) f.set('align', short(text.textAlignH));
  if (text.textAlignV) f.set('vAlign', short(text.textAlignV));
  if (text.textCase) f.set('case', short(text.textCase));
  if (text.textDecoration) f.set('decoration', short(text.textDecoration));
  if (text.autoResize) f.set('autoResize', short(text.autoResize));
  if (text.mixed?.length) f.set('mixed', flow(text.mixed));

  if (opts.detail === 'full' && text.segments?.length) {
    f.set(
      'segments',
      flow(
        text.segments.map((s) => {
          const seg = new Fields();
          seg.set('text', s.text);
          if (s.textStyle) seg.set('style', `@${s.textStyle.name}`);
          else if (s.fontFamily) seg.set('face', `${s.fontFamily} ${s.fontStyle ?? ''}`.trim());
          seg.set('size', s.fontSize);
          seg.set('color', formatPaints(s.fills, opts));
          seg.set('link', s.hyperlink);
          return flow(seg.build());
        }),
      ),
    );
  }

  return f.build();
}

// ================================================================ 值格式化

/** 给 yaml.ts 之外的地方用（切图清单要按同一套规则显示颜色 token）。 */
export function paintText(paints: PaintInfo[] | undefined): string | undefined {
  return formatPaints(paints, { detail: 'compact' });
}

function formatPaints(paints: PaintInfo[] | undefined, opts: SerializeOptions): string | undefined {
  if (!paints?.length) return undefined;
  const visible = paints.filter((p) => p.visible !== false);
  if (visible.length === 0) return undefined;
  return visible.map((p) => formatPaint(p, opts)).join(' + ');
}

function formatPaint(paint: PaintInfo, opts: SerializeOptions): string {
  const suffix = paint.opacity !== undefined ? `@${paint.opacity}` : '';

  switch (paint.kind) {
    case 'solid':
      return (paint.token ? formatToken(paint.token, opts) : (paint.color ?? '?')) + suffix;
    case 'gradient': {
      const stops = paint.stops?.map((s) => s.color).join('→') ?? '';
      return `${paint.gradientType?.toLowerCase() ?? 'gradient'}(${stops})${suffix}`;
    }
    case 'image':
      return `<image${paint.scaleMode ? `:${short(paint.scaleMode)}` : ''}>`;
    case 'video':
      return '<video>';
    default:
      return '<paint>';
  }
}

function formatEffect(effect: EffectInfo, opts: SerializeOptions): string {
  if (effect.token) return formatToken(effect.token, opts);
  const kind =
    effect.type === 'DROP_SHADOW'
      ? 'shadow'
      : effect.type === 'INNER_SHADOW'
        ? 'innerShadow'
        : effect.type === 'LAYER_BLUR'
          ? 'blur'
          : effect.type === 'BACKGROUND_BLUR'
            ? 'bgBlur'
            : effect.type.toLowerCase();

  if (kind === 'blur' || kind === 'bgBlur') return `${kind}(${effect.radius ?? 0})`;

  const bits = [
    effect.offset ? `${effect.offset[0]},${effect.offset[1]}` : '0,0',
    String(effect.radius ?? 0),
    effect.spread ? String(effect.spread) : undefined,
    effect.color,
  ].filter(Boolean);
  return `${kind}(${bits.join(' ')})`;
}

function formatToken(token: TokenRef, opts: SerializeOptions): string {
  const name = `$${token.name}`;
  // compact 只给名字；full 带上解析值，方便核对
  if (opts.detail === 'full' && token.value !== undefined) {
    return `${name}(${String(token.value)})`;
  }
  return name;
}

function formatPadding(pad: [number, number, number, number]): Flow | number {
  const [t, r, b, l] = pad;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return flow([t, r]);
  return flow([t, r, b, l]);
}

/** 枚举值缩写：MIN/MAX/CENTER/SPACE_BETWEEN… 全大写太占 token */
function short(value: string): string {
  const map: Record<string, string> = {
    MIN: 'start',
    MAX: 'end',
    CENTER: 'center',
    SPACE_BETWEEN: 'between',
    BASELINE: 'baseline',
    STRETCH: 'stretch',
    FILL: 'fill',
    HUG: 'hug',
    FIXED: 'fixed',
    SCALE: 'scale',
    LEFT: 'left',
    RIGHT: 'right',
    JUSTIFIED: 'justify',
    TOP: 'top',
    BOTTOM: 'bottom',
    UPPER: 'upper',
    LOWER: 'lower',
    TITLE: 'title',
    UNDERLINE: 'underline',
    STRIKETHROUGH: 'strike',
    WIDTH_AND_HEIGHT: 'wh',
    HEIGHT: 'h',
    TRUNCATE: 'truncate',
    NONE: 'none',
  };
  return map[value] ?? value;
}

/** 归一化空白后比较，用于判断图层名是否只是内容的副本。 */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ================================================================ 其它输出

export function serializeContext(ctx: DocumentContext, opts: SerializeOptions): string {
  const f = new Fields();
  f.set('file', ctx.name);
  f.set('fileKey', ctx.fileKey);
  f.set('docId', ctx.docId);
  f.set('currentPage', flow([['name', ctx.currentPage.name], ['id', ctx.currentPage.id]]));
  f.set(
    'pages',
    ctx.pages.map((p) => flow([['name', p.name], ['id', p.id]])),
  );

  if (ctx.selection.length > 0) {
    f.set(
      'selection',
      ctx.selection.map((node) => renderNode(node, undefined, contextOf(opts))),
    );
  } else {
    f.set('selection', []);
    f.set('hint', '当前没有选中任何节点。让用户在 Figma 里选中目标 Frame，或用 search_nodes 定位');
  }

  return toYaml(f.build());
}

/**
 * `--stat` 的输出：每个直接子节点一行，只报规模。
 *
 * 行数恒定为直接子节点数，不随子树大小增长 —— 这正是它存在的意义：
 * 先花 5 行知道「这棵树 210 个节点」，再决定是展开还是切图。
 */
export function serializeStats(stats: NodeStat[]): string {
  if (stats.length === 0) {
    return toYaml([
      ['stats', []],
      ['hint', '该节点没有子节点'],
    ]);
  }
  return toYaml([
    [
      'stats',
      stats.map((stat) => {
        const f = new Fields();
        f.set('id', stat.id);
        f.set('name', stat.name);
        f.set('type', TYPE_ALIAS[stat.type] ?? stat.type);
        f.set('descendants', stat.descendants);
        f.set('depth', stat.depth);
        if (stat.instance) f.set('instance', true);
        f.set('systemChrome', stat.systemChrome);
        return flow(f.build());
      }),
    ],
  ]);
}

/**
 * 走查结果。
 *
 * 一条一行（flow），因为它是给人扫读的清单不是要逐字段解析的数据；
 * path 用 › 串成可读路径，免去「拿到 id 还得再定位一次」。
 */
/**
 * `figma plan` 的输出。
 *
 * 各段的顺序就是使用顺序：先知道要还原什么（target/structure），
 * 再知道哪些是复用的（components），再拿 token 和切图清单，最后是走查。
 */
export function serializePlan(input: {
  root: NodeInfo;
  structure: NodeInfo[];
  components: ComponentUse[];
  modes: string[];
  colors: { name: string; uses?: number; values: [string, string][] }[];
  textStyles: TextStyleSummary[];
  spacing: SpacingSummary;
  assets: AssetItem[];
  texts: string[];
  findings: LintFinding[];
  sections: readonly PlanSection[];
  opts: SerializeOptions;
}): string {
  const ctx = contextOf(input.opts);
  const want = (section: PlanSection): boolean => input.sections.includes(section);
  const f = new Fields();

  if (want('target')) {
    const target = new Fields();
    target.set('name', input.root.name);
    target.set('id', input.root.id);
    if (input.root.w !== undefined) target.set('size', flow([input.root.w, input.root.h!]));
    if (input.root.clipsContent) target.set('clip', true);
    const fill = input.root.styles?.fill
      ? `@${input.root.styles.fill.name}`
      : formatPaints(input.root.fills, ctx);
    target.set('fill', fill);
    // 根节点有没有 Auto Layout 决定了整页是 flex 流还是绝对定位
    target.set('layoutRoot', input.root.layout ? layoutMode(input.root.layout.mode) : 'absolute');
    const absolute = (input.root.children ?? []).filter(
      (child) => child.layoutChild?.positioning === 'ABSOLUTE' || !input.root.layout,
    ).length;
    if (!input.root.layout && absolute > 0) {
      target.set('note', `${absolute} 个直接子节点靠坐标定位，其余在 Auto Layout 流内`);
    }
    f.set('target', target.build());
  }

  if (want('structure')) {
    f.set('structure', input.structure.map((node) => renderNode(node, undefined, ctx)));
  }

  if (want('components') && input.components.length > 0) {
    f.set(
      'components',
      input.components.map((use) => {
        const item = new Fields();
        item.set('of', use.of);
        if (use.library) item.set('library', true);
        item.set('count', use.count);
        if (use.props.size > 0) {
          item.set(
            'props',
            flow(
              [...use.props].map(
                ([key, values]) => [key, values.size === 1 ? [...values][0]! : flow([...values])] as Entry,
              ),
            ),
          );
        }
        item.set('ids', flow(use.ids));
        item.set('warn', use.resized);
        return flow(item.build());
      }),
    );
  }

  if (want('tokens')) {
    const tokens = new Fields();
    if (input.modes.length > 0) tokens.set('modes', flow(input.modes));
    if (input.modes.some((mode) => /dark|深色|暗色/i.test(mode))) {
      tokens.set('warn', '文件含 Dark mode，代码里的颜色必须是可切换变量，禁止写死单 mode 值');
    }
    if (input.colors.length > 0) {
      tokens.set(
        'colors',
        input.colors.map((color) => {
          const item = new Fields();
          item.set('name', `$${color.name}`);
          item.set('uses', color.uses);
          for (const [mode, value] of color.values) item.set(mode, value);
          return flow(item.build());
        }),
      );
    }
    if (input.textStyles.length > 0) {
      tokens.set(
        'text',
        input.textStyles.map((style) => {
          const item = new Fields();
          item.set('name', `@${style.name}`);
          item.set('uses', style.uses);
          item.set('family', style.family);
          item.set('size', style.size);
          item.set('lineHeight', style.lineHeight);
          item.set('weight', style.weight);
          if (style.measured) item.set('lineHeightFrom', 'measured');
          return flow(item.build());
        }),
      );
    }
    const spacing = new Fields();
    if (input.spacing.scale.length > 0) {
      spacing.set('scale', flow(input.spacing.scale.map(([name, value]) => [name, value] as Entry)));
    }
    if (input.spacing.used.length > 0) spacing.set('used', flow(input.spacing.used));
    if (input.spacing.offScale.length > 0) {
      spacing.set('offScale', flow(input.spacing.offScale));
    }
    if (spacing.length > 0) tokens.set('spacing', spacing.build());
    if (tokens.length > 0) f.set('tokens', tokens.build());
  }

  if (want('assets') && input.assets.length > 0) {
    f.set(
      'assets',
      input.assets.map((asset) => {
        const item = new Fields();
        item.set('id', asset.id);
        item.set('name', asset.name);
        item.set('size', Array.isArray(asset.size) ? flow(asset.size) : asset.size);
        item.set('color', asset.color);
        if (asset.colors) item.set('colors', flow(asset.colors));
        if (asset.unbound) item.set('warn', 'unbound-color');
        return flow(item.build());
      }),
    );
  }

  if (want('text') && input.texts.length > 0) f.set('text', flow(input.texts));

  if (want('lint') && input.findings.length > 0) {
    f.set(
      'lint',
      input.findings.map((item) => {
        const entry = new Fields();
        entry.set('level', item.level);
        entry.set('rule', item.rule);
        entry.set('node', item.node);
        entry.set('path', item.path);
        entry.set('detail', item.detail);
        return flow(entry.build());
      }),
    );
  }

  return toYaml(f.build());
}

export function serializeLint(findings: LintFinding[], darkMode: boolean): string {
  const f = new Fields();
  if (darkMode) {
    f.set('note', '文件含 Dark mode —— 任何裸色值都是 bug，代码里的颜色必须是可切换变量');
  }
  if (findings.length === 0) {
    f.set('findings', []);
    f.set('hint', '没有命中任何规则');
    return toYaml(f.build());
  }
  f.set(
    'findings',
    findings.map((item) => {
      const entry = new Fields();
      entry.set('level', item.level);
      entry.set('rule', item.rule);
      entry.set('node', item.node);
      if (item.nodes) entry.set('nodes', flow(item.nodes));
      entry.set('path', item.path);
      entry.set('of', item.of);
      entry.set('detail', item.detail);
      entry.set('fix', item.fix);
      return flow(entry.build());
    }),
  );
  return toYaml(f.build());
}

export function serializeMatches(matches: NodeMatch[], total: number): string {
  const f = new Fields();
  f.set(
    'matches',
    matches.map((m) =>
      flow([
        ['id', m.id],
        ['type', TYPE_ALIAS[m.type] ?? m.type],
        ['path', m.path],
      ]),
    ),
  );
  f.set('total', total);
  if (total > matches.length) f.set('truncated', `已截断到 ${matches.length} 个，可用 limit 调整`);
  return toYaml(f.build());
}

export function serializeTextItems(items: TextItem[], truncated: boolean): string {
  const f = new Fields();
  f.set(
    'texts',
    // Figma 默认用内容给文本图层命名，原样输出会把整段文案写两遍
    items.map((i) => {
      const item = new Fields();
      item.set('id', i.id);
      if (squash(i.name) !== squash(i.text)) item.set('name', i.name);
      item.set('text', i.text);
      return flow(item.build());
    }),
  );
  if (truncated) f.set('truncated', '已截断，可用 limit 调整');
  return toYaml(f.build());
}

/**
 * 同名集合合并。
 *
 * 同一个 `fd_sys_color` 会从本地、teamLibrary、引用反查三条路各来一份，
 * 变量也跟着重复三四遍，而且各份的 mode 列表还不一定一样。原样输出既浪费
 * 上下文，又会让人以为「有好几个不同的 fd_sys_color」。
 *
 * 合并规则：mode 取并集（缺 mode 的那一份在 note 里点名），变量按名字去重、
 * 值互相补齐。真有一份缺 mode 就说出来，不要静默取并集 —— 那可能是设计系统
 * 本身的问题。
 */
function mergeCollections(collections: VariableCollectionInfo[]): {
  collection: VariableCollectionInfo;
  note?: string;
}[] {
  const groups = new Map<string, VariableCollectionInfo[]>();
  for (const collection of collections) {
    const list = groups.get(collection.name) ?? [];
    list.push(collection);
    groups.set(collection.name, list);
  }

  const out: { collection: VariableCollectionInfo; note?: string }[] = [];
  for (const [name, list] of groups) {
    if (list.length === 1) {
      out.push({ collection: list[0]! });
      continue;
    }

    const modes: { id: string; name: string }[] = [];
    for (const collection of list) {
      for (const mode of collection.modes) {
        if (!modes.some((m) => m.name === mode.name)) modes.push(mode);
      }
    }

    const byName = new Map<string, VariableInfo>();
    for (const collection of list) {
      for (const variable of collection.variables ?? []) {
        const existing = byName.get(variable.name);
        if (!existing) {
          byName.set(variable.name, { ...variable, valuesByMode: { ...variable.valuesByMode } });
          continue;
        }
        for (const [mode, value] of Object.entries(variable.valuesByMode)) {
          existing.valuesByMode[mode] ??= value;
        }
        if (variable.uses !== undefined) {
          existing.uses = Math.max(existing.uses ?? 0, variable.uses);
        }
        existing.description ??= variable.description;
      }
    }

    const variables = [...byName.values()];
    const merged: VariableCollectionInfo = {
      ...list[0]!,
      name,
      modes,
      variableCount: variables.length,
      variables,
    };

    const short = list.filter((c) => c.modes.length > 0 && c.modes.length < modes.length);
    const note =
      short.length > 0
        ? `合并了 ${list.length} 份同名集合，其中 ${short.length} 份缺 mode：` +
          modes
            .filter((m) => short.some((c) => !c.modes.some((x) => x.name === m.name)))
            .map((m) => m.name)
            .join(' / ')
        : `合并了 ${list.length} 份同名集合`;
    out.push({ collection: merged, note });
  }
  return out;
}

export function serializeVariables(collections: VariableCollectionInfo[]): string {
  if (collections.length === 0) {
    return toYaml([
      ['collections', []],
      [
        'hint',
        '这个文件既没有本地变量集合，也读不到外部 Library 的集合。' +
          '设计稿里出现的 $name 仍然可以直接当 design token 名用',
      ],
    ]);
  }

  return toYaml([
    [
      'collections',
      mergeCollections(collections).map(({ collection, note: mergeNote }) => {
        const modes = collection.modes.map((m) => m.name);
        const f = new Fields();
        f.set('name', collection.name);
        f.set('id', collection.id);
        // 外部 Library 的集合拿不到 modes，除非解析了值
        if (modes.length > 0) f.set('modes', flow(modes));
        f.set('variableCount', collection.variableCount);
        f.set('library', collection.libraryName);
        if (collection.remote && !collection.libraryName) f.set('remote', true);
        if (collection.referenced) f.set('source', 'referenced');
        f.set('note', mergeNote);

        const variables = collection.variables ?? [];
        if (variables.length > 0) {
          f.set(
            'variables',
            variables.map((variable) => {
              const v = new Fields();
              v.set('name', `$${variable.name}`);
              v.set('type', variable.type.toLowerCase());
              // 引用次数：高频 token 就是最该先和项目里的变量对齐的那几个
              v.set('uses', variable.uses);

              const values = modes
                .map((mode) => {
                  const value = variable.valuesByMode[mode];
                  if (!value) return undefined;
                  const text =
                    value.kind === 'alias'
                      ? `→$${value.name}${value.resolved !== undefined ? `(${String(value.resolved)})` : ''}`
                      : String(value.value);
                  return [mode, text] as Entry;
                })
                .filter((entry): entry is Entry => entry !== undefined);
              // 单 mode 时键名没信息量，直接给值
              if (values.length === 1) v.set('value', values[0]![1]);
              else if (values.length > 1) v.set('values', flow(values));
              v.set('desc', variable.description);
              return flow(v.build());
            }),
          );
        }
        return f.build();
      }),
    ],
  ]);
}

export function serializeStyles(styles: StyleInfo[]): string {
  if (styles.length === 0) {
    return toYaml([
      ['styles', []],
      ['hint', '本文件没有定义本地样式'],
    ]);
  }

  const opts: SerializeOptions = { detail: 'full' };
  const byType = new Map<string, StyleInfo[]>();
  for (const style of styles) {
    const list = byType.get(style.type) ?? [];
    list.push(style);
    byType.set(style.type, list);
  }

  const groups: Entry[] = [];
  for (const [type, list] of byType) {
    groups.push([
      type,
      list.map((style) => {
        const f = new Fields();
        f.set('name', `@${style.name}`);
        if (style.paints) f.set('paint', formatPaints(style.paints, opts));
        if (style.effects?.length) {
          f.set('effect', style.effects.map((e) => formatEffect(e, opts)).join(' + '));
        }
        if (style.text) {
          const t = style.text;
          // 结构化而不是拼成一行字符串：写 CSS 要的是 font-size / line-height /
          // font-weight 三个独立的值，"Flyme Sans VF Medium 20/auto" 三个都没给全
          const font = new Fields();
          font.set('family', t.fontFamily);
          font.set('style', t.fontStyle);
          const { weight, italic } = parseFontStyle(t.fontStyle);
          font.set('weight', weight);
          if (italic) font.set('italic', true);
          font.set('size', t.fontSize);
          font.set('lineHeight', lineHeightPx(t.lineHeight, t.fontSize) ?? t.lineHeight);
          font.set('tracking', t.letterSpacing);
          if (t.textCase) font.set('case', short(t.textCase));
          f.set('font', flow(font.build()));
          // auto 行高是从页面上单行文本的渲染高度实测的，不是设计师显式给的
          if (t.lineHeightAuto) f.set('lineHeightFrom', 'measured');
        }
        f.set('uses', style.uses);
        if (style.remote) f.set('library', true);
        if (style.referenced) f.set('source', 'referenced');
        f.set('desc', style.description);
        return flow(f.build());
      }),
    ]);
  }

  return toYaml([['styles', groups]]);
}

export function serializeComponents(components: ComponentSummary[], total: number): string {
  const f = new Fields();
  f.set(
    'components',
    components.map((c) => {
      const item = new Fields();
      item.set('kind', c.type === 'COMPONENT_SET' ? 'Set' : 'Component');
      item.set('name', c.name);
      item.set('id', c.id);
      if (c.variantProperties) {
        item.set(
          'variants',
          flow(
            Object.entries(c.variantProperties).map(([k, v]) => [k, flow(v)] as Entry),
          ),
        );
      }
      item.set('variantCount', c.variantCount);
      item.set('page', c.pageName);
      if (c.remote) item.set('library', true);
      item.set('desc', c.description);
      return item.build();
    }),
  );
  f.set('total', total);
  if (total > components.length) {
    f.set('truncated', `已截断到 ${components.length} 个，可用 limit 调整`);
  }
  return toYaml(f.build());
}
