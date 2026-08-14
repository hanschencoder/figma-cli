# Figma 插件侧注意事项

改 `packages/plugin/**` 或 manifest 时读这份。

## dynamic-page 下全异步

manifest 用 `documentAccess: "dynamic-page"`。同步的 `figma.getNodeById`、直接遍历
其它页的 `children` 会抛错。必须用：

- `figma.getNodeByIdAsync(id)`
- `page.loadAsync()` —— 访问非当前页的内容前
- `figma.loadAllPagesAsync()` —— 跨全部页面搜索前

遍历大子树用 `findAllWithCriteria`（原生加速）而不是递归 `findAll`。

## manifest 是生成的

`packages/plugin/manifest.json` 由 `build.mjs` 从 `shared/src/config.ts` 的
`PORT_RANGE_START/END` 生成，**不要手改**。

两条 Figma 的校验规则：

- `allowedDomains` **不接受 IP 字面量**，`http://127.0.0.1` 会报
  `must be a valid URL`。只能写 `localhost`，且**必须带端口**
- 因此 daemon 在同一端口同时绑 `127.0.0.1` 和 `::1`（`config.ts` 的 `BIND_HOSTS`），
  避免 `localhost` 解析到未监听的那一栈

端口段 3055–3064 全部放行，daemon 逐个尝试绑定。改端口段要重新 build 并**重新
Import manifest**。

## 插件重载规则

Figma 在**应用级**缓存插件文件：

- 改 `src/**` → `npm run build:plugin`，关掉插件窗口重开即可
- 改 manifest（含端口段常量）→ 必须 `Plugins → Development → Import plugin from manifest...` 重新导入

## 二进制载荷

图像用沙箱内置的 `figma.base64Encode(bytes)` 编码后再过 `postMessage`，不要在 UI 侧
手写 `String.fromCharCode` 分段循环 —— 那在几 MB 上会爆栈，而且多一次
Uint8Array 的结构化克隆。UI 只负责把 base64 字符串按 `CHUNK_SIZE` 切片。

## v2 写操作预警

协议的 method 命名空间已留位（`node.get*` → 未来 `node.set*`）。届时注意：

- 改文本前必须 `figma.loadFontAsync`，漏了直接报错
- 批量操作要分批 yield，否则冻结 Figma 主线程
- 考虑 `figma.commitUndo()` 分组，让用户能一次撤销
