import { spawn, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TunnelConfig } from './tunnel-config';
import { tunnelDir } from './tunnel-config';

const execAsync = promisify(execCb);
// execFileAsync 不走 shell，参数数组传递避免路径转义问题，适合带路径参数的 CLI 调用
const execFileAsync = promisify(execFileCb);

// 二进制下载失败时抛出，附带手动放置指引供前端渲染下载链接。
// 这样前端可以引导用户手动下载并放到指定路径，而不是只能报错。
export class BinaryDownloadError extends Error {
  readonly manualPath: string;
  readonly downloadUrls: string[];
  constructor(message: string, manualPath: string, downloadUrls: string[]) {
    super(message);
    this.name = 'BinaryDownloadError';
    this.manualPath = manualPath;
    this.downloadUrls = downloadUrls;
  }
}

// Tailscale Funnel 首次启用需用户在浏览器完成授权，携带授权链接供前端渲染向导。
// auth_url 优先取命令输出的一次性链接（含 node 参数，直接授权当前节点），无链接时回退到管理后台。
export class TailscaleFunnelAuthError extends Error {
  readonly authUrl: string;
  static readonly FALLBACK_AUTH_URL = 'https://login.tailscale.com/admin/dns/funnel';
  constructor(message: string, authUrl?: string) {
    super(message);
    this.name = 'TailscaleFunnelAuthError';
    this.authUrl = authUrl ?? TailscaleFunnelAuthError.FALLBACK_AUTH_URL;
  }
}

// Provider 抽象基类：封装"二进制管理 + 子进程启动 + URL 解析 + 停止"通用流程。
// 新增 provider 只需继承并实现抽象方法，无需改动 TunnelService。
abstract class TunnelProvider {
  protected proc: ChildProcess | null = null;
  protected publicUrl: string | null = null;
  protected exited = false;
  // binary 非 readonly：ensureBinary 中 binaryPath 不存在时需重新指向默认下载路径
  protected binary: string;
  // 最近输出收集：超时诊断的关键信息，保留最近 20 行避免内存无限增长
  protected recentLines: string[] = [];
  private static readonly MAX_RECENT_LINES = 20;

  constructor(protected readonly localPort: number, protected readonly binaryPath: string) {
    // 优先用户手动放置路径（离线/下载失败场景），否则自动下载到数据目录
    this.binary = binaryPath || path.join(tunnelDir(), this.binaryName());
  }

  abstract binaryName(): string;
  abstract downloadUrls(): string[];
  abstract successPattern(): RegExp;
  abstract providerName(): string;
  // 启动超时（毫秒）：各 provider 覆写，cpolar 免费版首次连接需 ~22s
  protected startTimeoutMs(): number {
    return 15000;
  }
  // 启动成功后如何确定 publicUrl：默认从正则匹配结果取，named tunnel 覆写为固定 hostname
  protected resolvePublicUrl(matched: string): string {
    return matched;
  }

  // 确保二进制存在；用户指定了路径但不存在时回退自动下载（参考 17_xianyu 行为）
  // 为什么回退而非直接报错：用户可能先填了路径但文件被删，回退下载更友好
  protected async ensureBinary(): Promise<void> {
    if (fs.existsSync(this.binary)) return;
    if (this.binaryPath) {
      // 用户指定了路径但不存在：打 warning 后回退到数据目录自动下载
      console.warn(`[tunnel] 配置的二进制路径不存在: ${this.binaryPath}，回退到自动下载`);
      this.binary = path.join(tunnelDir(), this.binaryName());
    }
    await this.downloadBinary();
  }

  // 多镜像源 fallback 下载，全部失败才抛 BinaryDownloadError
  protected async downloadBinary(): Promise<void> {
    await fsp.mkdir(path.dirname(this.binary), { recursive: true });
    const urls = this.downloadUrls();
    let lastErr: Error | null = null;
    for (const url of urls) {
      try {
        await this.doDownload(url, this.binary);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new BinaryDownloadError(
      `${this.binaryName()} 所有下载源均失败: ${lastErr?.message ?? '未知错误'}`,
      this.binary,
      urls,
    );
  }

  // 默认直接下载；cpolar 覆写为"下载 zip + 解压"
  protected async doDownload(url: string, target: string): Promise<void> {
    await downloadFile(url, target);
  }

  // 子类钩子：启动前准备（如 cpolar 配置 authtoken）
  // 为什么改异步：cpolar authtoken 配置用 execFileSync 会阻塞事件循环，改 async 后子类可用非阻塞调用
  protected async beforeStart(): Promise<void> {
    // 基类默认空实现：子类（如 CpolarProvider）按需覆写为 authtoken 配置等前置步骤
  }

  // 启动隧道子进程，等待成功标志出现（超时抛含诊断信息的异常）
  async start(): Promise<void> {
    await this.ensureBinary();
    await this.beforeStart();
    this.recentLines = [];

    const args = this.startCommand();
    // windowsHide 等价于 Python 的 CREATE_NO_WINDOW，避免弹出黑窗
    // stdin=ignore 防止子进程卡在等待用户输入（cpolar 首次运行可能提示确认）
    this.proc = spawn(this.binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exited = false;

    this.proc.on('exit', (code) => {
      this.exited = true;
      this.publicUrl = null;
      if (code !== null && code !== 0) {
        this.appendRecentLine(`[进程退出] exit code=${code}`);
      }
    });

    await this.waitForSuccess(this.startTimeoutMs());
  }

  protected abstract startCommand(): string[];

  // 等待成功标志出现，超时抛含进程状态+最近输出的诊断异常
  private waitForSuccess(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error('子进程未启动'));
      }
      const proc = this.proc;
      const pattern = this.successPattern();
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        // 诊断信息：进程状态 + 最近输出，帮助定位网络/凭证/端口等问题
        const processStatus = proc.exitCode === null
          ? '仍在运行（可能卡住等待输入或网络连接）'
          : `已退出（exit code=${proc.exitCode}）`;
        const recentOutput = this.recentLines.length > 0
          ? this.recentLines.join('\n')
          : '（无输出）';
        reject(new Error(
          `[${this.binaryName()}] 启动超时（${timeoutMs / 1000}s），未能获取公网 URL。\n` +
          `进程状态: ${processStatus}\n最近输出:\n${recentOutput}`,
        ));
      }, timeoutMs);

