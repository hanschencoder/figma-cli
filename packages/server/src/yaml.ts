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
  PaintInfo,
  StyleInfo,
  TextInfo,
  TextItem,
  TokenRef,
  VariableCollectionInfo,
} from '@figma-mcp/shared';

export interface SerializeOptions {
  /** full 会带上 token 的解析值、stroke、effect 细节 */
  detail: 'compact' | 'full';
}

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
export type YamlValue = string | number | boolean | Flow | Entry[] | YamlValue[];

/** 包一层表示「这个结构走 flow 风格」，如 `{mode: vertical, gap: 16}`。 */
class Flow {
  constructor(readonly value: Entry[] | YamlValue[]) {}
}

function flow(value: Entry[] | YamlValue[]): Flow {
  return new Flow(value);
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
  if (value instanceof Flow || !Array.isArray(value) || value.length === 0) return undefined;
  if (isEntries(value)) return undefined;
  if (!(value as YamlValue[]).every((v) => typeof v !== 'object')) return undefined;
  const text = emitFlow(flow(value as YamlValue[]));
  return text.length <= AUTO_FLOW_MAX ? text : undefined;
}

function emit(value: YamlValue, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);

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
      if (item instanceof Flow) {
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

function emitEntry(key: string, value: YamlValue, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);

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
  return toYaml(roots.map((root) => nodeValue(root, undefined, opts)));
}

function nodeValue(node: NodeInfo, parent: NodeInfo | undefined, opts: SerializeOptions): Entry[] {
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

  // 坐标：Auto Layout 流内的子节点位置由布局决定，写出来是噪音
  const inFlow = parent?.layout !== undefined && node.layoutChild?.positioning !== 'ABSOLUTE';
  if (!inFlow && node.x !== undefined && node.y !== undefined && (node.x || node.y)) {
    f.set('pos', flow([node.x, node.y]));
  }
  if (node.layoutChild?.positioning === 'ABSOLUTE') f.set('absolute', true);

  // 自身布局
  if (node.layout) {
    const l = node.layout;
    const layout = new Fields();
    layout.set(
      'mode',
      l.mode === 'HORIZONTAL' ? 'horizontal' : l.mode === 'VERTICAL' ? 'vertical' : 'grid',
    );
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
    f.set(
      'children',
      node.children.map((child) => nodeValue(child, node, opts)),
    );
  }
  // 只标记「还有东西没展开」。具体差几个、为什么没展开，都不值得逐行重复 ——
  // 下钻用的 rootId 就是同一行的 id，截断原因在文档末尾的注释里
  if (node.truncated) f.set('more', true);

  return f.build();
}

function textFields(text: TextInfo, node: NodeInfo, opts: SerializeOptions): Entry[] {
  const f = new Fields();

  if (node.styles?.text) {
    f.set('style', `@${node.styles.text.name}`);
  } else {
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
      ctx.selection.map((node) => nodeValue(node, undefined, opts)),
    );
  } else {
    f.set('selection', []);
    f.set('hint', '当前没有选中任何节点。让用户在 Figma 里选中目标 Frame，或用 search_nodes 定位');
  }

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
      collections.map((collection) => {
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

        const variables = collection.variables ?? [];
        if (variables.length > 0) {
          f.set(
            'variables',
            variables.map((variable) => {
              const v = new Fields();
              v.set('name', `$${variable.name}`);
              v.set('type', variable.type.toLowerCase());

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
          f.set(
            'font',
            [
              t.fontFamily && t.fontStyle ? `${t.fontFamily} ${t.fontStyle}` : t.fontFamily,
              t.fontSize !== undefined ? `${t.fontSize}/${t.lineHeight ?? 'auto'}` : undefined,
              t.letterSpacing ? `tracking=${t.letterSpacing}` : undefined,
              t.textCase ? `case=${short(t.textCase)}` : undefined,
            ]
              .filter(Boolean)
              .join(' '),
          );
        }
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
