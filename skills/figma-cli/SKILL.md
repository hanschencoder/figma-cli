---
name: figma-cli
description: 读取本地 Figma 设计稿并还原成 Android 界面代码（Jetpack Compose 与原生 View/XML）——读结构与布局、提取 design token（变量/样式）映射到 MaterialTheme 或 colors.xml、抽文案进 strings.xml、切图转 VectorDrawable、导截图对照。当用户提到 Figma、设计稿、还原设计、切图、design token、组件变体，或让你「照着这个设计实现」时使用。通过 figma-cli 命令直连 Figma 桌面版插件，没有 REST API 的速率限制。
---

# 读 Figma 设计稿，写出对得上的 Android 界面

`figma-cli` 命令直接读用户此刻在 Figma 桌面版里打开的文档，数据来自 Plugin API，看到的永远是屏幕上当前的样子——包括未保存的编辑和实例覆盖。

**这套工具相对截图识别的全部价值在于：设计稿里的语义被保留了下来。**颜色不是 `#000000` 而是 `$文字图形/OnSurface`（→ `colorScheme.onSurface`），字体不是 17px 而是 `@Headline/medium`（→ `typography.headlineMedium`），布局不是坐标而是 Auto Layout（→ `Column` / `LinearLayout`）。**丢掉这些语义、照着坐标和色值堆 UI，就白读了。**

**默认目标是 Jetpack Compose。** 项目里如果是 XML 布局（有 `res/layout/`、`ViewBinding`、`ConstraintLayout` 依赖），就走 View 那一路——**先看项目用的是哪个，不要问都不问就写 Compose**。两条路的映射本文都给。

## 前提

Figma 桌面版开着，且「Figma CLI Bridge」插件在运行。报 `NO_DOCUMENT` 就是插件没跑，让用户去 `Plugins → Development → Figma CLI Bridge`。daemon 首次执行时自动拉起，不用管。

---

## 一、还原一个页面的标准流程

```bash
figma-cli ctx                                  # 1. 用户在哪个文件、哪一页、选中了什么
figma-cli image <id>                           # 2. 先看一眼整体（Read 工具读打印出的路径）
figma-cli plan <id>                            # 3. 一站式调研 —— 结构/组件/token/切图清单/文案/走查
# → 确认 dp 基准（第二节）、确认项目是 Compose 还是 XML、确认项目已有的主题与组件 →
figma-cli tree --root-id <id> --depth 4        #    某一块结构看不够细时再单独下钻
figma-cli export <id...> --format SVG --out …  # 4. 切图 → 转 VectorDrawable（第六节）
# → 写代码 →
figma-cli image <id>                           # 5. 再导一次，和你跑出来的截图对照
```

**永远先 `figma-cli ctx`。** 不知道用户在看什么就开始猜是浪费时间。

**第 3 步是主力。** `figma-cli plan` 一次给出：目标尺寸与根布局、深度可控的结构骨架、组件复用清单（同一个组件出现了几次、id 分别是哪些）、**这个子树实际用到的**颜色与文字 token（带引用次数）、间距刻度与可疑值、可直接切图的资源清单、全部文案、以及设计走查发现。中等复杂页面控制在 150 行以内。

只要其中几段：`figma-cli plan <id> --only tokens,assets`。

**token 那一段不能跳过。** 结构告诉你「这里用了 `$主题色/Base/Primary`」，token 表才告诉你它是什么、有几套模式（Light/Dark）、该对应 `MaterialTheme` 里的哪个槽位。只读结构不读 token，你会把 `$容器/SurfaceContainer` 当成一个不认识的字符串扔掉，然后硬编码一个 `Color(0xFF1C1B1F)` —— 暗色模式当场崩掉。

**写代码前必须先看项目已有的东西**：`Theme.kt` / `Color.kt` / `Type.kt`，或 `res/values/colors.xml`、`themes.xml`、`dimens.xml`。设计稿的 token 要落到**项目里已有的名字**上，没有对应的就报告给用户，不要自己造。

---

## 二、单位：px → dp / sp

Figma 输出的所有数值都是**设计稿像素**。Android 侧要先定一个换算基准，定错了整页都偏。

**先看根 Frame 的宽度**（`figma-cli plan` 第一行就有）：

| 根宽 | 含义 | 换算 |
|---|---|---|
| 360 / 375 / 390 / 392 / 412 / 414 | **1x 稿**（绝大多数情况） | `1px = 1dp`，直接用 |
| 720 / 750 / 1080 / 1125 | 2x / 3x 稿 | 全部除以 2 或 3 再用 |

**1x 稿是常态，直接把数字当 dp 写。** 拿不准就看状态栏高度：24 或 34 左右 = 1x，48 / 72 = 2x / 3x。**换算基准要在交付说明里写清楚。**