      const handleData = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          const stripped = line.trim();
          if (stripped) {
            this.appendRecentLine(stripped);
          }
        }
        const match = pattern.exec(text);
        if (match) {
          this.publicUrl = this.resolvePublicUrl(match[0]);
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`子进程异常退出，code=${code}`));
      };
      const cleanup = createProcCleanup(proc, timer, { onData: handleData, onError, onExit });

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);
      proc.on('error', onError);
      proc.on('exit', onExit);
    });
  }

  protected appendRecentLine(line: string): void {
    this.recentLines.push(line);
    if (this.recentLines.length > TunnelProvider.MAX_RECENT_LINES) {
      this.recentLines.shift();
    }
    console.log(`[${this.binaryName()}] ${line}`);
  }

  // 同步终止子进程（cloudflared/cpolar 被 kill 后立即退出，无需 graceful wait）
  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // 忽略 kill 失败（进程可能已退出）
    }
    this.proc = null;
    this.exited = true;
    this.publicUrl = null;
  }

  get status(): 'running' | 'stopped' {
    return this.proc && !this.exited ? 'running' : 'stopped';
  }

  get url(): string | null {
    return this.publicUrl;
  }
}

// Cloudflare quick tunnel：免注册，自动分配 trycloudflare 域名。
// 大陆访问可能不稳定，但开箱即用。
class CloudflareProvider extends TunnelProvider {
  private readonly tunnelMode: 'quick' | 'named';
  private readonly tunnelId: string;
  private readonly credentialsFile: string;
  private readonly hostname: string;

  constructor(
    localPort: number,
    binaryPath: string,
    tunnelMode: 'quick' | 'named',
    tunnelId: string,
    credentialsFile: string,
    hostname: string,
  ) {
    super(localPort, binaryPath);
    this.tunnelMode = tunnelMode;
    this.tunnelId = tunnelId;
    this.credentialsFile = credentialsFile;
    this.hostname = hostname;
  }

  binaryName(): string {
    return 'cloudflared.exe';
  }
  providerName(): string {
    return 'cloudflare';
  }
  downloadUrls(): string[] {
    // 主源 GitHub latest + ghfast 镜像（大陆访问更稳定）+ 固定版本兜底
    // 为什么弃用 jsDelivr：jsDelivr /gh/ 路径只能访问仓库源码，无法访问 release assets，
    // 旧 URL `cdn.jsdelivr.net/gh/cloudflare/cloudflared@latest/cloudflared-windows-amd64.exe` 必然 404
    return [
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      'https://github.com/cloudflare/cloudflared/releases/download/2024.12.2/cloudflared-windows-amd64.exe',
    ];
  }

  protected startTimeoutMs(): number {
    // named tunnel 注册连接需更久（连接 Cloudflare 边缘节点）
    return this.tunnelMode === 'named' ? 60000 : 15000;
  }

  successPattern(): RegExp {
    if (this.tunnelMode === 'named') {
      // named tunnel 成功标志：兼容新旧 cloudflared 输出
      return /Registered tunnel (?:connection|connector)/;
    }
    return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  }

  protected resolvePublicUrl(_matched: string): string {
    // named tunnel 域名是固定的，直接用配置的 hostname
    return this.tunnelMode === 'named' ? `https://${this.hostname}` : _matched;
  }

  startCommand(): string[] {
    if (this.tunnelMode === 'named') {
      // named tunnel 通过 config.yml 加载 tunnel_id + credentials-file + ingress 规则
      // 为什么用 config.yml 而非命令行参数：cloudflared 要求 ingress 规则必须在配置文件中
      const configPath = this.generateConfigYml();
      return ['--config', configPath, '--no-autoupdate', 'tunnel', 'run'];
    }
    return ['tunnel', '--url', `http://localhost:${this.localPort}`, '--no-autoupdate'];
  }

