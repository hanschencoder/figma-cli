# svg2vd-deps.jar 里有什么

这个 jar 是由 `build-deps-jar.sh` 从下列上游产物裁剪合并而来，只保留了 `com.android.ide.common.vectordrawable.Svg2Vector` 的类闭包，外加本仓库的 `Svg2Vd` 入口类。**没有任何修改，只有删减。**

| 组件 | 版本 | 许可 | 来源 |
|---|---|---|---|
| com.android.tools:sdk-common | 31.9.0 | Apache-2.0 | https://dl.google.com/dl/android/maven2 |
| com.android.tools:common | 31.9.0 | Apache-2.0 | https://dl.google.com/dl/android/maven2 |
| com.google.guava:guava | 33.2.1-jre | Apache-2.0 | https://repo1.maven.org/maven2 |
| org.jetbrains.kotlin:kotlin-stdlib | 2.0.21 | Apache-2.0 | https://repo1.maven.org/maven2 |

四个上游组件均以 Apache License 2.0 分发，允许再分发。许可证全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

重新生成：`bash scripts/vd/build-deps-jar.sh`（在本仓库里跑）