- 尺寸、间距、圆角、描边宽度 → `dp`（`16.dp` / `16dp`）
- **字号和行高 → `sp`**（`16.sp` / `16sp`）。绝不用 dp 写字号，那会让系统字体缩放失效。
- 1x 稿里出现 `.5` 的小数（`gap: 0.5`、`stroke: 0.5`）是正常的，`0.5.dp` 合法；但出现 `[66.9, 22]` 这种脏尺寸多半是设计稿没对齐，`figma-cli lint` 会报出来。

**别把设计稿宽度写死进布局。** 根 Frame 的 `size: [392, 215]` 里，392 是画板宽，对应 `fillMaxWidth()` / `match_parent`，不是 `width(392.dp)`。

---

## 三、读懂输出：YAML 字段 → Compose / View

输出全是 YAML，无意义的字段一律省略。

```yaml
- type: Frame
  name: 内容框
  id: "1:3640"
  size: [392, 215]
  abs: [0, 96]
  layout: {mode: vertical, gap: 16, padding: [0, 20], justify: center, align: center}
  sizing: {w: fill, h: hug}
  fill: $容器/SurfaceContainer
  radius: 12
  children:
    - type: Text
      id: "1:3644"
      text: 明白，您希望每天上午9点…
      color: $文字图形/OnSurface
      font: {style: "@Headline/medium"}
```

对应：

```kotlin
Column(
    modifier = Modifier
        .fillMaxWidth()
        .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(12.dp))
        .padding(horizontal = 20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    horizontalAlignment = Alignment.CenterHorizontally,
) {
    Text("明白，您希望每天上午9点…",
        style = MaterialTheme.typography.headlineMedium,
        color = MaterialTheme.colorScheme.onSurface)
}
```

### 字段对照表

| 字段 | Compose | View / XML |
|---|---|---|
| `layout: {mode: vertical}` | `Column` | `LinearLayout` `orientation="vertical"` |
| `layout: {mode: horizontal}` | `Row` | `LinearLayout` `orientation="horizontal"` |
| 没有 `layout` 但有多个 children | `Box` | `FrameLayout` / `ConstraintLayout` |
| `layout.gap` | `Arrangement.spacedBy(n.dp)` | 子项 margin，或 `LinearLayout` 的 divider / `Flow` |
| `layout.padding` | `Modifier.padding(...)` | `android:padding*` |
| `layout.padding` 顺序 | **CSS 顺序**：1个=四边，2个=上下/左右，4个=**上 右 下 左** | 右→`End`，左→`Start`（RTL） |
| `layout.justify` | 主轴 `Arrangement`：`start/center/end/between`→`Start/Center/End/SpaceBetween` | `gravity` / `layout_constraint*_chainStyle` |
| `layout.align` | 交叉轴 `horizontalAlignment` / `verticalAlignment` | `gravity` |
| `sizing: {w: fill}` | **主轴上** `Modifier.weight(1f)`；**交叉轴上** `fillMaxWidth()` | 主轴 `0dp + layout_weight`；交叉轴 `match_parent` |
| `sizing: {w: hug}` | 不写 modifier（默认 wrap） | `wrap_content` |
| `sizing: {w: fixed}` 或没有 sizing | `Modifier.width(n.dp)` | `n dp` |
| `size: [w, h]` | 宽高。**父级是 Auto Layout 时优先照 `sizing` 写，别硬编码这两个数** | 同左 |
| `abs: [x, y]` | **相对本次 `--root-id` 左上角**的绝对坐标，见第五节 | 同左 |
| `pos: [x, y]` | 相对父级；只在**非** Auto Layout 流内出现 → `Box` + `Modifier.offset(x.dp, y.dp)` | `ConstraintLayout` margin / `FrameLayout` margin |
| `absolute: true` | 在 Auto Layout 里被设成绝对定位 → 外层包 `Box`，该项用 `Modifier.align()` + `offset()` | `FrameLayout` 子项 |
| `fill: $token` | `Modifier.background(colorScheme.x, shape)` | `android:background` / shape drawable |
| `fill` 是渐变 | `Brush.linearGradient(...)` + `background(brush, shape)` | `<gradient>` shape drawable |
| `color` | `Text(color = …)` | `android:textColor` |
| `stroke: {paint, weight}` | `Modifier.border(w.dp, color, shape)` | shape drawable `<stroke>` / `strokeWidth` |
| `radius` | `RoundedCornerShape(n.dp)`；数组四角顺序 **TL TR BR BL** 与 `RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart)` 一致 | `<corners>` / `ShapeAppearance` |
| `effect: shadow(...)` | 见第五节，**不能直接照抄** | 同左 |
| `effect: blur(...)` | `Modifier.blur(r.dp)`（API 31+） | `RenderEffect`（API 31+） |
| `opacity` | `Modifier.alpha(f)` | `android:alpha` |
| `rotate` | `Modifier.rotate(deg)` | `android:rotation` |
| `blend` | `Modifier.graphicsLayer { blendMode = … }` / 自绘 | 一般做不了，报告给用户 |
| `clip: true` | `Modifier.clip(shape)` | `clipChildren` / `outlineProvider` |
| `font: {style: "@X"}` | 文字样式引用 → `figma-cli styles` 查它的字号/行高/字重，映射到 `typography.*` | `?attr/textAppearance*` |
| `font: {size: 14/20px, weight: 500}` | `fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight(500)` | `textSize` / `lineHeight` / `fontWeight` |
| `component: {of, props}` | **这是个组件实例** → 一个 `@Composable`，见下 | 一个自定义 View / include |
| `bind: {...}` | 该属性绑定到了变量（如 `paddingLeft: $Margin medium`）→ 用 token 常量，别写字面量 | `@dimen/…` |
| `more: true` + `descendants: N` | 还有 N 个后代没展开 —— 看这个数决定要不要下钻 | 同左 |
| `$name` | **变量**（variable） | |
| `@name` | **样式**（style） | |

