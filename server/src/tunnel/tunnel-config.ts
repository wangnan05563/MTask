/**
 * 内网穿透：隧道配置的类型定义与持久化。
 * 配置与隧道工具（二进制 / cloudflared config.yml）统一存放在应用数据目录下：
 *   开发态：server/src/data/tunnel/
 *   打包态：%APPDATA%\mtask\data\tunnel/（由 MTask_DATA_DIR 覆盖）
 * 数据目录可写，避免打包态把二进制下载进只读的 resources/app。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TunnelProvider = 'cloudflare' | 'cpolar' | 'tailscale';

export interface TunnelConfig {
  provider: TunnelProvider;
  /** 本地被穿透端口；0 表示用后端自身端口 */
  localPort: number;
  cpolarAuthtoken: string;
  /** 用户指定的隧道二进制路径；留空则自动下载到数据目录 */
  binaryPath: string;
  autoStart: boolean;
  /** cloudflare 模式：quick=免注册快速隧道，named=固定域名 */
  tunnelMode: 'quick' | 'named';
  tunnelId: string;
  tunnelName: string;
  credentialsFile: string;
  hostname: string;
  /** cloudflared login 成功后保存的 cert.pem 绝对路径 */
  certFile: string;
  /** tailscale：固定地址的路径前缀（空=根路径） */
  pathPrefix: string;
  /** 访问令牌：启用隧道后，所有数据接口需携带该令牌（防止公网未授权访问） */
  accessToken: string;
}

const DEFAULT: TunnelConfig = {
  provider: 'cloudflare',
  localPort: 0,
  cpolarAuthtoken: '',
  binaryPath: '',
  autoStart: false,
  tunnelMode: 'quick',
  tunnelId: '',
  tunnelName: '',
  credentialsFile: '',
  hostname: '',
  certFile: '',
  pathPrefix: '',
  accessToken: '',
};

/** 应用数据目录：与后端连接层一致（MTask_DATA_DIR 覆盖），隧道子目录存二进制与配置 */
function dataDir(): string {
  return process.env.MTask_DATA_DIR ?? join(__dirname, '..', '..', 'data');
}

/** 隧道工作目录：统一放应用数据目录下，保证打包态可写 */
export function tunnelDir(): string {
  const dir = join(dataDir(), 'tunnel');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath(): string {
  return join(tunnelDir(), 'tunnel-config.json');
}

// 配置内存缓存：accessTokenGuard 每请求调用 loadTunnelConfig，读文件+解析会浪费一次 IO。
// 配置很少变（仅隧道管理操作写），缓存 + 写后刷新即可。
let configCache: TunnelConfig | null = null;

export function loadTunnelConfig(): TunnelConfig {
  if (configCache) return configCache;
  let cfg: TunnelConfig;
  try {
    if (!existsSync(configPath())) cfg = { ...DEFAULT };
    else cfg = { ...DEFAULT, ...JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<TunnelConfig> };
  } catch {
    cfg = { ...DEFAULT };
  }
  configCache = cfg;
  return cfg;
}

/** 配置被写入后清缓存，保证下次读取为最新值 */
function clearConfigCache(): void {
  configCache = null;
}

/** 整体保存（合并现有，保留未提交字段，如 certFile） */
export function saveTunnelConfig(patch: Partial<TunnelConfig>): void {
  const existing = loadTunnelConfig();
  // 特例：cpolarAuthtoken 空串表示"不修改已存 token"，避免回传脱敏串覆盖真实值
  const next: TunnelConfig = {
    ...existing,
    ...patch,
    cpolarAuthtoken: patch.cpolarAuthtoken || existing.cpolarAuthtoken,
  };
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  clearConfigCache();
}

/** 增量保存单个字段（命名隧道向导逐步持久化用） */
export function saveTunnelField<K extends keyof TunnelConfig>(key: K, value: TunnelConfig[K]): void {
  saveTunnelConfig({ [key]: value } as Partial<TunnelConfig>);
}

/** 后端自身 HTTP 端口（穿透默认目标） */
export function backendPort(): number {
  return Number(process.env.MTask_PORT ?? 39876);
}

/** 生成新的访问令牌并持久化，返回明文（调用方需在启用隧道前先建立令牌） */
export function regenerateAccessToken(): string {
  const token = randomUUID();
  saveTunnelField('accessToken', token);
  return token;
}