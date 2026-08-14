# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

自建的 Figma → AI 通道，绕开 REST API 速率限制。插件读文档树 → daemon → `figma` CLI。**v1 只读。**

## 命令

```bash
npm run build          # shared → server → plugin，顺序敏感
npm run build:server   # 只改了 daemon / CLI / 序列化
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

**stdout 只有 YAML，不许掺一行别的。** 进度提示（如「daemon 已启动」）走 stderr，而且写成
`# 注释` 形式；「已截断」「找不到这些 id」这类附注用 `note()` 追加成 YAML 注释行 —— 这样
`figma tree 2>&1 | yq` 也不会炸。help / usage 报错是例外，那是给人看的。

**输出一律 YAML。** 序列化在 `server/src/yaml.ts`，自带一个最小 emitter（不引第三方）。
引号规则保守：含 `:` `#` `@` 等保留字符就加引号 —— 节点 id `12:34` 不加引号会被 YAML 1.1
解析器读成六十进制数字 754。省 token 靠「无意义字段不写」和「短结构走 flow」，不靠自造格式。

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

**输出格式改 `server/src/yaml.ts`，不要改插件。** 插件改一行要重新 build 加在 Figma
里重载；daemon 重启就生效。只有字段根本没采集时才动 `plugin/src/collect/`。

**折叠 / 走查 / 派生视角都在 server 侧吃同一份中间 JSON。** 插件只负责把一棵完整的树
捞回来，怎么裁（`fold.ts` 的图标/系统 chrome/同构兄弟折叠）、怎么聚合（`plan.ts`）、
怎么走查（`lint.ts`）、怎么翻译（`css.ts`）都是 server 的事。加派生视角不要动插件。
折叠是**有损**的 —— 每条都必须留一个关闭开关（`--expand-icons` / `--expand-system` /
`--no-dedupe`），且**折叠后原始节点 id 必须仍能在输出里检索到**（`sameAs` 行带自己的 id）。

**能机械算出来的就别让使用者手算。** `abs` 绝对坐标（不用逐层累加 pos）、行高实测值
（不用拿 size 反推）、font-weight 数值（不用查 style 名表）、currentColor 替换 —— 这些
都是「算错一位也看不出来、错误直接进交付物」的地方，宁可每个节点多一行也要给全。

**tool 定义只写在 `server/src/tools/registry.ts`。** CLI 和 MCP 是两个前端，共用同一份
zod schema / 实现 / 描述；CLI 的 `--help` 和参数校验从 schema 反射生成。

## 参考文档（按需 Read）

- 三段式约束、数据流全景、各文件职责：`.claude/docs/architecture.md`
- 改插件或 manifest 前必读（dynamic-page 异步、端口白名单、重载规则）：`.claude/docs/figma-plugin.md`
- 冒烟脚本的坑、真实设计稿验证方式、排查入口：`.claude/docs/testing.md`
- 设计动机与背景取舍：`README.md`
