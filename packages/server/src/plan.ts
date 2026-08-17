/**
 * `figma-cli plan` —— 还原前的一站式调研。
 *
 * 标准流程里 ctx / tree / vars / styles / text / components 这几步拿到的
 * 是**同一个子树的不同切面**，每次都重新遍历一遍、每次都要一轮往返。
 * 这里一次问清楚：结构、组件复用、token、切图清单、文案、走查。
 *
 * 目标是一个中等复杂页面控制在 150 行以内 —— 超了就自动降 structure 的深度，
 * 因为其余几段都是聚合结果，不会爆的只有它会。
 */

import type {
  NodeInfo,
  StyleInfo,
  VariableCollectionInfo,
} from '@figma-cli/shared';
import { classifyGraphic, foldIcon, isSystemInset, type FoldOptions } from './fold.js';
import { lineHeightPx, parseFontStyle } from './font.js';
import type { LintFinding } from './lint.js';

export const PLAN_SECTIONS = ['target', 'structure', 'components', 'tokens', 'assets', 'text', 'lint'] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

/** 输出的目标行数。超过就降 structure 深度重来。 */
const LINE_BUDGET = 150;

export interface PlanInput {
  roots: NodeInfo[];
  collections: VariableCollectionInfo[];
  styles: StyleInfo[];
  findings: LintFinding[];
  depth: number;
  sections: PlanSection[];
  fold: FoldOptions;
}

// ---------------------------------------------------------------- 结构裁剪

/**
 * 把深树裁成骨架：限定深度、实例内部一律不展开。
 *
 * 深树本身不进上下文 —— 它只是用来算组件计数、切图清单、文案和走查的原料。
 */
export function pruneTree(node: NodeInfo, depth: number, fold: FoldOptions): NodeInfo {
  const copy: NodeInfo = { ...node };
  const children = node.children ?? [];

  if (children.length === 0) return copy;

  // 会被折叠成一行的节点不裁 —— 裁了反而变成 `more: true` 两行，
  // 而且状态栏的文案和可导出 id 就拿不到了
  if (isSystemInset(node, fold) || foldIcon(node, fold, () => undefined)) return copy;

  if (depth <= 0 || node.type === 'INSTANCE') {
    delete copy.children;
    copy.childCount = children.length;
    copy.descendants = node.descendants ?? countNodes(node);
    copy.truncated = true;
    copy.truncatedBy = node.type === 'INSTANCE' ? 'instance' : 'depth';
    return copy;
  }
  copy.children = children.map((child) => pruneTree(child, depth - 1, fold));
  return copy;
}

export function countNodes(node: NodeInfo): number {
  let count = 0;
  for (const child of node.children ?? []) count += 1 + countNodes(child);
  return count;
}

// ---------------------------------------------------------------- 聚合

export interface ComponentUse {
  of: string;
  count: number;
  library?: boolean;
  ids: string[];
  props: Map<string, Set<string>>;
  resized?: string;
}

