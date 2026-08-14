---
name: figma
description: 读取本地 Figma 设计稿并还原成前端代码——读结构与布局、提取 design token（变量/样式）、抽文案、切图、导截图对照。当用户提到 Figma、设计稿、还原设计、切图、design token、组件变体，或让你「照着这个设计实现」时使用。通过 figma CLI 直连 Figma 桌面版插件，没有 REST API 的速率限制。
---

# 读 Figma 设计稿，写出对得上的代码

`figma` 命令直接读用户此刻在 Figma 桌面版里打开的文档，数据来自 Plugin API，
看到的永远是屏幕上当前的样子——包括未保存的编辑和实例覆盖。

**这套工具相对截图识别的全部价值在于：设计稿里的语义被保留了下来。**
颜色不是 `#000000` 而是 `$文字图形/OnSurface`，字体不是 17px 而是 `@Headline/medium`，
布局不是坐标而是 Auto Layout。**丢掉这些语义去写代码，就白读了。**

## 前提

Figma 桌面版开着，且「Figma MCP Bridge」插件在运行。报 `NO_DOCUMENT` 就是插件没跑，
让用户去 `Plugins → Development → Figma MCP Bridge`。daemon 首次执行时自动拉起，不用管。

---

## 一、还原一个页面的标准流程

```bash
figma ctx                                  # 1. 用户在哪个文件、哪一页、选中了什么
figma image <id>                           # 2. 先看一眼整体（Read 工具读打印出的路径）
figma plan <id>                            # 3. 一站式调研 —— 结构/组件/token/切图清单/文案/走查
# → 按需补读 →
figma tree --root-id <id> --depth 4        #    某一块结构看不够细时再单独下钻
figma export <id...> --out ./src/assets    # 4. 切图（要内联进 HTML 就 --stdout --currentcolor）
# → 写代码 →
figma image <id>                           # 5. 再导一次，和你实现的效果对照
```

**永远先 `figma ctx`。** 不知道用户在看什么就开始猜是浪费时间。

**第 3 步是主力。** `figma plan` 一次给出：目标尺寸与根布局、深度可控的结构骨架、
组件复用清单（同一个组件出现了几次、id 分别是哪些）、**这个子树实际用到的**
颜色与文字 token（带引用次数）、间距刻度与可疑值、可直接切图的资源清单、
全部文案、以及设计走查发现。中等复杂页面控制在 150 行以内。

只要其中几段：`figma plan <id> --only tokens,assets`。

**token 那一段不能跳过。** 结构告诉你「这里用了 `$主题色/Base/Primary`」，token 表才
告诉你它是什么、有几套模式（Light/Dark）、在代码里该对应哪个变量。只读结构不读
token，你会把 `$容器/SurfaceContainer` 当成一个不认识的字符串扔掉。

---

## 二、读懂输出：YAML 字段 → 前端概念

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

| 字段 | 前端对应 |
|---|---|
| `layout: {mode: vertical}` | `display:flex; flex-direction:column`（`horizontal` 就是 row） |
| `layout.gap` | `gap` |
| `layout.padding` | `padding`，**CSS 顺序**（1 个=四边，2 个=上下/左右，4 个=上右下左） |
| `layout.justify` / `align` | `justify-content` / `align-items`（`between`=space-between，`start`=flex-start） |
| `sizing: {w: fill}` | 主轴上 `flex:1`，交叉轴上 `align-self:stretch` / `width:100%` |
| `sizing: {w: hug}` | `width:fit-content`（内容撑开） |
| `sizing: {w: fixed}` 或没有 sizing | 用 `size` 里的固定值 |
| `size: [w, h]` | 宽高。**父级是 Auto Layout 时优先照 `sizing` 写，别硬编码这两个数** |
| `abs: [x, y]` | **相对本次 `--root-id` 左上角**的绝对坐标，见第六节 |
| `pos: [x, y]` | 相对父级；只在**非** Auto Layout 流内出现 → 绝对定位 |
| `absolute: true` | 在 Auto Layout 里被设成绝对定位 → `position:absolute` |
| `fill` / `color` | 背景色 / 文字色 |
| `stroke: {paint, weight}` | `border` |
| `radius` | `border-radius`，数组是四角 |
| `effect` | `box-shadow`（`shadow(x,y 模糊 扩散 色值)`）或 `filter: blur()` |
| `opacity` / `rotate` / `blend` | `opacity` / `transform: rotate()` / `mix-blend-mode` |
| `clip: true` | `overflow: hidden` |
| `font: {style: "@X"}` | 文字样式引用 → 去 `figma styles` 查它的字号/行高/字重 |
| `font: {size: 14/20px, weight: 500}` | 裸值。`14/20px` 是 字号/行高，`weight` 已换算成 CSS 数值 |
| `component: {of, props}` | **这是个组件实例**，见下 |
| `bind: {...}` | 该属性绑定到了变量（如 `paddingLeft: $Margin medium`） |
| `more: true` + `descendants: N` | 还有 N 个后代没展开 —— 看这个数决定要不要下钻 |
| `$name` | **变量**（variable） |
| `@name` | **样式**（style） |

