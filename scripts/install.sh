#!/usr/bin/env bash
#
# figma-cli 一键安装 / 更新。两种跑法：
#
#   curl -fsSL https://raw.githubusercontent.com/hanschencoder/figma-cli/main/scripts/install.sh | bash
#                                        自己 clone 到 ~/.figma-cli/src 再安装
#   bash scripts/install.sh              已经有仓库时就地安装（重复执行是安全的）
#   bash scripts/install.sh --uninstall  卸载 CLI 与 skill
#
# 做四件事：装依赖并构建 → 把 figma-cli 命令链到 PATH → 把 skill 链进各 AI 工具的
# skill 目录（Claude Code / Cursor / Codex / Gemini / Copilot，装了哪个链哪个）
# → 停掉旧 daemon。插件 manifest 仍需在 Figma 里手动 Import（Figma 没有别的通道），
# 脚本最后会把路径打出来。
#
# 仓库必须**留在本地**：全局的 figma-cli 命令和各工具的 skill 都是软链，
# 指向仓库里的文件 —— 删掉仓库等于卸载。
#
# 环境变量：
#   FIGMA_CLI_REPO    仓库地址，默认 GitHub 上的 hanschencoder/figma-cli
#   FIGMA_CLI_BRANCH  分支，默认 main
#   FIGMA_CLI_SRC     自动 clone 的落点，默认 ~/.figma-cli/src
#   FIGMA_SKILL_DIR   只链到这一个目录（给非常规布局用），默认自动探测各工具
set -euo pipefail

REPO_URL="${FIGMA_CLI_REPO:-https://github.com/hanschencoder/figma-cli.git}"
BRANCH="${FIGMA_CLI_BRANCH:-main}"
STATE_DIR="$HOME/.figma-cli"
SRC_DIR="${FIGMA_CLI_SRC:-$STATE_DIR/src}"
RECORD="$STATE_DIR/install.json"
SKILL_NAME="figma-cli"
WORKSPACE="@figma-cli/server"
MIN_NODE_MAJOR=20

# 脚本在不在一份可用的仓库里？
#
# `curl | bash` 时 BASH_SOURCE 是空的（或指向 /dev/fd/…），拿不到仓库 ——
# 这种情况下自己 clone 一份到 SRC_DIR。就地跑时用脚本所在的那份，不去碰网络。
REPO_ROOT=""
self="${BASH_SOURCE[0]:-}"
if [ -n "$self" ] && [ -f "$self" ]; then
  candidate="$(cd "$(dirname "$self")/.." 2>/dev/null && pwd -P || true)"
  if [ -n "$candidate" ] && [ -d "$candidate/skills/$SKILL_NAME" ] && [ -f "$candidate/package.json" ]; then
    REPO_ROOT="$candidate"
  fi
fi

# 各 AI 工具的 skill 目录。**只在工具的主目录已存在时才建链** —— 没装的工具
# 不该被凭空造出一个 ~/.cursor 来。要支持新工具在这里加一行即可。
TOOL_DIRS=(
  "$HOME/.claude/skills:Claude Code"
  "$HOME/.cursor/skills:Cursor"
  "$HOME/.codex/skills:Codex"
  "$HOME/.gemini/skills:Gemini CLI"
  "$HOME/.copilot/skills:GitHub Copilot CLI"
  "$HOME/.agents/skills:通用 skills 目录"
)

# 同名的 figma-cli 命令 / skill 默认直接接管。它几乎总是「同一个项目的另一份
# checkout」—— 为这种情况停下来要求加参数，只是把一次必然的重跑摊给使用者。
# 真实文件/目录会先备份；软链是安装器自己的产物，直接换掉。
TAKEOVER=1
MODE=install

# ---------------------------------------------------------------- 输出

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
  E_ON=1
else
  C_DIM=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
  E_ON=0
fi

# emoji 只在交互终端里出现：日志重定向到文件时它们只会碍事
emo() { [ "$E_ON" = 1 ] && printf '%s ' "$1"; }

