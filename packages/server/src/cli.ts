#!/usr/bin/env node
/**
 * figma-cli —— AI 和人共用的入口。
 *
 * 两个设计要点：
 *   1. 不占常驻 context。tool 定义只在 skill 被触发时才进入上下文，
 *      平时不付这份开销。
 *   2. 可组合。`figma-cli tree --depth 6 > /tmp/t.txt && grep 推荐 /tmp/t.txt`
 *      —— 大文件下能把绝大部分内容挡在上下文之外。
 *
 * daemon 由本命令按需拉起（见 ensureDaemon），之后常驻复用。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CLIENT_HOST, HEALTH_PATH, PORTS, STATE_DIR } from '@figma-cli/shared';
import { CALL_PATH, SHUTDOWN_PATH } from './daemon.js';
import { absolutizePathArgs, createTools, type ToolDef } from './tools/registry.js';
import { yamlOf, type Entry } from './yaml.js';

const BIN = 'figma-cli';
const SPAWN_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 700;

/** 只用来拿 schema / 描述，不会真的执行 —— 真正的执行在 daemon 里。 */
const TOOLS: ToolDef[] = createTools({ hub: null as never, router: null as never });

// ---------------------------------------------------------------- 参数解析

type ArgKind = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'enum';

interface ArgSpec {
  key: string;
  flag: string;
  kind: ArgKind;
  required: boolean;
  choices?: string[];
  desc: string;
}

function unwrap(type: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let inner = type;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner._def.innerType as z.ZodTypeAny;
      continue;
    }
    return { inner, optional };
  }
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function specsOf(tool: ToolDef): ArgSpec[] {
  return Object.entries(tool.schema).map(([key, raw]) => {
    const { inner, optional } = unwrap(raw as z.ZodTypeAny);
    let kind: ArgKind = 'string';
    let choices: string[] | undefined;

    if (inner instanceof z.ZodNumber) kind = 'number';
    else if (inner instanceof z.ZodBoolean) kind = 'boolean';
    else if (inner instanceof z.ZodArray) {
      const element = unwrap(inner._def.type as z.ZodTypeAny).inner;
      kind = element instanceof z.ZodNumber ? 'number[]' : 'string[]';
    }
    else if (inner instanceof z.ZodEnum) {
      kind = 'enum';
      choices = inner._def.values as string[];
    }

    return {
      key,
      flag: kebab(key),
      kind,
      required: !optional,
      choices,
      desc: (raw as z.ZodTypeAny).description ?? '',
    };
  });
}

class UsageError extends Error {}

function parseArgs(tool: ToolDef, argv: string[]): Record<string, unknown> {
  const specs = specsOf(tool);
  const byFlag = new Map<string, ArgSpec>();
  for (const spec of specs) {
    byFlag.set(spec.flag, spec);
    byFlag.set(spec.key, spec);
  }

  const out: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = (eq < 0 ? token.slice(2) : token.slice(2, eq)).replace(/^no-/, '');
    const negated = token.slice(2).startsWith('no-');
    const spec = byFlag.get(name);
    if (!spec) throw new UsageError(`未知参数 --${name}`);

    if (spec.kind === 'boolean') {
      const raw = eq < 0 ? undefined : token.slice(eq + 1);
      out[spec.key] = negated ? false : raw === undefined ? true : raw !== 'false';
      continue;
    }

    const raw = eq < 0 ? argv[++i] : token.slice(eq + 1);
    if (raw === undefined) throw new UsageError(`--${name} 缺少取值`);
    out[spec.key] = coerce(spec, raw);
  }

  // 位置参数按 tool.positional 顺序填入，最后一个可变长
  const slots = tool.positional ?? [];
  for (let i = 0; i < slots.length; i++) {
    const key = slots[i]!;
    if (out[key] !== undefined) continue;
    const spec = specs.find((s) => s.key === key);
    if (!spec) continue;

    const isLast = i === slots.length - 1;
    if (isLast && tool.variadic) {
      const rest = positionals.slice(i);
      if (rest.length > 0) out[key] = rest;
    } else if (positionals[i] !== undefined) {
      out[key] = coerce(spec, positionals[i]!);
    }
  }

  const extra = positionals.length - slots.length;
  if (extra > 0 && !tool.variadic) {
    throw new UsageError(`多余的位置参数：${positionals.slice(slots.length).join(' ')}`);
  }

  try {
    return z.object(tool.schema).parse(out) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new UsageError(
        err.issues.map((i) => `--${kebab(String(i.path[0] ?? ''))}: ${i.message}`).join('\n'),
      );
    }
    throw err;
  }
}

