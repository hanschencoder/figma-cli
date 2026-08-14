import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_RANGE_START, PORT_RANGE_END } from '../shared/src/config.ts';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'build');
const watch = process.argv.includes('--watch');

/**
 * shared 包在插件侧直接从 TS 源码 bundle，不依赖 dist。
 * 插件是单文件产物，走源码可以少一层构建顺序依赖。
 */
const sharedAlias = {
  '@figma-mcp/shared': resolve(root, '../shared/src/index.ts'),
};

/** 沙箱侧：figma.* 在这里跑，没有 DOM、没有网络。 */
const codeOptions = {
  entryPoints: [resolve(root, 'src/code.ts')],
  outfile: resolve(outDir, 'code.js'),
  bundle: true,
  format: 'iife',
  target: 'es2017',
  platform: 'neutral',
  alias: sharedAlias,
  logLevel: 'info',
};

/**
 * UI 侧：iframe，有 DOM 和网络。
 * 产物必须内联进单个 html —— Figma 只加载 manifest.ui 指向的那一个文件。
 */
const uiOptions = {
  entryPoints: [resolve(root, 'src/ui.ts')],
  outfile: resolve(outDir, 'ui.js'),
  bundle: true,
  format: 'iife',
  target: 'es2017',
  platform: 'browser',
  alias: sharedAlias,
  logLevel: 'info',
  write: false,
};

async function inlineUi(result) {
  const js = result.outputFiles[0].text;
  const html = await readFile(resolve(root, 'src/ui.html'), 'utf8');
  if (!html.includes('__UI_SCRIPT__')) {
    throw new Error('src/ui.html 缺少 __UI_SCRIPT__ 占位符');
  }
  // 用函数形式替换，避免 js 里的 $& 等特殊序列被 replace 解释
  await writeFile(resolve(outDir, 'ui.html'), html.replace('__UI_SCRIPT__', () => js));
}

/**
 * 从端口段常量生成 manifest.json。
 *
 * 手写这份白名单必然会和 config.ts 里的端口段漂移，而 manifest 一旦不对，
 * 症状是 WebSocket 静默失败 —— 最难查的那类问题。所以由构建生成，
 * 产物照常提交进仓库（Figma 需要一个静态文件来 Import）。
 *
 * host 同时列出 127.0.0.1 和 localhost：server 绑的是 127.0.0.1，
 * 插件也连 127.0.0.1，避开 localhost 在 IPv6 环境下解析成 ::1 的坑。
 */
async function generateManifest() {
  const hosts = ['127.0.0.1', 'localhost'];
  const domains = [];
  for (const host of hosts) {
    for (const scheme of ['http', 'ws']) {
      domains.push(`${scheme}://${host}`);
      for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
        domains.push(`${scheme}://${host}:${port}`);
      }
    }
  }

  const template = JSON.parse(await readFile(resolve(root, 'manifest.template.json'), 'utf8'));
  template.networkAccess.allowedDomains = domains;
  template.networkAccess.devAllowedDomains = domains;
  template.networkAccess.reasoning =
    `Connects to a local MCP server over WebSocket on 127.0.0.1 ` +
    `(port range ${PORT_RANGE_START}-${PORT_RANGE_END} for fallback when a port is occupied). ` +
    `No data leaves the machine.`;

  await writeFile(resolve(root, 'manifest.json'), `${JSON.stringify(template, null, 2)}\n`);
}

await mkdir(outDir, { recursive: true });
await generateManifest();

if (watch) {
  const codeCtx = await context(codeOptions);
  const uiCtx = await context({
    ...uiOptions,
    plugins: [
      {
        name: 'inline-ui',
        setup(b) {
          b.onEnd(async (result) => {
            if (result.errors.length === 0) {
              await inlineUi(result);
              console.log('[plugin] ui.html rebuilt');
            }
          });
        },
      },
    ],
  });
  await Promise.all([codeCtx.watch(), uiCtx.watch()]);
  console.log('[plugin] watching...');
} else {
  await build(codeOptions);
  await inlineUi(await build(uiOptions));
  console.log('[plugin] build done ->', outDir);
}
