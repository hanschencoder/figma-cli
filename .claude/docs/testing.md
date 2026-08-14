# 验证方式

没有单元测试，靠集成验证（明确的项目约定）。

## npm run smoke

起一个真 daemon + 一个假 Figma 插件（WebSocket 客户端喂合成数据），走 daemon 的 HTTP
`/call` 跑完全部 tool，另加一组 CLI 断言。**不需要打开 Figma。** 改了 YAML 序列化或
tool 逻辑后先跑这个。

改 `scripts/smoke.mjs` 时的两个约束：

- **固定用端口 3064**（`FIGMA_CLI_PORT`）隔离，否则假插件会连到常驻 daemon 上，
  自己的 server 反而没有文档
- 脚本里调 CLI **必须异步**（`promisify(execFile)`）。假插件跑在脚本自己的进程里，
  `execFileSync` 会堵死事件循环，插件回不了消息，请求只能等到超时
- 所有 tool 调用要显式带 `docId`。Figma 开着时真实插件也会连上来，两个文档并存会让
  路由（正确地）拒绝猜测目标
- 假插件的 `node.tree` 要能识别 `params.stat`（`--stat` 模式返回 `stats` 而非 `roots`）；
  `node.exportPlan` 的 target 要带 `component` / `paints`，否则测不到文件名回退和
  `--currentcolor`。合成数据里应保留一组结构同构的兄弟、一个图标、一个状态栏，
  折叠逻辑才有东西可折

## 回归断言

合成的 `CARD` 覆盖了这些「机械可消除的冗余」和「静默出错」场景，对应的断言不能退化：

| 断言 | 覆盖的规格项 |
|---|---|
| `abs: [x, y]` + `# abs 坐标原点` 注释 | P3 绝对坐标 |
| `more: true` 带 `descendants` | P11 后代计数 |
| `{type: Icon, ...}` 且不含内部矢量 id | P2 图标折叠 |
| `{type: SystemChrome, ...}` 且不含内部 id | P5 系统 chrome |
| `{sameAs, diff}` | P1 同构兄弟折叠 |
| `--no-dedupe` 等开关能看回原样、原始 id 仍可检索 | 折叠是有损的、必须可逆 |
| `styles` 出 `weight` / `lineHeight`、不含 `auto` | P4 行高字重 |
| `export --stdout --currentcolor` 只换绑 token 的色、文件名回退主组件名 | P8 |
| `plan` 各段齐全且 ≤150 行 | P6 |
| `lint` 抓到描边裸色值（grep 抓不到的那类） | P9 |

## 对真实设计稿验证

需要 Figma 桌面版开着且「Figma CLI Bridge」插件在运行。

```bash
figma-cli ctx                              # 当前文件/页面/选中项
figma-cli tree --depth 3
figma-cli tree --depth 8 > /tmp/t.txt      # 大树落盘再 grep，不进上下文
figma-cli node <id>                        # 完整属性，含 token 解析值
figma-cli image <id>                       # 落盘 PNG，用 Read 工具看
figma-cli status                           # daemon 端口/pid/已连接文档
```

`figma-cli` 未装到 PATH 时用 `node packages/server/dist/cli.js`。

**假数据验证不出来的东西**（历史上真实设计稿一次性暴露了四个问题）：组件实例内部
把节点预算吃光、文本图层名与内容重复、截断提示逐行重复、变体实例名与 props 重复。
所以改完输出格式，除了 smoke 还要在真实文档上看一眼。

## 排查入口

- `figma-cli status` —— daemon 端口、pid、已连接文档
- `~/.figma-cli/daemon.log` —— 自动拉起的 daemon 的输出
- `~/.figma-cli/daemon.json` —— 当前 daemon 的端口与 pid
- `curl http://localhost:3055/health`
- 插件面板的「日志」按钮
