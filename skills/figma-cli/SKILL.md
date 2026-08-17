---
name: figma-cli
description: 读 Figma 设计稿还原 Android 界面（Compose / View XML）：读结构与布局、把 design token 落成主题层、抽文案、切图转 VectorDrawable、截图对照。用户提到 Figma、设计稿、还原设计、切图、design token、组件变体，或让你「照着这个设计实现」时使用。直连 Figma 桌面版插件，无 REST API 速率限制。
---

# 读 Figma 设计稿，还原 Android 界面

`figma-cli` 直连用户此刻在 Figma 桌面版里打开的文档，看到的永远是屏幕上当前的样子，含未保存的编辑与实例覆盖。

**这套工具的全部价值在于设计稿的语义被保留了下来**：颜色是 `$文字图形/OnSurface` 而不是 `#000000`，字体是 `@Headline/medium` 而不是 17px，布局是 Auto Layout 而不是坐标。**照着坐标和色值堆 UI 就等于白读。**

**默认写 Jetpack Compose**；项目里有 `res/layout/` / `ViewBinding` / `ConstraintLayout` 依赖就走 View 那一路。**先看项目用的是哪个，别默认写 Compose。**

**前提**：Figma 桌面版开着且「Figma CLI Bridge」插件在运行。报 `NO_DOCUMENT` 就是插件没跑，让用户去 `Plugins → Development → Figma CLI Bridge`；daemon 自动拉起，不用管。

---

## 一、标准流程

```bash
figma-cli ctx                                  # 1. 用户在哪个文件、哪一页、选中了什么
# → 读项目已有主题（Theme/Color/Type.kt 或 res/values/）——token 往哪落取决于这个 →
figma-cli image <id>                           # 2. 先看一眼整体（Read 打印出的路径）
figma-cli plan <id>                            # 3. 一站式调研：结构/组件/token/切图/文案/走查
# → 定 dp 基准（第三节）、建公共样式层（第二节）→
figma-cli tree --root-id <id> --depth 4        # 4. 某块结构看不够细时单独下钻
figma-cli export <id...> --format SVG --out …  # 5. 切图 → VectorDrawable（第六节）
# → 写代码 →
figma-cli image <id>                           # 6. 再导一次，和你跑出来的截图对照（第九节）
```

**永远先 `ctx`。** 不知道用户在看什么就开始猜是浪费时间。

**`plan` 是主力**，一条命令替代 ctx+tree+vars+styles+text+components+lint，中等页面 ≤150 行。只要其中几段：`--only tokens,assets`。它的七段是 `target` / `structure` / `components` / `tokens` / `assets` / `text` / `lint`。

**读项目已有的主题要排在 `plan` 前面**：`Theme.kt` / `Color.kt` / `Type.kt`，或 `res/values/` 下的 `colors.xml` / `themes.xml` / `dimens.xml`。设计稿的 token 该落到哪个槽位，取决于项目里有没有现成的 M3 scheme —— 先知道这件事，读 `tokens` 段时才知道每一行往哪放。

**`structure` 段会降级。** 页面大到超预算时它会降 depth，降到 1 还超就整段省略，并在末尾注释里给出该跑的 `tree` 命令。**看到降级提示就当这段不存在**，结构另走 `tree`，别在两个 `more: true` 上做文章。

---

## 二、token 优先：先有公共样式层，再写界面

**页面代码里不该出现色值、字号、间距字面量**——它们全都该是对主题层的引用。设计稿给了什么 token，主题层就该有什么槽位。

`plan` 的 `tokens` 段就是这一层的原料：

```yaml
tokens:
  modes: [Light, Dark]
  warn: 文件含 Dark mode，代码里的颜色必须是可切换变量，禁止写死单 mode 值
  colors:
    - {name: $文字图形/OnSurface, uses: 14, Light: "#000000", Dark: "#eeeeee"}
    - {name: $容器/SurfaceContainer, uses: 6, Light: →$Gray-50, Dark: →$Gray-900}
  text:
    - {name: "@Headline/medium", uses: 4, family: Flyme Sans VF, size: 17, lineHeight: 24, weight: 600}
  spacing:
    scale: {Margin/small: 8, Margin/medium: 12, Margin/large: 20}
    used: [8, 12, 16, 20]
    offScale: [7, 13]
```

### 四类 token 的落点

| 设计稿里的东西 | Compose | View / XML |
|---|---|---|
| 颜色变量 `$…` | `ColorScheme` 槽位 → `MaterialTheme.colorScheme.x` | `colors.xml` + 主题 attr → `?attr/colorX` |
| 文字样式 `@…` | `Typography` 槽位 → `MaterialTheme.typography.x` | `<style>` TextAppearance → `?attr/textAppearanceX` |
| float 集合（`Margin` / `Radius` 刻度） | `object Spacing { val medium = 12.dp }` | `dimens.xml` → `@dimen/…` |
| 组件实例 `component.of` | 一个 `@Composable` | 一个自定义 View / `<include>` |

