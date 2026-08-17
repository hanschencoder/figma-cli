#!/usr/bin/env bash
#
# SVG → VectorDrawable，转不了的自动退回 PNG 切图。
#
# 跑的是 Android Studio「New → Vector Asset」背后那份实现
# （com.android.ide.common.vectordrawable.Svg2Vector），依赖已经内置在
# lib/svg2vd-deps.jar 里 —— **不查 gradle 缓存、不联网下载、不依赖 Android Studio**。
# 运行期只要系统上有 JRE/JDK 11+。
#
#   svg2vd.sh -o app/src/main/res/drawable ./svg/*.svg
#   svg2vd.sh -o res/drawable --prefix ic_ "icon.svg=1:2345"   # 带 id，失败时自动切 PNG
#
# PNG 回退：VectorDrawable 表达不了 <filter> / <mask> / <pattern> / 位图填充，
# 这时 Svg2Vector 仍会吐出一个「看着合法」的 XML（可能残留 url(#...)，构建期才炸）。
# 本脚本一律把这种情况判为失败、不落 XML，改用 figma-cli 把该节点导成 PNG。
# 要自动导，参数得写成 <file.svg>=<figma 节点 id>；没给 id 就只报告该跑什么命令。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
JAR="${FIGMA_VD_CP:-$HERE/lib/svg2vd-deps.jar}"

OUT_DIR=""
PNG_OUT=""
PREFIX=""
PLACEHOLDER="#FF000000"
PNG_SCALES="2,3"
KEEP_NAMES=0
NO_PNG=0
SVGS=()

die() { echo "error: $*" >&2; exit 1; }
note() { echo "$*" >&2; }

usage() {
  cat >&2 <<'EOF'
用法: svg2vd.sh [选项] <file.svg[=节点id]> ...

  -o, --out <dir>        VectorDrawable 输出目录，默认与输入同目录
      --png-out <dir>    PNG 回退的输出目录，默认 <out>/../png-fallback
      --png-scales <s>   回退 PNG 的倍率，默认 2,3（= xhdpi,xxhdpi）
      --no-png-fallback  转换失败就只报错，不导 PNG
      --prefix <s>       输出文件名前缀，例如 ic_
      --placeholder <c>  currentColor 的替换色，默认 #FF000000
      --keep-names       不做 Android 资源名清洗（默认转成 [a-z0-9_]）
  -h, --help

参数写成 <file.svg>=<节点id> 时，转换失败会自动调 figma-cli 把该节点导成 PNG。
节点 id 含 ; 的要整体加引号: "icon.svg=I1:36;64:2356"
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT_DIR="${2:?--out 缺少参数}"; shift 2 ;;
    --png-out) PNG_OUT="${2:?--png-out 缺少参数}"; shift 2 ;;
    --png-scales) PNG_SCALES="${2:?--png-scales 缺少参数}"; shift 2 ;;
    --no-png-fallback) NO_PNG=1; shift ;;
    --prefix) PREFIX="${2:?--prefix 缺少参数}"; shift 2 ;;
    --placeholder) PLACEHOLDER="${2:?--placeholder 缺少参数}"; shift 2 ;;
    --keep-names) KEEP_NAMES=1; shift ;;
    -h|--help) usage 0 ;;
    -*) die "未知选项 $1（--help 看用法）" ;;
    *) SVGS+=("$1"); shift ;;
  esac