### Compose 的两个高频坑

**1. Modifier 顺序决定结果。** Figma 的 `padding` 是内边距，背景要铺满含 padding 的区域：

```kotlin
Modifier.background(color, shape).padding(16.dp)   // ✅ 背景在外，padding 在内
Modifier.padding(16.dp).background(color, shape)   // ❌ 背景缩小了一圈
```
`clip` / `border` 同理，都要在 `padding` 之前。`size` 也一样：`.size(48.dp).padding(12.dp)` 是「48 的盒子内缩 12」，`.padding(12.dp).size(48.dp)` 是「48 的盒子外扩 12」。

**2. `fill` 在主轴还是交叉轴，写法完全不同。** 这是每个节点都要重新判断的地方：`Row` 里 `sizing: {w: fill}` → `Modifier.weight(1f)`；`Column` 里 `sizing: {w: fill}` → `Modifier.fillMaxWidth()`。判断不了就让工具替你判断（第五节末）。

### 三种折叠

输出里会出现这三种「一行顶一大段」的行。**折叠后原始 id 都还在**，可以直接拿去 `figma-cli export` / `figma-cli node`。

```yaml
- {type: Icon, name: 文件2, id: "I1:1035;64:2356", size: 24, color: $文字图形/OnSurface, of: 文件2}
- {type: SystemChrome, of: StatusBar 状态栏, id: "...", size: [392, 34], text: ["18:30"],
   exportable: [{name: 右侧图标组, id: "...", size: [66.9, 22]}]}
- {sameAs: "1:1035", id: "1:1036", abs: [0, 569], diff: {text: 旅游}}
```

- **`type: Icon`** —— 原子图标，内部矢量几何已省。你要的三件事（可导出的 id、尺寸、颜色 token）都在这一行上 → `Icon(painterResource(R.drawable.ic_x), null, Modifier.size(24.dp), tint = colorScheme.onSurface)`。带 `warn: unbound-color` 说明它有没绑 token 的裸色值（多色图标别加 tint）。真要看矢量细节：`--expand-icons`。
- **`type: SystemChrome`** —— 状态栏 / 导航条 / 键盘。**绝对不要还原成 UI 节点**，见第七节。要看内部：`--expand-system`。
- **`sameAs`** —— 和前面那个 id 的节点结构完全相同，只列差异。**出现它就是最强的列表信号**：多个 `sameAs` 连成一片 = `LazyColumn` + 一个 item Composable（或 `RecyclerView` + 一个 ViewHolder），`diff` 里的东西就是数据类的字段。**别把 8 个 `sameAs` 展开成 8 段一模一样的代码。** 要看原样：`--no-dedupe`。

### 两个最重要的信号

**`$` 和 `@` 必须映射成主题里的引用，绝不硬编码。**

```kotlin
color = MaterialTheme.colorScheme.primary          // ✅  $主题色/Base/Primary
color = Color(0xFF0A84FF)                          // ❌  白读了，暗色下必错
```

**Figma 变量名往往就是 Material 3 的槽位名，直接对得上**（这是最省事的一段）：

| Figma 变量 | Compose | XML |
|---|---|---|
| `$…/Primary`、`$…/OnPrimary` | `colorScheme.primary` / `.onPrimary` | `?attr/colorPrimary` |
| `$容器/Surface`、`$容器/SurfaceContainerLowest` | `colorScheme.surface` / `.surfaceContainerLowest` | `?attr/colorSurface` |
| `$文字图形/OnSurface`、`$文字图形/OnSurfaceVariant` | `colorScheme.onSurface` / `.onSurfaceVariant` | `?attr/colorOnSurface` |
| `$…/Outline`、`$…/OutlineVariant` | `colorScheme.outline` / `.outlineVariant` | `?attr/colorOutline` |
| `@Headline/medium`、`@Body/large`、`@Label/small` | `typography.headlineMedium` / `bodyLarge` / `labelSmall` | `?attr/textAppearanceHeadlineMedium` |

