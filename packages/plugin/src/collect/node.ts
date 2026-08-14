/**
 * 节点采集。
 *
 * 两档详细度：
 *   compact —— 树/选中项摘要。几何 + 布局 + 填充 + 圆角 + 文本 + 样式引用，
 *              刚好够模型还原一屏 UI 的结构，不含 stroke/effect/富文本分段。
 *   full    —— get_node_detail 用，字段填满。
 *
 * 所有可选字段在"无意义"时省略（opacity=1、visible=true、rotation=0…），
 * 这是控制 token 成本的第一道闸。
 */

import type {
  ComponentInfo,
  ComponentPropertyInfo,
  LayoutChildInfo,
  LayoutInfo,
  NodeInfo,
  TextInfo,
  TextSegment,
} from '@figma-mcp/shared';
import {
  ResolveCache,
  collectNodeTokens,
  collectStyleRefs,
  mapEffects,
  mapPaints,
  num,
  toHex,
} from './common.js';

export type Detail = 'compact' | 'full';

/** compact 模式下单个文本节点最多带多少字符，超出截断。 */
const COMPACT_TEXT_LIMIT = 400;

export interface CollectOptions {
  detail: Detail;
  includeHidden: boolean;
  /**
   * 是否展开组件实例的内部结构。
   * 默认关闭：实例内部是设计系统的实现细节，展开会吃掉绝大部分节点预算，
   * 对生成代码几乎没帮助 —— 实例名 + props 才是有用的信息。
   */
  expandInstances: boolean;
  /** 当前节点是否是本次请求的根。显式请求某个实例的树时应该能看进去 */
  atRoot: boolean;
  /** 剩余可展开的层数 */
  depth: number;
  /** 整棵树的节点预算，防止大文件把 context 撑爆 */
  budget: { remaining: number };
}

export async function collectNode(
  node: BaseNode,
  cache: ResolveCache,
  opts: CollectOptions,
): Promise<NodeInfo> {
  const info: NodeInfo = { id: node.id, name: node.name, type: node.type };
  const scene = node as SceneNode;

  if ('visible' in scene && !scene.visible) info.visible = false;
  if ('locked' in scene && scene.locked) info.locked = true;

  collectGeometry(scene, info);
  collectLayout(scene, info);
  await collectAppearance(scene, info, cache, opts.detail);
  await collectText(scene, info, cache, opts.detail);
  await collectComponent(scene, info, opts.detail);

  if (opts.detail === 'full') {
    const tokens = await collectNodeTokens(scene, cache);
    if (tokens) info.tokens = tokens;
    const exportSettings = (scene as { exportSettings?: readonly unknown[] }).exportSettings;
    if (exportSettings && exportSettings.length > 0) info.exportable = true;
  }

  await collectChildren(node, info, cache, opts);
  return info;
}

// ---------------------------------------------------------------- 几何

function collectGeometry(node: SceneNode, info: NodeInfo): void {
  if ('width' in node) {
    info.w = num(node.width);
    info.h = num(node.height);
  }
  if ('x' in node) {
    info.x = num(node.x);
    info.y = num(node.y);
  }
  if ('rotation' in node && typeof node.rotation === 'number' && Math.abs(node.rotation) > 0.01) {
    info.rotation = num(node.rotation);
  }
  if ('opacity' in node && typeof node.opacity === 'number' && node.opacity < 0.999) {
    info.opacity = num(node.opacity);
  }
  if ('blendMode' in node && node.blendMode && node.blendMode !== 'PASS_THROUGH') {
    info.blendMode = node.blendMode;
  }
  if ('isMask' in node && node.isMask) info.isMask = true;
}

// ---------------------------------------------------------------- 布局

