/**
 * 配对 token。
 *
 * localhost WebSocket 不是安全边界 —— 任何本地网页都能连上端口读你的设计稿。
 * 成本最低的补丁：server 生成一个 token 落到 ~/.figma-mcp/token，
 * 插件面板粘贴一次后存进 figma.clientStorage，之后握手自动带上。
 *
 * 设 FIGMA_MCP_NO_AUTH=1 可以关掉（本机独占、调试时用）。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_DIR, TOKEN_FILE } from '@figma-mcp/shared';
import { log } from './logger.js';

export interface Auth {
  enabled: boolean;
  token: string;
  tokenPath: string;
  verify(supplied: string | undefined): boolean;
}

export function loadOrCreateAuth(): Auth {
  const dir = join(homedir(), TOKEN_DIR);
  const tokenPath = join(dir, TOKEN_FILE);
  const enabled = process.env.FIGMA_MCP_NO_AUTH !== '1';

  let token = '';
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    // 文件不存在或读不了，下面重新生成
  }

  if (!/^[0-9a-f]{32}$/.test(token)) {
    token = randomBytes(16).toString('hex');
    try {
      writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      log.info(`生成新的配对 token -> ${tokenPath}`);
    } catch (err) {
      log.warn('无法写入 token 文件，本次运行使用内存中的临时 token:', String(err));
    }
  }

  return {
    enabled,
    token,
    tokenPath,
    verify(supplied) {
      if (!enabled) return true;
      return typeof supplied === 'string' && timingSafeEqualStr(supplied.trim(), token);
    },
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