**顺序是：先补齐主题层，再写页面。** 主题里缺哪个槽位就先加进 `Color.kt` / `Type.kt` / `colors.xml`，页面代码只写引用。**不要在页面里定义颜色常量**，那等于把 token 拍平了。

### 硬规则

- **`$` 和 `@` 一律映射成主题引用，不硬编码。** `color = MaterialTheme.colorScheme.primary` ✅ / `Color(0xFF0A84FF)` ❌
- **别名要串成引用。** `→$Gray-50` 表示该 token 指向另一个 token（`vars` 里还会带上解析值 `→$Gray-50(#f7f7f7)`），代码里也这么串（`surfaceContainer = Gray50`），不要拍平成色值。
- **`uses` 高的先对齐**，那几个是页面的主色/主字号。
- **项目里找不到对应名字**：先按同名、再按同值找；都没有就**报告「设计稿用了 X，项目主题里没有」**，不要自己挑一个色值或造一个变量名。
- **`offScale` 是设计稿自己的问题**（`used` 里不在 `scale` 上的值），照报告不照改。
- **`+` 连起来的是多层填充，按从下往上叠。** `fill: "$主题色/Yellow/Primary + #000000@0.2(multiply)"` = 底层是那个 token，上面再叠一层 20% 不透明度的黑、混合模式 multiply；`@0.2` 是该层不透明度，括号里是混合模式（**没有括号就是 NORMAL**）。能拆成两层就拆两层（`Box` 叠一个半透明遮罩），要合成一个色值的话必须按标出来的混合模式算，**别默认 NORMAL**，并在交付说明里写明这是算出来的值。

Figma 变量名往往直接就是 M3 槽位名，这段最省事：

| Figma | Compose | XML |
|---|---|---|
| `$…/Primary`、`$…/OnPrimary` | `colorScheme.primary` / `.onPrimary` | `?attr/colorPrimary` |
| `$容器/Surface`、`$容器/SurfaceContainerLowest` | `colorScheme.surface` / `.surfaceContainerLowest` | `?attr/colorSurface` |
| `$文字图形/OnSurface`、`$文字图形/OnSurfaceVariant` | `colorScheme.onSurface` / `.onSurfaceVariant` | `?attr/colorOnSurface` |
| `$…/Outline`、`$…/OutlineVariant` | `colorScheme.outline` / `.outlineVariant` | `?attr/colorOutline` |
| `@Headline/medium`、`@Body/large`、`@Label/small` | `typography.headlineMedium` / `bodyLarge` / `labelSmall` | `?attr/textAppearanceHeadlineMedium` |

名字对不上 M3 的（业务色、品牌色、`fd_*` 私有集合）就在项目里找同名/同值的，找不到照上面的规则报告。

### 多 mode = 多主题，暗色是硬约束

`modes` 里出现 Dark，任何硬编码色值都是 bug：

- **Compose**：`lightColorScheme()` / `darkColorScheme()` 两套，`isSystemInDarkTheme()` 选择，`@Preview(uiMode = UI_MODE_NIGHT_YES)` 也要写一个。项目开了 dynamic color 的话**设计稿品牌色会被系统色盖掉**，要跟用户确认。
- **XML**：`values/colors.xml` + `values-night/colors.xml`，布局里只用 `?attr/…` / `@color/…`。
- 多出来的 `Dark-soft`、`Box Dark` 这类额外 mode：**问用户做不做**，别默认忽略也别硬做。
- 只有一套 mode 的 token 两个主题同值，正常。

### 单独查 token

```bash
figma-cli vars --used-by <id>      # 这个子树用到的变量 + 引用次数，通常十几行
figma-cli styles --used-by <id>    # 同上，样式（字号/行高/字重/阴影）
figma-cli vars                     # 整个文件的变量表（大，落盘再检索）
```

- 反查**只覆盖当前页或指定子树**（上限 3000 节点），换页要重跑。
- `lineHeight` 已解析成像素，直接当 `sp` 用；带 `lineHeightFrom: measured` 表示设计稿写的是 `auto`，值是实测出来的。
- 同名集合自动合并去重，`note` 里说明合并了几份。

### 文本对不上，按顺序查这三条

1. **`includeFontPadding`** —— `TextView` 与老版本 Compose 默认 `true`，上下各加一段留白。Compose 用 `PlatformTextStyle(includeFontPadding = false)`，XML 用 `android:includeFontPadding="false"`。
2. **行高分配** —— Figma 把字形在行高里居中。Compose 用 `LineHeightStyle(alignment = Center, trim = …)`，XML 用 `android:lineHeight` + `firstBaselineToTopHeight`。**改一次跑一次截图，别靠推。**
3. **字重** —— `FontWeight(500)` 只在字体族真有 Medium（或可变字体）时生效，否则是合成假粗体。

