# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

自建的 Figma → AI 通道，绕开 Figma REST API 的速率限制。Figma 插件直接读内存里的
文档树，通过 WebSocket 交给常驻 daemon，`figma` CLI + skill 提供给 AI。**v1 只读。**

设计动机、取舍和背景见 README.md，这里只讲改代码需要知道的事。

## 常用命令

```bash
npm install
npm run build              # shared → server → plugin，顺序敏感
npm run build:server       # 只改了 daemon/CLI/DSL 时
npm run build:plugin       # 只改了插件时
npm run typecheck          # tsc -b 全部三个包
npm run smoke              # 全链路冒烟，不需要打开 Figma
```

### 改完代码后必须做的事

| 改了什么 | 必须做 |
|---|---|
| `packages/server/**` | `npm run build:server && figma stop` —— **不 stop 的话跑的还是旧 daemon** |
| `packages/plugin/src/**` | `npm run build:plugin`，然后在 Figma 里关掉插件窗口重开 |
| `packages/plugin/manifest.template.json` 或端口段常量 | 重新 build，然后在 Figma 里**重新 Import manifest**（Figma 在应用级缓存插件文件，重开窗口不够） |
| `packages/shared/**` | `npm run build`（两端都依赖） |

`packages/plugin/manifest.json` 是 `build.mjs` 从 `shared/src/config.ts` 的端口段常量
**生成**的，不要手改。

## 测试方式

没有单元测试，靠集成验证（这是明确的项目约定）。

**`npm run smoke`** —— 起一个真 daemon + 一个假 Figma 插件（WebSocket 客户端喂合成
数据），跑完全部 tool 的 MCP 和 CLI 两条路径。固定用端口 3064 隔离，不会连到常驻
daemon 上。改了 DSL 序列化或 tool 逻辑后先跑这个。

注意：假插件跑在 smoke 脚本自己的进程里，所以脚本里调 CLI **必须异步**
（`promisify(execFile)`），`execFileSync` 会堵死事件循环让插件回不了消息。

**对真实设计稿验证** —— 直接用 CLI，需要 Figma 桌面版开着且插件在运行：

```bash
figma ctx                                   # 当前选中项
figma tree --depth 3
figma tree --depth 8 > /tmp/t.txt           # 大树落盘再 grep
figma status                                # daemon 端口/pid/已连接文档
```

`figma` 未安装到 PATH 时用 `node packages/server/dist/cli.js`。

## 架构

```
AI ──► figma CLI ──HTTP POST /call──► daemon ──WS /bridge──► 插件 UI(iframe)
                                        ▲                        │ postMessage
                                   MCP stdio 前端                 ▼
                                     (可选)                  插件沙箱 ──► figma.*
```

### 三段式是硬约束，不是设计选择

Figma 插件沙箱（`code.ts`，能调 `figma.*`）**没有网络**；插件 UI（iframe）有网络但
碰不到 `figma.*`。所以所有数据都得在两者之间用 `postMessage` 倒一次手。

插件 UI 也**不能监听端口**，只能主动发起连接 —— 这是 daemon 必须存在的原因：CLI 是
短命进程，等插件重新握手要好几秒。

### 关键分工：插件裁剪，daemon 格式化

- **插件侧**（`packages/plugin/src/collect/`）只做字段白名单裁剪，回传精简的中间
  JSON（`shared/src/model.ts` 定义形状）
- **daemon 侧**（`packages/server/src/dsl.ts`）把中间 JSON 转成紧凑文本 DSL

**改输出格式优先改 `dsl.ts`**，因为插件每改一行都要重新 build + 在 Figma 里重载，
而 daemon 重启一下就生效。只有当需要的字段插件根本没采集时，才动 `collect/`。

### tools/registry.ts 是单一事实来源

`packages/server/src/tools/registry.ts` 定义每个 tool 的 zod schema、描述和实现，
**传输无关**。CLI（`cli.ts`）和 MCP（`index.ts`）只是两个前端：

- CLI 的 `--help`、参数解析、类型校验全部从 zod schema 反射生成
- 加一个新命令只需要往 registry 数组里加一项，两个前端自动都有

CLI 命令名是短名（`tree`），MCP 用规范名（`get_node_tree`），CLI 两个都接受。

### 数据流全景

一次 `figma tree` 的完整路径：

```
cli.ts 解析参数(zod) → POST /call → daemon.ts 路由 → registry 的 run()
  → hub.request() 发 WS req，等 res（带超时、分片重组）
  → 插件 ui.ts 转 postMessage → code.ts → handlers.ts dispatch
  → collect/node.ts 采集裁剪 → 原路返回
  → dsl.ts serializeNodes() → 文本
```

## 核心不变量

改代码时容易破坏的几条：

**1. 日志一律 stderr。** MCP 前端用 stdio，stdout 是 JSON-RPC 通道，往里写一个字节
日志就让客户端解析失败。用 `logger.ts` 的 `log.*`，不要 `console.log`。

**2. token 引用优先于原始值。** 输出 `$color/brand` 而不是 `#0A84FF`，`@Headline/mini`
而不是字号字重。这是整个项目相对截图识别的核心价值（`collect/common.ts` 的
`resolveToken` / `collectStyleRefs`）。`$` = 变量，`@` = 样式。

**3. 上下文预算是第一约束。** 中间数据模型的可选字段**在无意义时一律省略**
（opacity=1、visible=true、rotation=0…）。加字段前先想清楚它在典型设计稿上会
多产生多少 token。组件实例内部默认不展开、文本图层名与内容重复时只输出一次，
都是这条规则的产物。

**4. 不静默猜测目标文档。** `router.ts`：单连接自动选，多连接未指定时报错并列出
候选。猜错文档产生的错误极难排查。

**5. dynamic-page 下全异步。** manifest 用 `documentAccess: "dynamic-page"`，
同步的 `figma.getNodeById` / 直接遍历其它页的 children 会抛错。必须
`getNodeByIdAsync()` / `page.loadAsync()` / `figma.loadAllPagesAsync()`。

**6. 端口段不能写死单个。** manifest 白名单里放行 3055–3064，daemon 逐个尝试绑定。
manifest 里**不能写 IP 字面量**（Figma 报 `must be a valid URL`），只能 `localhost`
且必须带端口 —— 因此 daemon 在同一端口同时绑 `127.0.0.1` 和 `::1`，避免
`localhost` 解析到未监听的那一栈。

## 目录

```
packages/shared/src/    config.ts(端口段等常量) model.ts(中间数据形状) protocol.ts(WS 线协议)
packages/server/src/    hub.ts(WS+HTTP) daemon.ts router.ts dsl.ts logger.ts auth.ts
                        cli.ts(CLI 前端) index.ts(MCP 前端) tools/registry.ts
packages/plugin/src/    code.ts(沙箱) ui.ts(iframe) handlers.ts collect/{common,node,ds}.ts
skills/figma/SKILL.md   给 AI 的使用说明，软链到 ~/.claude/skills/
scripts/smoke.mjs       全链路冒烟
```

## v2 预留

协议的 method 命名空间已为写操作留位（`node.get*` → 未来 `node.set*`）。做写操作时
注意：改文本前必须 `figma.loadFontAsync`，批量操作要分批 yield 否则冻结 Figma 主线程。