step() { printf '\n%s==>%s %s%s\n' "$C_OK" "$C_OFF" "$(emo "${2:-}")" "$1"; }
info() { printf '    %s\n' "$1"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
ok()   { printf '    %s%s%s\n' "$C_OK" "$(emo ✅)$1" "$C_OFF"; }
warn() { printf '    %s%s%s\n' "$C_WARN" "$(emo ⚠️)$1" "$C_OFF"; }
die()  { printf '\n%s%s%s\n' "$C_ERR" "$(emo 💥)$1" "$C_OFF" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法:
  curl -fsSL https://raw.githubusercontent.com/hanschencoder/figma-cli/main/scripts/install.sh | bash
  bash scripts/install.sh [选项]

  (无选项)      安装或更新 CLI 与 skill，可重复执行
  --uninstall   卸载：解除 figma-cli 命令、移除各工具下的 skill 软链、停掉 daemon
  --keep-existing  遇到不是这份仓库装的 figma-cli 命令 / skill 就报错停下，
                不接管（默认是接管，真实文件会先备份）
  --force       兼容旧写法，默认已经是接管，给了也不影响
  -h, --help    显示本说明

skill 会链进已安装的 AI 工具：Claude Code / Cursor / Codex / Gemini CLI /
GitHub Copilot CLI，以及通用的 ~/.agents/skills。没装的工具自动跳过。

没有现成仓库时（curl 那条）脚本会自己 clone 到 ~/.figma-cli/src。
仓库要留在本地：命令和 skill 都是指向它的软链。

环境变量:
  FIGMA_CLI_REPO    仓库地址，默认 https://github.com/hanschencoder/figma-cli.git
  FIGMA_CLI_BRANCH  分支，默认 main
  FIGMA_CLI_SRC     自动 clone 的落点，默认 ~/.figma-cli/src
  FIGMA_SKILL_DIR   只链到这一个目录，跳过自动探测
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --force) TAKEOVER=1 ;;
    --keep-existing) TAKEOVER=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数 $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------- 工具

# 解析软链到真实路径。macOS 的 readlink 没有 -f，借 node 来做（这时候已确认 node 存在）。
realpath_of() {
  node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])) } catch { process.exit(1) }' "$1" 2>/dev/null
}

json_field() {
  # json_field <文件> <字段>，读不到就输出空
  node -e '
    try {
      const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}
  ' "$1" "$2" 2>/dev/null
}

backup_path() { printf '%s.bak.%s' "$1" "$(date +%Y%m%d%H%M%S)"; }

# 该往哪些目录装 skill。
#
# FIGMA_SKILL_DIR 给了就只认它（非常规布局的逃生舱）；否则遍历工具名单，
# 只挑主目录已存在的 —— 即「这个工具装了」。$2 = all 时不做存在性过滤，
# 卸载要清理的是历史上可能建过链的全部位置。
skill_dirs() {
  if [ -n "${FIGMA_SKILL_DIR:-}" ]; then
    printf '%s:自定义\n' "$FIGMA_SKILL_DIR"
    return
  fi
  local entry dir
  for entry in "${TOOL_DIRS[@]}"; do
    dir="${entry%%:*}"
    if [ "${1:-installed}" = all ] || [ -d "$(dirname "$dir")" ]; then
      printf '%s\n' "$entry"
    fi
  done
}

# clone 或更新自动管理的那份仓库，之后 REPO_ROOT 指向它。
fetch_repo() {
  command -v git >/dev/null 2>&1 || die "没找到 git —— 自动安装需要它来拉仓库，或者自己 clone 后跑 bash scripts/install.sh"

  if [ -d "$SRC_DIR/.git" ]; then
    info "更新 $SRC_DIR"
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 \
      || die "拉取 $REPO_URL 的 $BRANCH 失败 —— 检查网络或 FIGMA_CLI_REPO"
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH" >/dev/null 2>&1 || die "更新 $SRC_DIR 失败"
  elif [ -e "$SRC_DIR" ]; then
    die "$SRC_DIR 已存在但不是 git 仓库。确认无用后删掉它，或用 FIGMA_CLI_SRC 换个位置。"
  else
    info "clone $REPO_URL"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 \
      || die "clone $REPO_URL 失败 —— 检查网络或 FIGMA_CLI_REPO"
  fi
  REPO_ROOT="$SRC_DIR"
}

