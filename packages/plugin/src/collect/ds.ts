/**
 * 设计系统采集：变量、样式、组件。
 *
 * 远端 Library 的策略（v1）：不导出其完整定义，只在被本文件引用时以
 * 「名字 + 解析值」出现。getLocalVariableCollectionsAsync 本来也只给本地集合。
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
  opts: { collectionId?: string; expand: boolean; limit: number },
): Promise<{ collections: VariableCollectionInfo[]; truncated: boolean }> {
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
  opts: { type?: StyleInfo['type']; limit: number },
): Promise<{ styles: StyleInfo[]; truncated: boolean }> {
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

  if (out.length > opts.limit) {
    out.length = opts.limit;
    truncated = true;
  }

  return { styles: out, truncated };
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