function collectLayout(node: SceneNode, info: NodeInfo): void {
  const asFrame = node as Partial<FrameNode>;

  if (asFrame.layoutMode && asFrame.layoutMode !== 'NONE') {
    const layout: LayoutInfo = { mode: asFrame.layoutMode as LayoutInfo['mode'] };

    if (asFrame.layoutWrap === 'WRAP') layout.wrap = true;
    // SPACE_BETWEEN 下 itemSpacing 无效，由下面的 primaryAlign 表达即可
    if (
      asFrame.primaryAxisAlignItems !== 'SPACE_BETWEEN' &&
      typeof asFrame.itemSpacing === 'number' &&
      asFrame.itemSpacing !== 0
    ) {
      layout.gap = num(asFrame.itemSpacing);
    }
    if (asFrame.layoutWrap === 'WRAP' && typeof asFrame.counterAxisSpacing === 'number') {
      layout.gapCross = num(asFrame.counterAxisSpacing);
    }

    const pad: [number, number, number, number] = [
      num(asFrame.paddingTop ?? 0),
      num(asFrame.paddingRight ?? 0),
      num(asFrame.paddingBottom ?? 0),
      num(asFrame.paddingLeft ?? 0),
    ];
    if (pad.some((p) => p !== 0)) layout.padding = pad;

    if (asFrame.primaryAxisAlignItems && asFrame.primaryAxisAlignItems !== 'MIN') {
      layout.primaryAlign = asFrame.primaryAxisAlignItems;
    }
    if (asFrame.counterAxisAlignItems && asFrame.counterAxisAlignItems !== 'MIN') {
      layout.counterAlign = asFrame.counterAxisAlignItems;
    }
    if (asFrame.itemReverseZIndex) layout.itemReverseZIndex = true;

    info.layout = layout;
  }

  if ('clipsContent' in node && node.clipsContent) info.clipsContent = true;

  // layoutSizing* 比 layoutGrow/layoutAlign 直观得多（FIXED / HUG / FILL），
  // 也正好对应前端的 flex 语义
  const child: LayoutChildInfo = {};
  const sizingH = (node as { layoutSizingHorizontal?: string }).layoutSizingHorizontal;
  const sizingV = (node as { layoutSizingVertical?: string }).layoutSizingVertical;
  if (sizingH && sizingH !== 'FIXED') child.sizingH = sizingH;
  if (sizingV && sizingV !== 'FIXED') child.sizingV = sizingV;
  const positioning = (node as { layoutPositioning?: string }).layoutPositioning;
  if (positioning === 'ABSOLUTE') child.positioning = 'ABSOLUTE';
  if (Object.keys(child).length > 0) info.layoutChild = child;

  // 约束只在父级不是 Auto Layout 时才有意义
  const parentLayoutMode = (node.parent as Partial<FrameNode> | null)?.layoutMode;
  const inFlow = parentLayoutMode && parentLayoutMode !== 'NONE' && positioning !== 'ABSOLUTE';
  if (!inFlow && 'constraints' in node && node.constraints) {
    const { horizontal, vertical } = node.constraints;
    if (horizontal !== 'MIN' || vertical !== 'MIN') {
      info.constraints = { h: horizontal, v: vertical };
    }
  }
}

// ---------------------------------------------------------------- 外观

async function collectAppearance(
  node: SceneNode,
  info: NodeInfo,
  cache: ResolveCache,
  detail: Detail,
): Promise<void> {
  const bound = (node as { boundVariables?: Record<string, unknown> }).boundVariables;

  if ('fills' in node) {
    const fills = await mapPaints(
      node.fills,
      node,
      cache,
      bound?.fills as VariableAlias[] | undefined,
    );
    if (fills) info.fills = fills;
  }

  const radius = collectCornerRadius(node);
  if (radius !== undefined) info.cornerRadius = radius;

  const styles = await collectStyleRefs(node, cache);
  if (styles) info.styles = styles;

  // compact 模式下 effect/stroke 通常不影响布局理解，留给 detail
  if (detail === 'full') {
    if ('strokes' in node) {
      const strokes = await mapPaints(
        node.strokes,
        node,
        cache,
        bound?.strokes as VariableAlias[] | undefined,
      );
      if (strokes) {
        info.strokes = strokes;
        info.strokeWeight = collectStrokeWeight(node);
        if ('strokeAlign' in node && node.strokeAlign !== 'INSIDE') {
          info.strokeAlign = node.strokeAlign;
        }
        if ('dashPattern' in node && node.dashPattern.length > 0) {
          info.dashPattern = [...node.dashPattern];
        }
      }
    }
    if ('effects' in node) {
      const effects = await mapEffects(node.effects, node, cache);
      if (effects) info.effects = effects;
    }
  } else if ('effects' in node && node.effects.length > 0) {
    // compact 只保留"有阴影"这个事实和它的 token，细节留给 detail
    const effects = await mapEffects(node.effects, node, cache);
    if (effects) info.effects = effects;
  }
}

