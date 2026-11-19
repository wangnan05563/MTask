/**
 * CLI Process Adapter（T05796）：平台无关的“本地进程型”AI 执行通道。
 *
 * 设计边界：
 * - 只负责启动一个配置好的外部 CLI、收集 stdout/stderr、维护进程级 ticket 状态；
 * - 不把命令拼成 shell 字符串：spawn(command, args, { shell:false })，任务正文走 stdin/临时文件；
 * - 不把 token/密码放进命令行；平台凭据只能由调用方通过 env 配置注入；
 * - 失败、ENOENT、空输出、超时都返回 failed/timeout，交由 QueueService / Relay 回退 A；
 * - 本适配器不解析平台私有协议；Qoder/Trae/Codex 的具体 flags 由各自的配置决定。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult,
  StreamResult, SubmitResult, PollResult,
} from './types';
import { describeError } from './types';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * T05796 复审：CLI 只继承进程环境中的非敏感项，令牌/密钥必须由 cli.env 显式注入。
 * 原实现直接把整个 process.env 交给第三方 CLI（任务正文又可能被提示注入），
 * 会让 CLI 读到 MTask/Sonar/模型密钥等与任务无关的秘密。
 */
const SENSITIVE_ENV_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|ENCRYPT)/i;

function buildCliEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SENSITIVE_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

interface CliRunState {
  child: ChildProcess;
  status: 'starting' | 'running' | 'success' | 'failed' | 'timeout';
  stdout: string;
  stderr: string;
  outputBytes: number;
  startedAt: number;
  finishedAt?: number;
  promptDir?: string;
  timer?: NodeJS.Timeout;
  killedByTimeout?: boolean;
}

const runStates = new Map<string, CliRunState>();