done
[ ${#SVGS[@]} -gt 0 ] || usage 1

[ -f "$JAR" ] || die "找不到内置依赖 $JAR
       这个脚本要和同目录的 lib/ 一起用，别单独拷走。
       仓库里重新生成：bash scripts/vd/build-deps-jar.sh"

# ---------------------------------------------------------------- JDK

# 只用系统上的 java，不去翻 Android Studio 自带的 JBR。内置 jar 全部编到
# Java 11 字节码（major 55），所以 JRE 11+ 就够，不需要 javac。
JAVA=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA="$(command -v java)"
fi

if [ -z "$JAVA" ]; then
  die "系统上找不到 java。SVG → VectorDrawable 需要 JRE/JDK 11 或更高。
       装一个（macOS: brew install --cask temurin / Linux: apt install default-jre），
       或设 JAVA_HOME 指向已有的 JDK，然后重跑。
       —— 在此之前不要把 SVG 直接放进 res/drawable/，它不是合法的 drawable 资源。"
fi

JAVA_MAJOR="$("$JAVA" -version 2>&1 | head -1 | sed -n 's/.*version "\([0-9]*\).*/\1/p')"
if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt 11 ] 2>/dev/null; then
  die "java 版本太低（检测到 ${JAVA_MAJOR}，需要 11+）：$JAVA
       内置依赖是 Java 11 字节码，更低版本会 UnsupportedClassVersionError。
       升级 JDK，或设 JAVA_HOME 指向 11+ 的那个。"
fi

# ---------------------------------------------------------------- 资源名

sanitize() {
  local n
  n=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_]/_/g; s/__*/_/g; s/^_//; s/_$//')
  [ -n "$n" ] || n="asset"
  case "$n" in [0-9]*) n="v$n" ;; esac
  printf '%s' "$n"
}

PAIRS=()          # 传给 java 的 <in> <outName> 序列
RENAMED=()
declare -a USED_NAMES=()
declare -a SRC_FILES=()
declare -a SRC_IDS=()
last_dir="."

for arg in "${SVGS[@]}"; do
  # <file.svg> 或 <file.svg>=<节点id>
  f="${arg%%=*}"
  id=""
  [ "$arg" != "$f" ] && id="${arg#*=}"
  [ -f "$f" ] || die "文件不存在：$f"

  base="$(basename "$f")"; stem="${base%.svg}"
  if [ "$KEEP_NAMES" -eq 1 ]; then clean="$stem"; else clean="$(sanitize "$stem")"; fi
  name="$PREFIX$clean"
  n=2; cand="$name"
  while printf '%s\n' "${USED_NAMES[@]:-}" | grep -qx "$cand"; do cand="${name}_$n"; n=$((n+1)); done
  [ "$cand" != "$name" ] && clean="$stem"
  name="$cand"; USED_NAMES+=("$name")
  [ "$clean" != "$stem" ] && RENAMED+=("$base → $name.xml")

  last_dir="$(dirname "$f")"
  PAIRS+=("$f" "$name.xml")
  SRC_FILES+=("$f"); SRC_IDS+=("$id")
done

OUT_DIR="${OUT_DIR:-$last_dir}"
PNG_OUT="${PNG_OUT:-$OUT_DIR/../png-fallback}"

# ---------------------------------------------------------------- 转换

RESULT="$("$JAVA" -cp "$JAR" Svg2Vd "$OUT_DIR" "${PAIRS[@]}" || true)"

CONVERTED=()
FAILED_FILES=()
FAILED_WHY=()
FIXED=()

while IFS=$'\t' read -r kind a b; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in
    ok)
      file="$OUT_DIR/$a"
      # currentColor 在 VectorDrawable 里不合法，Svg2Vector 原样透传 —— 换成占位色，
      # 由使用方的 tint / app:tint 盖掉。
      if grep -q '"currentColor"' "$file" 2>/dev/null; then
        sed -i.bak "s/\"currentColor\"/\"$PLACEHOLDER\"/g" "$file" && rm -f "$file.bak"
        FIXED+=("$a")
      fi
      CONVERTED+=("$a	$b")
      ;;
    fail) FAILED_FILES+=("$a"); FAILED_WHY+=("$b") ;;
  esac
done <<< "$RESULT"

for c in "${CONVERTED[@]:-}"; do [ -n "$c" ] && printf '%s\n' "$c" | awk -F'\t' '{printf "%s  (%s paths)\n", $1, $2}'; done

# ---------------------------------------------------------------- PNG 回退