名字对不上 M3 槽位的（业务色、品牌色、`fd_*` 私有集合），就在项目的 `Color.kt` / `colors.xml` 里找同名或同值的；找不到就**报告「设计稿用了 X，代码里没有对应变量」**，而不是自己挑一个色值。

**`component.of` 是组件复用信号。** 同一个 `of` 在树里出现多次 → 代码里就该是同一个 Composable / 自定义 View，`props` 就是它的参数：

```yaml
component: {of: _小标题, library: true, props: {小方屏: "off", back: "on", 右侧: icon}}
```
→ `SubTitle(back = true, trailing = Trailing.Icon)`，而不是把内部结构复制三遍。

`library: true` 表示主组件来自外部组件库——**先在项目里搜一遍有没有现成实现**（`grep` 组件名、看设计系统模块），八成有，别重新造。

---

## 四、token 表怎么读

`figma-cli plan` 的 tokens 段已经够用了。要单独查：

```bash
figma-cli vars --used-by <id>      # 只列这个子树用到的变量，带引用次数，通常十几行
figma-cli styles --used-by <id>    # 同上，样式（字号/行高/字重/阴影）
figma-cli vars                     # 整个文件的变量表（大，建议落盘再检索）
```

```yaml
collections:
  - name: fd_sys_color
    modes: [Light, Dark, Dark-soft, Box Dark]
    source: referenced
    variables:
      - {name: $文字图形/OnSurface, type: color, uses: 14, values: {Light: "#000000", Dark: "#eeeeee"}}
      - {name: $容器/SurfaceContainerLowest, type: color, uses: 2, values: {Light: →$White(#ffffff)}}
```

- **`modes` 就是主题**，见第八节。`Light` / `Dark` 两列直接对应 `lightColorScheme()` / `darkColorScheme()`，或 `values/` 与 `values-night/`。多出来的 `Dark-soft`、`Box Dark` 是额外主题，**问用户要不要做**，别默认忽略也别硬做。
- `uses: 14` 是引用次数 —— **这几个高频 token 就是最该先和项目主题对齐的**。
- `→$White(#ffffff)` 是别名：这个 token 指向另一个 token，代码里也应该这么串（`surfaceContainerLowest = White`），不要拍平成色值。
- `type: float` 的集合（如 `Margin tokens`）是间距/圆角刻度表 → `dimens.xml` 或 Compose 里的 `object Spacing { val medium = 12.dp }`。
- 同名集合会自动合并去重（`note` 里说明合并了几份、哪份缺 mode）。
- 反查**只覆盖当前页 / 指定子树**（上限 3000 个节点）。换页要重跑。
- 文字样式的 `lineHeight` 已经解析成像素 → 直接当 `sp` 用。带 `lineHeightFrom: measured` 表示设计稿里写的是 `auto`，这个值是从单行文本的渲染高度实测出来的。

### 文本对不上的头号原因

设计稿字号行高都照抄了，跑出来还是比设计稿高一截、或者上下不居中，按顺序查：

1. **`includeFontPadding`** —— 老版本 Compose / 所有 `TextView` 默认 `true`，会在文本上下各加一段字体留白。Compose 用 `PlatformTextStyle(includeFontPadding = false)`，XML 用 `android:includeFontPadding="false"`。
2. **行高分配方式** —— Figma 把字形在行高里居中。Compose 用 `LineHeightStyle(alignment = Center, trim = …)` 调，XML 用 `android:lineHeight` + `firstBaselineToTopHeight` / `lastBaselineToBottomHeight`。**改一次就跑一次截图实测**，别靠推。
3. **字重** —— `FontWeight(500)` 只有在字体族真的有 Medium 字重（或是可变字体）时才生效，否则系统会合成一个假粗体，视觉上明显不同。见第九节。

---

## 五、混合布局与验算

**这是最容易出错的地方。** 一个 Frame 完全可以既有 Auto Layout 子节点、又有 `absolute: true` 的子节点 —— 对应 Compose 的 `Box { Column {...}; Thing(Modifier.align(…).offset(…)) }`，或 XML 的 `FrameLayout` / `ConstraintLayout`。

**`pos` 是相对父级的，不是相对画板。** 想知道一个绝对定位的元素落在哪一行，**看 `abs`，不要逐层累加 `pos`**：

```yaml
- {type: Ellipse, name: 未读红点, id: "1:1058", size: [6, 6], pos: [38, 533], abs: [38, 533]}
- {type: Instance, name: 侧边栏, id: "1:1041", size: [392, 48], abs: [0, 521]}
#   → 533 - 521 = 12，正好是这一行的 padding-top，红点贴在这一行的图标顶部
```

`abs` 的原点是**本次 `--root-id` 的节点**，输出末尾有一行注释写明是谁。手工累加四层偏移算对了很大程度上靠运气，而这类错误在截图里极难发现——红点贴在任何一行看起来都「像是对的」。

**写完要验算。** 用各区块的 `size.h` 反推 gap/padding 是否和你的实现一致：

