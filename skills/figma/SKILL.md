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
figma image <id>                           # 2. 先看一眼整体（Read 工具读打印出来的路径）
figma tree --root-id <id> --depth 3        # 3. 分层读结构，不要一次拉深
figma vars > /tmp/vars.yaml                # 4. token 表：变量
figma styles > /tmp/styles.yaml            #    token 表：样式（字号/行高/阴影）
figma node "<id1>" "<id2>"                 # 5. 关键节点精读完整属性（多个 id 用空格分隔）
figma text --root-id <id>                  # 6. 文案（比读树便宜，能穿透实例）
figma export <id> --out ./src/assets       # 7. 图标/插图切图
# → 写代码 →
figma image <id>                           # 8. 再导一次，和你实现的效果对照
```

**永远先 `figma ctx`。** 不知道用户在看什么就开始猜是浪费时间。

**第 4 步不能跳。** 结构告诉你「这里用了 `$主题色/Base/Primary`」，token 表才告诉你
它是什么、有几套模式（Light/Dark）、在代码里该对应哪个变量。只读结构不读 token 表，
你会把 `$容器/SurfaceContainer` 当成一个不认识的字符串扔掉。

---

## 二、读懂输出：YAML 字段 → 前端概念

输出全是 YAML，无意义的字段一律省略。

```yaml
- type: Frame
  name: 内容框
  id: "1:3640"
  size: [392, 215]
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
| `pos: [x, y]` | 只在**非** Auto Layout 流内出现 → 绝对定位 |
| `absolute: true` | 在 Auto Layout 里被设成绝对定位 → `position:absolute` |
| `fill` / `color` | 背景色 / 文字色 |
| `stroke: {paint, weight}` | `border` |
| `radius` | `border-radius`，数组是四角 |
| `effect` | `box-shadow`（`shadow(x,y 模糊 扩散 色值)`）或 `filter: blur()` |
| `opacity` / `rotate` / `blend` | `opacity` / `transform: rotate()` / `mix-blend-mode` |
| `clip: true` | `overflow: hidden` |
| `font: {style: "@X"}` | 文字样式引用 → **去 `figma styles` 查它的字号/行高/字重** |
| `font: {face, size}` | 没绑样式，只有裸值。`size: 14/20px` 是 字号/行高 |
| `component: {of, props}` | **这是个组件实例**，见下 |
| `bind: {...}` | 该属性绑定到了变量（如 `paddingLeft: $Margin medium`） |
| `more: true` | 还有子节点没展开，拿同一行的 `id` 单独取树 |
| `$name` | **变量**（variable） |
| `@name` | **样式**（style） |

### 两个最重要的信号

**`$` 和 `@` 必须映射成代码里的 token，绝不硬编码。**

```
color: $主题色/Base/Primary   →   color: var(--primary)      ✅
color: $主题色/Base/Primary   →   color: #000000             ❌ 白读了
```

先在 `figma vars` / `figma styles` 的输出里找到它的定义，再和项目现有的 token 文件
（`tailwind.config`、`:root{}`、`theme.ts`…）对照，用**项目里已有的名字**。项目里没有
对应 token 时，告诉用户「设计稿用了 X，代码里没有对应变量」，而不是自己造一个色值。

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

```bash
figma vars      # 变量：颜色、间距、圆角、机型开关…
figma styles    # 样式：字体（字号/行高/字重）、色板、阴影、栅格
```

两者都会**自动反查当前页实际引用到的远端定义**（标 `source: referenced`）——
真实项目的 token 基本都定义在外部 Library 里，本文件往往一个都没有，这是正常的。

```yaml
collections:
  - name: fd_sys_color
    modes: [Light, Dark, Dark-soft, Box Dark]
    source: referenced
    variables:
      - {name: $文字图形/OnSurface, type: color, values: {Light: "#000000", Dark: "#eeeeee"}}
      - {name: $容器/SurfaceContainerLowest, type: color, values: {Light: →$White(#ffffff)}}
```

- **`modes` 就是主题**。有 Light/Dark 就说明这套设计支持深色模式，代码里的 token
  必须是可切换的变量，不能写死某一个 mode 的值。
