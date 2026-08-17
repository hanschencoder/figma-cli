/**
 * 设计走查。
 *
 * 替代原来那套 `grep -c 'fill: "#'` —— grep 方案有三个躲不开的问题：
 *   1. **会漏**：描边的裸色值格式是 `stroke: {paint: "#000000@0.15"}`，
 *      `grep 'fill: "#'` 抓不到，而那恰恰是最值钱的一类发现（暗色下不可见）。
 *   2. 只给计数不给位置，还得二次定位。
 *   3. 发现不了结构性问题：实例被 detach、实例被拖改尺寸，grep 无能为力。
 *
 * 原则：**只报告，不修改**。每条给出可执行的 fix 建议，做不做是设计侧的决定。
 */

import type { NodeInfo, PaintInfo, VariableCollectionInfo } from '@figma-cli/shared';

export type LintLevel = 'error' | 'warn' | 'info';

export interface LintFinding {
  level: LintLevel;
  rule: string;
  node?: string;
  nodes?: string[];
  path?: string;
  of?: string;
  detail: string;
  fix?: string;
}

export interface LintContext {
  /** 文件里存在 Dark mode —— 裸色值从「不规范」升级为「一定会出错」 */
  darkMode: boolean;
  /** 数值变量刻度表（间距 / 圆角），空表示没有可对照的刻度 */
  spacingScale: number[];
  /** token 名 → 各 mode 的值，用于查重复定义 */
  tokenValues: Map<string, Record<string, string>>;
  /** 系统控件判定，命中的子树整体跳过走查 */
  isSystem: (name: string) => boolean;
}

/** 同一条规则最多报这么多处，其余合并成一句。走查报告不该比设计稿还长。 */
const MAX_PER_RULE = 8;