function coerce(spec: ArgSpec, raw: string): unknown {
  if (spec.kind === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new UsageError(`--${spec.flag} 需要数字，收到 "${raw}"`);
    return n;
  }
  if (spec.kind === 'string[]' || spec.kind === 'number[]') {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (spec.kind === 'string[]') return parts;
    return parts.map((part) => {
      const n = Number(part);
      if (Number.isNaN(n)) throw new UsageError(`--${spec.flag} 需要数字列表，收到 "${part}"`);
      return n;
    });
  }
  return raw;
}

// ---------------------------------------------------------------- 帮助

function helpAll(): string {
  const width = Math.max(...TOOLS.map((t) => t.cli.length));
  const lines = TOOLS.map((t) => `  ${t.cli.padEnd(width)}  ${t.title}`);
  return [
    `用法: ${BIN} <命令> [参数]`,
    '',
    '读取 Figma 设计稿。需要 Figma 桌面版打开文件并运行 Figma CLI Bridge 插件。',
    '首次执行会自动拉起常驻 daemon。',
    '',
    '命令:',
    ...lines,
    '',
    '  status              daemon 与已连接文档的状态',
    '  stop                停止 daemon',
    '  daemon              前台运行 daemon（调试用）',
    '',
    `${BIN} <命令> --help 查看单个命令的参数。`,
  ].join('\n');
}

/** 终端里 CJK 字符占两列，按字符数补齐会歪掉。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function helpTool(tool: ToolDef): string {
  const specs = specsOf(tool);
  const positional = (tool.positional ?? [])
    .map((k) => {
      const spec = specs.find((s) => s.key === k);
      const label = tool.variadic && k === tool.positional?.at(-1) ? `<${k}...>` : `<${k}>`;
      return spec?.required ? label : `[${k}]`;
    })
    .join(' ');

  const flagLines = specs.map((s) => {
    const value =
      s.kind === 'boolean'
        ? ''
        : s.kind === 'enum'
          ? ` <${s.choices?.join('|')}>`
          : s.kind === 'string[]'
            ? ' <a,b,c>'
            : s.kind === 'number[]'
              ? ' <1,2,3>'
              : s.kind === 'number'
              ? ' <n>'
              : ' <值>';
    return { left: `  --${s.flag}${value}`, desc: s.desc + (s.required ? '（必填）' : '') };
  });
  const width = Math.max(0, ...flagLines.map((f) => displayWidth(f.left)));

  return [
    `用法: ${BIN} ${tool.cli}${positional ? ` ${positional}` : ''} [参数]`,
    '',
    tool.description,
    '',
    '参数:',
    ...flagLines.map((f) => `${pad(f.left, width)}  ${f.desc}`),
  ].join('\n');
}

// ---------------------------------------------------------------- daemon 发现与拉起

interface Endpoint {
  port: number;
  pid?: number;
}

async function probe(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${CLIENT_HOST}:${port}${HEALTH_PATH}`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: string };
    return body.service === 'figma-cli';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 等插件的 watchdog 发现新 daemon。只在刚拉起时用。 */
const PLUGIN_JOIN_TIMEOUT_MS = 9_000;

async function findDaemon(): Promise<Endpoint | undefined> {
  // 显式指定端口时只认这一个 —— 测试需要隔离到自己的 daemon
  const pinned = Number(process.env.FIGMA_CLI_PORT);
  if (pinned) return (await probe(pinned)) ? { port: pinned } : undefined;

  // 先试 daemon.json 记录的端口，命中就省掉扫描
  try {
    const raw = readFileSync(join(homedir(), STATE_DIR, 'daemon.json'), 'utf8').trim();
    if (raw) {
      const hint = JSON.parse(raw) as Endpoint;
      if (hint.port && (await probe(hint.port))) return hint;
    }
  } catch {
    // 没有或损坏，走扫描
  }

  for (const port of PORTS) {
    if (await probe(port)) return { port };
  }
  return undefined;
}

