#!/usr/bin/env bash
#
# 维护者脚本：重新生成内置的 lib/svg2vd-deps.jar。**普通使用不需要跑这个。**
#
#   bash scripts/vd/build-deps-jar.sh
#
# 做四件事：
#   1. 从 Google Maven / Maven Central 下载固定版本的 4 个 jar（不碰 gradle 缓存，
#      这样在任何机器上结果一致）
#   2. 用 jdeps 算出 Svg2Vector 的类闭包，把 3900+ 个类裁到 1500 上下
#   3. 编译 Svg2Vd.java 一并打进去 —— 运行期就只需要 JRE，不需要 javac
#   4. 打包成 skills/figma-cli/scripts/lib/svg2vd-deps.jar，并写一份 NOTICE
#
# 升级版本就改下面四个常量后重跑，然后**必须**跑一遍 test-svgs/ 里的样例对比输出。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
# 产物落进 skill 里 —— skill 目录只放运行时真正需要的东西，
# 源码 / 构建脚本 / 回归样例都留在仓库的 scripts/vd/ 下，不跟着 skill 分发。
OUT_DIR="$REPO_ROOT/skills/figma-cli/scripts/lib"
OUT_JAR="$OUT_DIR/svg2vd-deps.jar"
OUT_OK_MAJOR=55            # Java 11 的 class file major 版本
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SDK_TOOLS_VER=31.9.0        # com.android.tools:sdk-common / :common
GUAVA_VER=33.2.1-jre
KOTLIN_VER=2.0.21

GOOGLE=https://dl.google.com/dl/android/maven2
CENTRAL=https://repo1.maven.org/maven2

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v curl  >/dev/null || { echo "需要 curl"; exit 1; }
command -v javac >/dev/null || { echo "需要 JDK（javac）"; exit 1; }
command -v jdeps >/dev/null || { echo "需要 JDK（jdeps）"; exit 1; }
command -v jar   >/dev/null || { echo "需要 JDK（jar）"; exit 1; }

# ---------------------------------------------------------------- 1. 下载

say "下载依赖（固定版本）"
mkdir -p "$WORK/jars"
fetch() { # $1=url $2=文件名
  curl -sSfL -o "$WORK/jars/$2" "$1" || { echo "下载失败：$1"; exit 1; }
  printf '    %-32s %s\n' "$2" "$(wc -c < "$WORK/jars/$2" | tr -d ' ') bytes"
}
fetch "$GOOGLE/com/android/tools/sdk-common/$SDK_TOOLS_VER/sdk-common-$SDK_TOOLS_VER.jar" "sdk-common.jar"
fetch "$GOOGLE/com/android/tools/common/$SDK_TOOLS_VER/common-$SDK_TOOLS_VER.jar"         "common.jar"
fetch "$CENTRAL/com/google/guava/guava/$GUAVA_VER/guava-$GUAVA_VER.jar"                   "guava.jar"
fetch "$CENTRAL/org/jetbrains/kotlin/kotlin-stdlib/$KOTLIN_VER/kotlin-stdlib-$KOTLIN_VER.jar" "kotlin-stdlib.jar"

CP="$WORK/jars/sdk-common.jar:$WORK/jars/common.jar:$WORK/jars/guava.jar:$WORK/jars/kotlin-stdlib.jar"

# ---------------------------------------------------------------- 2. 编译

# 上游 jar 的字节码下限：sdk-common / common 是 major 55（Java 11），
# guava / kotlin-stdlib 是 52（Java 8）。所以整个 jar 的下限由 sdk-common 定在 Java 11，
# 我们自己的入口类也编到 11，别让它把要求顶到更高。
TARGET_RELEASE=11

say "编译 Svg2Vd.java（--release ${TARGET_RELEASE}）"
mkdir -p "$WORK/classes"
javac --release "$TARGET_RELEASE" -Xlint:-options -cp "$CP" -d "$WORK/classes" "$HERE/Svg2Vd.java"

# ---------------------------------------------------------------- 3. 算闭包

say "用 jdeps 算类闭包"
# kotlin-stdlib 是 multi-release jar，不给 --multi-release 的话 jdeps 直接报错
jdeps --multi-release base -R -verbose:class -cp "$CP" "$WORK/classes/Svg2Vd.class" 2>/dev/null \
  | awk '{print $1}' | grep -E '^(com|kotlin|org)\.' | sort -u > "$WORK/keep.txt"
