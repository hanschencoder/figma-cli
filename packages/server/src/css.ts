/**
 * Auto Layout → flex CSS 的机械翻译。
 *
 * 这个转换是纯机械、零判断、有唯一正确答案的，但**每次都要重新判断方向**：
 * `justify` / `align` 对应 `justify-content` / `align-items`，在 vertical 时
 * 主轴交叉轴互换；`sizing: {w: fill}` 在主轴上是 `flex:1`、在交叉轴上是
 * `align-self:stretch`。手做十五次总有一次会滑。
 *
 * 明确不做：不猜组件名、不生成 HTML/框架代码、不做响应式断点推断。
 */

import type { NodeInfo, PaintInfo, TokenRef } from '@figma-cli/shared';
import { lineHeightPx, parseFontStyle } from './font.js';

export interface CssOptions {
  /** 变量名前缀，如 `--` */
  varPrefix: string;
  /** 输出整棵子树 */
  nested: boolean;
}

export const DEFAULT_CSS: CssOptions = { varPrefix: '--', nested: false };

interface Decl {
  property: string;
  value: string;
  comment?: string;
}

/** 一个节点的声明块。`parentLayout` 决定 fill 落在主轴还是交叉轴。 */
export function cssRules(root: NodeInfo, opts: CssOptions): string {
  const blocks: string[] = [];
  emitBlock(root, undefined, className(root.name), blocks, opts);
  return blocks.join('\n\n');
}

