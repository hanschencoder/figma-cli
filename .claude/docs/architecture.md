# 架构

```
AI ──► figma CLI ──HTTP POST /call──► daemon ──WS /bridge──► 插件 UI(iframe)
                                        ▲                        │ postMessage
                                   MCP stdio 前端                 ▼
                                     (可选)                  插件沙箱 ──► figma.*
```

## 三段式是硬约束，不是设计选择

- 插件沙箱（`code.ts`，能调 `figma.*`）**没有网络**
- 插件 UI（iframe）有网络但碰不到 `figma.*`
- 所以数据必须在两者之间用 `postMessage` 倒一次手

插件 UI 也**不能监听端口**，只能主动发起连接 —— 这是 daemon 必须存在的原因：
CLI 是短命进程，每次执行都等插件重新握手要好几秒。

## 分工：插件裁剪，daemon 格式化

| 层 | 位置 | 职责 |
|---|---|---|
| 采集 | `packages/plugin/src/collect/` | 字段白名单裁剪，产出中间 JSON |
| 中间形状 | `packages/shared/src/model.ts` | 两端共用的数据契约 |
| 序列化 | `packages/server/src/yaml.ts` | 中间 JSON → YAML 文本 |

**改输出格式优先改 `yaml.ts`** —— 插件每改一行都要重新 build + 在 Figma 里重载，
daemon 重启一下就生效。只有当需要的字段插件根本没采集时，才动 `collect/`。

## tools/registry.ts 是单一事实来源

`packages/server/src/tools/registry.ts` 定义每个 tool 的 zod schema、描述和实现，
**传输无关**。CLI（`cli.ts`）和 MCP（`index.ts`）只是两个前端：

- CLI 的 `--help`、参数解析、类型校验全部从 zod schema 反射生成
- 加一个新命令只需往 registry 数组里加一项，两个前端自动都有
- CLI 用短名（`tree`），MCP 用规范名（`get_node_tree`），CLI 两个都接受

## 一次 `figma tree` 的完整路径

```
cli.ts 解析参数(zod) → POST /call → daemon.ts 路由 → registry 的 run()
  → hub.request() 发 WS req，等 res（带超时、分片重组）
  → 插件 ui.ts 转 postMessage → code.ts → handlers.ts dispatch
  → collect/node.ts 采集裁剪 → 原路返回
  → yaml.ts serializeNodes() → YAML 文本
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `shared/src/config.ts` | 端口段、分片大小、图像上限等常量。**manifest 从这里生成** |
| `shared/src/protocol.ts` | WS 线协议：hello / req / res / chunk / event |
| `server/src/hub.ts` | WS + HTTP 服务、端口绑定、请求关联、分片重组、心跳 |
| `server/src/daemon.ts` | 常驻进程装配：Hub + tools + `/call` `/shutdown` 路由 |
| `server/src/router.ts` | 多文档路由，拒绝静默猜测目标 |
| `plugin/src/ui.ts` | 端口扫描、重连 watchdog、请求来源路由、base64 分片 |
| `plugin/src/code.ts` | 沙箱侧消息中转、事件转发 |
| `plugin/src/handlers.ts` | 各 method 的实现入口 |
