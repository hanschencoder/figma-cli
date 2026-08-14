# 架构

```
AI ──► figma-cli ──HTTP POST /call──► daemon ──WS /bridge──► 插件 UI(iframe)
                                                               │ postMessage
                                                               ▼
                                                          插件沙箱 ──► figma.*
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
| 折叠 | `packages/server/src/fold.ts` | 图标 / 系统 chrome / 同构兄弟的判定与差异计算 |
| 派生 | `server/src/{lint,css,plan,svg,font}.ts` | 从同一份中间 JSON 派生走查 / CSS / 调研 / SVG 后处理 |

**改输出格式优先改 `yaml.ts` / `fold.ts`** —— 插件每改一行都要重新 build + 在 Figma
里重载，daemon 重启一下就生效。只有当需要的字段插件根本没采集时，才动 `collect/`。

折叠、走查、CSS、plan 全都跑在 server 侧，吃的是同一份中间 JSON。**插件只管把
一棵完整的树捞回来**，怎么裁、怎么聚合、怎么呈现都是 server 的事 —— 这样加一个
派生视角（比如未来的 `figma-cli diff`）不需要碰插件。

## tools/registry.ts 是单一事实来源

`packages/server/src/tools/registry.ts` 定义每个 tool 的 zod schema、描述和实现，
CLI 前端（`cli.ts`）只是从中反射出子命令：

- CLI 的 `--help`、参数解析、类型校验全部从 zod schema 反射生成
- 加一个新命令只需往 registry 数组里加一项，CLI 自动就有
- CLI 用短名（`tree`），也接受规范名（`get_node_tree`）

## 一次 `figma-cli tree` 的完整路径

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
| `server/src/fold.ts` | 三种结构折叠的判定 + 结构哈希 + 同构差异。**有损，每条都留了关闭开关** |
| `server/src/lint.ts` | 设计走查规则。只报告不修改 |
| `server/src/css.ts` | Auto Layout → flex 的机械翻译。不生成 HTML、不猜组件名 |
| `server/src/plan.ts` | `figma-cli plan` 的聚合：组件复用、切图清单、文案、间距刻度 |
| `server/src/svg.ts` | 导出 SVG 的 currentColor 替换与外壳剥离 |
| `server/src/font.ts` | style 名 → font-weight 数值、行高百分比 → 像素 |
| `server/src/daemon.ts` | 常驻进程装配：Hub + tools + `/call` `/shutdown` 路由 |
| `server/src/router.ts` | 多文档路由，拒绝静默猜测目标 |
| `plugin/src/ui.ts` | 端口扫描、重连 watchdog、请求来源路由、base64 分片 |
| `plugin/src/code.ts` | 沙箱侧消息中转、事件转发 |
| `plugin/src/handlers.ts` | 各 method 的实现入口 |