设计稿字体（如 `Flyme Sans VF`）本地通常没有：先查 `res/font/` 与 gradle 依赖 → 再看 Downloadable Fonts → 都没有才回退系统字体，**并在交付说明里写明字宽/字重有差异**。

---

## 三、单位：px → dp / sp

Figma 的数值都是设计稿像素，先定基准，定错整页都偏。**看根 Frame 宽度**（`plan` 的 `target.size`）：

| 根宽 | 换算 |
|---|---|
| 360 / 375 / 390 / 392 / 412 / 414 | **1x 稿**（常态），`1px = 1dp` 直接用 |
| 720 / 750 / 1080 / 1125 | 2x / 3x 稿，全部除以 2 或 3 |

- 尺寸、间距、圆角、描边 → `dp`；**字号和行高 → `sp`**（用 dp 写字号会让系统字体缩放失效）。
- 1x 稿里 `0.5` 这类小数正常；`[66.9, 22]` 这种脏尺寸是设计稿没对齐，`lint` 会报。
- **别把画板宽写进布局**：`size: [392, 215]` 的 392 对应 `fillMaxWidth()` / `match_parent`，不是 `width(392.dp)`。
- 换算基准要写进交付说明。

---

## 四、读输出：YAML 字段 → Compose / View

输出全是 YAML，无意义字段一律省略。

**字段是事实，层级只是参考。** 设计师的图层树是为了把视觉画准、便于设计侧协作（装饰性 wrapper、切图分组、蒙版、命名规范），不是给你照搬的 view 树——照抄会得到一堆没有语义、嵌套过深的 `Box`。要按**项目已有控件 + Android 常见布局写法**重新设计层级：

- **先找现成控件**：`Scaffold` / `TopAppBar` / `ListItem` / `Card` / `Chip`，以及项目里已有的业务组件，能用就用，别拿几层 Frame 拼一个同款。
- **该合并的合并**：只有一个子节点的 Frame 多半就是一个 Modifier（`padding` / `background` / `clip`），纯装饰的 wrapper 直接去掉。
- **该重组的重组**：视觉上成行成列却用绝对定位摆的，写成 `Row` / `Column`；结构重复的兄弟写成列表 + 一个 item（见下面的 `sameAs`）。
- **不能动的是事实层**：Auto Layout 的方向/gap/padding、`sizing`、token 引用、文案——那是设计意图，不是实现细节。
- 验收标准是**视觉与交互一致**，不是节点一一对应。

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

```kotlin
Column(
    modifier = Modifier
        .fillMaxWidth()
        .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(12.dp))
        .padding(horizontal = 20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    horizontalAlignment = Alignment.CenterHorizontally,
) {
    Text(
        stringResource(R.string.…),
        style = MaterialTheme.typography.headlineMedium,
        color = MaterialTheme.colorScheme.onSurface,
    )
}
```

