# figma-mcp

一套自建的 Figma ↔ AI 通道：**Figma 插件**直接读取本地打开的设计文档，通过 **WebSocket** 与本地 **daemon** 通信，`figma` CLI + skill 把设计稿以低 token 成本、高保真的形式交给 AI 模型。

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

**v1 是只读的。** 先把 CLI ↔ daemon ↔ 插件 ↔ Figma 这条链路做扎实，写操作留到第二阶段。协议和目录结构为写操作预留了位置（method 命名空间 `node.get*` / 未来 `node.set*`），但 v1 不实现。

---

## 三、快速开始

**前置条件**：Node ≥ 20、Figma **桌面版**（浏览器版连 `ws://localhost` 在部分浏览器上不可靠）。

### 1. 构建

```bash
npm install
npm run build
```

`manifest.json` 由构建脚本从端口段常量生成 —— 不要手改，改了会和 `config.ts` 漂移。

### 2. 在 Figma 里导入插件

Figma **桌面版** → `Plugins` → `Development` → `Import plugin from manifest...`
选择 `packages/plugin/manifest.json`。

导入后在 `Plugins → Development → Figma MCP Bridge` 运行。插件面板会显示连接状态。

> 改了插件代码只需重新 `npm run build:plugin` 并重开插件窗口；
> **但改了 `manifest.json` 必须重新 Import** —— Figma 在应用级缓存插件文件。

### 3. 安装 CLI 与 skill

```bash
npm link -w @figma-mcp/server                       # 把 figma 命令装到 PATH
ln -s "$PWD/skills/figma" ~/.claude/skills/figma    # 装 skill（用户级，所有项目可用）
```

验证：

```bash
figma --help
figma status
```

### 4. 配对

daemon 首次启动会生成 `~/.figma-mcp/token`。把里面的内容粘贴到插件面板的输入框，点保存。
之后 token 存在 `figma.clientStorage` 里，不用再输。

本机独占调试时可以用 `FIGMA_MCP_NO_AUTH=1` 跳过。

### 5. 用起来

```bash
figma ctx                      # 看用户选中了什么
figma tree --depth 3           # 读结构
figma image 1:3635             # 导出截图
figma vars                     # design token
```

daemon 会在第一条命令时自动拉起并常驻，不需要手动管理。

### 可选：MCP 前端

不能跑命令行的客户端可以用 MCP：

```bash
claude mcp add figma -s user -- node "$PWD/packages/server/dist/index.js"
```

它复用同一套 tools，且启动时也会把 daemon 带起来（`figma` CLI 会直接复用那个进程）。
但 tool 定义会常驻每个会话的 context —— 这正是主推 CLI 的原因。

### 环境变量

| 变量 | 说明 |
|---|---|
| `FIGMA_MCP_PORT` | 固定端口（CLI 也只认这个端口，用于测试隔离） |
| `FIGMA_MCP_NO_AUTH` | `1` 关闭配对校验 |
| `FIGMA_MCP_LOG_LEVEL` | `debug` / `info` / `warn` / `error`，日志走 stderr |

### 排查

- `figma status` —— daemon 端口、pid、已连接文档
- `~/.figma-mcp/daemon.log` —— daemon 的输出（自动拉起时看这里）
- `~/.figma-mcp/daemon.json` —— 当前 daemon 的端口与 pid
- `curl http://localhost:3055/health` —— 直接看 daemon 状态
- 插件面板的「日志」按钮展开活动日志
- `npm run smoke` —— 假插件跑全链路（MCP + CLI 两个前端），不需要打开 Figma，用来区分是 daemon 侧还是 Figma 侧的问题

---

## 四、命令清单

| 命令 | MCP tool 名 | 说明 |
|---|---|---|
| `figma docs` | `list_documents` | 列出已连接的 Figma 文档 |
| `figma use <docId>` | `select_document` | 多文档时指定目标 |
| `figma ctx` | `get_current_context` | 文件/页面/当前选中项 —— **入口** |
| `figma tree [id]` | `get_node_tree` | 分层展开结构 |
| `figma find <关键词>` | `search_nodes` | 按名称/类型定位 |
| `figma node <id>...` | `get_node_detail` | 完整属性 |
| `figma text [id]` | `get_text_content` | 抽取全部文案 |
| `figma image <id>` | `get_node_image` | 导出 PNG |
| `figma vars` | `get_variables` | 变量集合与各 mode 的值 |
| `figma styles` | `get_styles` | Paint / Text / Effect / Grid |
| `figma components` | `get_components` | 组件与变体清单 |

CLI 也接受 MCP 名（`figma get_node_tree` 等价于 `figma tree`）。

daemon 管理（无 MCP 对应）：