### 三种折叠

输出里会出现这三种「一行顶一大段」的行。**折叠后原始 id 都还在**，可以直接拿去
`figma export` / `figma node`。

```yaml
- {type: Icon, name: 文件2, id: "I1:1035;64:2356", size: 24, color: $文字图形/OnSurface, of: 文件2}
- {type: SystemChrome, of: StatusBar 状态栏, id: "...", size: [392, 34], text: ["18:30"],
   exportable: [{name: 右侧图标组, id: "...", size: [66.9, 22]}]}
- {sameAs: "1:1035", id: "1:1036", abs: [0, 569], diff: {text: 旅游}}
```

- **`type: Icon`** —— 原子图标，内部矢量几何已省。你要的三件事（可导出的 id、尺寸、
  颜色 token）都在这一行上。带 `warn: unbound-color` 说明它有没绑 token 的裸色值。
  真要看矢量细节：`--expand-icons`。
- **`type: SystemChrome`** —— 状态栏 / Home Indicator / 键盘。**不要逐节点还原**，
  见第七节。要看内部：`--expand-system`。
- **`sameAs`** —— 和前面那个 id 的节点结构完全相同，只列差异。
  **出现它就是最强的组件复用信号**：代码里应该是同一个组件渲染多次，
  `diff` 里的东西就是它的 props。要看原样：`--no-dedupe`。

### 两个最重要的信号

**`$` 和 `@` 必须映射成代码里的 token，绝不硬编码。**

```
color: $主题色/Base/Primary   →   color: var(--primary)      ✅
color: $主题色/Base/Primary   →   color: #000000             ❌ 白读了
```

先在 `figma plan` 的 tokens 段（或 `figma vars` / `figma styles`）里找到它的定义，再和
项目现有的 token 文件（`tailwind.config`、`:root{}`、`theme.ts`…）对照，用**项目里已有
的名字**。项目里没有对应 token 时，告诉用户「设计稿用了 X，代码里没有对应变量」，
而不是自己造一个色值。

**`component.of` 是组件复用信号。** 同一个 `of` 在树里出现多次 → 代码里就该是同一个
组件，`props` 就是它的 props：

```yaml
component: {of: _小标题, library: true, props: {小方屏: "off", back: "on", 右侧: icon}}
```
→ `<SubTitle back right="icon" />`，而不是把内部结构复制三遍。

`library: true` 表示主组件来自外部组件库——先问用户代码里有没有对应的现成组件，
八成有，别重新实现。

---

## 三、token 表怎么读

`figma plan` 的 tokens 段已经够用了。要单独查：