- `→$White(#ffffff)` 是别名：这个 token 指向另一个 token，代码里也应该这么串。
- `type: float` 的集合（如 `Margin tokens`）是间距/圆角刻度表，见下面的走查用法。
- 反查**只覆盖当前页**（上限 3000 个节点）。换页要重跑。
- `figma vars --values` 只在需要外部库**完整清单**的值时才用，很慢。日常不需要。

---

## 四、控制上下文开销

设计稿一页几百上千个节点是常态，全读进来必爆。

**分层下钻。** `--depth 2` 起步，看到 `more: true` 再对那个 id 单独取树。

**大树先落盘再检索**，只把命中的行读进上下文——这是 CLI 相对 MCP 的核心优势：

```bash
figma tree --root-id <id> --depth 8 --max-nodes 3000 > /tmp/t.yaml
grep -n "推荐\|Button" /tmp/t.yaml
grep -A 3 'type: Text' /tmp/t.yaml     # 输出是合法 YAML，装了 yq 也可以直接查询
```

`--max-nodes` 上限 3000，默认 400。

**实例内部默认不展开。** 状态栏、图标组这些是设计系统的实现细节，展开会吃掉整个节点
预算，而你多半应该直接复用现成组件。真要看内部：`figma tree --root-id "<实例id>"`
（rootId 直指实例时总是展开），或加 `--expand-instances`。

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
```

**优先不带 `--format`**：设计师在 Figma 里配的导出设置（格式/倍率/后缀）就是交付意图。

- 图标用 SVG；文案要在代码里改的加 `--no-svg-outline-text` 保留文本不转曲
- 倍率：Web 通常 `1,2`，移动端 `2,3`
- 文件名来自图层名（`icon / search` → `icon-search.svg`），同名自动加序号；名字不合适
  让用户在 Figma 里改图层名，别在代码里改
- 先 `figma find` 拿到 id，别猜

---

## 六、写完之后

**导一张图对照。** `figma image <id>` 再导一次，和你实现的页面并排看——光看结构想象
不出来的偏差（字重、行高、阴影浓淡）一眼就能发现。

**顺手做设计走查。** 设计稿并不总是规范的，你能发现设计师自己没发现的问题：

```bash
figma tree --root-id <id> --depth 20 --max-nodes 3000 > /tmp/t.yaml
grep -c 'fill: "#' /tmp/t.yaml        # 没绑 token 的裸色值有多少
grep -c 'font: {face:' /tmp/t.yaml    # 没绑文字样式的裸字号有多少
grep -oE '(padding|gap): [0-9]+' /tmp/t.yaml | sort | uniq -c   # 间距值分布
```

把间距值和 `figma vars` 里的间距刻度表（如 `$Margin small=8 / regular=12 / medium=16`）
对一遍，`18` 这种不在表里的值就是可疑的。**报告给用户，不要自己悄悄改成 16**。

---

## 命令速查

| 命令 | 用途 | 常用参数 |
|---|---|---|
| `figma ctx` | 文件/页面/选中项 —— 入口 | `--expand-selection` |
| `figma tree [id]` | 结构树 | `--root-id --depth --max-nodes --expand-instances` |
| `figma find <关键词>` | 按名称/类型定位 | `--types --all-pages --limit` |
| `figma node <id>...` | 完整属性（描边/阴影/富文本分段/token 解析值） | `--ids --with-children` |
| `figma text [id]` | 抽全部文案 | `--root-id --limit` |
| `figma image <id>` | 截图给自己看 | `--scale --format --max-dimension` |
| `figma export <id...>` | 切图进项目 | `--out --format --scales --recursive` |
| `figma vars` | 变量表（含反查到的远端） | `--values --scan --collection-id` |
| `figma styles` | 样式定义（字号/行高/阴影） | `--type --scan` |
| `figma components` | 组件与变体清单 | `--query --all-pages` |
| `figma docs` / `figma use <docId>` | 多文档时切换目标 | |
| `figma status` / `figma stop` | daemon 状态 / 停止 | |

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
| 结构里全是坐标没有 layout | 设计稿没用 Auto Layout，只能按绝对定位还原，并告诉用户这一点 |