  // 生成 cloudflared config.yml：ingress 规则将 hostname 流量路由到本地端口
  // 为什么每次启动都重新生成：local_port 可能从配置继承不同值，确保 ingress 指向正确端口
  private generateConfigYml(): string {
    const configDir = path.join(tunnelDir(), 'cloudflared');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.yml');
    // credentials-file 用绝对路径，避免 cloudflared 因相对路径找不到文件
    const credAbs = path.resolve(this.credentialsFile);
    // ingress 末尾必须有 http_status:404 兜底规则（cloudflared 强制要求最后一条不能有 hostname）
    const yml = [
      `tunnel: ${this.tunnelId}`,
      `credentials-file: ${credAbs}`,
      'ingress:',
      `  - hostname: ${this.hostname}`,
      `    service: http://localhost:${this.localPort}`,
      '  - service: http_status:404',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, yml, 'utf8');
    return configPath;
  }
}

// cpolar：国内推荐，需注册账号获取 authtoken。
// 下载的是 zip，需要解压后才能使用。
class CpolarProvider extends TunnelProvider {
  private readonly authtoken: string;

  constructor(localPort: number, binaryPath: string, authtoken: string) {
    super(localPort, binaryPath);
    this.authtoken = authtoken;
  }

  binaryName(): string {
    return 'cpolar.exe';
  }
  providerName(): string {
    return 'cpolar';
  }
  downloadUrls(): string[] {
    return [
      'https://www.cpolar.com/static/downloads/releases/cpolar-stable-windows-amd64.zip',
      'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-windows-amd64.zip',
    ];
  }

  // cpolar 免费版首次连接需 ~22s，15s 会超时失败
  protected startTimeoutMs(): number {
    return 40000;
  }

  // 正则匹配多级子域名（含区域中间层 xxx.r5.cpolar.top），单级正则会导致 URL 不匹配超时
  successPattern(): RegExp {
    return /https:\/\/[a-z0-9-]+(?:\.[a-z0-9]+)*\.cpolar\.[a-z]+/;
  }

  startCommand(): string[] {
    return ['http', String(this.localPort)];
  }

  // cpolar 下载的是 zip，用 Windows 10 内置的 tar 解压（避免 PowerShell 中文路径编码问题）
  protected async doDownload(url: string, target: string): Promise<void> {
    const tmpZip = target + '.zip';
    await downloadFile(url, tmpZip);
    try {
      const dir = path.dirname(target);
      // execFileAsync 不走 shell，参数数组传递避免路径转义问题
      await execFileAsync('tar', ['-xf', tmpZip, '-C', dir], { windowsHide: true, timeout: 30000 });
      // zip 内可能嵌套目录，递归查找 cpolar.exe
      const extracted = findFile(dir, 'cpolar.exe');
      if (!extracted) {
        throw new Error('zip 解压后未找到 cpolar.exe');
      }
      if (extracted !== target) {
        await fsp.rename(extracted, target);
      }
    } finally {
      try {
        await fsp.unlink(tmpZip);
      } catch {
        // 忽略临时文件清理失败
      }
    }
  }

  // 启动前配置 authtoken（幂等：重复配置会报错，忽略即可）
  // 为什么改异步：避免 execFileSync 阻塞事件循环 10s
  protected async beforeStart(): Promise<void> {
    if (!this.authtoken) {
      throw new Error('cpolar 需要 authtoken，请到 https://dashboard.cpolar.com/signup 注册获取');
    }
    try {
      await execFileAsync(this.binary, ['authtoken', this.authtoken], {
        windowsHide: true,
        timeout: 10000,
      });
    } catch {
      // authtoken 已配置时重复执行会报错，忽略
    }
  }
}

// Tailscale Funnel：免费固定 ts.net 地址，不下载二进制而是检测系统安装。
// 与其他 provider 根本不同：CLI 是配置工具（--bg 后台模式），命令返回后系统服务接管，
// 因此 status 必须主动查询 funnel status --json，而非靠子进程存活判断。
class TailscaleProvider extends TunnelProvider {
  private detectedBinary: string | null = null;
  // status 缓存：getter 同步返回，后台异步刷新避免 execFileSync 阻塞事件循环
  private cachedStatus: 'running' | 'stopped' = 'stopped';
  private statusTimer: NodeJS.Timeout | null = null;
  // 路径前缀（规范化后 /xxx/ 形式，空串表示根路径模式-旧行为）
  private readonly pathPrefix: string;

  constructor(localPort: number, binaryPath: string, pathPrefix: string = '') {
    super(localPort, binaryPath);
    this.pathPrefix = TailscaleProvider._normalizePathPrefix(pathPrefix);
  }

