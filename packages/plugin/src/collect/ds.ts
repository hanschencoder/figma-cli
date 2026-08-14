/**
 * 设计系统采集：变量、样式、组件。
 *
 * 变量分两条路：
 *   - 本文件的：getLocalVariableCollectionsAsync，能拿到 modes 和各 mode 的值
 *   - 外部 Library 的：teamLibrary API 只给「集合名 + 变量名 + 类型」，
 *     要值必须再逐个 importVariableByKeyAsync（见 collectLibraryVariables）
 */

import type {
  ComponentSummary,
  StyleInfo,
  TextInfo,
  VariableCollectionInfo,
  VariableInfo,
  VariableResolvedType,
  VariableValue as TokenValue,
} from '@figma-mcp/shared';
import {
  ResolveCache,
  formatVariableValue,
  isAlias,
  mapEffects,
  mapPaints,
  num,
} from './common.js';

// ---------------------------------------------------------------- 变量

export async function collectVariables(
  cache: ResolveCache,
  opts: {
    collectionId?: string;
    expand: boolean;
    limit: number;
    library?: boolean;
    values?: boolean;
    scan?: boolean;
  },
): Promise<{
  collections: VariableCollectionInfo[];
  truncated: boolean;
  libraryError?: string;
  libraryCount?: number;
  scanned?: number;
}> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const selected = opts.collectionId
    ? all.filter((c) => c.id === opts.collectionId)
    : all;

  const collections: VariableCollectionInfo[] = [];
  let truncated = false;

  for (const collection of selected) {
    const info: VariableCollectionInfo = {
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((m) => ({ id: m.modeId, name: m.name })),
      defaultModeId: collection.defaultModeId,
      variableCount: collection.variableIds.length,
    };
    if (collection.remote) info.remote = true;

    if (opts.expand) {
      const variables: VariableInfo[] = [];
      for (const id of collection.variableIds) {
        if (variables.length >= opts.limit) {
          truncated = true;
          break;
        }
        const variable = await cache.variable(id);
        if (variable) variables.push(await mapVariable(variable, collection, cache));
      }
      info.variables = variables;
    }

    collections.push(info);
  }

  // 外部 Library：设计稿里的 $name 大多来自这里，本地集合为空是常态
  let libraryError: string | undefined;
  let libraryCount: number | undefined;
  if (opts.library !== false && !opts.collectionId) {
    try {
      const { collections: remote, truncated: cut } = await collectLibraryVariables(cache, opts);
      collections.push(...remote);
      libraryCount = remote.length;
      if (cut) truncated = true;
    } catch (err) {
      // 个人草稿文件、没开 teamlibrary 权限、组织策略限制都会走到这里。
      // 这不该让整条命令失败 —— 本地集合还是有价值的
      libraryError = err instanceof Error ? err.message : String(err);
    }
  }

  // teamLibrary 只认「在本文件里启用了的变量库」。业务稿常常只是引用了别人的组件，
  // 组件内部绑着变量、库却没启用 —— 那条路就是空的，但设计稿里明明全是 $name。
  // 所以再兜一层：从页面上真正被引用的变量反查它所属的集合，值和 mode 都能拿到。
  let scanned: number | undefined;
  if (opts.scan !== false && !opts.collectionId) {
    const known = new Set(collections.map((c) => c.id));
    const { collections: referenced, nodes } = await collectReferencedCollections(cache, opts, known);
    collections.push(...referenced);
    scanned = nodes;
  }

  return { collections, truncated, libraryError, libraryCount, scanned };
}

/**
 * 从当前页被引用的变量反查集合。
 *
 * 只需要每个集合里的**任意一个**变量就能拿到 collectionId，进而拿到它的
 * modes 和完整 variableIds —— 所以扫描可以在见到足够多的集合后早早停下。
 */