| 命令 | 说明 |
|---|---|
| `figma status` | daemon 端口、pid、已连接文档 |
| `figma stop` | 停止 daemon（改了 server 代码后必须执行，否则跑的还是旧进程） |
| `figma daemon` | 前台运行 daemon，看实时日志 |

## 五、架构

Figma 插件有一条硬约束：`code.js`（沙箱主线程，能调 `figma.*`）**没有网络能力**；只有 `ui.html`（iframe）能发起 WebSocket，且域名必须在 manifest 的 `networkAccess.allowedDomains` 中声明。所以链路必然是三段式：

```
AI（读 skill 后调用命令）
   │  figma tree --depth 3
   ▼
figma CLI ──HTTP POST /call──►  daemon（常驻）
                                  │  内嵌 WS Server + HTTP /health
                                  │  ws://localhost:3055~3064
                                  ├───────────────►  Plugin@文档A
                                  └───────────────►  Plugin@文档B
                                                        │  figma.ui.postMessage
                                                        ▼
                                                    Plugin Sandbox ──► figma.*
```

### 为什么必须有 daemon

**Figma 插件不能监听端口。** 插件 UI 是 iframe，只能主动发起连接（WebSocket client、fetch），做不了 server。而 CLI 是短命进程，每次执行都等插件重新握手要好几秒。所以中间必须有个常驻进程。

CLI 首次执行时自动 spawn detached 把它拉起来（约 0.4s），之后所有命令都是毫秒级。`figma status` / `figma stop` 管理它。

### 为什么是 CLI 而不是 MCP

MCP 前端仍然保留（`packages/server/dist/index.js`），但主推 CLI + skill：

1. **Context 成本**。MCP 的 11 个 tool 定义**每个会话都常驻 context**，不管这次用不用 Figma，粗算 2000+ token 的固定开销。skill 是按需加载的。
2. **可组合**。`figma tree --depth 8 > /tmp/t.txt && grep 推荐 /tmp/t.txt` —— 几百个节点的大树能挡在上下文之外，只把命中的行读进来。这对「设计稿转代码」是数量级的差别。

代价是图片：MCP 能直接返回 image content block，CLI 只能落盘 + 打印路径，让 AI 自己 `Read`。多一步，但可用。

两个前端共用同一套 `tools/registry.ts`——同一份参数 schema、同一份实现、同一份描述文本。CLI 的 `--help` 就是从 schema 生成的，不会漂移。

### 多文档路由规则

绝不静默猜测当前该操作哪个文档：

- `figma docs` 列出所有已连接的 Figma 文档
- 只有一个连接时自动使用，无需指定
- 多个连接且未显式选择时 → **报错并列出候选**，要求先 `figma use <docId>`

---

## 六、关键设计决策

### 1. 输出用紧凑 DSL，不用 JSON

同样的信息，原始 JSON 大约是下面这种格式的 5–10 倍 token：

```
Frame "ProductCard" #12:34  340x420 autoV gap=16 pad=20 fill=$surface/card radius=12 effect=$elevation/1
  Rect "cover" #12:35  300x180 fill=<image:fill> radius=8
  Frame "info" #12:36  300x60 autoV gap=8 w=fill
    Text "title" #12:37  300x24 "AirPods Pro" color=$color/text-primary font=@text/heading-sm
    Text "price" #12:38  300x20 "¥1,899" color=$color/brand font=Inter Regular 14/20px
```

记号约定：`$name` 是**变量**（variable），`@name` 是**样式**（style）。

**核心规则：能还原成 token 引用的，绝不输出原始值。**
出现 `$` 或 `@` 时，生成的代码必须引用对应 token，不要硬编码字面值 —— 这条规则同时写进了
`get_node_tree` 的 tool 描述里，模型读到输出时就知道该怎么处理。

### 2. 插件侧裁剪，Server 侧格式化

- **插件侧**只做字段白名单裁剪，回传精简的中间 JSON（省 WS 带宽，避开大对象序列化开销）
- **daemon 侧**负责把中间 JSON 转成 DSL 文本

理由很实际：插件每改一行都要重新 build 并在 Figma 里重载，迭代很慢；而输出格式恰恰是最需要反复调试的部分。放在 daemon 侧，`npm run build && figma stop` 就生效。

### 3. 上下文预算是第一约束

一个中等复杂的 Frame，完整节点树 JSON 轻松几 MB，直接扔给模型必然爆 context。对策：

- **分层读取** —— `figma tree <id> --depth 2`，深层只给 `id/name/type`，按需下钻
- **字段白名单** —— 默认只返回布局相关属性，不返回完整 `fills`/`effects`/`vectorPaths`
- **语义化压缩** —— 上面的 DSL
- **先定位再细看** —— `figma find` 找到目标再 `figma node`，避免全树遍历
- **落盘再检索** —— 大树重定向到文件后 grep，只把命中行读进上下文（这是 CLI 相对 MCP 的核心优势）

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