export function lintTree(roots: NodeInfo[], ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  const counts = new Map<string, number>();

  const push = (finding: LintFinding): void => {
    const seen = counts.get(finding.rule) ?? 0;
    counts.set(finding.rule, seen + 1);
    if (seen < MAX_PER_RULE) findings.push(finding);
  };

  for (const root of roots) walk(root, [], undefined, ctx, push);
  checkDuplicateTokens(ctx, push);

  for (const [rule, count] of counts) {
    if (count > MAX_PER_RULE) {
      findings.push({
        level: 'info',
        rule,
        detail: `该规则共命中 ${count} 处，上面只列了前 ${MAX_PER_RULE} 处`,
      });
    }
  }

  const order: Record<LintLevel, number> = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

function walk(
  node: NodeInfo,
  ancestors: string[],
  parent: NodeInfo | undefined,
  ctx: LintContext,
  push: (finding: LintFinding) => void,
): void {
  // 状态栏这类不是本页的还原对象，它内部的色值规范与否不该占用走查名额
  if (ctx.isSystem(node.name)) return;

  const path = [...ancestors, node.name];
  const where = path.join(' › ');

  checkUnboundPaints(node, where, ctx, push);
  checkUnboundFont(node, where, push);
  checkInstanceResized(node, where, push);
  checkOffScaleSpacing(node, where, ctx, push);
  checkOverflow(node, where, push);
  checkNameMismatch(node, where, push);

  const children = node.children ?? [];
  checkDetached(children, where, push);
  for (const child of children) walk(child, path, node, ctx, push);
}

// ---------------------------------------------------------------- 色值

function checkUnboundPaints(
  node: NodeInfo,
  where: string,
  ctx: LintContext,
  push: (finding: LintFinding) => void,
): void {
  const report = (paints: PaintInfo[] | undefined, kind: 'fill' | 'stroke'): void => {
    for (const paint of paints ?? []) {
      if (paint.kind !== 'solid' || paint.visible === false || paint.token) continue;
      // 有样式引用（@name）时颜色也是有出处的
      if (kind === 'fill' && node.styles?.fill) continue;
      if (kind === 'stroke' && node.styles?.stroke) continue;
      const value = paint.opacity !== undefined ? `${paint.color}@${paint.opacity}` : paint.color;

      if (ctx.darkMode) {
        push({
          level: 'error',
          rule: 'dark-mode-hazard',
          node: node.id,
          path: where,
          detail: `${kind} ${value} 未绑 token；文件含 Dark mode，暗色下该元素会出错`,
          fix: '绑定语义 token，或改用 OnSurface 一类的低透明度别名',
        });
      } else {
        push({
          level: 'warn',
          rule: kind === 'fill' ? 'unbound-fill' : 'unbound-stroke',
          node: node.id,
          path: where,
          detail: `${kind} ${value} 未绑 token`,
          fix: '绑定到设计系统里的语义变量',
        });
      }
    }
  };

  report(node.fills, 'fill');
  report(node.strokes, 'stroke');
}

function checkUnboundFont(
  node: NodeInfo,
  where: string,
  push: (finding: LintFinding) => void,
): void {
  if (!node.text || node.styles?.text) return;
  push({
    level: 'warn',
    rule: 'unbound-font',
    node: node.id,
    path: where,
    detail: `裸字号 ${node.text.fontSize ?? '?'}${node.text.fontStyle ? ` ${node.text.fontStyle}` : ''}，未绑文字样式`,
    fix: '绑定到文字样式，否则代码侧无从判断它该用哪一级排版',
  });
}

// ---------------------------------------------------------------- 结构

/**
 * 实例被 detach。
 *
 * 判据是「同级里多数兄弟是某组件的实例，而这一个是同名的 Frame/Group」——
 * 单看一个节点是看不出来的，必须放在兄弟的语境里，这正是 grep 做不到的事。
 */
function checkDetached(
  children: NodeInfo[],
  where: string,
  push: (finding: LintFinding) => void,
): void {
  if (children.length < 3) return;

  const instanceNames = new Map<string, number>();
  for (const child of children) {
    if (child.type !== 'INSTANCE') continue;
    const of = child.component?.componentSetName ?? child.component?.mainComponentName ?? child.name;
    instanceNames.set(of, (instanceNames.get(of) ?? 0) + 1);
  }

  for (const child of children) {
    if (child.type !== 'FRAME' && child.type !== 'GROUP') continue;
    const count = instanceNames.get(child.name);
    if (count === undefined || count < 2) continue;
    push({
      level: 'warn',
      rule: 'detached-instance',
      node: child.id,
      path: `${where} › ${child.name}`,
      of: child.name,
      detail: `同级有 ${count} 个「${child.name}」实例，此节点是同名 ${child.type}（已 detach）`,
      fix: '重新关联主组件，否则代码侧会把它误判成特例',
    });
  }
}

function checkInstanceResized(
  node: NodeInfo,
  where: string,
  push: (finding: LintFinding) => void,
): void {
  const main = node.component?.mainSize;
  if (!main || node.w === undefined || node.h === undefined) return;
  // fill 的实例本来就该跟着父级变宽，那不是事故
  if (node.layoutChild?.sizingH === 'FILL' || node.layoutChild?.sizingV === 'FILL') return;
  if (Math.abs(main[0] - node.w) < 0.5 && Math.abs(main[1] - node.h) < 0.5) return;

  push({
    level: 'warn',
    rule: 'instance-resized',
    node: node.id,
    path: where,
    of: node.component?.componentSetName ?? node.component?.mainComponentName,
    detail: `实例 ${node.w}×${node.h}，主组件 ${main[0]}×${main[1]}`,
    fix: '确认是有意改的还是误拖；有意的话代码侧需要显式覆盖尺寸',
  });
}

// ---------------------------------------------------------------- 数值

function checkOffScaleSpacing(
  node: NodeInfo,
  where: string,
  ctx: LintContext,
  push: (finding: LintFinding) => void,
): void {
  if (ctx.spacingScale.length === 0 || !node.layout) return;

  const values: [string, number][] = [];
  if (node.layout.gap !== undefined) values.push(['gap', node.layout.gap]);
  for (const [i, side] of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].entries()) {
    const pad = node.layout.padding?.[i];
    if (pad !== undefined && pad !== 0) values.push([side, pad]);
  }

  for (const [name, value] of values) {
    if (ctx.spacingScale.includes(value)) continue;
    push({
      level: 'warn',
      rule: 'off-scale-spacing',
      node: node.id,
      path: where,
      detail: `${name}: ${value} 不在数值变量刻度 (${ctx.spacingScale.join('/')}) 内`,
      fix: '确认是有意的还是手拖出来的；报告给设计师，不要自己改成最近的刻度值',
    });
  }
}

