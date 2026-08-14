# 验证方式

没有单元测试，靠集成验证（明确的项目约定）。

## npm run smoke

起一个真 daemon + 一个假 Figma 插件（WebSocket 客户端喂合成数据），跑完全部 tool 的
MCP 和 CLI 两条路径。**不需要打开 Figma。** 改了 DSL 序列化或 tool 逻辑后先跑这个。

改 `scripts/smoke.mjs` 时的两个约束：

- **固定用端口 3064**（`FIGMA_MCP_PORT`）隔离，否则假插件会连到常驻 daemon 上，
  自己的 server 反而没有文档
- 脚本里调 CLI **必须异步**（`promisify(execFile)`）。假插件跑在脚本自己的进程里，
  `execFileSync` 会堵死事件循环，插件回不了消息，请求只能等到超时
- 所有 tool 调用要显式带 `docId`。Figma 开着时真实插件也会连上来，两个文档并存会让
  路由（正确地）拒绝猜测目标

## 对真实设计稿验证

需要 Figma 桌面版开着且「Figma MCP Bridge」插件在运行。

```bash
figma ctx                              # 当前文件/页面/选中项
figma tree --depth 3
figma tree --depth 8 > /tmp/t.txt      # 大树落盘再 grep，不进上下文
figma node <id>                        # 完整属性，含 token 解析值
figma image <id>                       # 落盘 PNG，用 Read 工具看
figma status                           # daemon 端口/pid/已连接文档
```

`figma` 未装到 PATH 时用 `node packages/server/dist/cli.js`。

**假数据验证不出来的东西**（历史上真实设计稿一次性暴露了四个问题）：组件实例内部
把节点预算吃光、文本图层名与内容重复、截断提示逐行重复、变体实例名与 props 重复。
所以改完输出格式，除了 smoke 还要在真实文档上看一眼。

## 排查入口

- `figma status` —— daemon 端口、pid、已连接文档
- `~/.figma-mcp/daemon.log` —— 自动拉起的 daemon 的输出
- `~/.figma-mcp/daemon.json` —— 当前 daemon 的端口与 pid
- `curl http://localhost:3055/health`
- 插件面板的「日志」按钮