/** 组件复用信号：同一个 of 出现多次 → 代码里就该是同一个组件。 */
export function collectComponentUses(roots: NodeInfo[], fold: FoldOptions): ComponentUse[] {
  const byName = new Map<string, ComponentUse>();

  const walk = (node: NodeInfo): void => {
    // 状态栏在 structure 里已经折成一行，它内部的 wifi/信号/5G 也不该出现在这里 ——
    // 这几段是「我要写哪些代码」，而系统控件恰恰是**明确不该还原**的东西
    if (isSystemInset(node, fold)) return;
    if (node.type === 'INSTANCE' && node.component) {
      const of = node.component.componentSetName ?? node.component.mainComponentName ?? node.name;
      const use: ComponentUse =
        byName.get(of) ?? { of, count: 0, ids: [], props: new Map<string, Set<string>>() };
      use.count++;
      if (use.ids.length < 6) use.ids.push(node.id);
      if (node.component.remote) use.library = true;
      for (const [key, prop] of Object.entries(node.component.properties ?? {})) {
        const values = use.props.get(key) ?? new Set<string>();
        values.add(String(prop.value));
        use.props.set(key, values);
      }
      const main = node.component.mainSize;
      if (main && node.w !== undefined && Math.abs(main[0] - node.w) >= 0.5) {
        use.resized = `实例宽 ${node.w} ≠ 主组件宽 ${main[0]}`;
      }
      byName.set(of, use);
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);

  return [...byName.values()].sort((a, b) => b.count - a.count);
}

export interface AssetItem {
  id: string;
  name: string;
  size: number | [number, number];
  color?: string;
  colors?: string[];
  unbound?: boolean;
  /** 见 classifyGraphic —— 决定这张图走 SVG 还是位图 */
  kind?: 'glyph' | 'multicolor' | 'raster';
  vector?: false;
  why?: string;
  shapes?: number;
}

/** 可直接喂给 export 的切图清单。判定复用图标折叠那一套规则。 */
export function collectAssets(
  roots: NodeInfo[],
  fold: FoldOptions,
  paintText: (paints: NodeInfo['fills']) => string | undefined,
): AssetItem[] {
  const out: AssetItem[] = [];
  const seen = new Set<string>();

  const walk = (node: NodeInfo): void => {
    if (isSystemInset(node, fold)) return;
    const icon = foldIcon(node, fold, paintText);
    if (icon) {
      // 同一个图标在页面上出现多次，切一次就够
      const key = `${icon.of ?? icon.name ?? node.name}|${JSON.stringify(icon.size)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const item: AssetItem = { id: node.id, name: icon.of ?? icon.name ?? node.name, size: icon.size };
        if (icon.color) item.color = icon.color;
        if (icon.colors) item.colors = icon.colors;
        if (icon.unbound) item.unbound = true;
        out.push(withGraphic(item, node));
      }
      return;
    }
    if (node.exportable) {
      out.push(
        withGraphic(
          {
            id: node.id,
            name: node.name,
            size: node.w !== undefined && node.h !== undefined ? [node.w, node.h] : 0,
          },
          node,
        ),
      );
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** 切一张图之前必须知道的：它能不能矢量化。判断不了就只能靠导出来看图。 */
function withGraphic(item: AssetItem, node: NodeInfo): AssetItem {
  const g = classifyGraphic(node);
  item.kind = g.kind;
  if (!g.vector) {
    item.vector = false;
    item.why = g.why;
  } else if (g.shapes > 0) {
    item.shapes = g.shapes;
  }
  return item;
}

/** 页面文案，按出现顺序去重。 */
export function collectTexts(roots: NodeInfo[], fold: FoldOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: NodeInfo): void => {
    // 状态栏的 "18:30" / "5G" / "100" 不是页面文案，进不了 strings.xml
    if (isSystemInset(node, fold)) return;
    if (node.text) {
      const text = node.text.characters.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

export interface SpacingSummary {
  scale: [string, number][];
  used: number[];
  offScale: number[];
}

/** 间距：刻度表 + 实际用到的值 + 不在刻度里的可疑值。 */
export function collectSpacing(
  roots: NodeInfo[],
  collections: VariableCollectionInfo[],
): SpacingSummary {
  const scale: [string, number][] = [];
  const scaleValues = new Set<number>();
  for (const collection of collections) {
    for (const variable of collection.variables ?? []) {
      if (variable.type !== 'FLOAT') continue;
      const first = Object.values(variable.valuesByMode)[0];
      if (first?.kind === 'raw' && typeof first.value === 'number') {
        scale.push([variable.name, first.value]);
        scaleValues.add(first.value);
      }
    }
  }

  const used = new Set<number>();
  const walk = (node: NodeInfo): void => {
    if (node.layout?.gap !== undefined) used.add(node.layout.gap);
    for (const pad of node.layout?.padding ?? []) {
      if (pad !== 0) used.add(pad);
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);

  const usedSorted = [...used].sort((a, b) => a - b);
  return {
    scale: scale.sort((a, b) => a[1] - b[1]),
    used: usedSorted,
    offScale: scaleValues.size > 0 ? usedSorted.filter((v) => !scaleValues.has(v)) : [],
  };
}

export interface TextStyleSummary {
  name: string;
  uses?: number;
  family?: string;
  size?: number;
  lineHeight?: number | string;
  weight?: number;
  measured?: boolean;
}

export function collectTextStyles(styles: StyleInfo[]): TextStyleSummary[] {
  return styles
    .filter((style) => style.type === 'TEXT' && style.text)
    .map((style) => {
      const t = style.text!;
      const { weight } = parseFontStyle(t.fontStyle);
      const item: TextStyleSummary = { name: style.name };
      if (style.uses !== undefined) item.uses = style.uses;
      item.family = t.fontFamily;
      item.size = t.fontSize;
      item.lineHeight = lineHeightPx(t.lineHeight, t.fontSize) ?? t.lineHeight;
      item.weight = weight;
      if (t.lineHeightAuto) item.measured = true;
      return item;
    })
    .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0));
}

export { LINE_BUDGET };
