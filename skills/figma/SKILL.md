---
name: figma
description: 读取本地 Figma 设计稿——把选中的 Frame 转成前端代码、提取 design token、核对文案、导出截图。当用户提到 Figma、设计稿、还原设计、切图、design token、组件变体，或让你「照着这个设计实现」时使用。通过 figma CLI 直连 Figma 桌面版插件，没有 REST API 的速率限制。
---

# 读取 Figma 设计稿

用 `figma` 命令直接读取用户此刻在 Figma 桌面版里打开的文档。数据来自 Figma
Plugin API，看到的永远是屏幕上当前的样子，包括未保存的编辑和组件实例的覆盖。

## 前提

需要 Figma 桌面版开着，且「Figma MCP Bridge」插件在运行。
命令报 `NO_DOCUMENT` 就是插件没跑起来，让用户去 `Plugins → Development → Figma MCP Bridge`。

daemon 会在首次执行时自动拉起，不需要你管。

## 标准流程

```bash
figma ctx                      # 1. 先看用户选中了什么
figma tree --depth 3           # 2. 读选中项的结构
figma image <id>               # 3. 需要看视觉效果时导出截图
figma export <id> --out ./assets  # 3'. 需要资源文件（图标/插图）时切图
figma node <id> [<id>...]      # 4. 对关键节点精读完整属性
figma vars && figma styles     # 5. 需要 design token 时
```

**永远先跑 `figma ctx`**。它告诉你用户在哪个文件、哪一页、选中了什么——不知道
这些就开始猜是在浪费时间。

## 输出格式

所有命令输出 YAML。无意义的字段一律省略，短结构走 flow 风格：

```yaml
- type: Frame
  name: ProductCard
  id: "12:34"
  size: [340, 420]
  layout: {mode: vertical, gap: 16, padding: 20}
  fill: $surface/card
  children:
    - type: Text
      id: "12:37"
      text: AirPods Pro
      size: [300, 24]
      color: $color/text-primary
      font: {style: "@text/heading-sm"}
```

| 字段 | 含义 |
|---|---|
| `id` | 节点 id，直接传给其它命令 |
| `size: [w, h]` | 宽高。`pos: [x, y]` 只在非 Auto Layout 流内出现 |
| `layout` | 自身的 Auto Layout：`mode` 方向、`gap` 间距、`padding` 内边距、`justify`/`align` 对齐 |
| `sizing: {w, h}` | 该节点作为子元素的尺寸行为：`fill` / `hug` / `fixed` |
| `component: {of, props}` | 实例指向的主组件与属性覆盖 |
| `bind` | 节点属性绑定到变量（width、itemSpacing…） |
| `more: true` | 还有子节点没展开。拿同一行的 `id` 单独取树继续下钻 |
| `$name` | 绑定的**变量**（variable） |
| `@name` | 绑定的**样式**（style） |

输出量大时先重定向到文件再检索，别整棵树读进上下文：

```bash
figma tree --depth 8 > /tmp/t.yaml && grep -n "推荐" /tmp/t.yaml
```

### 最重要的一条规则

**看到 `$` 或 `@` 就必须映射成代码里的 design token，绝不硬编码字面值。**

`color=$color/brand` → `var(--color-brand)` 或 `theme.color.brand`，
不要写 `#0A84FF`。这是这套工具相对截图识别的核心价值——设计稿里的语义
被完整保留了下来，丢掉就白读了。

不确定 token 在代码里叫什么，先 `figma vars` 看变量全貌，再和代码里的
token 文件对照。

## 控制上下文开销

设计稿很大，一个页面几百个节点是常态。

**分层下钻，不要一次拉深。** `--depth 2` 起步，看到 `… 还有 N 个子节点未展开
（rootId=#12:39）` 再针对那个节点单独取树。

**大树先落盘再检索**，别整个读进上下文：

```bash
figma tree --depth 8 --max-nodes 2000 > /tmp/tree.txt
grep -n '推荐\|Button' /tmp/tree.txt        # 只把命中的行读进来
```

**组件实例内部默认不展开**。状态栏、图标组这类是设计系统的实现细节，
展开会吃掉绝大部分节点预算。实例名 + `props{}` 通常就够生成代码了。
真要看内部：`figma tree <实例id>`（rootId 直指实例时总是展开）。

**要文案就用 `figma text`**，比读树便宜得多，而且能穿透实例：

```bash
figma text <id>                # 子树全部文本，含图层名
```

## 看截图

`figma image <id>` 把 PNG 落到本地并打印路径。**用 Read 工具读那个路径**
才能真正看到图。

生成代码后再导一次对照还原度，比凭结构描述想象靠谱。

## 切图

`figma export` 是给工程用的，和 `figma image` 不是一回事：前者原始尺寸、按图层名
命名、落到项目目录；后者有长边上限、落在临时目录，只是给你看一眼。

```bash
figma export <id> --out ./src/assets/icons                 # 按设计稿里配好的导出设置
figma export <id> --format SVG --out ./src/assets/icons    # 指定格式
figma export <id> --format PNG --scales 1,2,3 --out ./assets
figma export <frameId> --recursive --out ./assets          # 整个 Frame 下的图标一次切完
```

**优先不带 `--format`。** 设计师在 Figma 里配的导出设置（格式 / 倍率 / 文件名后缀）
就是他的交付意图，照做即可；只有在设计稿没配、或用户明确要别的格式时才覆盖。

- 图标用 SVG。文案要在代码里改的，加 `--no-svg-outline-text` 保留文本不转曲。
- 位图倍率：Web 通常 `1,2`，移动端 `2,3`。
- 文件名来自图层名（`icon / search` → `icon-search.svg`），同名自动加序号。
  名字不合适就先在 Figma 里改图层名，别在代码里改文件名。
- 导出前先 `figma find` 或 `figma tree` 拿到 id，别猜。

## 命令速查

| 命令 | 用途 |
|---|---|
| `figma ctx` | 文件/页面/当前选中项 —— 入口 |
| `figma tree [id]` | 节点结构树 |
| `figma find <关键词>` | 按图层名或类型定位节点 |
| `figma node <id>...` | 完整属性（描边、阴影、约束、富文本分段） |
| `figma text [id]` | 抽取全部文案 |
| `figma image <id>` | 导出 PNG 截图（给自己看） |
| `figma export <id...>` | 切图：PNG/JPG/SVG/PDF、多倍率、落到项目目录 |
| `figma vars` | 变量集合与各 mode 的值 |
| `figma styles` | Paint / Text / Effect / Grid 样式 |
| `figma components` | 组件与变体清单 |
| `figma docs` / `figma use <docId>` | 多文档时切换目标 |
| `figma status` / `figma stop` | daemon 状态与停止 |

`figma <命令> --help` 看完整参数。

## 排查

| 症状 | 处理 |
|---|---|
| `NO_DOCUMENT` | 插件没运行，让用户在 Figma 里启动它 |
| `AMBIGUOUS_DOCUMENT` | 开了多个文档，`figma docs` 看列表后 `figma use <docId>` |
| `TIMEOUT` | 文件太大，缩小 `--depth` / `--limit` 重试 |
| `figma: command not found` | 在项目目录跑 `bash scripts/install.sh` |
| 变量/样式为空 | token 定义在独立 Library 文件里。节点上的 `$name` 引用照常可用；要完整定义得在那个 Library 文件里跑插件 |