# 保险：vectordrawable 整个包全留。jdeps 是静态分析，反射加载的类它看不见，
# 而这个包正是最可能出现「某条 SVG 分支才走到」的地方。
for j in "$WORK/jars/sdk-common.jar"; do
  unzip -l "$j" | awk '/vectordrawable\/.*\.class$/{print $4}' \
    | sed 's|/|.|g; s|\.class$||' >> "$WORK/keep.txt"
done
sort -u "$WORK/keep.txt" -o "$WORK/keep.txt"
echo "    保留 $(wc -l < "$WORK/keep.txt" | tr -d ' ') 个类（含内部类会再展开）"

# ---------------------------------------------------------------- 4. 打包

say "解包 → 裁剪 → 重新打包"
mkdir -p "$WORK/ex"
for j in "$WORK"/jars/*.jar; do (cd "$WORK/ex" && unzip -oq "$j" 'com/*' 'kotlin/*' 'org/*' 2>/dev/null || true); done

python3 - "$WORK" <<'PY'
import os, sys
work = sys.argv[1]
keep = set(open(f"{work}/keep.txt").read().split())
root = f"{work}/ex"
removed = kept = 0
for dirpath, _, files in os.walk(root):
    for f in files:
        if not f.endswith(".class"):
            continue
        full = os.path.join(dirpath, f)
        name = os.path.relpath(full, root)[:-len(".class")].replace(os.sep, ".")
        if name.split("$")[0] in keep:
            kept += 1
        else:
            os.remove(full); removed += 1
print(f"    保留 {kept} 个 class，删除 {removed} 个")
PY

# Svg2Vd 自己的 class 也打进去 —— 运行期只需要 JRE
cp "$WORK/classes"/*.class "$WORK/ex/"
find "$WORK/ex" -type d -empty -delete

mkdir -p "$OUT_DIR"
(cd "$WORK/ex" && jar cf "$OUT_JAR" .)
printf '    %s  %s\n' "$OUT_JAR" "$(du -h "$OUT_JAR" | cut -f1)"

# ---------------------------------------------------------------- NOTICE

cat > "$OUT_DIR/NOTICE.md" <<NOTICE
# svg2vd-deps.jar 里有什么

这个 jar 是由 \`build-deps-jar.sh\` 从下列上游产物裁剪合并而来，只保留了 \`com.android.ide.common.vectordrawable.Svg2Vector\` 的类闭包，外加本仓库的 \`Svg2Vd\` 入口类。**没有任何修改，只有删减。**

| 组件 | 版本 | 许可 | 来源 |
|---|---|---|---|
| com.android.tools:sdk-common | $SDK_TOOLS_VER | Apache-2.0 | $GOOGLE |
| com.android.tools:common | $SDK_TOOLS_VER | Apache-2.0 | $GOOGLE |
| com.google.guava:guava | $GUAVA_VER | Apache-2.0 | $CENTRAL |
| org.jetbrains.kotlin:kotlin-stdlib | $KOTLIN_VER | Apache-2.0 | $CENTRAL |

四个上游组件均以 Apache License 2.0 分发，允许再分发。许可证全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

重新生成：\`bash scripts/vd/build-deps-jar.sh\`（在本仓库里跑）
NOTICE

# ---------------------------------------------------------------- 校验

say "校验字节码版本（上限 major ${OUT_OK_MAJOR}）"
python3 - "$OUT_OK_MAJOR" "$OUT_JAR" <<'PY'
import sys, zipfile, struct
limit, path = int(sys.argv[1]), sys.argv[2]
worst, worst_name = 0, ""
with zipfile.ZipFile(path) as z:
    for n in z.namelist():
        if not n.endswith(".class"):
            continue
        head = z.open(n).read(8)
        major = struct.unpack(">H", head[6:8])[0]
        if major > worst:
            worst, worst_name = major, n
print(f"    最高 major={worst}（{worst_name}）")
if worst > limit:
    print(f"    ✗ 超过上限 {limit}，这个 jar 会要求比预期更新的 JRE")
    sys.exit(1)
print(f"    ✓ 不超过 {limit}，JRE {limit - 44}+ 可用")
PY

say "完成。务必跑一遍回归样例：见 scripts/vd/test-svgs/README.md"