async function collectReferencedCollections(
  cache: ResolveCache,
  opts: { expand: boolean; limit: number },
  known: Set<string>,
): Promise<{ collections: VariableCollectionInfo[]; nodes: number }> {
  const page = figma.currentPage;
  const nodes = 'findAll' in page ? page.findAll(hasBoundVariables) : [];

  const variableIds = new Set<string>();
  for (const node of nodes.slice(0, SCAN_NODE_LIMIT)) {
    for (const id of boundVariableIds(node)) variableIds.add(id);
  }

  // collectionId → 这个集合里被引用到的变量 id。
  // 远端集合的 variableIds 有时是空的，那时候至少还有这些兜底
  const byCollection = new Map<string, Set<string>>();
  for (const id of variableIds) {
    const variable = await cache.variable(id);
    if (!variable || known.has(variable.variableCollectionId)) continue;
    const set = byCollection.get(variable.variableCollectionId) ?? new Set<string>();
    set.add(id);
    byCollection.set(variable.variableCollectionId, set);
  }

  const out: VariableCollectionInfo[] = [];
  for (const [collectionId, referencedIds] of byCollection) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    if (!collection) continue;

    // 集合自报的变量 ∪ 实际引用到的变量
    const ids = [...new Set([...collection.variableIds, ...referencedIds])];
    if (ids.length === 0) continue;

    const info: VariableCollectionInfo = {
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((m) => ({ id: m.modeId, name: m.name })),
      defaultModeId: collection.defaultModeId,
      variableCount: ids.length,
      referenced: true,
    };
    if (collection.remote) info.remote = true;

    if (opts.expand) {
      const variables: VariableInfo[] = [];
      for (const id of ids.slice(0, opts.limit)) {
        const variable = await cache.variable(id);
        if (variable) variables.push(await mapVariable(variable, collection, cache));
      }
      info.variables = variables;
    }
    out.push(info);
  }

  return { collections: out, nodes: Math.min(nodes.length, SCAN_NODE_LIMIT) };
}

/** 扫描节点数上限。大页面上全量遍历会卡住 Figma 主线程。 */
const SCAN_NODE_LIMIT = 3000;

function hasBoundVariables(node: SceneNode): boolean {
  const bound = (node as { boundVariables?: Record<string, unknown> }).boundVariables;
  return bound !== undefined && Object.keys(bound).length > 0;
}

