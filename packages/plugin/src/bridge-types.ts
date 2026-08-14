/**
 * 沙箱 ↔ UI iframe 之间的内部消息。
 *
 * 这一层的存在是 Figma 插件的硬约束：沙箱能调 figma.* 但没有网络，
 * UI 有网络但碰不到 figma.*。所有东西都得在这两者之间倒一次手。
 */

import type { DocumentIdentity, Method, ProtocolError } from '@figma-mcp/shared';

export type SandboxToUi =
  /** 握手所需的文档身份，插件启动时和文档变化时发送 */
  | { kind: 'doc'; doc: DocumentIdentity; page: { id: string; name: string } }
  /** clientStorage 里读出的配对 token，null 表示没存过 */
  | { kind: 'token'; token: string | null }
  | {
      kind: 'res';
      id: string;
      ok: true;
      result: unknown;
      /** 图像等二进制载荷。Figma 的 postMessage 支持 Uint8Array */
      bytes?: Uint8Array;
    }
  | { kind: 'res'; id: string; ok: false; error: ProtocolError }
  | { kind: 'event'; name: 'selectionchange' | 'currentpagechange'; payload: unknown }
  | { kind: 'log'; level: 'info' | 'error'; text: string };

export type UiToSandbox =
  | { kind: 'req'; id: string; method: Method; params: unknown }
  | { kind: 'get-token' }
  | { kind: 'set-token'; token: string }
  /** UI 加载完成，可以接收 doc 了 */
  | { kind: 'ui-ready' };