# 停掉常驻 daemon。旧进程跑的是旧代码，不停就等于没更新。
stop_daemon() {
  if command -v figma-cli >/dev/null 2>&1; then
    figma-cli stop >/dev/null 2>&1 || true
  fi
  # CLI 停不掉（比如旧版本协议对不上）就按 pid 兜底
  if [ -f "$STATE_DIR/daemon.json" ]; then
    local pid
    pid="$(json_field "$STATE_DIR/daemon.json" pid)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  # 没有仓库上下文时不做这步：模式串会退化成任意路径都能命中的子串
  [ -n "$REPO_ROOT" ] && pkill -f "$REPO_ROOT/packages/server/dist/daemon-entry.js" 2>/dev/null || true
  return 0
}

npm_bin_dir() { printf '%s/bin' "$(npm prefix -g)"; }

# ---------------------------------------------------------------- 卸载

if [ "$MODE" = uninstall ]; then
  # `curl | bash -s -- --uninstall` 没有仓库上下文，从安装记录里找回来 ——
  # 判断「这个软链是不是我们装的」全靠它
  [ -z "$REPO_ROOT" ] && REPO_ROOT="$(json_field "$RECORD" repoRoot)"
  [ -z "$REPO_ROOT" ] && [ -d "$SRC_DIR/.git" ] && REPO_ROOT="$SRC_DIR"
  SKILL_SRC="${REPO_ROOT:-/dev/null}/skills/$SKILL_NAME"

  step "停止 daemon" 🛑
  stop_daemon
  info "已停止（如果本来就没在跑，忽略）"

  step "解除 figma-cli 命令" 🔌
  if npm rm -g "$WORKSPACE" >/dev/null 2>&1; then
    ok "已解除 $WORKSPACE"
  else
    warn "npm rm -g 没有找到 ${WORKSPACE}，跳过"
  fi

  step "移除 skill" 🧹
  removed=0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    dir="${entry%%:*}"; label="${entry#*:}"
    target="$dir/$SKILL_NAME"
    if [ -L "$target" ]; then
      linked="$(realpath_of "$target" || true)"
      if [ "$linked" = "$SKILL_SRC" ] || [ -z "$linked" ]; then
        rm "$target"; ok "${label}：已移除 $target"; removed=$((removed + 1))
      else
        warn "${label}：$target 指向 ${linked}，不是本仓库装的，保留不动"
      fi
    elif [ -e "$target" ]; then
      warn "${label}：$target 是真实目录而非软链，保留不动（请自行确认后删除）"
    fi
  done <<EOF
$(skill_dirs all)
EOF
  [ "$removed" = 0 ] && info "没有找到本仓库装的 skill，跳过"

  # 自动 clone 的那份是脚本自己的东西，跟着卸载一起收走；
  # 用户自己 clone 的仓库一律不碰
  if [ "$REPO_ROOT" = "$SRC_DIR" ] && [ -d "$SRC_DIR/.git" ]; then
    step "移除自动安装的仓库" 🗑️
    rm -rf "$SRC_DIR"
    ok "已删除 $SRC_DIR"
  elif [ -n "$REPO_ROOT" ]; then
    dim "仓库 $REPO_ROOT 是你自己 clone 的，保留不动"
  fi

  rm -f "$RECORD"
  step "卸载完成" 👋
  dim "运行数据仍在 ${STATE_DIR}（daemon.log / exports），需要的话自行删除"
  dim "Figma 里的插件请在 Plugins → Development 里手动移除"
  printf '\n'
  exit 0
fi

# ---------------------------------------------------------------- 环境检查

step "检查环境" 🔍

command -v node >/dev/null 2>&1 || die "没找到 node。需要 Node >= ${MIN_NODE_MAJOR}，装好后重跑本脚本。"
command -v npm  >/dev/null 2>&1 || die "没找到 npm。"

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "${NODE_VERSION#v}" | cut -d. -f1)"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null \
  || die "Node 版本过低：${NODE_VERSION}，需要 >= $MIN_NODE_MAJOR"

info "node $NODE_VERSION  npm $(npm -v)"

if [ -z "$REPO_ROOT" ]; then
  step "获取仓库" ⬇️
  fetch_repo
  MANAGED=1
else
  MANAGED=0
fi
SKILL_SRC="$REPO_ROOT/skills/$SKILL_NAME"

