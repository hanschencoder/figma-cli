/**
 * 插件沙箱侧 —— figma.* 这一侧。
 *
 * 这里没有网络。所有对外通信都要通过 figma.ui.postMessage 交给 UI iframe，
 * 由它去连 WebSocket。这一层只做三件事：
 *   1. 启动 UI、上报文档身份
 *   2. 收 UI 转来的 req，交给 handlers 执行，把结果（含二进制）回给 UI
 *   3. 转发 selectionchange / currentpagechange
 */

import { ErrorCode, type ProtocolError } from '@figma-mcp/shared';
import type { SandboxToUi, UiToSandbox } from './bridge-types.js';
import { HandlerError, dispatch, documentIdentity } from './handlers.js';
import { collectNode } from './collect/node.js';
import { ResolveCache } from './collect/common.js';

figma.showUI(__html__, { width: 300, height: 240, themeColors: true });

function send(msg: SandboxToUi): void {
  figma.ui.postMessage(msg);
}

function sendDoc(): void {
  send({
    kind: 'doc',
    doc: documentIdentity(),
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
  });
}

function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof HandlerError) return err.protocolError;
  const message = err instanceof Error ? err.message : String(err);
  return { code: ErrorCode.INTERNAL, message };
}

figma.ui.onmessage = async (msg: UiToSandbox) => {
  switch (msg.kind) {
    case 'ui-ready':
      sendDoc();
      return;

    case 'req': {
      try {
        const { result, bytes } = await dispatch(msg.method, msg.params);
        send({
          kind: 'res',
          id: msg.id,
          ok: true,
          result,
          ...(bytes ? { base64: figma.base64Encode(bytes) } : {}),
        });
      } catch (err) {
        const error = toProtocolError(err);
        send({ kind: 'res', id: msg.id, ok: false, error });
        send({ kind: 'log', level: 'error', text: `${msg.method} 失败: ${error.message}` });
      }
      return;
    }
  }
};

figma.on('selectionchange', () => {
  void (async () => {
    const cache = new ResolveCache();
    const selection = [];
    for (const node of figma.currentPage.selection.slice(0, 10)) {
      selection.push(
        await collectNode(node, cache, {
          detail: 'compact',
          depth: 0,
          includeHidden: false,
          expandInstances: false,
          atRoot: true,
          budget: { remaining: 10 },
        }),
      );
    }
    send({ kind: 'event', name: 'selectionchange', payload: { selection } });
  })();
});

figma.on('currentpagechange', () => {
  send({
    kind: 'event',
    name: 'currentpagechange',
    payload: { id: figma.currentPage.id, name: figma.currentPage.name },
  });
  sendDoc();
});

send({ kind: 'log', level: 'info', text: 'bridge 已启动' });