function emitBlock(
  node: NodeInfo,
  parent: NodeInfo | undefined,
  selector: string,
  blocks: string[],
  opts: CssOptions,
): void {
  const decls = declarations(node, parent, opts);
  const header = `/* ${node.name} · ${node.id} */`;
  const body = decls
    .map((d) => `  ${d.property}: ${d.value};${d.comment ? `  /* ${d.comment} */` : ''}`)
    .join('\n');
  blocks.push(`${header}\n.${selector} {\n${body}\n}`);

  if (!opts.nested) return;
  const used = new Map<string, number>();
  for (const child of node.children ?? []) {
    const base = className(child.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    emitBlock(child, node, `${selector}__${base}${n > 1 ? `-${n}` : ''}`, blocks, opts);
  }
}

function declarations(node: NodeInfo, parent: NodeInfo | undefined, opts: CssOptions): Decl[] {
  const out: Decl[] = [];
  const parentMode = parent?.layout?.mode ?? node.parentLayoutMode;

  // ---- 自身是 Auto Layout 容器
  if (node.layout) {
    const vertical = node.layout.mode === 'VERTICAL';
    out.push({ property: 'display', value: 'flex' });
    out.push({ property: 'flex-direction', value: vertical ? 'column' : 'row' });

    const justify = cssAlign(node.layout.primaryAlign);
    if (justify) out.push({ property: 'justify-content', value: justify });
    const align = cssAlign(node.layout.counterAlign);
    if (align) out.push({ property: 'align-items', value: align });
    if (node.layout.wrap) out.push({ property: 'flex-wrap', value: 'wrap' });

    if (node.layout.gap !== undefined) {
      out.push({ property: 'gap', value: px(node.layout.gap), comment: bindComment(node, 'itemSpacing', opts) });
    }
    if (node.layout.padding) out.push({ property: 'padding', value: cssPadding(node.layout.padding) });
  } else if ((node.children?.length ?? 0) > 0) {
    // 没有 Auto Layout 而有子节点 —— 子节点靠坐标摆，父级必须是定位上下文
    out.push({ property: 'position', value: 'relative', comment: '子节点为绝对定位' });
  }

  // ---- 作为子元素的尺寸行为
  const sizingH = node.layoutChild?.sizingH;
  const sizingV = node.layoutChild?.sizingV;
  if (node.layoutChild?.positioning === 'ABSOLUTE') {
    out.push({ property: 'position', value: 'absolute' });
    if (node.x !== undefined) out.push({ property: 'left', value: px(node.x) });
    if (node.y !== undefined) out.push({ property: 'top', value: px(node.y) });
  }

  if (parentMode) {
    const mainIsH = parentMode === 'HORIZONTAL';
    pushSizing(out, 'w', sizingH, mainIsH, node.w);
    pushSizing(out, 'h', sizingV, !mainIsH, node.h);
  } else {
    if (node.w !== undefined) out.push({ property: 'width', value: px(node.w) });
    if (node.h !== undefined) out.push({ property: 'height', value: px(node.h) });
  }

  // ---- 外观
  const fill = paintValue(node.styles?.fill ? undefined : node.fills, opts);
  if (node.styles?.fill) {
    out.push({ property: 'background', value: varOf(node.styles.fill.name, opts, '@') });
  } else if (fill && !node.text) {
    out.push({ property: 'background', value: fill });
  }
  if (node.text) {
    const color = paintValue(node.fills, opts);
    if (color) out.push({ property: 'color', value: color });
    out.push(...textDecls(node, opts));
  }

  if (node.cornerRadius !== undefined) {
    out.push({
      property: 'border-radius',
      value: Array.isArray(node.cornerRadius)
        ? node.cornerRadius.map(px).join(' ')
        : px(node.cornerRadius),
    });
  }
  if (node.strokes?.length) {
    const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 1;
    const paint = paintValue(node.strokes, opts);
    if (paint) out.push({ property: 'border', value: `${px(weight)} solid ${paint}` });
  }
  if (node.opacity !== undefined) out.push({ property: 'opacity', value: String(node.opacity) });
  if (node.clipsContent) out.push({ property: 'overflow', value: 'hidden' });
  if (node.rotation !== undefined) {
    out.push({ property: 'transform', value: `rotate(${-node.rotation}deg)` });
  }

  const shadow = shadowValue(node);
  if (shadow) out.push({ property: 'box-shadow', value: shadow });

  return out;
}

/**
 * fill / hug / fixed 落到哪个属性上，取决于它在主轴还是交叉轴。
 * hug 输出成注释而不是硬值 —— 那个数字是内容撑出来的结果，写死就锁死了。
 */
function pushSizing(
  out: Decl[],
  axis: 'w' | 'h',
  sizing: string | undefined,
  isMainAxis: boolean,
  value: number | undefined,
): void {
  const property = axis === 'w' ? 'width' : 'height';
  if (sizing === 'FILL') {
    if (isMainAxis) out.push({ property: 'flex', value: '1 1 0', comment: `${property}: fill（主轴）` });
    else out.push({ property: 'align-self', value: 'stretch', comment: `${property}: fill（交叉轴）` });
    return;
  }
  if (sizing === 'HUG') {
    if (value !== undefined) {
      out.push({
        property: property === 'width' ? 'width' : 'height',
        value: 'fit-content',
        comment: `hug；设计稿实测 ${value}px，仅供校验`,
      });
    }
    return;
  }
  if (value !== undefined) out.push({ property, value: px(value) });
}

function textDecls(node: NodeInfo, opts: CssOptions): Decl[] {
  const out: Decl[] = [];
  const text = node.text!;

  if (node.styles?.text) {
    out.push({
      property: 'font',
      value: varOf(node.styles.text.name, opts, '@'),
      comment: '文字样式；具体字号/行高/字重见 figma-cli styles',
    });
    return out;
  }

  if (text.fontFamily) out.push({ property: 'font-family', value: `"${text.fontFamily}"` });
  if (text.fontSize !== undefined) out.push({ property: 'font-size', value: px(text.fontSize) });
  const lineHeight = lineHeightPx(text.lineHeight, text.fontSize);
  if (lineHeight !== undefined) {
    out.push({
      property: 'line-height',
      value: px(lineHeight),
      comment: text.lineHeightAuto ? 'Figma auto，取单行渲染高度' : undefined,
    });
  }
  const { weight, italic } = parseFontStyle(text.fontStyle);
  if (weight !== undefined) out.push({ property: 'font-weight', value: String(weight) });
  if (italic) out.push({ property: 'font-style', value: 'italic' });
  if (text.letterSpacing) out.push({ property: 'letter-spacing', value: text.letterSpacing });
  if (text.textAlignH) out.push({ property: 'text-align', value: text.textAlignH.toLowerCase() });
  if (text.textCase === 'UPPER') out.push({ property: 'text-transform', value: 'uppercase' });
  if (text.textDecoration === 'UNDERLINE') out.push({ property: 'text-decoration', value: 'underline' });
  return out;
}

function shadowValue(node: NodeInfo): string | undefined {
  const shadows = (node.effects ?? []).filter(
    (e) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'),
  );
  if (shadows.length === 0) return undefined;
  return shadows
    .map((e) => {
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      const [x, y] = e.offset ?? [0, 0];
      const spread = e.spread ? ` ${px(e.spread)}` : '';
      return `${inset}${px(x)} ${px(y)} ${px(e.radius ?? 0)}${spread} ${e.color ?? '#0000'}`;
    })
    .join(', ');
}

function paintValue(paints: PaintInfo[] | undefined, opts: CssOptions): string | undefined {
  const paint = (paints ?? []).find((p) => p.visible !== false);
  if (!paint) return undefined;
  if (paint.kind === 'solid') {
    return paint.token ? varOf(paint.token.name, opts, '$', paint.token) : paint.color;
  }
  if (paint.kind === 'gradient') {
    const stops = (paint.stops ?? []).map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ');
    return `linear-gradient(${stops})`;
  }
  if (paint.kind === 'image') return 'url(/* 位图，用 figma-cli export 切出来 */)';
  return undefined;
}

/**
 * token → `var(--slug)`，并在注释里保留原始 token 名。
 *
 * 不带 fallback 字面值是有意的：写了 fallback 就等于给了一条「直接用色值」
 * 的路，而 token 映射本来就是要人去和项目里已有的变量对上号的。
 */
function varOf(name: string, opts: CssOptions, mark: '$' | '@', token?: TokenRef): string {
  return `var(${opts.varPrefix}${slug(name)})  /* ${mark}${name}${token?.value !== undefined ? ` = ${String(token.value)}` : ''} */`;
}

function slug(name: string): string {
  return name
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function className(name: string): string {
  return slug(name) || 'node';
}

function cssAlign(value: string | undefined): string | undefined {
  switch (value) {
    case 'MIN':
      return 'flex-start';
    case 'MAX':
      return 'flex-end';
    case 'CENTER':
      return 'center';
    case 'SPACE_BETWEEN':
      return 'space-between';
    case 'BASELINE':
      return 'baseline';
    default:
      return undefined;
  }
}

function cssPadding(pad: [number, number, number, number]): string {
  const [t, r, b, l] = pad;
  if (t === r && r === b && b === l) return px(t);
  if (t === b && r === l) return `${px(t)} ${px(r)}`;
  return `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
}

function bindComment(node: NodeInfo, key: string, opts: CssOptions): string | undefined {
  const token = node.tokens?.[key];
  return token ? `绑定 $${token.name} → ${opts.varPrefix}${slug(token.name)}` : undefined;
}

function px(value: number): string {
  return value === 0 ? '0' : `${Math.round(value * 100) / 100}px`;
}