| 字段 | Compose | View / XML |
|---|---|---|
| `layout: {mode: vertical/horizontal}` | `Column` / `Row` | `LinearLayout` + `orientation` |
| 无 `layout` 但多个 children | `Box` | `FrameLayout` / `ConstraintLayout` |
| `layout.gap` | `Arrangement.spacedBy(n.dp)` | 子项 margin / divider |
| `layout.padding` | `Modifier.padding(...)`，**CSS 顺序**：1=四边，2=上下/左右，4=**上 右 下 左** | `android:padding*`，右→`End` 左→`Start` |
| `layout.justify` | 主轴 `Arrangement`：`start/center/end/between` → `Start/Center/End/SpaceBetween` | `gravity` / `chainStyle` |
| `layout.align` | 交叉轴 `horizontalAlignment` / `verticalAlignment` | `gravity` |
| `sizing: {w: fill}` | **主轴** `Modifier.weight(1f)`；**交叉轴** `fillMaxWidth()` | 主轴 `0dp + layout_weight`；交叉轴 `match_parent` |
| `sizing: {w: hug}` | 默认 wrap，不写 modifier | `wrap_content` |
| `sizing: {w: fixed}` / 无 sizing | `Modifier.width(n.dp)` | `n dp` |
| `size: [w, h]` | 父级是 Auto Layout 时**照 `sizing` 写，别硬编码** | 同左 |
| `abs: [x, y]` | 相对本次 `--root-id` 的绝对坐标，见第五节 | 同左 |
| `pos: [x, y]` | 相对父级，只在**非** Auto Layout 流内出现 → `Box` + `Modifier.offset()` | `ConstraintLayout` / `FrameLayout` margin |
| `absolute: true` | Auto Layout 里被设成绝对定位 → 外层 `Box` + `align()` + `offset()` | `FrameLayout` 子项 |
| `fill: $token` | `Modifier.background(colorScheme.x, shape)` | `android:background` / shape drawable |
| `fill` 是渐变 | `Brush.linearGradient(...)` | `<gradient>` shape drawable |
| `color` | `Text(color = …)` | `android:textColor` |
| `stroke: {paint, weight}` | `Modifier.border(w.dp, color, shape)` | `<stroke>` / `strokeWidth` |
| `radius` | `RoundedCornerShape(n.dp)`；数组四角 **TL TR BR BL**，与 `RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart)` 一致 | `<corners>` / `ShapeAppearance` |
| `effect: shadow(...)` | **不能照抄**，见第五节 | 同左 |
| `effect: blur(...)` | `Modifier.blur(r.dp)`（API 31+） | `RenderEffect`（API 31+） |
| `opacity` / `rotate` / `clip: true` | `Modifier.alpha(f)` / `.rotate(deg)` / `.clip(shape)` | `alpha` / `rotation` / `clipChildren` |
| `blend` | `graphicsLayer { blendMode = … }` / 自绘 | 一般做不了，报告用户 |
| `font: {style: "@X"}` | 查 `styles` 拿字号/行高/字重 → `typography.*` | `?attr/textAppearance*` |
| `font: {face, size: 14/20, weight: 500}` | 没绑样式的裸字号，`size` 是**字号/行高** → `fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight(500)`；**这类要报告给用户**（设计稿漏绑样式） | `textSize` / `lineHeight` / `fontWeight` |
| `component: {of, props}` | 组件实例 → 一个 `@Composable` | 自定义 View / `<include>` |
| `bind: {...}` | 该属性绑定了变量（如 `paddingLeft: $Margin medium`）→ 用刻度常量，别写字面量 | `@dimen/…` |
| `more: true` + `descendants: N` | 还有 N 个后代没展开，看这个数决定要不要下钻 | 同左 |

### Compose 两个高频坑

**1. Modifier 顺序决定结果。** 背景要铺满含 padding 的区域：

```kotlin
Modifier.background(color, shape).padding(16.dp)   // ✅
Modifier.padding(16.dp).background(color, shape)   // ❌ 背景缩了一圈
```
`clip` / `border` 同理都在 `padding` 之前；`.size(48.dp).padding(12.dp)` 是「48 的盒子内缩 12」，反过来是外扩。

**2. `fill` 在主轴还是交叉轴写法不同。** `Row` 里 `{w: fill}` → `weight(1f)`；`Column` 里 `{w: fill}` → `fillMaxWidth()`。拿不准用 `figma-cli css` 交叉验证（第五节末）。

### 三种折叠

一行顶一大段，**原始 id 都还在**，可以直接拿去 `export` / `node`：

```yaml
- {type: Icon, name: 文件2, id: "I1:1035;64:2356", size: 24, color: $文字图形/OnSurface, of: 文件2}
- {type: SystemInset, of: StatusBar 状态栏, id: "...", size: [392, 34], text: ["18:30"]}
- {sameAs: "1:1035", id: "1:1036", abs: [0, 569], diff: {text: 旅游}}
```

- **`Icon`** —— 原子图标，矢量几何已省。可导出 id、尺寸、颜色 token 都在这行 → `Icon(painterResource(R.drawable.ic_x), null, Modifier.size(24.dp), tint = colorScheme.onSurface)`。带 `warn: unbound-color` 是没绑 token 的裸色值（多色图标**别加 tint**）。要几何细节：`--expand-icons`。
- **`SystemInset`** —— 状态栏/导航栏/键盘这类系统控件。类型名就是结论：它在代码里是一份 **inset 预留**，不是 UI 节点，见第七节。要看内部：`--expand-system`。
**输出里印出来的 id 一律可以直接寻址**，折叠行、`--expand-instances` 展开出来的实例内部 id（`I18:4603;1656:28675`）都能直接拿去 `node` / `tree` / `export`（**含 `;` 的 id 在 shell 里必须加引号**）。真报 `找不到` 时先照错误提示里给的那条 `tree --expand-instances` 确认当前 id，不要断定节点不存在。

- **`sameAs`** —— 与前一个 id 结构相同，只列差异。**这是最强的列表信号**：连成一片 = `LazyColumn` + 一个 item Composable（或 `RecyclerView` + 一个 ViewHolder），`diff` 就是数据类字段。**别把 8 个 `sameAs` 展开成 8 段重复代码。** 要原样：`--no-dedupe`。

### 组件复用

同一个 `of` 出现多次 → 代码里就该是同一个 Composable / View，`props` 就是它的参数：

