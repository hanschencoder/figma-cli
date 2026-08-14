/**
 * 多文档路由。
 *
 * 原则：绝不静默猜测当前该操作哪个文档。
 * 只有一个连接时自动使用；多个连接且未显式选择时报错并列出候选，
 * 让模型（或用户）明确指定。猜错文档产生的错误极难排查。
 */

import { ErrorCode, type DocumentIdentity } from '@figma-mcp/shared';
import { BridgeError, type Hub } from './hub.js';

export class DocumentRouter {
  private activeDocId?: string;

  constructor(private readonly hub: Hub) {}

  select(docId: string): DocumentIdentity {
    const found = this.hub.listDocuments().find((d) => d.doc.docId === docId);
    if (!found) {
      throw new BridgeError({
        code: ErrorCode.NOT_FOUND,
        message: `没有已连接的文档 ${docId}`,
        detail: { available: this.candidates() },
      });
    }
    this.activeDocId = docId;
    return found.doc;
  }

  /** 解析出本次调用应该作用于哪个文档。 */
  resolve(explicitDocId?: string): string {
    if (explicitDocId) {
      if (!this.hub.hasDocument(explicitDocId)) {
        throw new BridgeError({
          code: ErrorCode.NOT_FOUND,
          message: `没有已连接的文档 ${explicitDocId}`,
          detail: { available: this.candidates() },
        });
      }
      return explicitDocId;
    }

    const docs = this.hub.listDocuments();

    if (docs.length === 0) {
      throw new BridgeError({
        code: ErrorCode.NO_DOCUMENT,
        message:
          '当前没有任何 Figma 插件连接。请在 Figma 桌面版打开设计文件，' +
          '运行 Plugins → Development → Figma MCP Bridge，等状态变为已连接后重试。',
      });
    }

    if (docs.length === 1) {
      this.activeDocId = docs[0]!.doc.docId;
      return this.activeDocId;
    }

    if (this.activeDocId && this.hub.hasDocument(this.activeDocId)) {
      return this.activeDocId;
    }

    throw new BridgeError({
      code: ErrorCode.AMBIGUOUS_DOCUMENT,
      message:
        `当前有 ${docs.length} 个 Figma 文档同时连接，无法确定操作目标。` +
        '请先调用 select_document，或在本次调用中传入 docId。',
      detail: { available: this.candidates() },
    });
  }

  candidates(): { docId: string; name: string; currentPage?: string; selection?: number }[] {
    return this.hub.listDocuments().map((c) => ({
      docId: c.doc.docId,
      name: c.doc.name,
      currentPage: c.currentPageName,
      selection: c.selectionHint?.count,
    }));
  }

  get active(): string | undefined {
    return this.activeDocId && this.hub.hasDocument(this.activeDocId)
      ? this.activeDocId
      : undefined;
  }
}
