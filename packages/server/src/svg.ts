/**
 * 导出 SVG 的后处理。
 *
 * Figma 导出的 SVG 里颜色是**解析后的字面值**（`fill="black"`、
 * `fill="#3C3C43" fill-opacity="0.6"`），进项目要一个个手改成 currentColor。
 * 这个替换是机械的，但只对**绑了 token 的**颜色安全 —— 裸色值可能是有意的
 * 多色图标，一律换掉就把它改坏了。
 */

/** SVG 里可能出现的颜色关键字。Figma 只用得到这几个。 */
const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  lime: '#00ff00',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
};

/** 归一化成 6 位小写 hex。alpha 不参与比较 —— SVG 里它走 fill-opacity。 */
export function normalizeColor(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (NAMED[text]) return NAMED[text];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const body = hex[1]!;
    if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
    return `#${body.slice(0, 6)}`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) {
      const channels = parts.map((p) =>
        Math.max(0, Math.min(255, Math.round(p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p)))),
      );
      if (channels.every((c) => Number.isFinite(c))) {
        return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      }
    }
  }
  return undefined;
}

export interface CurrentColorResult {
  svg: string;
  /** 被换成 currentColor 的次数 */
  replaced: number;
  /** 保留下来的裸色值 */
  unbound: string[];
}

/**
 * 把绑了 token 的 fill / stroke 换成 currentColor。
 *
 * `tokenColors` 是「这个子树里绑了变量的色值」，由 exportPlan 一起带回来 ——
 * 光看 SVG 是分不清哪个颜色有 token 的。
 */
export function toCurrentColor(svg: string, tokenColors: Set<string>): CurrentColorResult {
  let replaced = 0;
  const unbound = new Set<string>();

  const out = svg.replace(
    /\b(fill|stroke)="([^"]*)"/g,
    (whole, attr: string, value: string) => {
      if (value === 'none' || value.startsWith('url(') || value === 'currentColor') return whole;
      const normalized = normalizeColor(value);
      if (!normalized) return whole;
      if (tokenColors.has(normalized)) {
        replaced++;
        return `${attr}="currentColor"`;
      }
      unbound.add(normalized);
      return whole;
    },
  );

  return { svg: out, replaced, unbound: [...unbound] };
}

/** 只要 `<svg>` 里面的内容 —— 内联进已有 sprite 时外壳是多余的。 */
export function stripWrapper(svg: string): string {
  const open = svg.indexOf('>');
  const close = svg.lastIndexOf('</svg>');
  if (open < 0 || close < 0 || close < open) return svg;
  return svg.slice(open + 1, close).trim();
}

/** SVG 单行化：path 的 d 属性本来就长，换行只是徒增行数。 */
export function compactSvg(svg: string): string {
  return svg.replace(/>\s+</g, '><').trim();
}