  // 规范化路径前缀为 /xxx/ 形式，空字符串表示根路径模式（保持旧行为）
  // 为什么单独静态方法：构造函数和外部调用都需复用同一规范化逻辑
  private static _normalizePathPrefix(prefix: string): string {
    if (!prefix) return '';
    let p = prefix.trim();
    if (!p.startsWith('/')) p = '/' + p;
    if (!p.endsWith('/')) p = p + '/';
    return p;
  }

  binaryName(): string {
    return 'tailscale.exe';
  }
  providerName(): string {
    return 'tailscale';
  }
  // 不下载二进制：Tailscale 是系统级服务，必须用户预装
  downloadUrls(): string[] {
    return [];
  }
  successPattern(): RegExp {
    // 实际成功检测在覆写的 start() 中用字符串包含匹配，这里不使用
    return /Funnel started|listening on/i;
  }

  protected startTimeoutMs(): number {
    // 30s：基于前端 fetch 超时约束倒推，确保后端在超时前返回授权链接
    return 30000;
  }

  // 覆写 ensureBinary：检测系统安装而非下载
  protected async ensureBinary(): Promise<void> {
    if (this.binaryPath && fs.existsSync(this.binaryPath)) {
      this.detectedBinary = this.binaryPath;
      return;
    }
    if (this.binaryPath && !fs.existsSync(this.binaryPath)) {
      throw new Error(`配置的 Tailscale 路径不存在: ${this.binaryPath}`);
    }
    // 检测顺序：where 命令 → Program Files 标准路径
    let discovered: string | null = null;
    try {
      const { stdout } = await execAsync('where tailscale', { windowsHide: true, timeout: 5000 });
      const first = stdout.split(/\r?\n/)[0]?.trim();
      if (first && fs.existsSync(first)) {
        discovered = first;
      }
    } catch {
      // where 找不到，继续尝试标准路径
    }
    if (!discovered) {
      const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
      const standardPath = path.join(programFiles, 'Tailscale', 'tailscale.exe');
      if (fs.existsSync(standardPath)) {
        discovered = standardPath;
      }
    }
    if (!discovered) {
      throw new Error('未检测到 Tailscale。请先安装并登录 Tailscale：https://tailscale.com/download/windows');
    }
    this.detectedBinary = discovered;
  }

  // 覆写 start：tailscale funnel --bg 是配置命令，成功后系统服务接管
  async start(): Promise<void> {
    await this.ensureBinary();
    this.recentLines = [];

    // 前置检查：Tailscale 必须已登录 + 启用 MagicDNS
    // 为什么改异步：避免 execFileSync 阻塞事件循环导致其他 API 无响应
    const statusResult = await this.runCliAsync(['status', '--json']);
    const statusData = JSON.parse(statusResult) as Record<string, unknown>;
    if (statusData.BackendState !== 'Running') {
      throw new Error('请先打开并登录 Tailscale，然后重新启动隧道');
    }
    const selfInfo = statusData.Self as Record<string, unknown> | undefined;
    // 用 typeof 收窄替代 String() 显式转换：未知类型直接 String() 会被 S6551 标记，
    // 显式类型守卫更安全且意图明确
    const rawDnsName = typeof selfInfo?.DNSName === 'string' ? selfInfo.DNSName : '';
    const dnsName = rawDnsName.trim().replace(/\.$/, '');
    if (!dnsName.toLowerCase().endsWith('.ts.net')) {
      throw new Error('Tailscale 尚未启用 MagicDNS，无法生成固定 ts.net 地址');
    }

    // Popen 非阻塞读取：首次启用会输出授权链接后不退出，等待用户浏览器授权
    const binary = this.detectedBinary!;
    // 构造 funnel 命令：路径区分模式用 --set-path，根路径模式用默认行为
    // --set-path 是追加模式，不会覆盖其他应用的路径配置，实现多应用共存
    const args = ['funnel', '--bg', '--yes'];
    if (this.pathPrefix) {
      args.push('--set-path', this.pathPrefix);
    }
    args.push(`http://127.0.0.1:${this.localPort}`);
    this.proc = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exited = false;

    await this.waitForTailscaleFunnel(dnsName);

    // 启动成功后初始化缓存并定期异步刷新，避免 status getter 阻塞事件循环
    this.cachedStatus = 'running';
    this.refreshStatus();
    this.statusTimer = setInterval(() => this.refreshStatus(), 5000);
  }

