# 回归样例

改了 `Svg2Vd.java` 或重建 `lib/svg2vd-deps.jar` 之后跑一遍，确认下面的预期没变：

```bash
# 在仓库根目录
skills/figma-cli/scripts/svg2vd.sh -o /tmp/vdcheck scripts/vd/test-svgs/*.svg; echo "exit=$?"
```

| 样例 | 覆盖什么 | 预期 |
|---|---|---|
| `01-currentcolor-and-stroke` | `currentColor`、描边圆 | ✅ 2 paths，`currentColor` 被换成占位色 |
| `02-stroke-only-shape` | `fill="none"` + stroke 的图形 | ✅ 2 paths —— **npm 的 s2v 在这里只出 1 条**，是选 Svg2Vector 的原因 |
| `03-gradient-clip-group` | 线性渐变 + clipPath + group opacity | ✅ 2 paths，含 `<aapt:attr>` 渐变 |
| `04-wide-coverage` | 径向渐变、polygon/polyline/line/ellipse、嵌套 transform、内联 `style`、evenodd、`stroke-dasharray` | ✅ 6 paths。**注意虚线被静默丢掉**，这是已知的 VectorDrawable 限制 |
| `05-unsupported-filter-mask` | `<filter>` + 半透明 `<mask>` | ❌ 判为失败，不写 XML |
| `06-unsupported-pattern` | `<pattern>` + `<image>` | ❌ 判为失败（否则会残留 `fillColor="url(#p)"`，aapt 报错） |
| `07-malformed` | 截断的 SVG | ❌ 判为失败，转换结果为空 |

整体退出码应为 `3`（有失败项）。四个成功项都写出，三个失败项一个都不写出。
