/**
 * 紧凑 DSL 序列化。
 *
 * 同样的信息，原始 JSON 大约是这里输出的 5–10 倍 token。放在 server 侧而不是
 * 插件侧，是因为输出格式最需要反复调试 —— 改完重启 MCP 就生效，不用重载插件。
 *
 * 核心规则：**能还原成 token 引用的，绝不输出原始值。**
 * 记号约定：`$name` = 变量（variable），`@name` = 样式（style）。
 */

import type {
  ComponentSummary,
  DocumentContext,
  NodeInfo,
  NodeMatch,
  PaintInfo,
  StyleInfo,
  TextInfo,
  TextItem,
  TokenRef,
  VariableCollectionInfo,
} from '@figma-mcp/shared';

export interface DslOptions {
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

// ---------------------------------------------------------------- 节点树

export function serializeNodes(roots: NodeInfo[], opts: DslOptions): string {
  const lines: string[] = [];
  for (const root of roots) writeNode(root, undefined, 0, lines, opts);
  return lines.join('\n');
}

function writeNode(
  node: NodeInfo,
  parent: NodeInfo | undefined,
  depth: number,
  lines: string[],
  opts: DslOptions,
): void {
  const indent = '  '.repeat(depth);
  const parts: string[] = [
    `${TYPE_ALIAS[node.type] ?? node.type} ${quote(node.name)} #${node.id}`,
  ];

  const attrs = nodeAttrs(node, parent, opts);
  if (attrs.length > 0) parts.push(attrs.join(' '));

  lines.push(indent + parts.join('  '));

  if (node.children) {
    for (const child of node.children) writeNode(child, node, depth + 1, lines, opts);
  }
  if (node.truncated && node.childCount) {
    const shown = node.children?.length ?? 0;
    lines.push(
      `${indent}  … 还有 ${node.childCount - shown} 个子节点未展开（用 get_node_tree 指定 rootId=#${node.id} 继续下钻）`,
    );
  }
}

function nodeAttrs(node: NodeInfo, parent: NodeInfo | undefined, opts: DslOptions): string[] {
  const out: string[] = [];

  if (node.visible === false) out.push('hidden');
  if (node.locked) out.push('locked');

  // 尺寸
  if (node.w !== undefined && node.h !== undefined) out.push(`${node.w}x${node.h}`);

  // 文本内容是 TEXT 节点最重要的信息，紧跟在标识后面
  if (node.text) out.push(quote(node.text.characters));

  // 坐标：Auto Layout 流内的子节点位置由布局决定，写出来是噪音
  const inFlow =
    parent?.layout !== undefined && node.layoutChild?.positioning !== 'ABSOLUTE';
  if (!inFlow && node.x !== undefined && node.y !== undefined && (node.x || node.y)) {
    out.push(`@${node.x},${node.y}`);
  }
  if (node.layoutChild?.positioning === 'ABSOLUTE') out.push('absolute');

  // 自身布局
  if (node.layout) {
    const l = node.layout;
    out.push(l.mode === 'HORIZONTAL' ? 'autoH' : l.mode === 'VERTICAL' ? 'autoV' : 'grid');
    if (l.wrap) out.push('wrap');
    if (l.gap !== undefined) out.push(`gap=${l.gap}`);
    if (l.gapCross !== undefined) out.push(`gapCross=${l.gapCross}`);
    if (l.padding) out.push(`pad=${formatPadding(l.padding)}`);
    if (l.primaryAlign) out.push(`justify=${short(l.primaryAlign)}`);
    if (l.counterAlign) out.push(`align=${short(l.counterAlign)}`);
  }

  // 作为子元素的尺寸行为
  if (node.layoutChild?.sizingH) out.push(`w=${short(node.layoutChild.sizingH)}`);
  if (node.layoutChild?.sizingV) out.push(`h=${short(node.layoutChild.sizingV)}`);
  if (node.constraints) {
    out.push(`fix=${short(node.constraints.h)}/${short(node.constraints.v)}`);
  }
  if (node.clipsContent) out.push('clip');

  // 填充：样式引用 > 变量 > 原始值。TEXT 节点的填充就是文字颜色，换个更直白的名字
  const fill = node.styles?.fill
    ? `@${node.styles.fill.name}`
    : formatPaints(node.fills, opts);
  if (fill) out.push(`${node.text ? 'color' : 'fill'}=${fill}`);

  if (node.cornerRadius !== undefined) {
    out.push(
      `radius=${Array.isArray(node.cornerRadius) ? node.cornerRadius.join(',') : node.cornerRadius}`,
    );
  }

  if (node.opacity !== undefined) out.push(`opacity=${node.opacity}`);
  if (node.rotation !== undefined) out.push(`rotate=${node.rotation}`);
  if (node.blendMode) out.push(`blend=${node.blendMode}`);
  if (node.isMask) out.push('mask');

  // 描边
  if (node.strokes?.length) {
    const stroke = node.styles?.stroke
      ? `@${node.styles.stroke.name}`
      : formatPaints(node.strokes, opts);
    const weight =
      typeof node.strokeWeight === 'number'
        ? `${node.strokeWeight}px`
        : node.strokeWeight
          ? `${node.strokeWeight.top}/${node.strokeWeight.right}/${node.strokeWeight.bottom}/${node.strokeWeight.left}px`
          : '';
    out.push(`stroke=${[weight, stroke].filter(Boolean).join(' ')}`);
    if (node.strokeAlign) out.push(`strokeAlign=${node.strokeAlign}`);
    if (node.dashPattern?.length) out.push(`dash=${node.dashPattern.join(',')}`);
  }

  // 效果
  if (node.effects?.length) {
    const effect = node.styles?.effect
      ? `@${node.styles.effect.name}`
      : node.effects
          .filter((e) => e.visible !== false)
          .map((e) => formatEffect(e, opts))
          .join(' + ');
    if (effect) out.push(`effect=${effect}`);
  }

  // 文本
  if (node.text) out.push(...textAttrs(node.text, node, opts));

  // 组件
  if (node.component) {
    const c = node.component;
    if (c.mainComponentName) {
      const label = c.componentSetName
        ? `${c.componentSetName}/${c.mainComponentName}`
        : c.mainComponentName;
      out.push(`→ ${quote(label)}${c.remote ? ' (library)' : ''}`);
    }
    if (c.key && !c.mainComponentName) out.push(`key=${c.key}`);
    if (c.properties && Object.keys(c.properties).length > 0) {
      const props = Object.entries(c.properties)
        .map(([k, v]) => `${k}=${String(v.value)}`)
        .join(', ');
      out.push(`props{${props}}`);
    }
    if (c.description && opts.detail === 'full') out.push(`desc=${quote(c.description)}`);
  }

  // 节点级变量绑定（width / itemSpacing / padding…）
  if (node.tokens) {
    const tokens = Object.entries(node.tokens)
      .map(([k, v]) => `${k}=${formatToken(v, opts)}`)
      .join(' ');
    if (tokens) out.push(`bind{${tokens}}`);
  }

  if (node.exportable) out.push('exportable');

  return out;
}

/** 只负责排版属性 —— 文本内容本身已经在前面输出过了。 */
function textAttrs(text: TextInfo, node: NodeInfo, opts: DslOptions): string[] {
  const out: string[] = [];

  if (node.styles?.text) {
    out.push(`font=@${node.styles.text.name}`);
  } else {
    const font = [
      text.fontFamily && text.fontStyle ? `${text.fontFamily} ${text.fontStyle}` : text.fontFamily,
      text.fontSize !== undefined
        ? `${text.fontSize}${text.lineHeight && text.lineHeight !== 'auto' ? `/${text.lineHeight}` : ''}`
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (font) out.push(`font=${font}`);
  }

  if (text.letterSpacing) out.push(`tracking=${text.letterSpacing}`);
  if (text.textAlignH) out.push(`textAlign=${short(text.textAlignH)}`);
  if (text.textAlignV) out.push(`vAlign=${short(text.textAlignV)}`);
  if (text.textCase) out.push(`case=${short(text.textCase)}`);
  if (text.textDecoration) out.push(`decoration=${short(text.textDecoration)}`);
  if (text.autoResize) out.push(`autoResize=${short(text.autoResize)}`);
  if (text.mixed?.length) out.push(`mixed{${text.mixed.join(',')}}`);

  if (opts.detail === 'full' && text.segments?.length) {
    const segments = text.segments
      .map((s) => {
        const bits = [quote(s.text)];
        if (s.textStyle) bits.push(`@${s.textStyle.name}`);
        else if (s.fontFamily) bits.push(`${s.fontFamily} ${s.fontStyle ?? ''}`.trim());
        if (s.fontSize) bits.push(`${s.fontSize}`);
        const color = formatPaints(s.fills, opts);
        if (color) bits.push(color);
        if (s.hyperlink) bits.push(`link=${s.hyperlink}`);
        return bits.join(' ');
      })
      .join(' | ');
    out.push(`segments[${segments}]`);
  }

  return out;
}

// ---------------------------------------------------------------- 值格式化

function formatPaints(paints: PaintInfo[] | undefined, opts: DslOptions): string | undefined {
  if (!paints?.length) return undefined;
  const visible = paints.filter((p) => p.visible !== false);
  if (visible.length === 0) return undefined;
  return visible.map((p) => formatPaint(p, opts)).join(' + ');
}

function formatPaint(paint: PaintInfo, opts: DslOptions): string {
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

function formatEffect(effect: { type: string; color?: string; offset?: [number, number]; radius?: number; spread?: number; token?: TokenRef }, opts: DslOptions): string {
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

function formatToken(token: TokenRef, opts: DslOptions): string {
  const name = `$${token.name}`;
  // compact 只给名字；full 带上解析值，方便核对
  if (opts.detail === 'full' && token.value !== undefined) {
    return `${name}(${String(token.value)})`;
  }
  return name;
}

function formatPadding(pad: [number, number, number, number]): string {
  const [t, r, b, l] = pad;
  if (t === r && r === b && b === l) return String(t);
  if (t === b && r === l) return `${t},${r}`;
  return `${t},${r},${b},${l}`;
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

function quote(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------- 其它输出

export function serializeContext(ctx: DocumentContext, opts: DslOptions): string {
  const lines = [
    `文件: ${ctx.name}${ctx.fileKey ? `  (fileKey ${ctx.fileKey})` : ''}`,
    `docId: ${ctx.docId}`,
    `当前页: ${ctx.currentPage.name} #${ctx.currentPage.id}`,
    `全部页面: ${ctx.pages.map((p) => `${p.name} #${p.id}`).join(' | ')}`,
    '',
    ctx.selection.length > 0
      ? `选中 ${ctx.selection.length} 个节点:`
      : '当前没有选中任何节点。可以让用户在 Figma 里选中目标 Frame，或用 search_nodes 定位。',
  ];
  if (ctx.selection.length > 0) lines.push(serializeNodes(ctx.selection, opts));
  return lines.join('\n');
}

export function serializeMatches(matches: NodeMatch[], total: number): string {
  if (matches.length === 0) return '没有匹配的节点。';
  const lines = matches.map(
    (m) => `#${m.id}  ${TYPE_ALIAS[m.type] ?? m.type}  ${m.path}`,
  );
  if (total > matches.length) {
    lines.push(`… 共 ${total} 个匹配，已截断到 ${matches.length} 个（可用 limit 调整）`);
  }
  return lines.join('\n');
}

export function serializeTextItems(items: TextItem[], truncated: boolean): string {
  if (items.length === 0) return '该子树下没有文本节点。';
  const lines = items.map((i) => `#${i.id}  ${i.name}: ${quote(i.text)}`);
  if (truncated) lines.push('… 已截断（可用 limit 调整）');
  return lines.join('\n');
}

export function serializeVariables(collections: VariableCollectionInfo[]): string {
  if (collections.length === 0) {
    return (
      '本文件没有定义任何本地变量集合。\n' +
      '如果设计 token 定义在独立的 Library 文件里，请在那个文件里运行插件；' +
      '本文件中被引用的远端变量会在节点输出里以 $name 形式出现。'
    );
  }

  const lines: string[] = [];
  for (const collection of collections) {
    const modes = collection.modes.map((m) => m.name);
    lines.push(
      `集合 "${collection.name}" #${collection.id}` +
        `  变量 ${collection.variableCount}  模式 [${modes.join(', ')}]` +
        (collection.remote ? '  (library)' : ''),
    );

    for (const variable of collection.variables ?? []) {
      const values = modes
        .map((mode) => {
          const value = variable.valuesByMode[mode];
          if (!value) return undefined;
          const text =
            value.kind === 'alias'
              ? `→$${value.name}${value.resolved !== undefined ? `(${String(value.resolved)})` : ''}`
              : String(value.value);
          return modes.length === 1 ? text : `${mode}=${text}`;
        })
        .filter(Boolean)
        .join('  ');
      lines.push(`  $${variable.name}  ${variable.type.toLowerCase()}  ${values}`);
      if (variable.description) lines.push(`      // ${variable.description}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function serializeStyles(styles: StyleInfo[]): string {
  if (styles.length === 0) return '本文件没有定义本地样式。';

  const opts: DslOptions = { detail: 'full' };
  const byType = new Map<string, StyleInfo[]>();
  for (const style of styles) {
    const list = byType.get(style.type) ?? [];
    list.push(style);
    byType.set(style.type, list);
  }

  const lines: string[] = [];
  for (const [type, list] of byType) {
    lines.push(`${type} (${list.length})`);
    for (const style of list) {
      const bits: string[] = [`  @${style.name}`];
      if (style.paints) bits.push(formatPaints(style.paints, opts) ?? '');
      if (style.effects) {
        bits.push(style.effects.map((e) => formatEffect(e, opts)).join(' + '));
      }
      if (style.text) {
        const t = style.text;
        bits.push(
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
      if (style.remote) bits.push('(library)');
      lines.push(bits.filter(Boolean).join('  '));
      if (style.description) lines.push(`      // ${style.description}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function serializeComponents(
  components: ComponentSummary[],
  total: number,
): string {
  if (components.length === 0) return '没有找到组件。';

  const lines = components.map((c) => {
    const bits = [`${c.type === 'COMPONENT_SET' ? 'Set' : 'Component'} ${quote(c.name)} #${c.id}`];
    if (c.variantProperties) {
      bits.push(
        `variants{${Object.entries(c.variantProperties)
          .map(([k, v]) => `${k}: ${v.join('|')}`)
          .join(', ')}}`,
      );
    }
    if (c.variantCount) bits.push(`(${c.variantCount} 个变体)`);
    if (c.pageName) bits.push(`page=${c.pageName}`);
    if (c.remote) bits.push('(library)');
    const head = bits.join('  ');
    return c.description ? `${head}\n      // ${c.description}` : head;
  });

  if (total > components.length) {
    lines.push(`… 共 ${total} 个，已截断到 ${components.length} 个（可用 limit 调整）`);
  }
  return lines.join('\n');
}
