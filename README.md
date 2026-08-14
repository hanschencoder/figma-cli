# figma-mcp

一套自建的 Figma ↔ AI 通道：**Figma 插件**直接读取本地打开的设计文档，通过 **WebSocket** 与本地 **MCP Server** 通信，把设计稿以低 token 成本、高保真的形式交给 AI 模型。

---

## 一、为什么要做这个（初衷）

现有方案（官方 Figma MCP、Framelink figma-mcp 等）都走 **Figma REST API**，带来三个绕不开的问题：

1. **速率限制**。REST API 有 rate limit，稍微密集一点的迭代就被卡住 —— 这是最初的直接动机。
2. **只能读，不能写**。REST API 没有写能力，修改设计稿唯一的路径是 Plugin API。
3. **读不到"当前状态"**。未保存的编辑、当前选中项、本地未发布的变量与组件 override，REST 都看不到。

改用 **Figma Plugin API**，这三点同时解决：插件运行在 Figma 进程内，直接访问内存里的文档树，没有任何速率限制，能读能写，看到的永远是屏幕上此刻的样子。

**代价要清楚**：必须 Figma 客户端开着、插件在运行。这套东西**不能用于 CI 或后台批处理**。这是设计上的取舍，不是待修复的缺陷。

### 相对 REST 方案的核心增量

不只是"没有速率限制"。真正拉开差距的是 **design token 还原能力**：

节点上的 `boundVariables` / `fillStyleId` 能把一个颜色值反查回它绑定的变量或样式名。于是输出给模型的不是 `#0A84FF`，而是 `$color/brand`。模型据此生成的代码会写 `var(--color-brand)` 而不是硬编码色值 —— 这才是"设计稿转代码"真正有用的地方。

---

## 二、目标场景

| 场景 | 说明 | v1 |
|---|---|---|
| **设计稿 → 代码** | 读取选中 Frame 的布局/样式/文本，输出结构化描述供 AI 生成前端代码 | ✅ |
| **设计系统提取** | 导出变量、样式、组件清单，同步成代码里的 design token | ✅ |
| 批量改稿 / 规范检查 | 批量替换文案、检查 token 使用一致性 | v2 |
| AI 生成设计稿 | 自然语言驱动在 Figma 中创建页面 | v2 |

**v1 是只读的。** 先把 MCP Server ↔ 插件 ↔ Figma 这条链路做扎实，写操作留到第二阶段。协议和目录结构为写操作预留了位置（method 命名空间 `node.get*` / 未来 `node.set*`），但 v1 不实现。

---

## 三、架构

Figma 插件有一条硬约束：`code.js`（沙箱主线程，能调 `figma.*`）**没有网络能力**；只有 `ui.html`（iframe）能发起 WebSocket，且域名必须在 manifest 的 `networkAccess.allowedDomains` 中声明。所以链路必然是三段式：

```
Claude Code / 其他 MCP 客户端
   │  stdio (MCP)
   ▼
MCP Server (Node/TS)  ── 内嵌 WS Server + HTTP /health
   │  ws://127.0.0.1:3055~3064
   ├──────────────────────────►  Plugin@文档A
   └──────────────────────────►  Plugin@文档B
                                     │  figma.ui.postMessage
                                     ▼
                                 Plugin Sandbox  ──►  figma.*
```

### 为什么不做独立 relay 守护进程

因为目标是**单 MCP 客户端**。单客户端意味着只有一个 server 进程，直接内嵌 WS server 最简单。多个 Figma 文档并行是**插件侧多连接**（多个插件实例连同一个 server），由 server 的连接注册表解决，不需要额外进程。

> 如果将来要支持多客户端并存（Claude Code + Cursor 同时用），需要改成独立 relay，或者让插件扫描并连接多个端口。当前端口段设计已经为后者留好了空间。

### 多文档路由规则

绝不静默猜测当前该操作哪个文档：

- `list_documents()` 列出所有已连接的 Figma 文档
- 只有一个连接时自动使用，无需指定
- 多个连接且未显式选择时 → **报错并列出候选**，要求先 `select_document(id)`

---

## 四、关键设计决策

### 1. 输出用紧凑 DSL，不用 JSON

同样的信息，原始 JSON 大约是下面这种格式的 5–10 倍 token：

```
Frame "ProductCard" #12:34  340x420  autoV gap=16 pad=20
  fill=$surface/card  radius=$radius/lg  shadow=$elevation/1
  ├ Rect "cover" #12:35  300x180  radius=$radius/md  fill=<image>
  └ Frame "info" #12:36  autoV gap=8 grow=1
    ├ Text "title" #12:37  "AirPods Pro"  style=$text/heading-sm  color=$color/text-primary
    └ Text "price" #12:38  "¥1,899"       style=$text/body        color=$color/brand
```

**核心规则：能还原成 token 引用的，绝不输出原始值。**

### 2. 插件侧裁剪，Server 侧格式化

- **插件侧**只做字段白名单裁剪，回传精简的中间 JSON（省 WS 带宽，避开大对象序列化开销）
- **Server 侧**负责把中间 JSON 转成 DSL 文本

理由很实际：插件每改一行都要重新 build 并在 Figma 里重载，迭代很慢；而输出格式恰恰是最需要反复调试的部分。放在 server 侧，改完重启 MCP 就生效。

### 3. 上下文预算是第一约束

一个中等复杂的 Frame，完整节点树 JSON 轻松几 MB，直接扔给模型必然爆 context。对策：

- **分层读取** —— `get_node_tree(id, depth=2)`，深层只给 `id/name/type`，按需下钻
- **字段白名单** —— 默认只返回布局相关属性，不返回完整 `fills`/`effects`/`vectorPaths`
- **语义化压缩** —— 上面的 DSL
- **先定位再细看** —— `search_nodes` 找到目标再 `get_node_detail`，避免全树遍历