function collectCornerRadius(node: SceneNode): NodeInfo['cornerRadius'] {
  if (!('cornerRadius' in node)) return undefined;
  const radius = node.cornerRadius;
  if (typeof radius === 'number') return radius === 0 ? undefined : num(radius);

  // figma.mixed —— 四角不一致，取各角
  const corners = node as unknown as {
    topLeftRadius?: number;
    topRightRadius?: number;
    bottomRightRadius?: number;
    bottomLeftRadius?: number;
  };
  const values: [number, number, number, number] = [
    num(corners.topLeftRadius ?? 0),
    num(corners.topRightRadius ?? 0),
    num(corners.bottomRightRadius ?? 0),
    num(corners.bottomLeftRadius ?? 0),
  ];
  return values.some((v) => v !== 0) ? values : undefined;
}

function collectStrokeWeight(node: SceneNode): NodeInfo['strokeWeight'] {
  if (!('strokeWeight' in node)) return undefined;
  const weight = node.strokeWeight;
  if (typeof weight === 'number') return num(weight);

  const sides = node as unknown as {
    strokeTopWeight?: number;
    strokeRightWeight?: number;
    strokeBottomWeight?: number;
    strokeLeftWeight?: number;
  };
  return {
    top: num(sides.strokeTopWeight ?? 0),
    right: num(sides.strokeRightWeight ?? 0),
    bottom: num(sides.strokeBottomWeight ?? 0),
    left: num(sides.strokeLeftWeight ?? 0),
  };
}

// ---------------------------------------------------------------- 文本

async function collectText(
  node: SceneNode,
  info: NodeInfo,
  cache: ResolveCache,
  detail: Detail,
): Promise<void> {
  if (node.type !== 'TEXT') return;
  const text = node as TextNode;

  const characters = text.characters;
  const out: TextInfo = {
    characters:
      detail === 'compact' && characters.length > COMPACT_TEXT_LIMIT
        ? `${characters.slice(0, COMPACT_TEXT_LIMIT)}…`
        : characters,
  };

  const mixed: string[] = [];

  if (text.fontName === figma.mixed) {
    mixed.push('fontName');
  } else {
    out.fontFamily = text.fontName.family;
    out.fontStyle = text.fontName.style;
  }

  if (text.fontSize === figma.mixed) mixed.push('fontSize');
  else out.fontSize = num(text.fontSize);

  if (text.lineHeight === figma.mixed) mixed.push('lineHeight');
  else out.lineHeight = formatLineHeight(text.lineHeight);

  if (text.letterSpacing === figma.mixed) mixed.push('letterSpacing');
  else out.letterSpacing = formatLetterSpacing(text.letterSpacing);

  if (text.textCase === figma.mixed) mixed.push('textCase');
  else if (text.textCase !== 'ORIGINAL') out.textCase = text.textCase;

  if (text.textDecoration === figma.mixed) mixed.push('textDecoration');
  else if (text.textDecoration !== 'NONE') out.textDecoration = text.textDecoration;

  if (text.textAlignHorizontal !== 'LEFT') out.textAlignH = text.textAlignHorizontal;
  if (text.textAlignVertical !== 'TOP') out.textAlignV = text.textAlignVertical;
  if (text.textAutoResize !== 'NONE') out.autoResize = text.textAutoResize;

  if (mixed.length > 0) out.mixed = mixed;

  // 富文本分段只在 detail 且确实混排时才给 —— 否则体积翻倍且没有信息量
  if (detail === 'full' && mixed.length > 0) {
    out.segments = await collectSegments(text, cache);
  }

  info.text = out;
}

function formatLineHeight(lineHeight: LineHeight): string {
  if (lineHeight.unit === 'AUTO') return 'auto';
  if (lineHeight.unit === 'PERCENT') return `${num(lineHeight.value)}%`;
  return `${num(lineHeight.value)}px`;
}

function formatLetterSpacing(spacing: LetterSpacing): string | undefined {
  if (spacing.value === 0) return undefined;
  return spacing.unit === 'PERCENT' ? `${num(spacing.value)}%` : `${num(spacing.value)}px`;
}