function boundVariableIds(node: SceneNode): string[] {
  const bound = (node as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bound) return [];
  const out: string[] = [];
  for (const value of Object.values(bound)) {
    // 标量绑定是单个 alias，fills / strokes / effects 这些是 alias 数组
    for (const alias of Array.isArray(value) ? value : [value]) {
      const id = (alias as VariableAlias | undefined)?.id;
      if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

/**
 * 外部 Library 的变量集合。
 *
 * teamLibrary 只给描述性信息（集合名 / 变量名 / 类型），没有 modes、没有值。
 * 要值就得 importVariableByKeyAsync 把每个变量单独取回来 —— 一次一个调用，
 * 所以 values 默认关着。真取回来了，顺带就能从它的 collectionId 反查出 modes。
 */
async function collectLibraryVariables(
  cache: ResolveCache,
  opts: { expand: boolean; limit: number; values?: boolean },
): Promise<{ collections: VariableCollectionInfo[]; truncated: boolean }> {
  const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  const collections: VariableCollectionInfo[] = [];
  let truncated = false;

  for (const libraryCollection of available) {
    const entries = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
      libraryCollection.key,
    );

    const info: VariableCollectionInfo = {
      id: libraryCollection.key,
      name: libraryCollection.name,
      libraryName: libraryCollection.libraryName,
      remote: true,
      modes: [],
      variableCount: entries.length,
    };

    if (opts.expand) {
      const variables: VariableInfo[] = [];
      for (const entry of entries) {
        if (variables.length >= opts.limit) {
          truncated = true;
          break;
        }

        if (!opts.values) {
          variables.push({
            id: entry.key,
            name: entry.name,
            type: entry.resolvedType as VariableResolvedType,
            valuesByMode: {},
          });
          continue;
        }

        const imported = await figma.variables.importVariableByKeyAsync(entry.key);
        const collection = await figma.variables.getVariableCollectionByIdAsync(
          imported.variableCollectionId,
        );
        if (collection && info.modes.length === 0) {
          info.modes = collection.modes.map((m) => ({ id: m.modeId, name: m.name }));
          info.defaultModeId = collection.defaultModeId;
        }
        variables.push(
          collection
            ? await mapVariable(imported, collection, cache)
            : {
                id: entry.key,
                name: entry.name,
                type: entry.resolvedType as VariableResolvedType,
                valuesByMode: {},
              },
        );
      }
      info.variables = variables;
    }

    collections.push(info);
  }

  return { collections, truncated };
}

async function mapVariable(
  variable: Variable,
  collection: VariableCollection,
  cache: ResolveCache,
): Promise<VariableInfo> {
  const type = variable.resolvedType as VariableResolvedType;
  const info: VariableInfo = {
    id: variable.id,
    name: variable.name,
    type,
    valuesByMode: {},
  };
  if (variable.description) info.description = variable.description;
  if (variable.remote) info.remote = true;

  // scopes 默认是 ["ALL_SCOPES"]，没信息量就不带
  const scopes = variable.scopes;
  if (scopes.length > 0 && !(scopes.length === 1 && scopes[0] === 'ALL_SCOPES')) {
    info.scopes = [...scopes];
  }

  for (const mode of collection.modes) {
    const raw = variable.valuesByMode[mode.modeId];
    if (raw === undefined) continue;
    info.valuesByMode[mode.name] = await mapVariableValue(raw, type, cache);
  }

  return info;
}

async function mapVariableValue(
  raw: unknown,
  type: VariableResolvedType,
  cache: ResolveCache,
): Promise<TokenValue> {
  if (isAlias(raw)) {
    const target = await cache.variable(raw.id);
    const value: TokenValue = { kind: 'alias', name: target?.name ?? raw.id };
    if (target) {
      const targetModes = Object.keys(target.valuesByMode);
      const targetRaw = targetModes.length > 0 ? target.valuesByMode[targetModes[0]!] : undefined;
      if (!isAlias(targetRaw)) {
        const resolved = formatVariableValue(
          targetRaw as VariableValue | undefined,
          target.resolvedType as VariableResolvedType,
        );
        if (resolved !== undefined) value.resolved = resolved;
      }
    }
    return value;
  }

  const formatted = formatVariableValue(raw as VariableValue, type);
  return { kind: 'raw', value: formatted ?? '' };
}

// ---------------------------------------------------------------- 样式

export async function collectStyles(
  cache: ResolveCache,
  opts: { type?: StyleInfo['type']; limit: number; scan?: boolean },
): Promise<{ styles: StyleInfo[]; truncated: boolean; scanned?: number }> {
  const out: StyleInfo[] = [];
  let truncated = false;

  const wants = (t: StyleInfo['type']) => !opts.type || opts.type === t;

  if (wants('PAINT')) {
    for (const style of await figma.getLocalPaintStylesAsync()) {
      const info = base(style, 'PAINT');
      const paints = await mapPaints(style.paints, undefined, cache);
      if (paints) info.paints = paints;
      out.push(info);
    }
  }

  if (wants('TEXT')) {
    for (const style of await figma.getLocalTextStylesAsync()) {
      const info = base(style, 'TEXT');
      info.text = textStyleInfo(style);
      out.push(info);
    }
  }

  if (wants('EFFECT')) {
    for (const style of await figma.getLocalEffectStylesAsync()) {
      const info = base(style, 'EFFECT');
      const effects = await mapEffects(style.effects, undefined, cache);
      if (effects) info.effects = effects;
      out.push(info);
    }
  }

  if (wants('GRID')) {
    for (const style of await figma.getLocalGridStylesAsync()) {
      out.push(base(style, 'GRID'));
    }
  }

  // 和变量同一个问题：样式基本都定义在远端库里，getLocal* 只给本文件的。
  // 节点上的 fillStyleId / textStyleId 拿去 getStyleByIdAsync 对远端样式同样有效，
  // 所以扫一遍页面就能把「实际用到的那些样式」的完整定义反查出来。
  let scanned: number | undefined;
  if (opts.scan !== false) {
    const known = new Set(out.map((style) => style.id));
    const { styles: referenced, nodes } = await collectReferencedStyles(cache, opts, known);
    out.push(...referenced);
    scanned = nodes;
  }

  if (out.length > opts.limit) {
    out.length = opts.limit;
    truncated = true;
  }

  return { styles: out, truncated, scanned };
}

/** 节点上可能挂样式的字段。mixed（富文本里多段不同样式）直接跳过。 */
const STYLE_FIELDS = [
  'fillStyleId',
  'strokeStyleId',
  'textStyleId',
  'effectStyleId',
  'gridStyleId',
] as const;

function nodeStyleIds(node: SceneNode): string[] {
  const out: string[] = [];
  for (const field of STYLE_FIELDS) {
    const value = (node as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string' && value) out.push(value);
  }
  return out;
}

async function collectReferencedStyles(
  cache: ResolveCache,
  opts: { type?: StyleInfo['type']; limit: number },
  known: Set<string>,
): Promise<{ styles: StyleInfo[]; nodes: number }> {
  const page = figma.currentPage;
  const nodes = 'findAll' in page ? page.findAll((n) => nodeStyleIds(n).length > 0) : [];

  const ids = new Set<string>();
  for (const node of nodes.slice(0, SCAN_NODE_LIMIT)) {
    for (const id of nodeStyleIds(node)) {
      if (!known.has(id)) ids.add(id);
    }
  }

  const wants = (t: StyleInfo['type']) => !opts.type || opts.type === t;
  const out: StyleInfo[] = [];

  for (const id of ids) {
    if (out.length >= opts.limit) break;
    const style = await figma.getStyleByIdAsync(id);
    if (!style) continue;

    switch (style.type) {
      case 'PAINT': {
        if (!wants('PAINT')) continue;
        const info = base(style, 'PAINT');
        const paints = await mapPaints((style as PaintStyle).paints, undefined, cache);
        if (paints) info.paints = paints;
        info.referenced = true;
        out.push(info);
        break;
      }
      case 'TEXT': {
        if (!wants('TEXT')) continue;
        const info = base(style, 'TEXT');
        info.text = textStyleInfo(style as TextStyle);
        info.referenced = true;
        out.push(info);
        break;
      }
      case 'EFFECT': {
        if (!wants('EFFECT')) continue;
        const info = base(style, 'EFFECT');
        const effects = await mapEffects((style as EffectStyle).effects, undefined, cache);
        if (effects) info.effects = effects;
        info.referenced = true;
        out.push(info);
        break;
      }
      case 'GRID': {
        if (!wants('GRID')) continue;
        const info = base(style, 'GRID');
        info.referenced = true;
        out.push(info);
        break;
      }
      default:
        break;
    }
  }

  return { styles: out, nodes: Math.min(nodes.length, SCAN_NODE_LIMIT) };
}

function base(style: BaseStyle, type: StyleInfo['type']): StyleInfo {
  const info: StyleInfo = { id: style.id, name: style.name, type };
  if (style.description) info.description = style.description;
  if (style.remote) info.remote = true;
  return info;
}

function textStyleInfo(style: TextStyle): TextInfo {
  const info: TextInfo = {
    characters: '',
    fontFamily: style.fontName.family,
    fontStyle: style.fontName.style,
    fontSize: num(style.fontSize),
  };
  info.lineHeight =
    style.lineHeight.unit === 'AUTO'
      ? 'auto'
      : style.lineHeight.unit === 'PERCENT'
        ? `${num(style.lineHeight.value)}%`
        : `${num(style.lineHeight.value)}px`;
  if (style.letterSpacing.value !== 0) {
    info.letterSpacing =
      style.letterSpacing.unit === 'PERCENT'
        ? `${num(style.letterSpacing.value)}%`
        : `${num(style.letterSpacing.value)}px`;
  }
  if (style.textCase !== 'ORIGINAL') info.textCase = style.textCase;
  if (style.textDecoration !== 'NONE') info.textDecoration = style.textDecoration;
  return info;
}

// ---------------------------------------------------------------- 组件

export async function collectComponents(
  pages: readonly PageNode[],
  opts: { query?: string; limit: number },
): Promise<{ components: ComponentSummary[]; total: number; truncated: boolean }> {
  const needle = opts.query?.toLowerCase();
  const out: ComponentSummary[] = [];
  let total = 0;

  for (const page of pages) {
    await page.loadAsync();
    const found = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });

    for (const node of found) {
      // COMPONENT_SET 下的变体单独列出来只是噪音，父级已经带了变体属性
      if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') continue;
      if (needle && !node.name.toLowerCase().includes(needle)) continue;

      total++;
      if (out.length >= opts.limit) continue;

      const summary: ComponentSummary = {
        id: node.id,
        name: node.name,
        type: node.type,
        pageName: page.name,
      };
      if (node.key) summary.key = node.key;
      if (node.description) summary.description = node.description;
      if (node.remote) summary.remote = true;

      if (node.type === 'COMPONENT_SET') {
        const defs = node.variantGroupProperties;
        if (defs) {
          summary.variantProperties = Object.fromEntries(
            Object.entries(defs).map(([k, v]) => [k, [...v.values]]),
          );
        }
        summary.variantCount = node.children.length;
      }

      out.push(summary);
    }
  }

  return { components: out, total, truncated: total > out.length };
}