```yaml
component: {of: _小标题, library: true, props: {小方屏: "off", back: "on", 右侧: icon}}
```
→ `SubTitle(back = true, trailing = Trailing.Icon)`，不是把内部结构复制三遍。`library: true` 表示来自外部组件库，**先在项目里搜有没有现成实现**，八成有。

---

## 五、布局：混合定位与验算

一个 Frame 可以既有 Auto Layout 子节点、又有 `absolute: true` 的子节点 → `Box { Column {...}; Thing(Modifier.align(…).offset(…)) }`，XML 侧 `FrameLayout` / `ConstraintLayout`。

**`pos` 相对父级，`abs` 相对本次根节点（输出末尾注释写明是谁）。判断元素落在哪一行看 `abs`，不要逐层累加 `pos`**：

```yaml
- {type: Ellipse, name: 未读红点, id: "1:1058", size: [6, 6], pos: [38, 533], abs: [38, 533]}
- {type: Instance, name: 侧边栏, id: "1:1041", size: [392, 48], abs: [0, 521]}
#   → 533 - 521 = 12 = 这一行的 padding-top，红点贴在该行图标顶部
```

**写完必须验算**，用各区块的 `size.h` 反推 gap/padding：

```
分组     236 = 44 + 4×48                (无 gap)
聊天记录 240 = 44 + 4×48 + 4×1           (gap: 1)
容器     618 = 236 + 1 + 140 + 1 + 240   (gap: 1)  ✓
```

**阴影不能照抄。** `effect: shadow(0, 2 8 0 #000000@0.12)` 是 CSS 的 x/y/blur/spread/color，Android 的 `Modifier.shadow(elevation)` 只有一个高度值：先用 elevation 近似（`blur / 2` 起步，跑截图调，API 28+ 可用 `ambientColor` / `spotColor` 校色）；确需彩色/大扩散阴影就 `drawBehind` 自绘；**无论哪条都要在交付说明里写明是近似值**。

**`figma-cli css <id>` 用来判方向**：它替你算好了 `{w: fill}` 在主轴还是交叉轴——`flex: 1` → `weight(1f)`，`align-self: stretch` / `width: 100%` → `fillMaxWidth()`。**输出是 CSS，不要贴进 Android 代码。**

---

## 六、切图：SVG → VectorDrawable

| 命令 | 用途 | 落点 |
|---|---|---|
| `figma-cli image <id>` | **给你自己看**，核对还原度 | 临时目录，长边限 1500px |
| `figma-cli export <id...>` | **进项目的资源** | `--out` 指定目录，原始尺寸 |

**SVG 还是位图，`plan` 的 `assets` 段已经判好了，不要靠导出来看图决定：**

```yaml
assets:
  - {id: "18:4577", name: 图标, size: 24, color: $文字图形/OnSurface, kind: glyph, shapes: 1}
  - {id: "18:4570", name: 插画, size: 42, kind: multicolor, shapes: 6}
  - {id: "18:4575", name: 过期, size: 42, kind: raster, vector: false, why: image-fill, warn: unbound-color}
```

- **`kind: glyph`**（单色）/ **`multicolor`**（多色矢量）→ 走 SVG → VectorDrawable。`shapes` 约等于 SVG 里的 path 数，可以和 `svg2vd.sh` 打印的 path 数对一眼。
- **`vector: false`** → VectorDrawable 表达不了（`why: image-fill` 位图填充 / `blur` 模糊）→ 直接切 PNG，**不用先导出来看**。
- 没有 `vector: false` 的项就是能矢量化的。**别为了「这个图标画的是什么」去截图**——你马上就要 `export` 它，导出产物已经回答了所有影响代码的问题。

**图标一律走矢量**，先切 SVG 到中转目录，再转 VectorDrawable 进 `res/drawable/`：

```bash
figma-cli export "18:4558=ic_coin" "I18:4553;11132:19414=ic_back" --format SVG --currentcolor --out ./build/figma-svg   # <id>=<名字> 一步到位，省掉一轮 mv
figma-cli export <id...> --format SVG --currentcolor --out ./build/figma-svg  # id 从 plan 的 assets 段或 find 拿；--currentcolor 把绑了 token 的颜色留给主题染
figma-cli export <frameId> --recursive --format SVG --out ./build/figma-svg   # 整个 Frame 一次切完
"$SKILL_DIR/scripts/svg2vd.sh" -o app/src/main/res/drawable --prefix ic_ ./build/figma-svg/*.svg
```

`$SKILL_DIR` 是**本 skill 自己的目录**（就是这份 SKILL.md 所在处）。skill 会被链进不同工具的目录（`~/.claude/skills` / `~/.cursor/skills` / `~/.codex/skills` / `~/.agents/skills` …），**别把路径写死成其中某一个**；不确定就先 `ls ~/.claude/skills/figma-cli/scripts ~/.agents/skills/figma-cli/scripts 2>/dev/null` 找一下。

