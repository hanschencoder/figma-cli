#!/usr/bin/env node
/**
 * Daemon 的独立入口。CLI 用 spawn detached 拉起它，也可以手动前台运行调试。
 */

import { startDaemon } from './daemon.js';
import { log } from './logger.js';

const daemon = await startDaemon();

log.info(`figma daemon 已就绪（端口 ${daemon.port}，pid ${process.pid}）`);

const shutdown = (signal: string) => {
  log.info(`收到 ${signal}，退出中`);
  void daemon.stop().finally(() => process.exit(0));
  // 优雅关闭卡住时也要退出，否则会变成占着端口的僵尸进程
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