```
分组     236 = 44 + 4×48                (无 gap)
置顶     140 = 44 + 2×48                (无 gap)
聊天记录 240 = 44 + 4×48 + 4×1           (gap: 1)
容器     618 = 236 + 1 + 140 + 1 + 240   (gap: 1)  ✓
```

三层都对上了才能确信 `Arrangement.spacedBy` 和 padding 写对了。**这一步不能省。**

### 阴影：不能照抄

`effect: shadow(0, 2 8 0 #000000@0.12)` 是 CSS 式的 x/y/blur/spread/color。**Android 没有这个模型**，`Modifier.shadow(elevation)` 只有一个高度值。按顺序：

1. 能用 elevation 近似就近似（`blur / 2` 附近起步，跑截图对照着调），API 28+ 可以再用 `ambientColor` / `spotColor` 校色；
2. 设计稿明确要求彩色/大扩散阴影，用 `Modifier.drawBehind` 自绘或九宫格背景图；
3. **无论走哪条，都要在交付说明里写明「阴影是近似值」。**

### 让工具替你判断方向

`figma-cli css <id>` 输出的是 CSS，Android 用不了，**但它已经替你做完了那个每次都要重新判断的事**：`sizing: {w: fill}` 到底在主轴还是交叉轴。看到 `flex: 1` 就是 `Modifier.weight(1f)`，看到 `align-self: stretch` / `width: 100%` 就是 `fillMaxWidth()`。拿不准时用它交叉验证，不要把它的输出直接贴进代码。

---

## 六、切图：SVG → VectorDrawable

两个命令，用途完全不同：

| | 用途 | 落点 |
|---|---|---|
| `figma-cli image <id>` | **给你自己看**，判断视觉效果、核对还原度 | 临时目录，长边限 1500px |
| `figma-cli export <id>` | **进项目的资源文件** | `--out` 指定的目录，原始尺寸 |

**图标一律走矢量。**

```bash
figma-cli export <id...> --format SVG --out ./build/figma-svg            # 中转目录，别放 res/ 下
figma-cli export <frameId> --recursive --format SVG --out ./build/figma-svg  # 整个 Frame 一次切完
```

SVG 是中间产物，**`res/` 下任何目录都别放** —— `res/` 的子目录名有固定含义，放个 `raw-svg` 进去 aapt 直接报错，放进 `res/drawable/` 则是不合法的 drawable 资源。先落到 `build/` 之类的临时目录，转成 VectorDrawable 再进 `res/drawable/`。本 skill 自带脚本：

```bash
<本 SKILL.md 所在目录>/scripts/svg2vd.sh -o app/src/main/res/drawable --prefix ic_ ./build/figma-svg/*.svg
# 装好之后通常是 ~/.claude/skills/figma-cli/scripts/svg2vd.sh
```

跑的是 **Android Studio「New → Vector Asset」背后那份实现**（`com.android.ide.common.vectordrawable.Svg2Vector`）。依赖已经内置在 `scripts/lib/svg2vd-deps.jar`（2.5MB，从上游裁剪而来，见同目录 `NOTICE.md`）——**不查 gradle 缓存、不联网下载、不依赖 Android Studio**。

**唯一前提是系统上有 JRE/JDK 11+**（内置 jar 全部是 Java 11 字节码）。找不到 java 时脚本直接失败并提示怎么装 —— 这时候**不要退而把 SVG 塞进 `res/drawable/`**，那不是合法的 drawable 资源，构建期才炸。把这个前提告诉用户，等他们装好再继续。

### 转不了的自动退回 PNG

VectorDrawable 表达不了 `<filter>`（模糊/投影）、半透明 `<mask>`、`<pattern>`、位图填充。**遇到这些，Svg2Vector 仍会吐出一个「看着合法」的 XML** —— 可能残留 `android:fillColor="url(#p)"`（aapt 直接报错），也可能只是默默把效果丢了。脚本一律把这种情况判为**失败、不写出 XML**，并报出具体原因。

参数写成 `<file.svg>=<节点id>` 时，失败的会自动调 `figma-cli` 导成 PNG：

```bash
scripts/svg2vd.sh -o res/drawable --prefix ic_ \
  "icon_a.svg=1:2345" "icon_b.svg=I1:36;64:2356"    # 含 ; 的 id 整体加引号
```

没给 id 就只报告该跑哪条命令。`--png-scales` 默认 `2,3`（xhdpi/xxhdpi），`--no-png-fallback` 关掉。退回 PNG 的图标**换不了颜色，暗色模式下要单独处理**，交付说明里必须写。

退出码：`0` 全成功，`3` 有转换失败，`1` 环境问题（没 java 等）。

### 脚本顺带做的三件事

- **资源名清洗** —— Figma 图层名常是中文，Android 资源名只允许 `[a-z][a-z0-9_]*`。自动转换并在 stderr 上列出改了名的（中文名会被清成 `v2` 这类没意义的名字，**看到就手工改成有意义的**）。
- **`currentColor` 替换** —— 见下一条。
- **每个文件打印 path 数** —— 拿去和 `figma-cli image <iconId>` 的图对一眼，数量对不上就是转丢了东西。