async function ensureDaemon(): Promise<Endpoint> {
  const existing = await findDaemon();
  if (existing) return existing;

  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, 'daemon-entry.js');
  if (!existsSync(entry)) {
    throw new Error(`找不到 daemon 入口 ${entry}，先执行 npm run build`);
  }

  const logDir = join(homedir(), STATE_DIR);
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, 'daemon.log'), 'a');

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  for (;;) {
    const found = await findDaemon();
    if (found) {
      // 插件的重连 watchdog 每 5 秒扫一轮端口段，刚拉起的 daemon 它还不知道。
      // 不等一下的话，冷启动后的第一条命令必然误报「没有插件连接」。
      await waitForPlugin(found);
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `daemon 启动超时。看看 ${join(logDir, 'daemon.log')} 里的报错，` +
          `或用 \`${BIN} daemon\` 前台跑一遍`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 轮询 /health 直到有文档连上；超时就放行，让 tool 自己报 NO_DOCUMENT。 */
async function waitForPlugin(endpoint: Endpoint): Promise<void> {
  const deadline = Date.now() + PLUGIN_JOIN_TIMEOUT_MS;
  let notified = false;
  for (;;) {
    try {
      const res = await fetch(`http://${CLIENT_HOST}:${endpoint.port}${HEALTH_PATH}`);
      const body = (await res.json()) as { documents?: unknown[] };
      if ((body.documents?.length ?? 0) > 0) return;
    } catch {
      // daemon 刚起来偶发连不上，继续等
    }
    if (Date.now() > deadline) return;
    if (!notified) {
      notified = true;
      // 走 stderr，而且写成 YAML 注释 —— 就算有人 2>&1 合流，输出照样能解析
      process.stderr.write('# daemon 已启动，等待 Figma 插件接入…\n');
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function post(
  endpoint: Endpoint,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://${CLIENT_HOST}:${endpoint.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { error: text };
  }
  return { status: res.status, json: parsed };
}

// ---------------------------------------------------------------- 内建命令

async function cmdStatus(): Promise<number> {
  const found = await findDaemon();
  if (!found) {
    console.log(
      yamlOf([
        ['daemon', 'stopped'],
        ['hint', `执行任意命令会自动拉起，或 ${BIN} daemon 前台运行`],
      ]),
    );
    return 0;
  }
  const res = await fetch(`http://${CLIENT_HOST}:${found.port}${HEALTH_PATH}`);
  const health = (await res.json()) as {
    version: string;
    pid: number;
    documents: { docId: string; name: string }[];
  };
  const out: Entry[] = [
    ['daemon', 'running'],
    ['port', found.port],
    ['pid', health.pid],
    ['version', health.version],
    ['documents', health.documents.map((d) => [['name', d.name], ['docId', d.docId]] as Entry[])],
  ];
  if (health.documents.length === 0) {
    out.push(['hint', '没有 Figma 插件连接 —— 在 Figma 里运行 Figma CLI Bridge 插件']);
  }
  console.log(yamlOf(out));
  return 0;
}

async function cmdStop(): Promise<number> {
  const found = await findDaemon();
  if (!found) {
    console.log(yamlOf([['daemon', 'stopped']]));
    return 0;
  }
  const { status, json } = await post(found, SHUTDOWN_PATH, {});
  if (status !== 200) {
    console.error(
      yamlOf([
        ['error', 'STOP_FAILED'],
        ['message', String(json.error ?? status)],
      ]),
    );
    return 1;
  }
  console.log(yamlOf([['daemon', 'stopped'], ['port', found.port]]));
  return 0;
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(helpAll());
    return 0;
  }

  if (command === 'status') return cmdStatus();
  if (command === 'stop') return cmdStop();
  if (command === 'daemon') {
    await import('./daemon-entry.js');
    return new Promise<number>(() => {
      /* 前台常驻，靠信号退出 */
    });
  }

  const tool = TOOLS.find((t) => t.cli === command || t.name === command);
  if (!tool) {
    console.error(`未知命令 ${command}\n`);
    console.error(helpAll());
    return 2;
  }

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(helpTool(tool));
    return 0;
  }

  let args: Record<string, unknown>;
  try {
    // 路径参数在这里定死成绝对路径：daemon 的 cwd 和用户此刻在哪没有关系
    args = absolutizePathArgs(tool, parseArgs(tool, rest));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n`);
      console.error(helpTool(tool));
      return 2;
    }
    throw err;
  }

  const endpoint = await ensureDaemon();
  const { status, json } = await post(endpoint, CALL_PATH, { tool: tool.name, args });

  if (status !== 200) {
    console.error(
      yamlOf([
        ['error', `HTTP_${status}`],
        ['message', String(json.error ?? '')],
      ]),
    );
    return 1;
  }

  const text = String(json.text ?? '');
  if (json.ok === false) {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      yamlOf([
        ['error', 'CLI'],
        ['message', err instanceof Error ? err.message : String(err)],
      ]),
    );
    process.exit(1);
  });