**SVG 不能放 `res/` 下任何目录**（`res/` 子目录名有固定含义，aapt 直接报错）。`svg2vd.sh` 跑的是 Android Studio「Vector Asset」背后那份 `Svg2Vector`，依赖已内置，**唯一前提是 JRE/JDK 11+**；找不到 java 时脚本失败——**这时不要退而把 SVG 塞进 `res/drawable/`**，告诉用户装 java 再继续。退出码：`0` 全成功 / `3` 有转换失败 / `1` 环境问题。

**转不了的自动退回 PNG。** VectorDrawable 表达不了 `<filter>`、半透明 `<mask>`、`<pattern>`、位图填充，而 Svg2Vector 遇到这些仍会吐出「看着合法」的 XML（可能残留 `url(#p)` 让 aapt 报错，也可能默默丢效果），脚本一律判失败、不写 XML。参数写成 `<file.svg>=<节点id>` 就能自动导 PNG：

```bash
svg2vd.sh -o res/drawable --prefix ic_ "icon_a.svg=1:2345" "icon_b.svg=I1:36;64:2356"   # 含 ; 的 id 加引号
```

没给 id 就只报告该跑哪条命令。`--png-scales` 默认 `2,3`，`--no-png-fallback` 关掉。**退回 PNG 的图标换不了颜色，暗色模式要单独处理，交付说明必须写。**

### 上色与校验

- **`--currentcolor`** 把绑了 token 的 fill/stroke 换成 `currentColor`；`currentColor` 在 VectorDrawable 里不合法，`svg2vd.sh` 已替换成占位色 `#FF000000`（`--placeholder` 可改），你在用的地方染色即可：Compose `tint = colorScheme.onSurface` / XML `app:tint="?attr/colorOnSurface"`。裸色值原样保留并标 `warn: unbound-color`（可能是有意的多色图标，**别加 tint**）。
- 脚本会**清洗资源名**（中文会被清成 `v2` 这类无意义的名字，**看到就手工改**）、**打印每个文件的 path 数**（和 `figma-cli image <iconId>` 的图对一眼，数量对不上就是转丢了）。
- **`stroke-dasharray` 会被静默丢掉**，path 数还不变。设计稿里的虚线用 `PathEffect.dashPathEffect` / `<dashGap>` 画，别指望切图。
- 渐变只支持 linear/radial/sweep；**转失败又没法回退 PNG 的图标报告给用户**，别硬塞。
- 不要用 npm 的 `svg2vectordrawable` / `s2v`：它会静默丢掉只有描边没有填充的图形。
- `--stdout` 直接吐 SVG 源码（含 `token:` 告诉你该用哪个颜色属性），适合手改一两个图标。文案要在代码里改的加 `--no-svg-outline-text`。

### 位图

```bash
figma-cli export <id> --format PNG --scales 2,3 --out ./assets   # xhdpi/xxhdpi，够用；问用户最低密度
```

**文件名直接在 id 上给**：`figma-cli export "18:4575=ic_coin_expired" --format PNG --scales 2,3 --out ./assets`。不给的话文件名取图层名，设计稿里叫「功能-钱币」「图标」的层就会产出进不了 `res/` 的文件名，还得手工 `mv` 一遍。和 `svg2vd.sh` 的 `<file.svg>=<id>` 方向相反，别写反。

**导出目标含文本子节点时输出里会有 `warn: … 含文本子节点`** —— 那基本是选到了外层容器（比如连日期文字一起切了），照 `assets` 段给的 id 重切。

只有照片、复杂插画才切位图，优先转 WebP。**纯色/圆角/渐变的背景块不要切图**，用 `RoundedCornerShape` + `background` 或 shape drawable 画——切图在暗色下换不了色。文件名来自图层名，实例内部的 `Vector` 会自动回退到主组件名；走 `svg2vd.sh` 时不用加 `--ascii-names`。

---

## 七、系统控件不复刻，但必须预留 insets

设计稿基本都会画出状态栏、导航栏/手势条、键盘、灵动岛的视觉——**那是设计师在示意它们的位置，不是要你实现的 UI**。这些控件由系统绘制，App 里**一律不复刻**；你要做的是**按原生适配规则给它们预留 system insets**，让内容不被遮住。

输出里它们已折叠成 `type: SystemInset` 一行：**不要展开、不要画成节点、更不要把它的高度写成常量**（`size: [392, 34]` 里的 34 写成 padding 就是 bug——刘海/挖孔、三键导航 vs 手势导航，各设备各不相同）。