  // Tailscale 专用等待逻辑：检测成功标志或一次性授权链接
  private waitForTailscaleFunnel(dnsName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error('子进程未启动'));
      }
      const proc = this.proc;
      const authUrlPattern = /https:\/\/login\.tailscale\.com\/f\/funnel\?node=\S+/;
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        // 优先抛 TailscaleFunnelAuthError（已收集到授权链接）
        const authLine = this.recentLines.find((l) => authUrlPattern.test(l));
        if (authLine) {
          const match = authUrlPattern.exec(authLine);
          reject(new TailscaleFunnelAuthError(
            '首次启用 Funnel 需要在浏览器完成授权，请点击下方链接完成授权后重新启动隧道',
            match?.[0],
          ));
          return;
        }
        const processStatus = proc.exitCode === null
          ? '仍在运行'
          : `已退出（exit code=${proc.exitCode}）`;
        const recentOutput = this.recentLines.length > 0
          ? this.recentLines.join('\n')
          : '（无输出）';
        reject(new Error(
          `Tailscale Funnel 启动超时（30s），未能确认 Funnel 状态。\n` +
          `进程状态: ${processStatus}\n输出:\n${recentOutput}`,
        ));
      }, this.startTimeoutMs());

      const handleData = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          const stripped = line.trim();
          if (stripped) {
            this.appendRecentLine(stripped);
          }
        }
        // 检测成功标志
        if (/Funnel started|listening on/i.test(text)) {
          this.publicUrl = `https://${dnsName}${this.pathPrefix}`;
          cleanup();
          resolve();
          return;
        }
        // 检测授权链接：立即抛异常让前端渲染向导
        const authMatch = authUrlPattern.exec(text);
        if (authMatch) {
          cleanup();
          this.stop();
          reject(new TailscaleFunnelAuthError(
            '首次启用 Funnel 需要在浏览器完成授权，请点击下方链接完成授权后重新启动隧道',
            authMatch[0],
          ));
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        if (code === 0) {
          // 进程退出码 0 可能是配置成功后正常退出
          this.publicUrl = `https://${dnsName}${this.pathPrefix}`;
          resolve();
        } else {
          reject(new Error(`Tailscale Funnel 进程退出，code=${code}`));
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = createProcCleanup(proc, timer, { onData: handleData, onError, onExit });

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);
      proc.on('error', onError);
      proc.on('exit', onExit);
    });
  }

  startCommand(): string[] {
    // 实际命令在覆写的 start() 中构造，这里不会被调用
    return [];
  }

  // 覆写 stop：路径模式下不调用 funnel off（避免关闭其他应用的 Funnel 路径）
  // 根路径模式（旧行为）：异步执行 tailscale funnel off，不等待结果避免阻塞事件循环
  // 为什么用 spawn fire-and-forget：stop 在 SIGINT 钩子中调用，阻塞会导致退出延迟
  stop(): void {
    if (this.pathPrefix) {
      // 路径区分模式：Tailscale 无移除单个路径的命令，停止后路径配置保留
      // 重新启动应用后 --set-path 幂等更新配置自动恢复
      if (this.statusTimer) {
        clearInterval(this.statusTimer);
        this.statusTimer = null;
      }
      this.cachedStatus = 'stopped';
      this.publicUrl = null;
      this.exited = true;
      return;
    }
    if (this.detectedBinary) {
      // unref() 让子进程不阻止 Node.js 退出
      spawn(this.detectedBinary, ['funnel', 'off'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
    }
    // 清除状态刷新定时器
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.cachedStatus = 'stopped';
    this.detectedBinary = null;
    this.publicUrl = null;
    this.exited = true;
  }

  // 覆写 status：返回缓存值，后台定时器异步刷新（避免 execFileSync 阻塞事件循环）
  get status(): 'running' | 'stopped' {
    return this.cachedStatus;
  }

  // 提取 allowFunnel 中第一个 .ts.net 主机。
  // 提取为独立方法降低 refreshStatus 认知复杂度（S3776）。
  private findTsNetHost(allowFunnel: Record<string, boolean>): string | null {
    for (const [endpoint, enabled] of Object.entries(allowFunnel)) {
      if (!enabled) continue;
      const h = endpoint.split(':')[0].replace(/\.$/, '');
      if (h.toLowerCase().endsWith('.ts.net')) {
        return h;
      }
    }
    return null;
  }

  // 路径区分模式：检查 Web.Handlers 中是否存在自己的路径前缀。
  // 提取为独立方法降低 refreshStatus 认知复杂度（S3776）。
  private checkPathPrefixInHandlers(data: Record<string, unknown>): boolean {
    const web = data.Web as Record<string, unknown> | undefined;
    if (!web || typeof web !== 'object') return false;
    for (const cfg of Object.values(web)) {
      if (cfg && typeof cfg === 'object' && 'Handlers' in (cfg as Record<string, unknown>)) {
        const handlers = (cfg as Record<string, unknown>).Handlers as Record<string, unknown>;
        return handlers !== undefined && (this.pathPrefix in handlers);
      }
    }
    return false;
  }

  // 异步刷新 status 缓存：用 execAsync 非阻塞查询 funnel status --json
  // 路径区分模式：通过检查 Handlers 中是否存在自己的路径前缀确认当前应用 Funnel 配置
  private async refreshStatus(): Promise<void> {
    if (!this.detectedBinary) {
      this.cachedStatus = 'stopped';
      return;
    }
    try {
      const result = await this.runCliAsync(['funnel', 'status', '--json']);
      const data = JSON.parse(result) as Record<string, unknown>;
      const allowFunnel = data.AllowFunnel as Record<string, boolean> | undefined;
      if (!allowFunnel) {
        this.cachedStatus = 'stopped';
        return;
      }
      const host = this.findTsNetHost(allowFunnel);
      if (!host) {
        this.cachedStatus = 'stopped';
        return;
      }
      // 路径区分模式：检查 Handlers 中是否存在自己的路径前缀
      if (this.pathPrefix) {
        if (!this.checkPathPrefixInHandlers(data)) {
          this.cachedStatus = 'stopped';
          return;
        }
        this.publicUrl = `https://${host}${this.pathPrefix}`;
        this.cachedStatus = 'running';
        return;
      }
      // 根路径模式（旧行为）：URL 不含路径前缀
      this.publicUrl = `https://${host}`;
      this.cachedStatus = 'running';
    } catch {
      this.publicUrl = null;
      this.cachedStatus = 'stopped';
    }
  }

  // 异步 CLI 调用：替代 execFileSync，避免阻塞 Node.js 事件循环
  private async runCliAsync(args: string[]): Promise<string> {
    if (!this.detectedBinary) {
      throw new Error('Tailscale 二进制未检测到');
    }
    const { stdout } = await execAsync(`"${this.detectedBinary}" ${args.join(' ')}`, {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
}

// 通用文件下载：支持 https/http + 301/302/303/307/308 重定向（GitHub releases 会重定向到 CDN）
// 为什么加 303/307/308：部分 CDN 和镜像服务使用这些状态码，仅支持 301/302 会导致下载失败
// 为什么加重定向深度限制：恶意或异常服务器可能构造重定向环导致无限递归栈溢出
const MAX_REDIRECTS = 5;
function downloadFile(url: string, target: string, redirectDepth = 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (redirectDepth >= MAX_REDIRECTS) {
      reject(new Error(`重定向次数超过上限 (${MAX_REDIRECTS})`));
      return;
    }
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location;
        if (location) {
          // 消费响应体避免 socket 泄漏，再递归跟随重定向
          res.resume();
          downloadFile(location, target, redirectDepth + 1).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(target);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve();
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    // 60 秒空闲超时（无数据传输），大文件下载只要持续有数据就不会触发
    req.setTimeout(60000, () => {
      req.destroy(new Error('下载超时'));
    });
  });
}

// 递归查找文件（cpolar zip 解压后可能嵌套目录）
function findFile(dir: string, name: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

// 共享的子进程清理闭包工厂：waitForSuccess 与 waitForTailscaleFunnel 的 cleanup 逻辑完全相同（S4144）
// 为什么不提取为类方法：cleanup 需捕获各 Promise 内的局部变量（timer/handleData 等），
// 闭包工厂是最小改动且保持类型安全的方式
function createProcCleanup(
  proc: ChildProcess,
  timer: NodeJS.Timeout,
  handlers: {
    onData: (chunk: Buffer) => void;
    onError: (err: Error) => void;
    onExit: (code: number | null) => void;
  },
): () => void {
  return () => {
    clearTimeout(timer);
    proc.stdout?.removeListener('data', handlers.onData);
    proc.stderr?.removeListener('data', handlers.onData);
    proc.removeListener('error', handlers.onError);
    proc.removeListener('exit', handlers.onExit);
  };
}

// TunnelService：管理 provider 生命周期，薄封装委托给 provider。
// 由 index.ts 创建单例并注入到 tunnel 路由，符合项目依赖注入模式。
export class TunnelService {
  private provider: TunnelProvider | null = null;
  private currentConfig: TunnelConfig | null = null;

  // 端口解析优先级：TUNNEL_PORT 环境变量 > tunnel.localPort > server.port
  // 为什么支持环境变量：命令行启动时临时覆盖隧道端口而不改 config.json
  static resolvePort(tunnel: TunnelConfig, serverPort: number): number {
    const envPort = process.env.TUNNEL_PORT;
    if (envPort) {
      const p = Number.parseInt(envPort, 10);
      if (p > 0 && p <= 65535) return p;
    }
    return tunnel.localPort > 0 ? tunnel.localPort : serverPort;
  }

  async start(config: TunnelConfig, serverPort: number): Promise<void> {
    // 配置变更（provider/port/binaryPath/authtoken/named tunnel 字段任一变化）时重建 provider
    const configChanged =
      !this.currentConfig ||
      this.currentConfig.provider !== config.provider ||
      this.currentConfig.localPort !== config.localPort ||
      this.currentConfig.binaryPath !== config.binaryPath ||
      this.currentConfig.cpolarAuthtoken !== config.cpolarAuthtoken ||
      this.currentConfig.tunnelMode !== config.tunnelMode ||
      this.currentConfig.tunnelId !== config.tunnelId ||
      this.currentConfig.hostname !== config.hostname ||
      this.currentConfig.pathPrefix !== config.pathPrefix;

    if (configChanged) {
      if (this.provider) {
        this.provider.stop();
      }
      const port = TunnelService.resolvePort(config, serverPort);
      this.provider = createProvider(config, port);
    } else if (this.status === 'running') {
      // 配置未变且已在运行，跳过重复启动
      return;
    }

    // provider 可能在子进程崩溃后为 null，需重建
    if (!this.provider) {
      const port = TunnelService.resolvePort(config, serverPort);
      this.provider = createProvider(config, port);
    }

    await this.provider.start();
    this.currentConfig = config;
  }

  stop(): void {
    if (this.provider) {
      this.provider.stop();
    }
  }

  get status(): 'running' | 'stopped' {
    return this.provider?.status ?? 'stopped';
  }

  get publicUrl(): string | null {
    return this.provider?.url ?? null;
  }

  get providerName(): string {
    return this.currentConfig?.provider ?? '';
  }
}

// Provider 工厂：按 config.provider 创建对应实例
function createProvider(config: TunnelConfig, localPort: number): TunnelProvider {
  switch (config.provider) {
    case 'cloudflare':
      return new CloudflareProvider(
        localPort,
        config.binaryPath,
        config.tunnelMode,
        config.tunnelId,
        config.credentialsFile,
        config.hostname,
      );
    case 'cpolar':
      return new CpolarProvider(localPort, config.binaryPath, config.cpolarAuthtoken);
    case 'tailscale':
      return new TailscaleProvider(localPort, config.binaryPath, config.pathPrefix);
    default:
      throw new Error(`不支持的 provider: ${config.provider}`);
  }
}

// ===== Cloudflare Named Tunnel 向导服务 =====
// login 是两阶段操作（POST start + GET poll），必须在同一实例上调用，
// 因为 _loginProcess / _loginOutput / _loginAuthUrl 状态保存在实例上。
// 由 routes/tunnel.ts 持有全局单例，跨请求保持状态。
export class CloudflareLoginService {
  private loginProcess: ChildProcess | null = null;
  private loginOutput: string[] = [];
  private loginAuthUrl: string | null = null;

  // 启动 cloudflared tunnel login 子进程，10s 内提取授权 URL
  // 为什么用 async 而非同步 busy wait：Node.js 事件循环模型下 busy wait 会阻塞所有 I/O
  async startLogin(binaryPath: string): Promise<{
    status: 'waiting' | 'failed';
    authUrl: string | null;
    message: string;
    output?: string;
  }> {
    // 已有 login 进行中：直接返回当前状态
    if (this.loginProcess?.exitCode === null) {
      return {
        status: 'waiting',
        authUrl: this.loginAuthUrl,
        message: 'login 已在进行中，请在浏览器中完成授权',
      };
    }

    const binary = binaryPath || path.join(tunnelDir(), 'cloudflared.exe');
    // --no-autoupdate 是全局标志，必须在子命令 tunnel 之前
    this.loginProcess = spawn(binary, ['--no-autoupdate', 'tunnel', 'login'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.loginAuthUrl = null;
    this.loginOutput = [];

    // 后台读取 stdout，提取授权 URL
    this.startLoginOutputCollection();

    // 非阻塞等待：每 500ms 检查一次，最多 10s
    return this.waitForLoginResult();
  }

  // 启动 login 子进程的输出收集与 URL 提取（提取为独立函数降低 startLogin 认知复杂度，S3776）
  private startLoginOutputCollection(): void {
    if (!this.loginProcess) return;
    const urlPattern = /https:\/\/\S+/;
    const collectOutput = (chunk: Buffer): void => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.loginOutput.push(trimmed);
          if (this.loginAuthUrl === null) {
            const match = urlPattern.exec(trimmed);
            if (match?.[0].includes('cloudflare')) {
              this.loginAuthUrl = match[0];
            }
          }
        }
      }
    };
    this.loginProcess.stdout?.on('data', collectOutput);
    this.loginProcess.stderr?.on('data', collectOutput);
  }

  // 非阻塞等待 login 结果：提取为独立函数降低 startLogin 认知复杂度（S3776）
  private async waitForLoginResult(): Promise<{
    status: 'waiting' | 'failed';
    authUrl: string | null;
    message: string;
    output?: string;
  }> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (this.loginAuthUrl) break;
      if (this.loginProcess?.exitCode !== null) break;
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    if (this.loginAuthUrl) {
      return {
        status: 'waiting',
        authUrl: this.loginAuthUrl,
        message: '请在浏览器中完成 Cloudflare 授权',
      };
    }

    const proc = this.loginProcess;
    if (proc && proc.exitCode !== null) {
      const output = this.loginOutput.join('\n');
      const exitCode = proc.exitCode;
      this.cleanupLoginProcess();
      return {
        status: 'failed',
        authUrl: null,
        message: `cloudflared login 进程已退出（exit code=${exitCode}）`,
        output,
      };
    }

    // 进程仍在运行但未输出 URL：浏览器可能已自动打开
    return {
      status: 'waiting',
      authUrl: null,
      message: 'cloudflared login 已启动，浏览器应该已自动打开。如果未打开，请稍等...',
    };
  }

  // 检查 login 状态：success/failed/waiting/idle 四种
  checkLoginStatus(): {
    status: 'waiting' | 'success' | 'failed' | 'idle';
    authUrl: string | null;
    certFile?: string;
    message: string;
    output?: string;
    checkedPaths?: string[];
  } {
    if (!this.loginProcess) {
      return { status: 'idle', authUrl: null, message: 'login 未启动' };
    }

    // 检查所有可能的 cert.pem 位置
    const certPaths = this.findCertPemPaths();
    for (const p of certPaths) {
      if (fs.existsSync(p)) {
        const certFile = p;
        this.cleanupLoginProcess();
        return {
          status: 'success',
          authUrl: this.loginAuthUrl,
          certFile,
          message: '授权成功，cert.pem 已生成',
        };
      }
    }

    if (this.loginProcess.exitCode !== null) {
      const output = this.loginOutput.join('\n');
      const exitCode = this.loginProcess.exitCode;
      this.cleanupLoginProcess();
      if (exitCode === 0) {
        return {
          status: 'failed',
          authUrl: null,
          message: 'login 进程已退出但未找到 cert.pem',
          output,
          checkedPaths: certPaths,
        };
      }
      return {
        status: 'failed',
        authUrl: null,
        message: `login 失败（exit code=${exitCode}）`,
        output,
      };
    }

    return {
      status: 'waiting',
      authUrl: this.loginAuthUrl,
      message: '等待用户在浏览器中完成授权...',
    };
  }

  // 创建命名隧道：cloudflared tunnel --origincert <cert> create <name>
  // 为什么改异步：execFileSync 30s 超时会阻塞事件循环，用户点击向导按钮时其他 API 无响应
  async createTunnel(tunnelName: string, certFile: string, binaryPath: string): Promise<{
    tunnelId: string;
    credentialsFile: string;
    tunnelName: string;
  }> {
    const binary = binaryPath || path.join(tunnelDir(), 'cloudflared.exe');
    const args = ['--no-autoupdate', 'tunnel', '--origincert', certFile, 'create', tunnelName];
    const { stdout: output } = await execFileAsync(binary, args, {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    // 解析 tunnel_id（UUID 格式）
    const idMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output);
    if (!idMatch) {
      throw new Error(`无法从输出解析 tunnel_id: ${output}`);
    }
    // 兼容新旧 cloudflared 输出格式，路径可能被引号包裹
    const credMatch = /(?:credentials file|tunnel credentials written to)\s+"?(.+?\.json)"?/i.exec(output);
    if (!credMatch) {
      throw new Error(`无法从输出解析 credentials_file: ${output}`);
    }
    return {
      tunnelId: idMatch[0],
      credentialsFile: credMatch[1],
      tunnelName,
    };
  }

  // 配置 DNS CNAME：cloudflared tunnel --origincert <cert> route dns <name> <hostname>
  // 为什么改异步：同 createTunnel，避免 30s 阻塞
  async routeDns(
    tunnelNameOrId: string,
    hostname: string,
    certFile: string,
    binaryPath: string,
  ): Promise<string> {
    const binary = binaryPath || path.join(tunnelDir(), 'cloudflared.exe');
    const args = [
      '--no-autoupdate', 'tunnel', '--origincert', certFile,
      'route', 'dns', tunnelNameOrId, hostname,
    ];
    await execFileAsync(binary, args, {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return `https://${hostname}`;
  }

  // 查找所有可能的 cert.pem 位置（不同 Windows 版本/cloudflared 版本路径不同）
  private findCertPemPaths(): string[] {
    const paths: string[] = [];
    // Windows 默认：%USERPROFILE%\.cloudflared\cert.pem
    paths.push(path.join(os.homedir(), '.cloudflared', 'cert.pem'));
    // 部分 Windows 版本使用 LOCALAPPDATA
    if (process.env.LOCALAPPDATA) {
      paths.push(path.join(process.env.LOCALAPPDATA, '.cloudflared', 'cert.pem'));
    }
    // APPDATA 兜底
    if (process.env.APPDATA) {
      paths.push(path.join(process.env.APPDATA, '.cloudflared', 'cert.pem'));
    }
    // 从 login 输出正则提取路径（cloudflared 可能输出 cert.pem 的绝对路径）
    const output = this.loginOutput.join('\n');
    // 字符类内的 / 无需转义（S6535）；用 regex.exec 替代 str.match 语义更明确（S6594）
    const m = /[A-Za-z]:[\\/][^\s]*cert\.pem|\/[^\s]*cert\.pem/.exec(output);
    if (m) {
      paths.push(m[0]);
    }
    return paths;
  }

  // 清理 login 子进程：kill
  private cleanupLoginProcess(): void {
    if (!this.loginProcess) return;
    try {
      this.loginProcess.kill();
    } catch {
      // 忽略 kill 失败
    }
    this.loginProcess = null;
  }
}