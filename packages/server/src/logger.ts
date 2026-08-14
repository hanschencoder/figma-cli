/**
 * 日志一律走 stderr。
 *
 * CLI 的 stdout 只输出 YAML，掺一个字节的日志就会让 `figma-cli tree 2>&1 | yq`
 * 这类管道解析失败。所以日志无论何时都走 stderr。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env.FIGMA_CLI_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const parts = args.map((a) =>
    typeof a === 'string' ? a : safeStringify(a),
  );
  process.stderr.write(`[${ts}] ${level.toUpperCase().padEnd(5)} ${parts.join(' ')}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