```kotlin
enableEdgeToEdge()                                     // Activity 里
Modifier.windowInsetsPadding(WindowInsets.statusBars)  // 内容避让
Modifier.imePadding()                                  // 键盘避让
Modifier.navigationBarsPadding()                       // 导航条避让
```

XML 侧：`WindowCompat.setDecorFitsSystemWindows(false)` + `ViewCompat.setOnApplyWindowInsetsListener`，或 `android:fitsSystemWindows="true"`。状态栏图标深浅对应 `isAppearanceLightStatusBars`——那是一个布尔值，不是一堆节点。

**读坐标时把这段视觉高度扣掉**：设计稿的 `abs` 原点是画板顶部，含状态栏那一条；第一块内容的 `abs.y` 或根 Frame 的 `padding-top` 如果正好等于状态栏高度，那是给 inset 占的位，**换成 `windowInsetsPadding`，不要当成设计间距写死**。真正的间距是它减去状态栏高度之后的部分。设计稿底部同理——贴着底的按钮/导航栏要 `navigationBarsPadding()`，不是固定 margin。

设计稿里系统组件叫别的名字时，在 `~/.figma-cli/config.json` 里加：`{ "systemComponents": ["MyStatusBar", "顶部信息栏"] }`。

---

## 八、什么时候该看图

**截图是这套流程里最贵的操作**（图像上下文常常是全部 YAML 输出的两倍），而树里是精确值、截图是像素。按下面的规则决定，别凭感觉。

| | 场景 |
|---|---|
| **必导** | 开工第一张（整个目标，定基准）和收工最后一张（实机对照，验收） |
| **该导** | 树里出现**说不通的组合**：有 `radius` / `padding` 却没有 `fill`（可能有个圆形底片，也可能是裸图标，只读树会多画一个背景）、非 NORMAL 的 `blend`、需要判断 elevation 的 `effect: shadow` |
| **该导** | 要比较**一组同类元素的视觉差异**（三个状态的签到图标、几个变体）时——**导它们的公共父节点，一张搞定**，别一个个导 |
| **别导** | 只是想知道某个图标「画的是什么」。`assets` 的 `kind` / `vector` 已经回答了「SVG 还是 PNG」，剩下的导出产物会回答 |
| **别导** | 为了确认间距、尺寸、层级——树里是精确值，截图反而不如数字准 |

---

## 九、写完之后

**截图对照。** `figma-cli image <id>` 再导一次设计稿，跑一张你实现的截图（模拟器截屏 / `@Preview`；有 `android` CLI skill 就用它），**用 Read 在同一轮里先后读入两张图**。重点看这五项：**字重、行高与基线、阴影浓淡、圆角、图标光学尺寸**——结构错看树就能发现，这五项只能看图。用设计稿同宽的设备对照，**再看一眼另一个宽度**确认 `fill` / `weight` 没写成固定宽。

**走查。** `figma-cli lint <id>`（`--level warn` 只看 error/warn）：未绑 token 的裸色值（含描边，grep 抓不到的那类）、裸字号、被 detach 的实例、被拖改尺寸的实例、不在刻度表里的间距、超出裁剪容器的内容、图层名与文案不符、值重复的 token，每条带 `path` 和 `fix`。**只报告，不要自己改**——`gap: 1` 不在刻度上就报出来，不要悄悄写成 8。

**Android 侧自查：**

- **文案全进 `strings.xml`**，`figma-cli text --root-id <id>` 一次抽全。
- **左右写 `Start` / `End`**，不写 `Left` / `Right`。
- **系统栏区域走 insets 不走固定 padding**（第七节），三键导航和手势导航各看一眼。
- **可点击元素触摸目标 ≥ 48dp**：设计稿画的 24dp 是视觉尺寸，点击区靠 `minimumInteractiveComponentSize()` 撑开。
- **设计稿不画交互态**（按下/禁用/焦点/涟漪），按 Material 默认走并在交付说明里列出你替设计师做的决定。
- 图标 `contentDescription` 该给的给，纯装饰传 `null`。
- 长文案截断、超长换行、字体缩放 200% 溢出，设计稿都没画，**要试**。

**交付说明必须写清六件事：**

1. dp 换算基准（几倍稿、根宽多少）
2. 没能一比一还原的部分及原因（字体缺失、阴影近似、位图占位、VectorDrawable 不支持的效果…）
3. 设计稿里没有对应 token 的色值/字号——报告，不要自己造变量
4. 走查发现（`lint` 的 error/warn）
5. 需要用户决策的点（复用哪个已有组件、dynamic color 冲突、要不要做额外 mode）
6. 暗色模式覆盖情况——哪些做了、哪些因为裸色值做不了

---

## 命令速查