### 4. 远端变量只做引用还原

`figma.variables.getLocalVariableCollections()` 只能拿到**本地**变量集合。如果 token 定义在独立的 Library 文件里，业务稿引用的是远端变量。

v1 的策略是**不追求导出远端 Library 的完整定义**，只做本文件内的引用还原：

```
node.boundVariables.fills[0].id
  → figma.variables.getVariableByIdAsync(id)   // 远端变量也能拿到 name
  → variable.resolveForConsumer(node)          // 按消费者节点的 mode 上下文求值
  → 输出:  fill=$color/brand (#0A84FF)
```

`resolveForConsumer` 正好是为这个场景设计的，对远端变量同样有效。Style 同理走 `getStyleByIdAsync` 拿 name。

`get_variables` 分两档：本地集合给完整结构（含所有 mode）；远端变量只在被引用时以「名字 + 解析值」出现。

### 5. 图像作为核心能力

`exportAsync` → PNG → base64 → MCP image content，让模型能"看见"设计稿，也能在生成代码后自检还原度。

- **必须分片**：几 MB 的 base64 单条 WS 消息不稳，协议里带 `chunkIndex/total`
- **必须限尺寸**：默认 scale=1、长边上限 ~1500px，超出自动降采样。Claude 会把图片缩到约 1.15M 像素，传更大纯粹浪费 token 和时间
- 同时落盘到临时目录并返回路径，方便肉眼调试

---

## 五、已知的坑（来自踩坑与参考实现）

这一节是给未来的自己看的，每一条都是会浪费半天时间的那种。

1. **manifest 的 `networkAccess` 改了必须重新 Import 插件。** Figma 在**应用级**缓存插件文件，关闭重开插件窗口不够。因此**端口不能写死** —— manifest 里预留端口段 `3055–3064`，server 启动时从 3055 起逐个尝试绑定，插件扫描整段。改端口不需要动 manifest。

2. **`documentAccess: "dynamic-page"` 是现代插件的必需项**，代价是所有节点访问都必须走异步 API：`getNodeByIdAsync()`、`loadAllPagesAsync()`。同步的 `getNodeById` / 直接遍历 `figma.root.children` 会抛错。

3. **`enablePrivatePluginApi: true`** 才能访问 `figma.fileKey`。拿不到时降级用 `figma.root.id` 作为文档标识。

4. **插件可能先于 server 打开。** 必须有后台重连 watchdog 持续探测，而不是让用户手动重启插件 —— 这是参考实现里被反复吐槽的痛点。

5. **在同端口挂一个 HTTP `/health`。** 插件先 HTTP 探活再建 WS，比直接连 WS 试错快得多，端口扫描才不会卡住。

6. **建议用 Figma 桌面版。** 从 https 页面连 `ws://localhost` 依赖"localhost 属于 potentially trustworthy origin"这条豁免 —— Chrome 支持，Safari 不保证。桌面版是 Electron，行为稳定。

7. **localhost WebSocket 不是安全边界。** 任何本地网页都能连上读你的设计稿。因此加配对 token：server 启动时生成并写入 `~/.figma-mcp/token`，插件面板粘贴一次后存入 `figma.clientStorage`。

8. **大文件遍历会卡住 Figma 主线程。** 用 `findAllWithCriteria`（原生加速）而不是递归 `findAll`，配合 depth 限制。

9. **（v2 写操作预警）改文本前必须 `figma.loadFontAsync`**，漏了直接报错；批量操作要分批 yield，否则 Figma 主线程冻结。

---

## 六、目录结构

```
figma-mcp/
├─ packages/
│  ├─ shared/     协议类型定义（两端共用）
│  ├─ server/     MCP server + WS Hub + tools + DSL 序列化
│  └─ plugin/     manifest.json + code.ts（沙箱）+ ui.html/ui.ts
```

技术栈：TypeScript · `@modelcontextprotocol/sdk` · `@figma/plugin-typings` · esbuild · npm workspaces

---

## 七、v1 Tool 清单

### 定位与导航
| Tool | 说明 |
|---|---|
| `list_documents` | 列出已连接的 Figma 文档 |
| `select_document` | 多文档时指定目标 |
| `get_current_context` | 文件名、页面列表、当前页、当前选中项摘要 —— **AI 的入口** |
| `get_node_tree` | 分层展开结构，深层只给 id/name/type |
| `search_nodes` | 按名称/类型查找，避免全树遍历 |

### 读取细节
| Tool | 说明 |
|---|---|
| `get_node_detail` | 单/多节点完整属性：尺寸、autolayout、constraints、fill/stroke/effect、文本样式 |
| `get_text_content` | 一次性抽出子树所有文案 |
| `get_node_image` | 渲染节点为 PNG 回传 |

### 设计系统
| Tool | 说明 |
|---|---|
| `get_variables` | 变量集合 + 各 mode 的值 |
| `get_styles` | Paint / Text / Effect / Grid styles |
| `get_components` | 组件与变体清单，含 variant properties |

---

## 八、v1 明确不做

- 写操作（创建/修改节点、变量 CRUD）
- Dev Mode 深度集成
- CI / 无头运行
- 跨文件 Library 的完整导出
- 多 MCP 客户端并存
- 任意 JS 执行（`figma_execute` 式的逃生舱）—— 强大但不可控，不进 v1

---

## 九、参考

- [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp) —— 端口段扫描、重连 watchdog、manifest 缓存坑等实践来源
- [Figma Plugin API](https://www.figma.com/plugin-docs/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
