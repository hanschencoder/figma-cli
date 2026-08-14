/**
 * 字体 style 名 → CSS 可用的数值。
 *
 * Figma 给的是 "Medium" / "Semi Bold" / "Bold Italic" 这种 PostScript 风格的
 * style 名，而 CSS 要的是 `font-weight: 500` + `font-style: italic`。这个换算
 * 是确定的、有唯一正确答案的，没道理让每个使用者自己查一遍表。
 */

const WEIGHTS: [RegExp, number][] = [
  [/^(thin|hairline)$/, 100],
  [/^(extralight|ultralight)$/, 200],
  [/^light$/, 300],
  [/^(regular|normal|book|roman)$/, 400],
  [/^medium$/, 500],
  [/^(semibold|demibold|demi)$/, 600],
  [/^bold$/, 700],
  [/^(extrabold|ultrabold)$/, 800],
  [/^(black|heavy|fat|poster)$/, 900],
];

export interface FontStyleInfo {
  weight?: number;
  italic?: true;
}

/**
 * 解析 style 名。
 *
 * 认不出来就不给 weight —— 可变字体的 style 名五花八门（"VF Display 55"），
 * 猜一个 400 出来比不给更糟：使用者会照着它写 CSS 而不会去核对。
 */
export function parseFontStyle(style: string | undefined): FontStyleInfo {
  if (!style) return {};
  const out: FontStyleInfo = {};

  let text = style.toLowerCase().replace(/[\s_-]+/g, '');
  if (text.includes('italic') || text.includes('oblique')) {
    out.italic = true;
    text = text.replace(/italic|oblique/g, '');
  }
  if (text === '') {
    // 只有 "Italic"，没写字重 —— 那就是常规字重
    out.weight = 400;
    return out;
  }

  for (const [pattern, weight] of WEIGHTS) {
    if (pattern.test(text)) {
      out.weight = weight;
      return out;
    }
  }
  return out;
}

/** 行高字符串（"21px" / "150%"）里的像素值。百分比要靠字号才能换算。 */
export function lineHeightPx(
  lineHeight: string | undefined,
  fontSize: number | undefined,
): number | undefined {
  if (!lineHeight || lineHeight === 'auto') return undefined;
  const px = /^([\d.]+)px$/.exec(lineHeight);
  if (px) return round(Number(px[1]));
  const percent = /^([\d.]+)%$/.exec(lineHeight);
  if (percent && fontSize !== undefined) return round((Number(percent[1]) / 100) * fontSize);
  return undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
