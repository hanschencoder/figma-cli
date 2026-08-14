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
  | {
      kind: 'res';
      id: string;
      ok: true;
      result: unknown;
      /**
       * 图像等二进制载荷，已在沙箱侧用 figma.base64Encode 编码。
       * 放在沙箱编码而不是 UI：那是原生实现，比 UI 里手写分段
       * String.fromCharCode 更快，也不会在几 MB 上爆栈。
       */
      base64?: string;
    }
  | { kind: 'res'; id: string; ok: false; error: ProtocolError }
  | { kind: 'event'; name: 'selectionchange' | 'currentpagechange'; payload: unknown }
  | { kind: 'log'; level: 'info' | 'error'; text: string };

export type UiToSandbox =
  | { kind: 'req'; id: string; method: Method; params: unknown }
  /** UI 加载完成，可以接收 doc 了 */
  | { kind: 'ui-ready' };
