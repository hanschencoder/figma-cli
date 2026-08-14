/**
 * 端口段。
 *
 * 为什么是「段」而不是单个端口：manifest.json 的 networkAccess.allowedDomains
 * 是静态的，而 Figma 在应用级缓存插件文件 —— 改 manifest 必须重新 Import 插件。
 * 预留一段端口，server 端口冲突时可以自由降级，插件扫描整段，都不用动 manifest。
 */
export const PORT_RANGE_START = 3055;
export const PORT_RANGE_END = 3064;

export const PORTS: readonly number[] = Array.from(
  { length: PORT_RANGE_END - PORT_RANGE_START + 1 },
  (_, i) => PORT_RANGE_START + i,
);

export const HOST = '127.0.0.1';

/** 插件先打 HTTP /health 探活，再建 WS —— 比直接连 WS 试错快得多。 */
export const HEALTH_PATH = '/health';
export const WS_PATH = '/bridge';

/** 协议版本。两端不一致时握手拒绝，避免出现难以定位的字段错配。 */
export const PROTOCOL_VERSION = 1;

/** 请求超时（毫秒）。图像导出单独放宽。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const IMAGE_REQUEST_TIMEOUT_MS = 60_000;

/** 单条 WS 消息的 base64 分片大小。几 MB 的单条消息在 Figma iframe 里不稳。 */
export const CHUNK_SIZE = 256 * 1024;

/** 图像长边上限。Claude 会把图缩到约 1.15M 像素，传更大纯粹浪费 token 和时间。 */
export const MAX_IMAGE_DIMENSION = 1500;

/** 配对 token 存放位置（相对 home 目录）。 */
export const TOKEN_DIR = '.figma-mcp';
export const TOKEN_FILE = 'token';