**`stroke-dasharray` 会被静默丢掉**，虚线变实线，而且 path 数不变、Svg2Vector 也不报错，上面那些校验全都抓不到。设计稿里有虚线（分隔线、占位框）就别指望切图，用 Compose 的 `drawBehind` + `PathEffect.dashPathEffect` 或 XML 的 `<dashGap>` 画。

**不要用 npm 的 `svg2vectordrawable` / `s2v`。** 实测它会**静默丢掉只有描边没有填充的图形**（`fill="none"` + `stroke=…`）—— 描边图标整条路径凭空消失，输出还是一个合法的 `<vector>`，不看图根本发现不了。同一个双路径 SVG，Svg2Vector 出 2 条 path，它只出 1 条。

渐变只支持 linear/radial/sweep。**转失败又没法回退 PNG 的图标要报告给用户**，别硬塞。

- `--currentcolor` 把**绑了 token 的** fill/stroke 换成 `currentColor`。**`currentColor` 在 VectorDrawable 里不合法**，Svg2Vector 会原样透传成 `android:fillColor="currentColor"`，运行期崩 —— `svg2vd.sh` 已经替你换成占位色 `#FF000000`（`--placeholder` 可改），你只要在用的地方染色：Compose `Icon(..., tint = colorScheme.onSurface)` / XML `app:tint="?attr/colorOnSurface"`，tint 会盖掉占位色。裸色值原样保留并标 `warn: unbound-color`（那可能是有意的多色图标，**别给它加 tint**）。
- `--stdout` 直接吐 SVG 源码到终端（含 `token:` 字段告诉你该用哪个颜色属性），适合你要手工改一两个图标；批量还是落盘。
- 文字要在代码里改的加 `--no-svg-outline-text` 保留文本不转曲。

**位图（照片、复杂插画）才切 PNG/WebP**，按 Android 密度桶给倍率：

```bash
figma-cli export <id> --format PNG --scales 1,1.5,2,3,4 --out ./assets
#                                          m  h   xh xxh xxxh   → drawable-{m,h,xh,xxh,xxxh}dpi
```

实际项目通常只要 `2,3`（xhdpi/xxhdpi）就够，**问用户项目的最低密度支持**。优先转成 WebP（Android Studio 右键 `Convert to WebP`）。

**纯色/圆角/渐变的背景块不要切图**，用 `RoundedCornerShape` + `background` 或 shape drawable 画出来——切图在暗色模式下换不了色。

其它规则：

- 优先不带 `--format` 时用的是设计师在 Figma 里配的导出设置，但设计师配的多半是 iOS 习惯的 `@2x/@3x` 后缀，**Android 侧还是显式指定 `--format SVG` 更省事**。
- 文件名来自图层名；实例内部节点的图层名没意义（`Vector`），会自动回退到**主组件名**。中文名和 `ic_` 前缀都由 `svg2vd.sh` 处理（清洗 + `--prefix`），**这里不用加 `--ascii-names`**；只有不走脚本、直接拿 PNG 进 `res/` 时才需要它。
- 先 `figma-cli find` 或看 `figma-cli plan` 的 assets 段拿 id，别猜。

---

## 七、系统 chrome 用 WindowInsets，不要还原

状态栏、导航条、键盘、灵动岛这类东西：**不要展开、不要画成节点、不要写死高度。**

它们在输出里已经折叠成 `type: SystemChrome` 一行。设计稿里那个 `size: [392, 34]` 的状态栏，在代码里对应的是：

```kotlin
enableEdgeToEdge()                                     // Activity 里
Modifier.windowInsetsPadding(WindowInsets.statusBars)  // 内容避让
Modifier.imePadding()                                  // 键盘避让
Modifier.navigationBarsPadding()                       // 导航条避让
```
XML 侧对应 `WindowCompat.setDecorFitsSystemWindows(false)` + `ViewCompat.setOnApplyWindowInsetsListener`，或 `android:fitsSystemWindows="true"`。

**把 34dp 写成 padding 是 bug** —— 不同设备、不同刘海、三键导航 vs 手势导航的高度都不一样。

设计稿里状态栏的图标颜色（深/浅）对应 `isAppearanceLightStatusBars`，这是要设的；但那是一个布尔值，不是一堆节点。展开一个状态栏要花约 200 行，换回来的只有 4 个事实。

设计稿里的系统组件叫别的名字时，在 `~/.figma-cli/config.json` 里加：

```json
{ "systemComponents": ["MyStatusBar", "顶部信息栏"] }
```

---

## 八、暗色模式是硬约束

`figma-cli vars` 的 `modes` 一旦包含 Dark：

