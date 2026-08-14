/**
 * 采集层的公共部分：颜色归一化、变量/样式还原、Paint & Effect 映射。
 *
 * 这里是整个项目相对 REST 方案的核心增量所在 —— 把一个色值反查回它绑定的
 * 变量或样式名。输出 `$color/brand` 而不是 `#0A84FF`，模型才会生成
 * `var(--color-brand)` 而不是硬编码。
 */

import type {
  EffectInfo,
  PaintInfo,
  StyleRef,
  TokenRef,
  VariableResolvedType,
} from '@figma-cli/shared';

// ---------------------------------------------------------------- 颜色

function channel(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** RGB(A) → #RRGGBB，alpha < 1 时输出 #RRGGBBAA。 */
export function toHex(color: RGB | RGBA, extraOpacity = 1): string {
  const alpha = ('a' in color ? color.a : 1) * extraOpacity;
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha >= 0.999 ? base : `${base}${channel(alpha)}`;
}

/** 数字保留最多 2 位小数，去掉无意义的尾零 —— 纯粹为了省 token。 */
export function num(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------- 缓存

/**
 * 单次请求内的解析缓存。
 * 一个 Frame 里几百个节点引用同一批变量是常态，不缓存会产生大量重复 await。
 */
export class ResolveCache {
  private variables = new Map<string, Variable | null>();
  private styles = new Map<string, StyleRef | null>();

  async variable(id: string): Promise<Variable | null> {
    if (this.variables.has(id)) return this.variables.get(id)!;
    let v: Variable | null = null;
    try {
      v = await figma.variables.getVariableByIdAsync(id);
    } catch {
      v = null;
    }
    this.variables.set(id, v);
    return v;
  }

  async style(id: string): Promise<StyleRef | null> {
    if (this.styles.has(id)) return this.styles.get(id)!;
    let ref: StyleRef | null = null;
    try {
      const style = await figma.getStyleByIdAsync(id);
      if (style) {
        ref = { id: style.id, name: style.name };
        if (style.remote) ref.remote = true;
      }
    } catch {
      ref = null;
    }
    this.styles.set(id, ref);
    return ref;
  }
}

// ---------------------------------------------------------------- 变量还原

function formatVariableValue(
  value: VariableValue | undefined,
  type: VariableResolvedType,
): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (type === 'COLOR' && typeof value === 'object' && 'r' in value) {
    return toHex(value as RGBA);
  }
  if (typeof value === 'number') return num(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return undefined;
}

/**
 * 把一个变量绑定还原成 { 名字, 当前上下文的解析值 }。
 *
 * resolveForConsumer 会按 consumer 节点所在的 mode 上下文求值 —— 这正是
 * 我们想要的，而且对远端 Library 变量同样有效（v1 不导出远端集合的完整定义，
 * 只做这种引用级还原）。
 */
export async function resolveToken(
  alias: VariableAlias | undefined,
  consumer: SceneNode | undefined,
  cache: ResolveCache,
): Promise<TokenRef | undefined> {
  if (!alias || alias.type !== 'VARIABLE_ALIAS') return undefined;
  const variable = await cache.variable(alias.id);
  if (!variable) return undefined;

  const ref: TokenRef = { name: variable.name };
  if (variable.remote) ref.remote = true;

  if (consumer) {
    try {
      const resolved = variable.resolveForConsumer(consumer);
      const formatted = formatVariableValue(
        resolved.value,
        resolved.resolvedType as VariableResolvedType,
      );
      if (formatted !== undefined) ref.value = formatted;
    } catch {
      // 某些节点类型不是合法 consumer，退化为只给名字
    }
  }

  // 没有 consumer（比如样式里的绑定）时退回变量自身第一个 mode 的值
  if (ref.value === undefined) {
    ref.value = await fallbackValue(variable, cache);
  }
  return ref;
}

/** 无 consumer 上下文时的兜底取值：取第一个 mode，最多跟随一层别名。 */
async function fallbackValue(
  variable: Variable,
  cache: ResolveCache,
  depth = 0,
): Promise<string | number | boolean | undefined> {
  const modeIds = Object.keys(variable.valuesByMode);
  if (modeIds.length === 0) return undefined;
  const raw = variable.valuesByMode[modeIds[0]!];

  if (isAlias(raw)) {
    if (depth >= 1) return undefined;
    const target = await cache.variable(raw.id);
    return target ? fallbackValue(target, cache, depth + 1) : undefined;
  }
  return formatVariableValue(raw, variable.resolvedType as VariableResolvedType);
}

export function isAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'VARIABLE_ALIAS'
  );
}

export { formatVariableValue };