```bash
figma vars --used-by <id>      # 只列这个子树用到的变量，带引用次数，通常十几行
figma styles --used-by <id>    # 同上，样式（字号/行高/字重/阴影）
figma vars                     # 整个文件的变量表（大，建议落盘再检索）
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

- **`modes` 就是主题**，见第八节。
- `uses: 14` 是引用次数 —— **这几个高频 token 就是最该先和项目变量对齐的**。
- `→$White(#ffffff)` 是别名：这个 token 指向另一个 token，代码里也应该这么串，不要拍平。
- `type: float` 的集合（如 `Margin tokens`）是间距/圆角刻度表。
- 同名集合会自动合并去重（`note` 里说明合并了几份、哪份缺 mode）。
- 反查**只覆盖当前页 / 指定子树**（上限 3000 个节点）。换页要重跑。
- 文字样式的 `lineHeight` 已经解析成像素。带 `lineHeightFrom: measured` 表示设计稿里
  写的是 `auto`，这个值是从单行文本的渲染高度实测出来的 —— 可以直接写进 CSS。

---

## 四、控制上下文开销

设计稿一页几百上千个节点是常态，全读进来必爆。

**先看规模再决定怎么读。**

```bash
figma tree --root-id <id> --stat     # 每个直接子节点一行：后代数、深度
```

看到 `descendants: 47` 就直接展开，看到 `210` 就换策略（切图，或落盘 grep）。
树里的 `more: true` 也带着 `descendants`，不用靠猜。

**分层下钻。** `--depth 2` 起步，看到 `more: true` 再对那个 id 单独取树。
一次要好几块：`figma tree 1:1033 1:1039 1:1051 --depth 6`（多个 root 一条命令）。

**大树先落盘再检索**，只把命中的行读进上下文——这是 CLI 相对 MCP 的核心优势。
落盘目录用**你自己的临时目录**（各家 agent 的沙箱规则不同，别硬编码 `/tmp`）：

```bash
figma tree --root-id <id> --depth 8 --max-nodes 3000 > "$SCRATCH/t.yaml"
grep -n "推荐\|Button" "$SCRATCH/t.yaml"
grep -A 3 'type: Text' "$SCRATCH/t.yaml"     # 输出是合法 YAML，装了 yq 也可以直接查询
```

`--max-nodes` 上限 3000，默认 400。

**实例内部默认不展开。** 状态栏、图标组这些是设计系统的实现细节，而你多半应该直接
复用现成组件。**要拿实例内部图标的 id 就大胆 `--expand-instances`** —— 图标会自动
折叠成 `type: Icon` 一行，不会再被矢量几何淹没。真要看几何细节才加 `--expand-icons`。

**要文案就用 `figma text`**，比读树便宜得多，而且能穿透实例。

**实例内部的 id 带 `;`，shell 里必须加引号**：

```bash
figma tree --root-id "I1:3636;11190:19163"   # ✓
figma tree --root-id I1:3636;11190:19163     # ✗ 被 zsh 截成两条命令
```

---

## 五、切图与截图

两个命令，用途完全不同：

| | 用途 | 落点 |
|---|---|---|
| `figma image <id>` | **给你自己看**，判断视觉效果、核对还原度 | 临时目录，长边限 1500px |
| `figma export <id>` | **进项目的资源文件** | `--out` 指定的目录，原始尺寸 |

```bash
figma image <id>                                           # 用 Read 工具读打印出的路径才能看到图
figma export <id> --out ./src/assets/icons                 # 按设计稿里配好的导出设置
figma export <id> --format SVG --out ./src/assets/icons
figma export <id> --format PNG --scales 1,2,3 --out ./assets
figma export <frameId> --recursive --out ./assets          # 整个 Frame 下的图标一次切完

# 要把图标内联进 HTML/JSX：一步到位，不用先落盘再 cat
figma export "I1:28;64:2356" "I1:41;64:2356" --format SVG --stdout --currentcolor
```

**优先不带 `--format`**：设计师在 Figma 里配的导出设置（格式/倍率/后缀）就是交付意图。

- 图标用 SVG；文案要在代码里改的加 `--no-svg-outline-text` 保留文本不转曲
- 倍率：Web 通常 `1,2`，移动端 `2,3`
- `--stdout` 直接吐 SVG 源码（含 `token:` 字段告诉你该给容器设哪个 CSS 变量）；
  `--currentcolor` 把**绑了 token 的** fill/stroke 换成 `currentColor`，
  裸色值原样保留并标 `warn: unbound-color`（那可能是有意的多色图标）；
  只要内部节点不要 `<svg>` 外壳就加 `--no-svg-wrapper`
- 文件名来自图层名；实例内部节点的图层名没意义（`Vector`），会自动回退到**主组件名**
  （`文件2.svg`）。要纯 ASCII 文件名加 `--ascii-names`
- 先 `figma find` 或看 `figma plan` 的 assets 段拿 id，别猜

---

## 六、混合布局：Auto Layout 流 + 绝对定位共存

**这是最容易出错的地方。** 一个 Frame 完全可以既有 Auto Layout 子节点、又有
`absolute: true` 的子节点 —— 对应 `position: relative` + 内部 `position: absolute`。

**`pos` 是相对父级的，不是相对画板。** 想知道一个绝对定位的元素落在哪一行，
**看 `abs`，不要逐层累加 `pos`**：

```yaml
- {type: Ellipse, name: 未读红点, id: "1:1058", size: [6, 6], pos: [38, 533], abs: [38, 533]}
- {type: Instance, name: 侧边栏, id: "1:1041", size: [392, 48], abs: [0, 521]}
#   → 533 - 521 = 12，正好是这一行的 padding-top，红点贴在这一行的图标顶部
```

`abs` 的原点是**本次 `--root-id` 的节点**，输出末尾有一行注释写明是谁。手工累加四层
偏移算对了很大程度上靠运气，而这类错误在截图里极难发现——红点贴在任何一行看起来
都「像是对的」。

**写完要验算。** 用各区块的 `size.h` 反推 gap/padding 是否和你的实现一致：

```
分组     236 = 44 + 4×48                (无 gap)
置顶     140 = 44 + 2×48                (无 gap)
聊天记录 240 = 44 + 4×48 + 4×1           (gap: 1)
容器     618 = 236 + 1 + 140 + 1 + 240   (gap: 1)  ✓
```

三层都对上了才能确信 flex 写对了。**这一步不能省。**

拿不准某个节点该翻译成什么 CSS 时，让工具做这个机械转换：

```bash
figma css <id>            # 单个节点的声明块
figma css <id> --nested   # 连子树，生成 BEM 风格类名（只出 CSS，不出 HTML）
```

它会正确处理「`sizing: {w: fill}` 在主轴上是 `flex:1`、在交叉轴上是
`align-self:stretch`」这类每次都要重新判断方向的地方，而且绑了变量的属性输出
`var(--slug)` 并在注释里保留原 token 名。

---

## 七、系统 chrome 直接切图

状态栏、Home Indicator、键盘、灵动岛这类东西：**不要展开、不要逐节点还原。**

它们在输出里已经折叠成 `type: SystemChrome` 一行，上面有你需要的全部东西：容器
尺寸、padding、文案、以及右侧图标组的可导出 id。整体 `figma export` 出一张图，
或者在真实工程里交给系统 / 独立组件。

展开一个状态栏要花约 200 行，换回来的只有 4 个事实。

设计稿里的系统组件叫别的名字时，在 `~/.figma-mcp/config.json` 里加：

```json
{ "systemComponents": ["MyStatusBar", "顶部信息栏"] }
```

---

## 八、暗色模式是硬约束

`figma vars` 的 `modes` 一旦包含 Dark：

- **任何裸色值都是 bug** —— 它在暗色下必然出错。要么找到对应的 token，
  要么明确报告给用户，不要自己挑一个色值。
  真实案例：环形进度底环 `stroke: "#000000@0.15"` 未绑 token，暗色背景下完全不可见。
- 别名 `→$White(#ffffff)` 在代码里也应该串成变量引用，不要拍平成色值。
- 写 CSS 时**三种主题状态都要覆盖**：`:root` / `@media (prefers-color-scheme: dark)` /
  `[data-theme="dark"]`。只写媒体查询会导致显式切换失效。

`figma lint`（下一节）会把裸色值在有 Dark mode 时直接报成 `error`。

---

## 九、写完之后

### 导一张图对照

`figma image <id>` 再导一次，**用 Read 工具在同一轮对话里先后读入**你的实现截图和
设计稿截图——视觉差异在连续两张图之间最容易发现。重点核对这四项：

**字重、行高、阴影浓淡、圆角。** 结构错误看树就能发现，这四项只能看图。

### 做设计走查

```bash
figma lint <id>                 # 全部
figma lint <id> --level warn    # 只看 error 和 warn
```

设计稿并不总是规范的，你能发现设计师自己没发现的问题。规则包括：未绑 token 的裸
色值（**含描边** —— 这条 grep 抓不到，而它往往是最值钱的一条）、未绑样式的裸字号、
被 detach 的实例、被拖改尺寸的实例、不在刻度表里的间距、超出裁剪容器的内容、
图层名与文案不符、值重复的 token。

每条都带 `path`（可读层级路径）和 `fix` 建议。

**只报告，不要自己改。** `gap: 1` 不在刻度表里就报出来，不要悄悄写成 8。

### 交付时必须说清楚这五件事

1. **没能一比一还原的部分**及原因（字体缺失、位图占位、外部组件未复用…）
2. **设计稿里没有对应 token 的色值/字号** —— 报告，不要自己造变量
3. **走查发现**（`figma lint` 的 error/warn）
4. **需要用户决策的点**（是否引入项目已有组件、图层名是否要在 Figma 侧改）
5. **暗色模式覆盖情况** —— 哪些做了、哪些因为裸色值做不了

### 设计稿字体本地没有时

设计稿字体（如 `Flyme Sans VF`）在开发机上通常不存在。按顺序：

1. 检查项目里有没有该字体文件，有就 `@font-face`；
2. 没有就用**同类度量**的字体回退，CSS 里保留原字体名作为首选：
   `font-family: "Flyme Sans VF", system-ui, sans-serif`；
3. **必须在交付说明里告知用户字宽会有差异**，不要默默替换。

---

## 命令速查

| 命令 | 用途 | 常用参数 |
|---|---|---|
| `figma ctx` | 文件/页面/选中项 —— 入口 | `--expand-selection` |
| `figma plan [id]` | **一站式调研，还原从这条开始** | `--depth --only` |
| `figma tree [id...]` | 结构树，可多个 root | `--depth --max-nodes --expand-instances --stat --no-abs` |
| `figma find <关键词>` | 按名称/类型定位 | `--types --all-pages --limit` |
| `figma node <id>...` | 完整属性（不折叠，用于精读） | `--with-children` |
| `figma text [id]` | 抽全部文案 | `--root-id --limit` |
| `figma css <id>` | 布局 → flex CSS 的机械翻译 | `--nested --var-prefix` |
| `figma lint [id]` | 设计走查 | `--level --expand-instances` |
| `figma image <id>` | 截图给自己看 | `--scale --format --max-dimension` |
| `figma export <id...>` | 切图进项目 | `--out --format --scales --recursive --stdout --currentcolor` |
| `figma vars` | 变量表 | `--used-by --values --collection-id` |
| `figma styles` | 样式定义（字号/行高/字重） | `--used-by --type` |
| `figma components` | 组件与变体清单 | `--query --all-pages` |
| `figma docs` / `figma use <docId>` | 多文档时切换目标 | |
| `figma status` / `figma stop` | daemon 状态 / 停止 | |

折叠开关（`tree` / `plan` 通用）：`--expand-icons` `--expand-system` `--no-dedupe`
`--dedupe-scope document` `--icon-max-size`。

`figma <命令> --help` 看完整参数。**多个 id 用空格分隔**（`figma node "1:2" "3:4"`）。

所有命令的 stdout 都是合法 YAML，进度提示和附注走注释行或 stderr，不会破坏解析。
出错时 stderr 上是 `error: <码>` + `message:`，退出码非 0 —— 别把错误当数据往下用。

## 排查

| 症状 | 处理 |
|---|---|
| `NO_DOCUMENT` | 插件没运行，让用户在 Figma 里启动它。**不要重试**，等用户确认 |
| `AMBIGUOUS_DOCUMENT` | 开了多个文档，`figma docs` 看列表后 `figma use <docId>` |
| `TIMEOUT` | 文件太大，缩小 `--depth` / `--limit` 重试 |
| `figma: command not found` | 在项目目录跑 `bash scripts/install.sh` |
| `vars` / `styles` 是空的 | 该页没用任何 token，或插件是旧版（`figma docs` 看 `plugin` 版本，让用户关掉插件窗口重开） |
| 输出里没有 `abs` / `descendants` / 折叠 | 插件是旧版，让用户关掉插件窗口重开 |
| 结构里全是坐标没有 layout | 设计稿没用 Auto Layout，只能按绝对定位还原，并告诉用户这一点 |