- **任何硬编码的 `Color(0xFF…)` / `#RRGGBB` 都是 bug** —— 它在暗色下必然出错。要么找到对应的 token，要么明确报告给用户，不要自己挑一个色值。真实案例：环形进度底环 `stroke: "#000000@0.15"` 未绑 token，暗色背景下完全不可见。
- 别名 `→$White(#ffffff)` 在代码里也应该串成引用，不要拍平。
- **Compose**：两套 `ColorScheme`（`lightColorScheme()` / `darkColorScheme()`），`isSystemInDarkTheme()` 选择；`@Preview(uiMode = UI_MODE_NIGHT_YES)` 必须也写一个。项目开了 dynamic color（`dynamicLightColorScheme`）的话，**设计稿的品牌色会被系统色盖掉** —— 这是个要跟用户确认的冲突点。
- **XML**：`values/colors.xml` + `values-night/colors.xml`，布局里一律用 `?attr/…` 或 `@color/…`，不写字面量。
- 只有一套 mode 的 token 在两个主题下是同一个值，这是正常的，照抄即可。

`figma-cli lint`（下一节）会把裸色值在有 Dark mode 时直接报成 `error`。

---

## 九、写完之后

### 跑起来对照

`figma-cli image <id>` 再导一次设计稿截图，再跑一张你实现的截图（模拟器/真机截屏，或 Compose 的 `@Preview` + `Screenshot` 测试；有 `android` CLI skill 就用它取截图），**用 Read 工具在同一轮对话里先后读入两张图**——视觉差异在连续两张图之间最容易发现。

重点核对这五项：**字重、行高与基线、阴影浓淡、圆角、图标的光学尺寸**。结构错误看树就能发现，这五项只能看图。

**用设计稿同宽的设备**对照（392 稿就用 Pixel 类 ~412dp 的机型，注意差值），并且**至少再看一眼另一个宽度**，确认 `fill` / `weight` 没写成固定宽。

### 做设计走查

```bash
figma-cli lint <id>                 # 全部
figma-cli lint <id> --level warn    # 只看 error 和 warn
```

设计稿并不总是规范的，你能发现设计师自己没发现的问题。规则包括：未绑 token 的裸色值（**含描边** —— 这条 grep 抓不到，而它往往是最值钱的一条）、未绑样式的裸字号、被 detach 的实例、被拖改尺寸的实例、不在刻度表里的间距、超出裁剪容器的内容、图层名与文案不符、值重复的 token。每条都带 `path` 和 `fix` 建议。

**只报告，不要自己改。** `gap: 1` 不在刻度表里就报出来，不要悄悄写成 8。

### Android 侧自查

- **文案全部进 `strings.xml`**，不要硬编码在 Composable / 布局里。`figma-cli text --root-id <id>` 一次抽全，直接生成 `<string name="…">`。
- **左右一律写 `Start` / `End`**，不写 `Left` / `Right`（Figma 的 padding 数组是上/右/下/左，右=End，左=Start）。
- **可点击元素的触摸目标 ≥ 48dp**。设计稿画的是 24dp 图标，点击区要靠 `minimumInteractiveComponentSize()` 或 `Modifier.size(48.dp)` 撑开——**视觉尺寸和触摸尺寸是两回事，设计稿只画了前者**。
- **设计稿不画交互态**：按下、禁用、焦点、涟漪。按 Material 默认走，并在交付说明里列出你替设计师做了哪些决定。
- **内容描述**：图标 `contentDescription` 该给的给，纯装饰传 `null`。
- 长文案的截断、超长中文/英文换行、字体缩放 200% 下的溢出，设计稿都没画，**要试**。

### 交付时必须说清楚这六件事

1. **dp 换算基准**（设计稿是几倍稿、根宽多少）
2. **没能一比一还原的部分**及原因（字体缺失、阴影只能近似、位图占位、VectorDrawable 不支持的效果、外部组件未复用…）
3. **设计稿里没有对应 token 的色值/字号** —— 报告，不要自己造变量
4. **走查发现**（`figma-cli lint` 的 error/warn）
5. **需要用户决策的点**（是否引入项目已有组件、dynamic color 冲突、图层名是否要在 Figma 侧改、要不要做额外主题 mode）
6. **暗色模式覆盖情况** —— 哪些做了、哪些因为裸色值做不了

### 设计稿字体本地没有时

设计稿字体（如 `Flyme Sans VF`）在项目里通常不存在。按顺序：

1. 检查 `res/font/` 和 gradle 依赖里有没有该字体，有就用 `FontFamily`；
2. 有 Downloadable Fonts 源（Google Fonts）就用；
3. 都没有就回退到系统字体，**并注意字重**：系统默认字体族只有 Regular/Bold 时，`FontWeight(500)` 会被合成，视觉偏差明显；
4. **必须在交付说明里告知用户字宽/字重会有差异**，不要默默替换。

---

## 命令速查