info "仓库 $REPO_ROOT"
[ -d "$SKILL_SRC" ] || die "找不到 $SKILL_SRC —— $REPO_ROOT 看起来不是 figma-cli 的仓库"

VERSION="$(json_field "$REPO_ROOT/package.json" version)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

# 之前装过什么版本，用来在结尾打印「更新」而不是「安装」
PREV_VERSION=''
PREV_COMMIT=''
IS_UPDATE=0
if [ -f "$RECORD" ]; then
  PREV_VERSION="$(json_field "$RECORD" version)"
  PREV_COMMIT="$(json_field "$RECORD" commit)"
  [ -n "$PREV_VERSION" ] && IS_UPDATE=1
fi
if [ "$IS_UPDATE" = 1 ]; then
  info "检测到已安装 v$PREV_VERSION ($PREV_COMMIT) —— 本次为更新"
fi

# ---------------------------------------------------------------- 旧 daemon

# 放在构建之前：旧进程占着端口、跑着旧代码，先送走再说。
step "停止旧 daemon" 🛑
stop_daemon
info "已停止（如果本来就没在跑，忽略）"

# ---------------------------------------------------------------- 构建

# npm 和 esbuild 都往 stderr 写正常日志，直接放出来会淹掉脚本自己的输出。
# 收进临时文件，只在失败时整段打出来。
run_quiet() {
  local title="$1"; shift
  local log; log="$(mktemp -t figma-cli-install)"
  if ! (cd "$REPO_ROOT" && "$@") >"$log" 2>&1; then
    printf '\n'; cat "$log" >&2; rm -f "$log"
    die "$title 失败（完整输出见上）"
  fi
  rm -f "$log"
}

step "安装依赖" 📦
run_quiet "npm install" npm install --no-audit --no-fund
ok "依赖就绪"

step "构建 shared / server / plugin" 🔨
# 先清掉增量状态再编。tsbuildinfo 曾经被误提交过，留在老 clone 里会让 tsc -b
# 认为「已经编译过」而什么都不发射 —— 装出来的 dist 缺一半文件。
# 安装是低频操作，多花几秒换一个一定完整的产物。
rm -rf "$REPO_ROOT"/packages/*/dist "$REPO_ROOT"/packages/*/tsconfig.tsbuildinfo
run_quiet "构建" npm run build
ok "产物就绪"

# ---------------------------------------------------------------- CLI

step "安装 figma-cli 命令" 🔗

BIN_DIR="$(npm_bin_dir)"
BIN_PATH="$BIN_DIR/figma-cli"
OURS="$REPO_ROOT/packages/server/dist/cli.js"