| 命令 | 用途 | 常用参数 |
|---|---|---|
| `figma-cli ctx` | 文件/页面/选中项 —— 入口 | `--expand-selection` |
| `figma-cli plan [id]` | **一站式调研，还原从这条开始** | `--depth --only` |
| `figma-cli tree [id...]` | 结构树，可多个 root | `--depth --max-nodes --expand-instances --stat --no-abs` |
| `figma-cli find <关键词>` | 按名称/类型定位 | `--types --all-pages --limit` |
| `figma-cli node <id>...` | 完整属性（不折叠，精读用） | `--with-children`（只一层）`--depth` |
| `figma-cli text [id]` | 抽全部文案（→ strings.xml）；截断时会报总数 | `--root-id --limit` |
| `figma-cli vars` | 变量表 | `--used-by --values --collection-id` |
| `figma-cli styles` | 样式定义（字号/行高/字重） | `--used-by --type` |
| `figma-cli components` | 组件与变体清单 | `--query --all-pages` |
| `figma-cli css <id>` | 布局 → flex CSS；**只用来判主轴/交叉轴** | `--nested --var-prefix` |
| `figma-cli lint [id]` | 设计走查 | `--level --expand-instances` |
| `figma-cli image <id>` | 截图给自己看 | `--scale --format --max-dimension` |
| `figma-cli export <id...>` | 切图进项目；`<id>=<名字>` 直接定文件名 | `--out --format --scales --recursive --stdout --currentcolor` |
| `figma-cli docs` / `use <docId>` | 多文档时切换目标 | |

折叠开关（`tree` / `plan` 通用）：`--expand-icons` `--expand-system` `--no-dedupe` `--dedupe-scope document` `--icon-max-size`。

`figma-cli <命令> --help` 看完整参数。**多个 id 用空格分隔**（`figma-cli node "1:2" "3:4"`）。stdout 恒为合法 YAML，附注走注释行、日志走 stderr；出错时 stderr 是 `error: <码>` 且退出码非 0，**别把错误当数据往下用**。

## 控制上下文

一页几百上千个节点是常态，全读进来必爆。

```bash
figma-cli tree --root-id <id> --stat            # 每个直接子节点一行：后代数、深度 —— 先看规模
figma-cli tree 1:1033 1:1039 --depth 6          # 多个 root 一条命令
figma-cli tree --root-id <id> --depth 8 --max-nodes 3000 > "$SCRATCH/t.yaml"   # 大树落盘再 grep
grep -n "推荐\|Button" "$SCRATCH/t.yaml"
```

- **先分流，再决定怎么钻**：
  - 目标是**整页** → 保守阶梯：`--depth 2` 起步，看到 `more: true` 再对那个 id 单独取树。
  - 目标是**一个可复用组件**（列表行、卡片，`descendants` 小于 30） → **别走阶梯，一次拿全**：`figma-cli tree --root-id <id> --depth 8 --expand-instances --no-dedupe`。阶梯在这里是反效率的，一层层试三四次的开销比一次全量还大。
- **`node --with-children` 只展开一层**，再往下还是 `more: true`——它不是「取全」的命令。要多层用 `node <id> --depth 4`，要整棵子树用 `tree`。
- `descendants: 47` 就直接展开，`210` 就换策略（落盘 grep 或直接切图）。`--max-nodes` 默认 400、上限 3000。
- 落盘目录用**你自己的临时目录**，别硬编码 `/tmp`。
- **实例内部默认不展开**（那是设计系统的实现细节，你多半该复用项目现成组件）。**要拿实例内图标 id 就大胆 `--expand-instances`**，图标会自动折叠成一行。
- **要文案就用 `figma-cli text`**，比读树便宜得多且能穿透实例。
- **实例内部 id 带 `;`，shell 里必须加引号**：`figma-cli tree --root-id "I1:3636;11190:19163"`。

## 排查

| 症状 | 处理 |
|---|---|
| `NO_DOCUMENT` | 插件没运行，让用户在 Figma 里启动。**不要重试**，等用户确认 |
| `AMBIGUOUS_DOCUMENT` | 开了多个文档，`figma-cli docs` 看列表后 `figma-cli use <docId>` |
| `TIMEOUT` | 文件太大，缩小 `--depth` / `--limit` 重试 |
| `figma-cli: command not found` | 在项目目录跑 `bash scripts/install.sh` |
| `vars` / `styles` 是空的 | 该页没用 token，或插件是旧版（`figma-cli docs` 看 `plugin` 版本，让用户关掉插件窗口重开） |
| 输出里没有 `abs` / `descendants` / 折叠 | 插件是旧版，让用户关掉插件窗口重开 |
| 结构里全是坐标没有 layout | 设计稿没用 Auto Layout，只能按绝对定位还原（`ConstraintLayout` 或 `Box` + `offset`），并告诉用户 |