| 命令 | 用途 | 常用参数 |
|---|---|---|
| `figma-cli ctx` | 文件/页面/选中项 —— 入口 | `--expand-selection` |
| `figma-cli plan [id]` | **一站式调研，还原从这条开始** | `--depth --only` |
| `figma-cli tree [id...]` | 结构树，可多个 root | `--depth --max-nodes --expand-instances --stat --no-abs` |
| `figma-cli find <关键词>` | 按名称/类型定位 | `--types --all-pages --limit` |
| `figma-cli node <id>...` | 完整属性（不折叠，用于精读） | `--with-children` |
| `figma-cli text [id]` | 抽全部文案（→ strings.xml） | `--root-id --limit` |
| `figma-cli css <id>` | 布局 → flex CSS；**只用来判断主轴/交叉轴** | `--nested --var-prefix` |
| `figma-cli lint [id]` | 设计走查 | `--level --expand-instances` |
| `figma-cli image <id>` | 截图给自己看 | `--scale --format --max-dimension` |
| `figma-cli export <id...>` | 切图进项目 | `--out --format --scales --recursive --stdout --currentcolor --ascii-names` |
| `figma-cli vars` | 变量表 | `--used-by --values --collection-id` |
| `figma-cli styles` | 样式定义（字号/行高/字重） | `--used-by --type` |
| `figma-cli components` | 组件与变体清单 | `--query --all-pages` |
| `figma-cli docs` / `figma-cli use <docId>` | 多文档时切换目标 | |
| `figma-cli status` / `figma-cli stop` | daemon 状态 / 停止 | |

折叠开关（`tree` / `plan` 通用）：`--expand-icons` `--expand-system` `--no-dedupe` `--dedupe-scope document` `--icon-max-size`。

`figma-cli <命令> --help` 看完整参数。**多个 id 用空格分隔**（`figma-cli node "1:2" "3:4"`）。

所有命令的 stdout 都是合法 YAML，进度提示和附注走注释行或 stderr，不会破坏解析。出错时 stderr 上是 `error: <码>` + `message:`，退出码非 0 —— 别把错误当数据往下用。

## 控制上下文开销

设计稿一页几百上千个节点是常态，全读进来必爆。

**先看规模再决定怎么读。**

```bash
figma-cli tree --root-id <id> --stat     # 每个直接子节点一行：后代数、深度
```

看到 `descendants: 47` 就直接展开，看到 `210` 就换策略（切图，或落盘 grep）。树里的 `more: true` 也带着 `descendants`，不用靠猜。

**分层下钻。** `--depth 2` 起步，看到 `more: true` 再对那个 id 单独取树。一次要好几块：`figma-cli tree 1:1033 1:1039 1:1051 --depth 6`（多个 root 一条命令）。

**大树先落盘再检索**，只把命中的行读进上下文。落盘目录用**你自己的临时目录**（各家 agent 的沙箱规则不同，别硬编码 `/tmp`）：

```bash
figma-cli tree --root-id <id> --depth 8 --max-nodes 3000 > "$SCRATCH/t.yaml"
grep -n "推荐\|Button" "$SCRATCH/t.yaml"
grep -A 3 'type: Text' "$SCRATCH/t.yaml"     # 输出是合法 YAML，装了 yq 也可以直接查询
```

`--max-nodes` 上限 3000，默认 400。

**实例内部默认不展开。** 状态栏、图标组这些是设计系统的实现细节，而你多半应该直接复用项目里现成的组件。**要拿实例内部图标的 id 就大胆 `--expand-instances`** ——图标会自动折叠成 `type: Icon` 一行，不会再被矢量几何淹没。真要看几何细节才加 `--expand-icons`。

**要文案就用 `figma-cli text`**，比读树便宜得多，而且能穿透实例。

**实例内部的 id 带 `;`，shell 里必须加引号**：

```bash
figma-cli tree --root-id "I1:3636;11190:19163"   # ✓
figma-cli tree --root-id I1:3636;11190:19163     # ✗ 被 zsh 截成两条命令
```

## 排查

| 症状 | 处理 |
|---|---|
| `NO_DOCUMENT` | 插件没运行，让用户在 Figma 里启动它。**不要重试**，等用户确认 |
| `AMBIGUOUS_DOCUMENT` | 开了多个文档，`figma-cli docs` 看列表后 `figma-cli use <docId>` |
| `TIMEOUT` | 文件太大，缩小 `--depth` / `--limit` 重试 |
| `figma-cli: command not found` | 在项目目录跑 `bash scripts/install.sh` |
| `vars` / `styles` 是空的 | 该页没用任何 token，或插件是旧版（`figma-cli docs` 看 `plugin` 版本，让用户关掉插件窗口重开） |
| 输出里没有 `abs` / `descendants` / 折叠 | 插件是旧版，让用户关掉插件窗口重开 |
| 结构里全是坐标没有 layout | 设计稿没用 Auto Layout，只能按绝对定位还原（`ConstraintLayout` 或 `Box` + `offset`），并告诉用户这一点 |