if [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; then
  current="$(realpath_of "$BIN_PATH" || true)"
  # 断链时 realpath 解不出来，退回 readlink —— 「被换掉的是什么」得说得出口
  if [ -z "$current" ]; then current="$(readlink "$BIN_PATH" 2>/dev/null || true)"; fi
  if [ "$current" = "$OURS" ]; then
    dim "已有本仓库的链接，重新链接以确保是最新的"
  elif [ "$TAKEOVER" = 0 ]; then
    die "$BIN_PATH 已存在且指向 ${current:-未知}，不是这份仓库装的
    （多半是同一个项目的另一份 checkout）。去掉 --keep-existing 就会接管。"
  elif [ -L "$BIN_PATH" ]; then
    # 软链就是 npm link 自己的产物，备份它只会在 PATH 目录里堆垃圾
    rm "$BIN_PATH"
    warn "原来的 figma-cli 指向 ${current:-未知}，已改指向这份仓库"
  else
    bak="$(backup_path "$BIN_PATH")"
    mv "$BIN_PATH" "$bak"
    warn "原有的 figma-cli 是个真实文件（指向 ${current:-未知}），已备份到 $bak"
  fi
fi

(cd "$REPO_ROOT" && npm link -w "$WORKSPACE") >/dev/null 2>&1 || die "npm link 失败"

command -v figma-cli >/dev/null 2>&1 || warn "figma-cli 不在当前 PATH 里 —— 确认 $BIN_DIR 在 PATH 中"
ok "figma-cli -> $OURS"

# ---------------------------------------------------------------- skill

step "安装 skill" 🧩

# 软链而不是拷贝：skill 正本就是仓库里的 skills/figma-cli，git pull 之后
# 各工具看到的立刻是新版，不用重跑本脚本。
link_skill() {
  # 同一条 local 里引用前面刚赋的变量会在 set -u 下炸 —— 整条命令先做词展开，
  # 那时 dir 还没赋上。target 必须单独一行
  local dir="$1" label="$2" linked bak
  local target="$dir/$SKILL_NAME"

  mkdir -p "$dir" 2>/dev/null || { warn "${label}：无法创建 ${dir}，跳过"; return; }

  if [ -L "$target" ]; then
    linked="$(realpath_of "$target" || true)"
    if [ "$linked" = "$SKILL_SRC" ]; then
      dim "${label}：已指向本仓库，随仓库更新"
      SKILL_TARGETS+=("$target")
      return
    fi
    if [ "$TAKEOVER" = 1 ] || [ -z "$linked" ]; then
      rm "$target"
      warn "${label}：原软链指向 ${linked:-已失效的路径}，已替换"
    else
      warn "${label}：$target 指向 ${linked}，不是这份仓库装的，跳过（--keep-existing）"
      return
    fi
  elif [ -e "$target" ]; then
    # 真实目录：可能是早期手动拷进去的版本，备份后换成软链
    bak="$(backup_path "$target")"
    mv "$target" "$bak"
    warn "${label}：原目录已备份到 $bak"
  fi

  if ln -s "$SKILL_SRC" "$target" 2>/dev/null; then
    ok "${label}：$target"
  else
    # 软链不可用（例如 Windows 无权限）就退回复制，代价是更新要重跑本脚本
    cp -r "$SKILL_SRC" "$target" || { warn "${label}：写入 $target 失败，跳过"; return; }
    warn "${label}：软链不可用，已改为复制 —— 仓库更新后需要重跑本脚本"
  fi
  SKILL_TARGETS+=("$target")
}

SKILL_TARGETS=()
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  link_skill "${entry%%:*}" "${entry#*:}"
done <<EOF
$(skill_dirs)
EOF

if [ "${#SKILL_TARGETS[@]}" = 0 ]; then
  warn "没有探测到任何 AI 工具的 skill 目录"
  dim "装了工具却没被认出来的话：FIGMA_SKILL_DIR=<该工具的 skills 目录> 重跑本脚本"
else
  dim "正本 $SKILL_SRC —— 软链跟着仓库走，git pull 后各工具自动是新版"
fi

# ---------------------------------------------------------------- 记录

mkdir -p "$STATE_DIR"
node -e '
  const [file, version, commit, repo, bin, ...skills] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify(
    { version, commit, repoRoot: repo, binPath: bin, skillTargets: skills,
      installedAt: new Date().toISOString() }, null, 2) + "\n");
' "$RECORD" "$VERSION" "$COMMIT" "$REPO_ROOT" "$BIN_PATH" ${SKILL_TARGETS+"${SKILL_TARGETS[@]}"}

# ---------------------------------------------------------------- 收尾

MANIFEST="$REPO_ROOT/packages/plugin/manifest.json"

if [ "$IS_UPDATE" = 1 ]; then
  step "更新完成：v$PREV_VERSION ($PREV_COMMIT) → v$VERSION ($COMMIT)" 🎉
  info "插件代码可能也变了 —— 在 Figma 里关掉插件窗口重开一次"
  dim "只有 manifest.json 变了才需要重新 Import（端口段变更时）"
else
  step "安装完成：v$VERSION ($COMMIT)" 🎉
  cat <<EOF

    $(emo 🧩)还差一步 —— 在 Figma 桌面版里导入插件（只需一次）：
      Plugins → Development → Import plugin from manifest...
      选择 $MANIFEST

    然后 Plugins → Development → Figma CLI Bridge 运行它。
EOF
fi

if [ "${MANAGED:-0}" = 1 ]; then
  dim "仓库在 $REPO_ROOT —— 命令与 skill 都是指向它的软链，别删；重跑本脚本即可更新"
fi

cat <<EOF

    $(emo 🔎)验证：
      figma-cli --help
      figma-cli status
      figma-cli ctx          # 插件跑起来之后，看看选中了什么

    $(emo 💡)skill 需要重启 AI 工具后才会被加载。

EOF