async function collectSegments(text: TextNode, cache: ResolveCache): Promise<TextSegment[]> {
  const raw = text.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fills',
    'textStyleId',
    'textDecoration',
    'hyperlink',
  ]);

  const out: TextSegment[] = [];
  for (const seg of raw) {
    const item: TextSegment = { text: seg.characters };
    if (seg.fontName) {
      item.fontFamily = seg.fontName.family;
      item.fontStyle = seg.fontName.style;
    }
    if (typeof seg.fontSize === 'number') item.fontSize = num(seg.fontSize);
    if (seg.textDecoration && seg.textDecoration !== 'NONE') {
      item.textDecoration = seg.textDecoration;
    }
    if (seg.hyperlink?.type === 'URL') item.hyperlink = seg.hyperlink.value;
    if (typeof seg.textStyleId === 'string' && seg.textStyleId) {
      const ref = await cache.style(seg.textStyleId);
      if (ref) item.textStyle = ref;
    }
    const fills = await mapPaints(seg.fills, text, cache);
    if (fills) item.fills = fills;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------- 组件

async function collectComponent(
  node: SceneNode,
  info: NodeInfo,
  detail: Detail,
): Promise<void> {
  if (node.type === 'INSTANCE') {
    const instance = node as InstanceNode;
    const component: ComponentInfo = {};
    try {
      const main = await instance.getMainComponentAsync();
      if (main) {
        component.mainComponentId = main.id;
        component.mainComponentName = main.name;
        if (main.remote) component.remote = true;
        if (main.key) component.key = main.key;
        if (main.parent?.type === 'COMPONENT_SET') {
          component.componentSetName = main.parent.name;
        }
      }
    } catch {
      // 主组件可能在未加载的远端库里，拿不到就算了
    }
    const props = mapComponentProperties(instance.componentProperties);
    if (props) component.properties = props;
    info.component = component;
    return;
  }

  if (node.type === 'COMPONENT') {
    const comp = node as ComponentNode;
    const component: ComponentInfo = {};
    if (comp.key) component.key = comp.key;
    if (comp.description) component.description = comp.description;
    if (comp.parent?.type === 'COMPONENT_SET') component.componentSetName = comp.parent.name;
    if (comp.variantProperties) {
      component.properties = Object.fromEntries(
        Object.entries(comp.variantProperties).map(([k, v]) => [
          k,
          { type: 'VARIANT', value: v ?? '' } satisfies ComponentPropertyInfo,
        ]),
      );
    }
    info.component = component;
    return;
  }

  if (node.type === 'COMPONENT_SET' && detail === 'full') {
    const set = node as ComponentSetNode;
    const component: ComponentInfo = {};
    if (set.key) component.key = set.key;
    if (set.description) component.description = set.description;
    const defs = set.componentPropertyDefinitions;
    if (defs) {
      component.properties = Object.fromEntries(
        Object.entries(defs).map(([k, def]) => {
          const item: ComponentPropertyInfo = {
            type: def.type,
            value: (def.defaultValue as string | number | boolean) ?? '',
          };
          if (def.variantOptions) item.options = [...def.variantOptions];
          return [k, item];
        }),
      );
    }
    info.component = component;
  }
}

function mapComponentProperties(
  props: InstanceNode['componentProperties'] | undefined,
): Record<string, ComponentPropertyInfo> | undefined {
  if (!props) return undefined;
  const entries = Object.entries(props);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([key, prop]) => [
      // Figma 会给属性名加 "#123:4" 后缀，对模型是纯噪音
      key.replace(/#\d+:\d+$/, ''),
      { type: prop.type, value: prop.value as string | number | boolean },
    ]),
  );
}

// ---------------------------------------------------------------- 子节点

async function collectChildren(
  node: BaseNode,
  info: NodeInfo,
  cache: ResolveCache,
  opts: CollectOptions,
): Promise<void> {
  if (!('children' in node)) return;
  const children = (node as ChildrenMixin).children;
  const visible = opts.includeHidden
    ? children
    : children.filter((c) => !('visible' in c) || c.visible);

  if (visible.length === 0) return;

  const stopAtInstance = node.type === 'INSTANCE' && !opts.expandInstances && !opts.atRoot;
  if (stopAtInstance) {
    info.childCount = visible.length;
    info.truncated = true;
    info.truncatedBy = 'instance';
    return;
  }

  if (opts.depth <= 0) {
    info.childCount = visible.length;
    info.truncated = true;
    info.truncatedBy = 'depth';
    return;
  }

  const out: NodeInfo[] = [];
  for (const child of visible) {
    if (opts.budget.remaining <= 0) {
      info.childCount = visible.length;
      info.truncated = true;
      info.truncatedBy = 'budget';
      break;
    }
    opts.budget.remaining--;
    out.push(
      await collectNode(child, cache, {
        ...opts,
        atRoot: false,
        depth: opts.depth - 1,
      }),
    );
  }
  if (out.length > 0) info.children = out;
}

// ---------------------------------------------------------------- 导出的小工具

export { ResolveCache, toHex };