id_of() {  # $1=svg 路径 → 对应的节点 id（没有就空）
  local i=0
  while [ $i -lt ${#SRC_FILES[@]} ]; do
    [ "${SRC_FILES[$i]}" = "$1" ] && { printf '%s' "${SRC_IDS[$i]}"; return; }
    i=$((i + 1))
  done
}

FALLBACK_DONE=()
FALLBACK_TODO=()

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  note ""
  note "# 以下 SVG 转不成 VectorDrawable（已跳过，没有写出 XML）："
  i=0
  while [ $i -lt ${#FAILED_FILES[@]} ]; do
    note "#   $(basename "${FAILED_FILES[$i]}")  ——  ${FAILED_WHY[$i]}"
    i=$((i + 1))
  done

  if [ "$NO_PNG" -eq 1 ]; then
    note "# --no-png-fallback 已指定，不导 PNG。"
  else
    ids=()
    for f in "${FAILED_FILES[@]}"; do
      id="$(id_of "$f")"
      if [ -n "$id" ]; then ids+=("$id"); else FALLBACK_TODO+=("$(basename "$f")"); fi
    done

    if [ ${#ids[@]} -gt 0 ]; then
      if command -v figma-cli >/dev/null 2>&1; then
        note ""
        note "# 改用 PNG 切图（scales=${PNG_SCALES}）→ $PNG_OUT"
        mkdir -p "$PNG_OUT"
        if figma-cli export "${ids[@]}" --format PNG --scales "$PNG_SCALES" --out "$PNG_OUT" >/dev/null; then
          FALLBACK_DONE=("${ids[@]}")
        else
          note "# figma-cli export 失败 —— Figma 可能没开着或插件没跑，手工重试："
          note "#   figma-cli export ${ids[*]} --format PNG --scales $PNG_SCALES --out $PNG_OUT"
        fi
      else
        note "# figma-cli 不在 PATH 上，手工跑："
        note "#   figma-cli export ${ids[*]} --format PNG --scales $PNG_SCALES --out $PNG_OUT"
      fi
    fi

    if [ ${#FALLBACK_TODO[@]} -gt 0 ]; then
      note ""
      note "# 这几个没给节点 id，没法自动回退：${FALLBACK_TODO[*]}"
      note "# 把参数写成 <file.svg>=<节点id> 再跑，或手工："
      note "#   figma-cli export <id> --format PNG --scales $PNG_SCALES --out $PNG_OUT"
    fi
  fi
fi

# ---------------------------------------------------------------- 收尾提示

# 只报真正写出来的那些 —— 转换失败的文件根本没落盘，列出来只是噪音
SHOWN_RENAMES=()
for r in "${RENAMED[@]:-}"; do
  [ -n "$r" ] || continue
  target="${r##* → }"
  for c in "${CONVERTED[@]:-}"; do
    [ "${c%%	*}" = "$target" ] && { SHOWN_RENAMES+=("$r"); break; }
  done
done
if [ ${#SHOWN_RENAMES[@]} -gt 0 ]; then
  note ""
  note "# 以下文件名被清洗成合法资源名（中文会被清成没意义的名字，看到就手工改）："
  printf '#   %s\n' "${SHOWN_RENAMES[@]}" >&2
fi

if [ ${#FIXED[@]} -gt 0 ]; then
  note ""
  note "# 以下文件里的 currentColor 已替换成 $PLACEHOLDER —— 在用的地方染色："
  note "#   Compose: Icon(..., tint = MaterialTheme.colorScheme.onSurface)"
  note "#   XML:     app:tint=\"?attr/colorOnSurface\""
  printf '#   %s\n' "${FIXED[@]}" >&2
fi

if [ ${#FALLBACK_DONE[@]} -gt 0 ]; then
  note ""
  note "# PNG 回退产物在 ${PNG_OUT}，按倍率放进密度桶：1→mdpi 1.5→hdpi 2→xhdpi 3→xxhdpi 4→xxxhdpi"
  note "# 位图换不了颜色 —— 这些图标在暗色模式下要单独处理，交付时说明。"
fi

note ""
note "# 转完对一眼：paths 数和 figma-cli image <iconId> 的图对不上就是掉了东西"
note "# 注意 stroke-dasharray 会被静默丢掉（VectorDrawable 没有虚线），path 数察觉不到"

[ ${#FAILED_FILES[@]} -eq 0 ] || exit 3