`figma vars` 分两档：本地集合给完整结构（含所有 mode）；远端变量只在被引用时以「名字 + 解析值」出现。

### 5. 图像作为核心能力

`exportAsync` → PNG → base64 → MCP image content，让模型能"看见"设计稿，也能在生成代码后自检还原度。

- **必须分片**：几 MB 的 base64 单条 WS 消息不稳，协议里带 `chunkIndex/total`
- **必须限尺寸**：默认 scale=1、长边上限 ~1500px，超出自动降采样。Claude 会把图片缩到约 1.15M 像素，传更大纯粹浪费 token 和时间
- 同时落一份到 `~/.figma-mcp/exports/` 并返回路径，方便肉眼核对模型「看到」的是什么

---

## 七、已知的坑（来自踩坑与参考实现）

这一节是给未来的自己看的，每一条都是会浪费半天时间的那种。

1. **manifest 的 `networkAccess` 改了必须重新 Import 插件。** Figma 在**应用级**缓存插件文件，关闭重开插件窗口不够。因此**端口不能写死** —— manifest 里预留端口段 `3055–3064`，server 启动时从 3055 起逐个尝试绑定，插件扫描整段。改端口不需要动 manifest。

2. **`documentAccess: "dynamic-page"` 是现代插件的必需项**，代价是所有节点访问都必须走异步 API：`getNodeByIdAsync()`、`loadAllPagesAsync()`。同步的 `getNodeById` / 直接遍历 `figma.root.children` 会抛错。

3. **`enablePrivatePluginApi: true`** 才能访问 `figma.fileKey`。拿不到时降级用 `figma.root.id` 作为文档标识。

4. **插件可能先于 server 打开。** 必须有后台重连 watchdog 持续探测，而不是让用户手动重启插件 —— 这是参考实现里被反复吐槽的痛点。

5. **在同端口挂一个 HTTP `/health`。** 插件先 HTTP 探活再建 WS，比直接连 WS 试错快得多，端口扫描才不会卡住。

6. **`allowedDomains` 里不能写 IP 字面量。** `http://127.0.0.1` 会被 Figma 直接判为 `must be a valid URL`，插件加载失败。只能写 `localhost`，而且必须带端口。

7. **写了 `localhost` 就必须双栈监听。** `localhost` 在不同环境下解析成 `::1` 或 `127.0.0.1`，server 只绑一个的话会出现「server 明明在跑、`/health` 手动 curl 也通、插件就是连不上」。所以 server 在同一端口上同时绑 `127.0.0.1` 和 `::1`，共用一个 `WebSocketServer`（`noServer` 模式 + 各自转交 upgrade）。

8. **建议用 Figma 桌面版。** 从 https 页面连 `ws://localhost` 依赖"localhost 属于 potentially trustworthy origin"这条豁免 —— Chrome 支持，Safari 不保证。桌面版是 Electron，行为稳定。

9. **localhost WebSocket 不是安全边界。** 任何本地网页都能连上读你的设计稿。因此加配对 token：server 启动时生成并写入 `~/.figma-mcp/token`，插件面板粘贴一次后存入 `figma.clientStorage`。

10. **大文件遍历会卡住 Figma 主线程。** 用 `findAllWithCriteria`（原生加速）而不是递归 `findAll`，配合 depth 限制。

11. **（v2 写操作预警）改文本前必须 `figma.loadFontAsync`**，漏了直接报错；批量操作要分批 yield，否则 Figma 主线程冻结。

---

## 八、目录结构

```
figma-mcp/
├─ packages/
│  ├─ shared/     协议类型定义（两端共用）
│  ├─ server/     daemon + WS Hub + tools 注册表 + DSL；两个前端 cli.ts / index.ts(MCP)
│  └─ plugin/     manifest.json + code.ts（沙箱）+ ui.html/ui.ts
├─ skills/figma/  给 AI 的使用说明（软链到 ~/.claude/skills/）
└─ scripts/       smoke.mjs 全链路冒烟
```

技术栈：TypeScript · `@modelcontextprotocol/sdk` · `@figma/plugin-typings` · esbuild · npm workspaces

---

## 九、v1 明确不做

- 写操作（创建/修改节点、变量 CRUD）
- Dev Mode 深度集成
- CI / 无头运行
- 跨文件 Library 的完整导出
- 多客户端并存下的 daemon 抢占（当前是先到先得，后来的复用同一个）
- 任意 JS 执行（`figma_execute` 式的逃生舱）—— 强大但不可控，不进 v1

---

## 十、参考

- [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp) —— 端口段扫描、重连 watchdog、manifest 缓存坑等实践来源
- [Figma Plugin API](https://www.figma.com/plugin-docs/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