/** 节点级标量变量绑定（width / cornerRadius / itemSpacing / padding…）。 */
export async function collectNodeTokens(
  node: SceneNode,
  cache: ResolveCache,
): Promise<Record<string, TokenRef> | undefined> {
  const bound = (node as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bound) return undefined;

  const out: Record<string, TokenRef> = {};
  for (const key of Object.keys(bound)) {
    // fills/strokes/effects 是数组，各自在对应的 Paint/Effect 上处理
    if (key === 'fills' || key === 'strokes' || key === 'effects' || key === 'layoutGrids') {
      continue;
    }
    const alias = bound[key] as VariableAlias | undefined;
    const ref = await resolveToken(alias, node, cache);
    if (ref) out[key] = ref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------- Paint

export async function mapPaints(
  paints: readonly Paint[] | typeof figma.mixed | undefined,
  consumer: SceneNode | undefined,
  cache: ResolveCache,
  /** 节点级 boundVariables.fills / .strokes，老版本绑定形式的兜底 */
  nodeLevelAliases?: readonly VariableAlias[],
): Promise<PaintInfo[] | undefined> {
  if (!paints || paints === figma.mixed || paints.length === 0) return undefined;

  const out: PaintInfo[] = [];
  for (let i = 0; i < paints.length; i++) {
    const paint = paints[i]!;
    const info = await mapPaint(paint, consumer, cache, nodeLevelAliases?.[i]);
    if (info) out.push(info);
  }
  return out.length > 0 ? out : undefined;
}

async function mapPaint(
  paint: Paint,
  consumer: SceneNode | undefined,
  cache: ResolveCache,
  fallbackAlias?: VariableAlias,
): Promise<PaintInfo | undefined> {
  const info: PaintInfo = { kind: 'unknown' };
  if (paint.visible === false) info.visible = false;
  if (paint.opacity !== undefined && paint.opacity < 0.999) info.opacity = num(paint.opacity);
  if (paint.blendMode && paint.blendMode !== 'NORMAL') info.blendMode = paint.blendMode;

  switch (paint.type) {
    case 'SOLID': {
      info.kind = 'solid';
      info.color = toHex(paint.color);
      const alias =
        (paint.boundVariables?.color as VariableAlias | undefined) ?? fallbackAlias;
      const token = await resolveToken(alias, consumer, cache);
      if (token) info.token = token;
      return info;
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      info.kind = 'gradient';
      info.gradientType = paint.type.replace('GRADIENT_', '');
      info.stops = paint.gradientStops.map((s) => ({
        color: toHex(s.color),
        pos: num(s.position),
      }));
      return info;
    }
    case 'IMAGE': {
      info.kind = 'image';
      if (paint.scaleMode) info.scaleMode = paint.scaleMode;
      if (paint.imageHash) info.imageHash = paint.imageHash;
      return info;
    }
    case 'VIDEO': {
      info.kind = 'video';
      return info;
    }
    default:
      return info;
  }
}

// ---------------------------------------------------------------- Effect

export async function mapEffects(
  effects: readonly Effect[] | typeof figma.mixed | undefined,
  consumer: SceneNode | undefined,
  cache: ResolveCache,
): Promise<EffectInfo[] | undefined> {
  if (!effects || effects === figma.mixed || effects.length === 0) return undefined;

  const out: EffectInfo[] = [];
  for (const effect of effects) {
    const info: EffectInfo = { type: effect.type };
    if (effect.visible === false) info.visible = false;

    if ('color' in effect && effect.color) info.color = toHex(effect.color as RGBA);
    if ('offset' in effect && effect.offset) {
      info.offset = [num(effect.offset.x), num(effect.offset.y)];
    }
    if ('radius' in effect && typeof effect.radius === 'number') {
      info.radius = num(effect.radius);
    }
    if ('spread' in effect && typeof effect.spread === 'number' && effect.spread !== 0) {
      info.spread = num(effect.spread);
    }

    const alias = (effect as { boundVariables?: Record<string, VariableAlias> })
      .boundVariables?.color;
    const token = await resolveToken(alias, consumer, cache);
    if (token) info.token = token;

    out.push(info);
  }
  return out;
}

// ---------------------------------------------------------------- 样式引用

export async function collectStyleRefs(
  node: SceneNode,
  cache: ResolveCache,
): Promise<Record<string, StyleRef> | undefined> {
  const out: Record<string, StyleRef> = {};
  const pairs: [string, unknown][] = [
    ['fill', (node as { fillStyleId?: unknown }).fillStyleId],
    ['stroke', (node as { strokeStyleId?: unknown }).strokeStyleId],
    ['text', (node as { textStyleId?: unknown }).textStyleId],
    ['effect', (node as { effectStyleId?: unknown }).effectStyleId],
    ['grid', (node as { gridStyleId?: unknown }).gridStyleId],
  ];

  for (const [key, raw] of pairs) {
    if (typeof raw !== 'string' || raw === '') continue;
    const ref = await cache.style(raw);
    if (ref) out[key] = ref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
