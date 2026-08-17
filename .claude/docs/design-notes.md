# 设计动机与背景取舍

为什么是现在这个样子。改动涉及这些决策时先读一遍，别把已经踩过的坑再走一遍。README 只讲现状和用法，不讲这些。

## 为什么不走 REST API

现有方案（官方 Figma MCP、Framelink figma-developer-mcp 等）都走 Figma REST API，三个绕不开的问题：

1. **速率限制**，稍微密集一点的迭代就被卡住 —— 最初的直接动机
2. **只能读不能写**，修改设计稿唯一的路径是 Plugin API
3. **读不到「当前状态」**：未保存的编辑、当前选中项、本地未发布的变量与组件 override

Plugin API 三点同时解决：插件跑在 Figma 进程内，直接访问内存里的文档树。

**代价要清楚**：必须 Figma 客户端开着、插件在运行，不能用于 CI 或后台批处理。这是取舍，不是待修复的缺陷。

真正拉开差距的不是「没有速率限制」，是 **design token 还原能力**：节点上的 `boundVariables` / `fillStyleId` 能把色值反查回变量或样式名，输出 `$color/brand` 而不是 `#0A84FF`，模型据此写出的是主题引用而不是硬编码。

## 为什么是 CLI + skill，不是常驻 MCP tool

1. **Context 成本**：tool 定义只在 skill 被触发时才进入上下文，平时不占，粗算省 2000+ token 固定开销
2. **可组合**：`figma-cli tree --depth 8 > /tmp/t.txt && grep 推荐 /tmp/t.txt` —— 几百个节点的大树能挡在上下文之外

代价是图片：CLI 只能把截图落盘 + 打印路径，让 AI 自己 `Read`。多一步，但可用。

## 为什么输出 YAML 而不是自造紧凑 DSL

一行一个节点的自研格式还能再省约一半 token，但通用格式不需要额外解释 —— YAML 谁都认得，模型不必先读图例，下游也能直接 `yq` 处理。省下的 token 抵不过一次误读的代价。

省 token 因此只剩两个手段，都用足了：无意义字段一律不写、短结构走 flow。

引号规则保守：含 `:` `#` `@` 等保留字符就加引号 —— `12:34` 不加引号会被 YAML 1.1 解析器读成六十进制数字 754。

## 为什么远端变量要走两条路

`getLocalVariableCollectionsAsync()` 只能拿到本地集合，而真实项目里 token 基本都在独立 Library 文件中 —— 只看本地集合的话 `figma-cli vars` 在绝大多数设计稿上是空的。

**被引用的远端变量**从节点反查，能拿到确切的值：

```
node.boundVariables.fills[0].id
  → figma.variables.getVariableByIdAsync(id)   // 远端变量也能拿到 name
  → variable.resolveForConsumer(node)          // 按消费者节点的 mode 上下文求值
```

**Library 完整清单**走 `figma.teamLibrary`（manifest 需要 `teamlibrary` 权限）：

```
getAvailableLibraryVariableCollectionsAsync()   // 集合名 + libraryName + key
  → getVariablesInLibraryCollectionAsync(key)   // 变量名 + 类型，没有值也没有 mode
  → importVariableByKeyAsync(key)               // 要值只能逐个 import，慢
```

清单免费，值不是 —— 几百个变量就是几百次 import。所以默认只列清单，`--values` 才解析值。个人草稿、无 teamlibrary 权限、组织策略限制都会让这条路报错，**不该让整条命令失败**：本地集合照常输出，读不到的原因追加成一行注释。

## 图像

- **必须分片**：几 MB 的 base64 单条 WS 消息不稳，协议里带 `chunkIndex/total`
- **必须限尺寸**：默认 scale=1、长边上限 ~1500px。Claude 会把图缩到约 1.15M 像素，传更大纯粹浪费
- 同时落一份到 `~/.figma-cli/exports/` 并返回路径，方便肉眼核对模型「看到」的是什么
- 截图是整套流程里最贵的操作（图像上下文常是全部 YAML 输出的两倍）。**任何能用一个输出字段替代一次截图的改动，收益都是数量级的** —— `assets` 的 `kind` / `vector` 就是这么来的

## 不做鉴权

localhost WebSocket 严格说不是安全边界，本机任何进程都能连上端口读设计稿。早期加过配对 token，但它明文躺在 `~/.figma-cli/token`，能连端口的进程同样能读这个文件，等于没加。v1 全部接口只读、不出网，风险面是「本机已被攻破时能多读一份设计稿」，不值得付配对成本。

**v2 引入写操作时必须重新评估** —— 那时候的风险是别人能改你的稿子。

## 零碎的坑

- **`enablePrivatePluginApi: true`** 才能访问 `figma.fileKey`，拿不到时降级用 `figma.root.id` 作文档标识
- **插件可能先于 server 打开**，必须有后台重连 watchdog 持续探测，而不是让用户手动重启插件
- **在同端口挂一个 HTTP `/health`**：插件先 HTTP 探活再建 WS，比直接连 WS 试错快得多，端口扫描才不会卡住
- **建议 Figma 桌面版**：从 https 页面连 `ws://localhost` 依赖「localhost 属于 potentially trustworthy origin」这条豁免，Chrome 支持，Safari 不保证；桌面版是 Electron，行为稳定

manifest / dynamic-page / 双栈监听这几条见 `figma-plugin.md`。