/**
 * 内容超出裁剪容器。
 *
 * 用 abs 判断 —— 有了绝对坐标这件事才算得准，靠逐层累加 pos 是算不对的。
 */
function checkOverflow(
  node: NodeInfo,
  where: string,
  push: (finding: LintFinding) => void,
): void {
  if (!node.clipsContent || node.abs === undefined || node.h === undefined) return;
  const children = node.children ?? [];
  if (children.length === 0) return;

  let bottom = node.abs[1];
  for (const child of children) {
    if (child.abs === undefined || child.h === undefined) return;
    bottom = Math.max(bottom, child.abs[1] + child.h);
  }
  const overflow = bottom - (node.abs[1] + node.h);
  if (overflow <= 0.5) return;

  push({
    level: 'info',
    rule: 'overflow-clip',
    node: node.id,
    path: where,
    detail: `容器高 ${node.h}，子内容底部超出 ${Math.round(overflow * 10) / 10}，且 clip=true`,
    fix: '若这里本来就是滚动区，忽略即可',
  });
}

/** 语义化的图层名（title / icon-search）不算问题，只有「像另一段文案」的才是。 */
const SEMANTIC_NAME = /^[\w\s./-]+$/;

function checkNameMismatch(
  node: NodeInfo,
  where: string,
  push: (finding: LintFinding) => void,
): void {
  if (!node.text) return;
  const name = node.name.trim();
  const content = node.text.characters.trim();
  if (name === content || name === '' || SEMANTIC_NAME.test(name)) return;

  push({
    level: 'info',
    rule: 'layer-name-mismatch',
    node: node.id,
    path: where,
    detail: `图层名「${name}」，内容「${truncate(content)}」`,
    fix: '多半是改了文案没改图层名；会导致切图文件名对不上',
  });
}

function truncate(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

// ---------------------------------------------------------------- token

function checkDuplicateTokens(
  ctx: LintContext,
  push: (finding: LintFinding) => void,
): void {
  const byValue = new Map<string, string[]>();
  for (const [name, values] of ctx.tokenValues) {
    const key = Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mode, value]) => `${mode}=${value}`)
      .join('|');
    if (!key) continue;
    const list = byValue.get(key) ?? [];
    list.push(name);
    byValue.set(key, list);
  }

  for (const [key, names] of byValue) {
    if (names.length < 2) continue;
    push({
      level: 'info',
      rule: 'duplicate-token-value',
      detail: `${names.map((n) => `$${n}`).join(' / ')} 各 mode 的值完全相同（${key}）`,
      fix: '通常是别名没串起来；代码侧照着建变量会多出几个等价的名字',
    });
  }
}

// ---------------------------------------------------------------- 上下文构造

/** 从变量表提取走查需要的两样东西：有没有 Dark mode、数值刻度表。 */
export function lintContextOf(
  collections: VariableCollectionInfo[],
  isSystem: (name: string) => boolean,
): LintContext {
  const darkMode = collections.some((c) =>
    c.modes.some((m) => /dark|深色|暗色/i.test(m.name)),
  );

  const scale = new Set<number>();
  const tokenValues = new Map<string, Record<string, string>>();

  for (const collection of collections) {
    for (const variable of collection.variables ?? []) {
      const values: Record<string, string> = {};
      for (const [mode, value] of Object.entries(variable.valuesByMode)) {
        const text = value.kind === 'alias' ? `→${value.name}` : String(value.value);
        values[mode] = text;
        if (variable.type === 'FLOAT' && value.kind === 'raw' && typeof value.value === 'number') {
          scale.add(value.value);
        }
      }
      if (variable.type === 'COLOR') tokenValues.set(variable.name, values);
    }
  }

  return {
    darkMode,
    spacingScale: [...scale].sort((a, b) => a - b),
    tokenValues,
    isSystem,
  };
}
