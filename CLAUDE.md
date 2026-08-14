# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

自建的 Figma → AI 通道，绕开 REST API 速率限制。插件读文档树 → daemon → `figma` CLI。**v1 只读。**

## 命令

```bash
npm run build          # shared → server → plugin，顺序敏感
npm run build:server   # 只改了 daemon / CLI / DSL
npm run build:plugin   # 只改了插件
npm run typecheck      # tsc -b 三个包
npm run smoke          # 全链路冒烟，不需要打开 Figma
npm run setup          # = bash scripts/install.sh，安装/更新 CLI 与 skill（可重复跑）
```

## 改完代码后必须做的事

| 改了什么 | 必须做 |
|---|---|
| `packages/server/**` | `npm run build:server && figma stop` —— **不 stop 跑的还是旧 daemon** |
| `packages/plugin/src/**` | `npm run build:plugin`，在 Figma 里关掉插件窗口重开 |
| `manifest.template.json` 或端口段常量 | 重新 build，在 Figma 里**重新 Import manifest**（应用级缓存，重开窗口不够） |
| `packages/shared/**` | `npm run build`（两端都依赖） |

`packages/plugin/manifest.json` 是构建生成的，不要手改。

## 约定

**日志一律 stderr。** MCP 前端用 stdio，stdout 是 JSON-RPC 通道，写一个字节日志就让
客户端解析失败。用 `logger.ts` 的 `log.*`，不要 `console.log`。

**token 引用优先于原始值。** 输出 `$color/brand` 而不是 `#0A84FF`，`@Headline/mini`
而不是字号字重。`$` = 变量，`@` = 样式。这是本项目相对截图识别的核心价值，改采集或
序列化时不要退化成裸值。

**上下文预算是第一约束。** 中间数据模型的可选字段**在无意义时一律省略**
（opacity=1、visible=true、rotation=0…）。加字段前先估算它在典型设计稿上多产生多少
token。组件实例内部默认不展开、文本图层名与内容重复时只输出一次，都是这条的产物。

**路径参数必须由前端解析成绝对路径。** tool 跑在 daemon 里，daemon 的 cwd 是它被
拉起来时那个目录，跟用户此刻在哪毫无关系。要接收路径的 tool 在 `ToolDef.pathArgs`
里声明参数名，CLI 和 MCP 各自调 `absolutizePathArgs` 解析后再发出去。

**不静默猜测目标文档。** `router.ts`：单连接自动选，多连接未指定时报错并列出候选。

**输出格式改 `server/src/dsl.ts`，不要改插件。** 插件改一行要重新 build 加在 Figma
里重载；daemon 重启就生效。只有字段根本没采集时才动 `plugin/src/collect/`。

**tool 定义只写在 `server/src/tools/registry.ts`。** CLI 和 MCP 是两个前端，共用同一份
zod schema / 实现 / 描述；CLI 的 `--help` 和参数校验从 schema 反射生成。

## 参考文档（按需 Read）

- 三段式约束、数据流全景、各文件职责：`.claude/docs/architecture.md`
- 改插件或 manifest 前必读（dynamic-page 异步、端口白名单、重载规则）：`.claude/docs/figma-plugin.md`
- 冒烟脚本的坑、真实设计稿验证方式、排查入口：`.claude/docs/testing.md`
- 设计动机与背景取舍：`README.md`