function ticketFor(taskId: string): string {
  const safe = (taskId || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `cli-${safe}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimForError(value: string, max = 1000): string {
  const s = value.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanupStates(): void {
  const now = Date.now();
  for (const [ticket, state] of runStates) {
    if (state.finishedAt && now - state.finishedAt > STATE_TTL_MS) {
      runStates.delete(ticket);
    }
  }
}

function killTree(child: ChildProcess): void {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    return;
  }
  if (process.platform === 'win32') {
    // Windows 下 child.kill 只杀父进程；用 taskkill /T /F 清掉 CLI 派生的子进程。
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => { /* ignore */ });
    } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

function buildTaskPrompt(context: TaskContext): string {
  return [
    '你是 MTask 派发的 CLI 执行 Agent，请在当前工作空间内完成下面这个任务。',
    `【任务编号】${context.taskId}`,
    context.projectName ? `【项目】${context.projectName}` : '',
    `【标题】${context.title}`,
    context.description ? `【任务描述】\n${context.description}` : '',
    context.aiSummary ? `【AI 梳理摘要】\n${context.aiSummary}` : '',
    context.workspacePath ? `【工作空间】${context.workspacePath}` : '',
    context.prdContext ? `【PRD 需求上下文】\n${context.prdContext}` : '',
    context.webContext ? `【联网检索结果】\n${context.webContext}` : '',
    '【执行要求】',
    '1. 只改与任务相关的文件；不要提交、不要推送、不要改生产配置。',
    '2. 完成后把最终结果输出到 stdout，使用 Markdown：## 根因 / ## 影响范围 / ## 修复 / ## 验证 / ## 本次回写。',
    '3. 无法完成时明确写阻塞原因与所需资源；不要伪造验证结果。',
  ].filter(Boolean).join('\n');
}

function resolveCwd(context: TaskContext, config: ToolConfig): string {
  const configured = config.cli?.cwd?.trim();
  if (configured && configured !== 'project') {
    const abs = path.resolve(configured);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) throw new Error(`CLI cwd 不是目录：${abs}`);
    return abs;
  }
  if (context.workspacePath) {
    const abs = path.resolve(context.workspacePath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }
  // chat/probe 等没有任务工作空间的场景，允许显式配置或回落到服务进程目录；
  // 真实任务必须带 workspacePath：否则第三方 CLI 会在 MTask 服务目录里执行，
  // 一次提示注入就可能改到服务源码/配置。这里改为明确拒绝，而不是静默回落。
  if (context.taskId !== 'chat' && context.taskId !== 'probe') {
    throw new Error(`CLI 任务 ${context.taskId} 缺少可用的项目工作空间（projects.workspace_path），拒绝在服务进程目录执行`);
  }
  return process.cwd();
}

async function makePromptFile(taskId: string, prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mtask-cli-'));
  const file = path.join(dir, 'prompt.md');
  await fs.promises.writeFile(file, prompt, 'utf8');
  return { dir, file };
}

function replacePromptArgs(args: string[], promptFile: string | null, prompt: string): string[] {
  return args.map((arg) => {
    if (arg === '{promptFile}') {
      if (!promptFile) throw new Error('cli.args 使用 {promptFile} 时，promptMode 必须为 file');
      return promptFile;
    }
    if (arg === '{prompt}') return prompt;
    return arg;
  });
}

function successCodes(config: ToolConfig): number[] {
  const configured = config.cli?.successExitCodes;
  return configured && configured.length > 0 ? configured : [0];
}

function parseContent(raw: string, output: string | undefined): { ok: true; content: string } | { ok: false; error: string } {
  const mode = output ?? 'markdown';
  if (mode === 'markdown') return { ok: true, content: raw.trim() };
  if (mode === 'json') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const content = parsed.content ?? parsed.markdown ?? parsed.text;
      if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'CLI JSON 输出缺少 content/markdown/text 字段' };
      return { ok: true, content: content.trim() };
    } catch (e) {
      return { ok: false, error: `CLI JSON 输出解析失败：${describeError(e)}` };
    }
  }
  // jsonl：取最后一条非空 JSON 的 content/markdown/text；若没有则按原始文本返回。
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      const content = parsed.content ?? parsed.markdown ?? parsed.text;
      if (typeof content === 'string' && content.trim()) return { ok: true, content: content.trim() };
    } catch { /* 继续找上一条 */ }
  }
  return raw.trim()
    ? { ok: true, content: raw.trim() }
    : { ok: false, error: 'CLI JSONL 输出无可读内容' };
}

function startState(state: CliRunState, context: TaskContext, config: ToolConfig, promptFile: string | null): void {
  state.status = 'running';
  const maxBytes = config.cli?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const finish = (status: CliRunState['status'], error?: string) => {
    if (state.status === 'success' || state.status === 'failed' || state.status === 'timeout') return;
    state.status = status;
    state.finishedAt = Date.now();
    if (state.timer) clearTimeout(state.timer);
    if (error) state.stderr = `${state.stderr}\n${error}`.trim();
    if (state.promptDir) {
      fs.promises.rm(state.promptDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
    cleanupStates();
  };

  state.child.stdout?.setEncoding('utf8');
  state.child.stderr?.setEncoding('utf8');
  state.child.stdout?.on('data', (chunk: string) => {
    state.outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (state.outputBytes > maxBytes) {
      state.stderr += `\nCLI 输出超过上限 ${maxBytes} bytes，已中止`;
      state.killedByTimeout = false;
      finish('failed');
      killTree(state.child);
      return;
    }
    state.stdout += chunk;
  });
  state.child.stderr?.on('data', (chunk: string) => {
    if (state.stderr.length < MAX_STDERR_CHARS) state.stderr += chunk.slice(0, MAX_STDERR_CHARS - state.stderr.length);
  });
  // stdin 的 EPIPE 是异步流错误，外层 try/catch 捕不到；不挂 error 监听会让进程抛未捕获异常。
  state.child.stdin?.on('error', (err) => {
    finish('failed', `CLI stdin 写入失败：${describeError(err)}`);
  });
  state.child.on('error', (err) => {
    finish('failed', `CLI 启动失败：${describeError(err)}`);
  });
  state.child.on('close', (code, signal) => {
    if (state.status === 'timeout' || state.status === 'failed') return;
    if (state.killedByTimeout) {
      finish('timeout', 'CLI 执行超时，已终止进程树');
      return;
    }
    const exitCodes = successCodes(config);
    const raw = state.stdout.trim();
    const codeText = code == null ? `signal=${signal ?? 'unknown'}` : `exitCode=${code}`;
    if (code == null || !exitCodes.includes(code)) {
      finish('failed', `CLI 退出失败（${codeText}）${state.stderr ? `：${trimForError(state.stderr)}` : ''}`);
      return;
    }
    if (!raw) {
      finish('failed', 'CLI 退出成功但没有 stdout 输出');
      return;
    }
    const parsed = parseContent(raw, config.cli?.output);
    if (!parsed.ok) {
      finish('failed', parsed.error);
      return;
    }
    state.stdout = parsed.content;
    finish('success');
  });

  const timeoutMs = config.cli?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs > 0) {
    state.timer = setTimeout(() => {
      if (state.status !== 'running' && state.status !== 'starting') return;
      state.killedByTimeout = true;
      finish('timeout', `CLI 执行超过 ${timeoutMs}ms`);
      killTree(state.child);
    }, timeoutMs);
  }

  const prompt = buildTaskPrompt(context);
  if (config.cli?.promptMode === 'stdin' || !config.cli?.promptMode) {
    try {
      state.child.stdin?.end(prompt);
    } catch (e) {
      finish('failed', `CLI stdin 写入失败：${describeError(e)}`);
    }
  } else if (config.cli.promptMode === 'file' && !promptFile) {
    finish('failed', 'cli.promptMode=file 但未生成 prompt 文件');
  } else {
    // file/arg 模式已在 buildArgs 中替换；stdin 不写入。
    try { state.child.stdin?.end(); } catch { /* ignore */ }
  }
}

export class CliProcessAdapter implements AIAdapter {
  readonly type = 'cli-process' as AdapterType;

  async testConnection(config: ToolConfig) {
    const cfg = config.cli;
    if (!cfg?.command) return { ok: false, message: 'CLI 未配置 command' };
    const probeArgs = cfg.probeArgs && cfg.probeArgs.length > 0 ? cfg.probeArgs : ['--version'];
    const timeoutMs = Math.min(cfg.timeoutMs ?? config.timeoutMs ?? 15000, 15000);
    return await new Promise<{ ok: boolean; message: string }>((resolve) => {
      let done = false;
      const child = spawn(cfg.command, probeArgs, {
        cwd: resolveCwd({ taskId: 'probe', title: 'probe', description: '', projectName: '' }, config),
        env: buildCliEnv(cfg.env),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (result: { ok: boolean; message: string }) => {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { child.kill(); } catch { /* ignore */ }
        resolve(result);
      };
      let timer: NodeJS.Timeout | null = null;
      let out = '';
      let err = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (s: string) => { out += s; });
      child.stderr?.on('data', (s: string) => { err += s; });
      child.on('error', (e) => finish({ ok: false, message: `CLI 启动失败：${describeError(e)}` }));
      child.on('close', (code) => {
        const detail = trimForError(out || err, 300);
        finish({
          ok: code === 0,
          message: code === 0
            ? `CLI 可执行：${cfg.command}${detail ? `（${detail}）` : ''}`
            : `CLI 探测失败（exitCode=${code}）${detail ? `：${detail}` : ''}`,
        });
      });
      timer = setTimeout(() => finish({ ok: false, message: `CLI 探测超时（${timeoutMs}ms）` }), timeoutMs);
    });
  }

  async listModels(_config: ToolConfig): Promise<ModelsResult> {
    return { ok: false, message: 'CLI Process 不提供模型列表；model 字段仅用于运行时校验' };
  }

  async submit(context: TaskContext, config: ToolConfig): Promise<SubmitResult> {
    const cfg = config.cli;
    if (!cfg?.command) return { ok: false, error: 'CLI 未配置 command' };
    const prompt = buildTaskPrompt(context);
    let promptFile: string | null = null;
    let promptDir: string | undefined;
    try {
      if (cfg.promptMode === 'file') {
        const made = await makePromptFile(context.taskId, prompt);
        promptDir = made.dir;
        promptFile = made.file;
      }
      const args = replacePromptArgs(cfg.args ?? [], promptFile, prompt);
      const cwd = resolveCwd(context, config);
      const ticket = ticketFor(context.taskId);
      const child = spawn(cfg.command, args, {
        cwd,
        env: {
          ...buildCliEnv(cfg.env),
          MTASK_TASK_ID: context.taskId,
          MTASK_PROJECT_NAME: context.projectName ?? '',
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const state: CliRunState = {
        child,
        status: 'starting',
        stdout: '',
        stderr: '',
        outputBytes: 0,
        startedAt: Date.now(),
        promptDir,
      };
      runStates.set(ticket, state);
      startState(state, context, config, promptFile);
      return { ok: true, accepted: true, ticket };
    } catch (e) {
      if (promptDir) await fs.promises.rm(promptDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      return { ok: false, error: `CLI 提交失败：${describeError(e)}` };
    }
  }

  async poll(ticket: string, _config: ToolConfig): Promise<PollResult> {
    const state = runStates.get(ticket);
    if (!state) {
      return { status: 'failed', error: `CLI 回执不存在（可能服务已重启）：${ticket}` };
    }
    if (state.status === 'success') return { status: 'success', content: state.stdout };
    if (state.status === 'timeout') return { status: 'timeout', error: state.stderr || 'CLI 执行超时' };
    if (state.status === 'failed') return { status: 'failed', error: state.stderr || 'CLI 执行失败' };
    return { status: 'running' };
  }

  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    const submitted = await this.submit(context, config);
    if (!submitted.ok || !submitted.ticket) {
      return { ok: false, error: submitted.error ?? 'CLI 提交失败' };
    }
    const limit = Math.max(1000, config.cli?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    for (;;) {
      const result = await this.poll(submitted.ticket, config);
      if (result.status === 'success') return { ok: true, content: result.content };
      if (result.status === 'failed') return { ok: false, error: result.error };
      if (result.status === 'timeout') return { ok: false, error: result.error, timedOut: true };
      if (Date.now() - started > limit) {
        const state = runStates.get(submitted.ticket);
        if (state) {
          state.status = 'timeout';
          state.finishedAt = Date.now();
          killTree(state.child);
        }
        return { ok: false, error: `等待 CLI 执行超过 ${limit}ms`, timedOut: true };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async chat(system: string, user: string, config: ToolConfig, signal?: AbortSignal): Promise<JobResult> {
    if (signal?.aborted) return { ok: false, error: '已取消' };
    const result = await this.send({
      taskId: 'chat',
      title: '通用对话',
      description: `${system ? `${system}\n\n` : ''}${user}`,
      projectName: '',
    }, config);
    if (signal?.aborted) return { ok: false, error: '已取消' };
    return result;
  }

  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void, signal?: AbortSignal): Promise<StreamResult> {
    const result = await this.chat(system, user, config, signal);
    if (result.ok && result.content) onDelta(result.content);
    return result;
  }
}
