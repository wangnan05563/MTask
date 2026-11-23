/**
 * T05747（CodeBuddy 网关主链路）：CodeBuddy Remote Control 本地网关适配器。
 *
 * 为什么单独成适配器：WorkBuddy 桌面端把 CodeBuddy CLI 的 HTTP 网关暴露在回环地址，
 * 提供 `POST /api/v1/runs` 异步受理 + `GET /api/v1/runs/:runId/stream` SSE 结果流。
 * 这是一条**真正的推送通道**，与既有 `workbuddy` 中继适配器（POST 自定义 JSON 契约）不是同一协议，
 * 不能复用其请求体；但可以复用 `AIAdapter.submit/poll` 与 QueueService 的 ticket 状态机。
 *
 * 关键实测结论（2026-11-14，本机隔离网关 39879）：
 * - `GET /api/v1/health` 并非文档所称“免 X-CodeBuddy-Request”，实测缺该头直接 403；
 *   因此本适配器**所有**请求都带 `X-CodeBuddy-Request: 1`。
 * - `GET /api/v1/runs/:runId` 只返回 `{runId, active}`，**不返回结果**；结果只在 SSE 流里。
 * - SSE 事件顺序：`accepted` → 若干 `streaming`（content.chunk）→ `completed`（content.markdown）
 *   或 `error`（error.code/message）；流结束发 `event: done`。订阅晚于完成会 404（服务端不保留历史）。
 * - 因此 submit 拿到 runId 后必须**立即**在后台挂一条 SSE 长连接，poll 只读内存终态；
 *   不能把 SSE 读在 poll 里——QueueService.pollPending 串行遍历所有 job，一条长连接会阻塞整池。
 *
 * 安全：endpoint 只允许回环/内网显式配置；password 只走 Authorization 头，绝不入日志/错误体。
 */
import type {
  AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult,
  StreamResult, SubmitResult, PollResult,
} from './types';
import { formatHttpError, modelDispatcher } from './netutil';
import { describeError } from './types';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

interface RunState {
  status: 'starting' | 'running' | 'success' | 'failed' | 'timeout';
  content?: string;
  error?: string;
  /** streaming 事件的增量片段：仅当最终 markdown 缺失时兜底 */
  partial: string;
  startedAt: number;
  finalizedAt?: number;
}

/** ticket(runId) → 内存终态。进程重启后丢失，由 poll 的 active=false 兜底判失败。 */
const runStates = new Map<string, RunState>();
/** 终态保留时长：足够 QueueService 的 5s 轮询取走，超时后清理避免无界增长 */
const RUN_STATE_TTL_MS = 10 * 60 * 1_000;

function trimBase(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
}

function apiUrl(endpoint: string, path: string): string {
  const base = trimBase(endpoint);
  if (!base) throw new Error('CodeBuddy 网关 Endpoint 未配置');
  return `${base}/api/v1${path}`;
}

function requestHeaders(config: ToolConfig): Record<string, string> {
  const headers: Record<string, string> = {
    // 实测该头对 health 也必填（文档标注的 exempt 与当前版本不一致）
    'X-CodeBuddy-Request': '1',
    Accept: 'application/json',
  };
  const key = (config.apiKey ?? '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function readData(json: unknown): JsonRecord {
  if (!json || typeof json !== 'object') return {};
  const obj = json as JsonRecord;
  const data = obj.data;
  return data && typeof data === 'object' ? data as JsonRecord : obj;
}

function pickString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function gatewayHttpError(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `CodeBuddy 网关鉴权失败（HTTP ${status}）：请核对 AI 工具里配置的网关口令；`
      + '口令只通过 Authorization: Bearer 传递，不要拼进 URL';
  }
  if (status === 404) {
    return 'CodeBuddy 网关路径不存在（HTTP 404）：请核对 Endpoint 是否为网关根地址（不要带 /api/v1）';
  }
  return formatHttpError(status, body);
}

async function readErrorBody(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

/**
 * 解析统一响应信封：成功 `{data}`，失败 `{error:{code,message}}`。
 * health/auth/status 在当前版本有裸对象返回（无 data 包裹），readData 两者都兼容。
 */
async function requestJson(
  path: string,
  config: ToolConfig,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonRecord> {
  const tms = Math.max(1, timeoutMs);
  const res = await fetch(apiUrl(config.endpoint, path), {
    ...init,
    headers: { ...requestHeaders(config), ...(init.headers ?? {}) },
    dispatcher: modelDispatcher(tms),
    signal: AbortSignal.timeout(tms),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(gatewayHttpError(res.status, text));
  if (!text) return {};
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    throw new Error(`CodeBuddy 网关返回非 JSON：${text.slice(0, 120)}`);
  }
  const root = json as JsonRecord;
  const err = root.error;
  if (err && typeof err === 'object') {
    const code = pickString((err as JsonRecord).code);
    const message = pickString((err as JsonRecord).message) || '网关返回错误';
    throw new Error(`${code ? `${code}: ` : ''}${message}`);
  }
  return readData(json);
}

/** SSE 传输层错误（区别于 run 业务失败）：尽量带回网关 error 原文 */
function parseSseError(data: string): string {
  try {
    const j = JSON.parse(data) as JsonRecord;
    const e = j.error;
    if (e && typeof e === 'object') {
      const code = pickString((e as JsonRecord).code);
      const message = pickString((e as JsonRecord).message) || 'SSE 错误';
      return `${code ? `${code}: ` : ''}${message}`;
    }
  } catch { /* 非 JSON 原样返回 */ }
  return data.slice(0, 200) || 'SSE 连接异常结束';
}

/**
 * 终态文本判定：网关把「未登录」也包成 status=completed + content.markdown，
 * 若一律判成功会把鉴权失败写成任务结论（实测原文 AuthenticationRequiredError）。
 * 只拦截确定的“执行未发生”前缀，不把业务结论里正常出现的 Error 字样误判。
 */
function looksLikeExecutionFailure(text: string): boolean {
  const t = text.trim();
  return /^(AuthenticationRequiredError|AUTH_REQUIRED|Unauthorized|Failed to authenticate|Error:\s*EXECUTION_ERROR|EMPTY_PROMPT|CANCELLED)/i.test(t)
    || /Authentication required\. Please use \/login/i.test(t);
}

function finalize(state: RunState, status: RunState['status'], content?: string, error?: string): void {
  if (state.finalizedAt) return;
  state.status = status;
  state.content = content;
  state.error = error;
  state.finalizedAt = Date.now();
}

/** 把 SSE 的 message 事件映射到 RunState；返回 true 表示已收到终态、可以停止读流 */
function applyRunEvent(state: RunState, dataText: string): boolean {
  let payload: JsonRecord;
  try { payload = JSON.parse(dataText) as JsonRecord; } catch { return false; }
  const status = pickString(payload.status).toLowerCase();
  const content = payload.content && typeof payload.content === 'object' ? payload.content as JsonRecord : {};
  const markdown = pickString(content.markdown) || pickString(content.text);
  const chunk = pickString(content.chunk);

  if (status === 'streaming') {
    if (chunk) state.partial += chunk;
    state.status = 'running';
    return false;
  }
  if (status === 'accepted') {
    state.status = 'running';
    return false;
  }
  if (status === 'completed') {
    const text = markdown || state.partial;
    if (looksLikeExecutionFailure(text)) {
      finalize(state, 'failed', undefined, `执行未发生：${text.slice(0, 300)}`);
    } else {
      finalize(state, 'success', text || '（网关执行完成，但未返回文本结果）');
    }
    return true;
  }
  if (status === 'error' || status === 'failed') {
    const err = payload.error && typeof payload.error === 'object' ? payload.error as JsonRecord : {};
    const code = pickString(err.code);
    const message = pickString(err.message) || `网关执行失败（status=${status}）`;
    finalize(state, 'failed', undefined, `${code ? `${code}: ` : ''}${message}`);
    return true;
  }
  // 未知状态按仍在执行处理，避免误杀长任务
  return false;
}

/**
 * 后台消费 SSE：submit 拿到 runId 后立即调用，不 await。
 * 超时用 config.timeoutMs（同时是 QueueService 的等待上限），超时后 abort 并置 timeout。
 */
async function consumeRunStream(ticket: string, config: ToolConfig, state: RunState): Promise<void> {
  const runTimeoutMs = Math.max(1_000, config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runTimeoutMs);
  try {
    const res = await fetch(apiUrl(config.endpoint, `/runs/${encodeURIComponent(ticket)}/stream`), {
      headers: { ...requestHeaders(config), Accept: 'text/event-stream' },
      dispatcher: modelDispatcher(runTimeoutMs),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      // 404 = 订阅晚于完成：没有历史可补，判失败并让 PushDispatcher 降级
      finalize(state, 'failed', undefined,
        res.status === 404
          ? '结果流已结束且未捕获（执行过快或服务重启）——请检查网关是否已登录，必要时转 MCP 就绪池兜底'
          : gatewayHttpError(res.status, body));
      return;
    }
    if (!res.body) {
      finalize(state, 'failed', undefined, '网关未返回 SSE 流');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventName = 'message';
    let dataLines: string[] = [];
    let ended = false;

    const dispatch = (): boolean => {
      // SSE 的结束事件可能只有 `event: done` 而没有 data 行；必须在 dataLines 判空前处理，
      // 否则会把结束事件误吞成普通 message，直到流关闭才判「未收到 completed」。
      if (eventName === 'done') { ended = true; dataLines = []; return true; }
      if (!dataLines.length) { eventName = 'message'; return false; }
      const dataText = dataLines.join('\n');
      dataLines = [];
      if (eventName === 'error') { finalize(state, 'failed', undefined, parseSseError(dataText)); ended = true; return true; }
      if (eventName === 'message' && applyRunEvent(state, dataText)) { ended = true; return true; }
      eventName = 'message';
      return false;
    };

    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          if (dispatch()) break;
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (ended) break;
    }
    if (ended) {
      // 收到终态/done 后主动断开 SSE，避免长连接占住网关会话
      try { await reader.cancel(); } catch { /* 已结束的流 cancel 失败无影响 */ }
    }
    if (state.finalizedAt === undefined) {
      // 流自然结束但没收到 completed：不要拿 streaming 片段冒充最终结论，判失败交给 MCP 就绪池兜底
      finalize(state, 'failed', undefined,
        `SSE 流结束但未收到 completed${state.partial ? `（已收到 ${state.partial.length} 字符片段）` : ''}`);
    }
  } catch (e) {
    if (controller.signal.aborted) {
      finalize(state, 'timeout', undefined, `等待 CodeBuddy 执行超过 ${runTimeoutMs}ms，已超时`);
    } else {
      finalize(state, 'failed', undefined, `SSE 读取失败：${describeError(e)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function startRunState(ticket: string, config: ToolConfig): RunState {
  const existing = runStates.get(ticket);
  if (existing) return existing;
  const state: RunState = { status: 'starting', partial: '', startedAt: Date.now() };
  runStates.set(ticket, state);
  void consumeRunStream(ticket, config, state);
  return state;
}

function cleanupRunStates(): void {
  const now = Date.now();
  for (const [ticket, state] of runStates) {
    if (state.finalizedAt && now - state.finalizedAt > RUN_STATE_TTL_MS) runStates.delete(ticket);
  }
}

/** 构造派发给 Agent 的提示词：任务上下文 + 结果结构 + 工作空间，均来自 MTask 任务快照 */
function buildTaskPrompt(context: TaskContext): string {
  const lines = [
    '你是 MTask 派发的执行 Agent，请在当前工作空间内完成下面这个任务。',
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
    '2. 完成后按 Markdown 输出：## 根因 / ## 影响范围 / ## 修复 / ## 验证 / ## 本次回写。',
    '3. 无法完成时明确写阻塞原因与所需资源；不要伪造验证结果。',
  ];
  return lines.filter(Boolean).join('\n');
}

export class CodeBuddyGatewayAdapter implements AIAdapter {
  readonly type = 'codebuddy-gateway' as AdapterType;

  /**
   * 连接测试：health（证明网关活着）+ auth/status（证明认证形态）。
   * 若网关开启了密码而工具未配口令，必须判失败——否则“连接成功”会误导用户去派发。
   */
  async testConnection(config: ToolConfig) {
    try {
      const health = await requestJson('/health', config, {}, Math.min(config.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
      if (pickString(health.status) !== 'ok') {
        return { ok: false, message: `CodeBuddy 网关 health 非 ok：${JSON.stringify(health).slice(0, 120)}` };
      }
      const auth = await requestJson('/auth/status', config, {}, Math.min(config.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
      const authEnabled = auth.authEnabled === true;
      const hasKey = (config.apiKey ?? '').trim().length > 0;
      if (authEnabled && !hasKey) {
        return { ok: false, message: '网关可达，但 authEnabled=true 且未配置口令：请填写网关密码（Authorization: Bearer）' };
      }
      if (authEnabled && hasKey) {
        // auth/status 不校验口令；用需要鉴权的 /info 真正验一次
        const info = await requestJson('/info', config, {}, Math.min(config.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
        const version = pickString(info.version);
        return { ok: true, message: `CodeBuddy 网关可达且口令有效${version ? `（版本 ${version}）` : ''}；未发起真实 Agent 执行` };
      }
      return { ok: true, message: 'CodeBuddy 网关可达（authEnabled=false）；未发起真实 Agent 执行' };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  async listModels(_config: ToolConfig): Promise<ModelsResult> {
    return { ok: false, message: 'CodeBuddy Gateway 是 Agent 执行通道，不提供模型列表；model 字段可填 codebuddy 以满足 MTask 运行时校验' };
  }

  /** 派发任务：POST /runs 受理后返回 runId，并在后台挂 SSE 直到终态 */
  async submit(context: TaskContext, config: ToolConfig): Promise<SubmitResult> {
    const runTimeoutMs = Math.max(1_000, config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const messageId = `mtask-${context.taskId}-${nonce}`;
    const body = {
      id: messageId,
      type: 'message',
      version: '1.0',
      source: {
        platform: 'mtask',
        sender: { id: 'mtask', name: 'MTask' },
        conversation: { id: `mtask-${context.taskId}-${nonce}`, type: 'direct' },
      },
      payload: { text: buildTaskPrompt(context) },
      timeoutMs: runTimeoutMs,
    };
    try {
      const data = await requestJson('/runs', config, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const runId = pickString(data.runId);
      if (!runId) return { ok: false, error: 'CodeBuddy 网关未返回 runId' };
      startRunState(runId, config);
      cleanupRunStates();
      return { ok: true, accepted: true, ticket: runId };
    } catch (e) {
      return { ok: false, error: describeError(e) };
    }
  }

  /**
   * 轮询只读内存终态，绝不在这里阻塞读 SSE。
   * 内存无记录（进程重启/队列里遗留 ticket）时用 GET /runs/:runId 的 active 判活；
   * active=false 且无终态说明结果流已随完成删除，判失败交给 PushDispatcher 降级。
   */
  async poll(ticket: string, config: ToolConfig): Promise<PollResult> {
    const state = runStates.get(ticket);
    if (state) {
      if (state.status === 'success') return { status: 'success', content: state.content };
      if (state.status === 'failed') return { status: 'failed', error: state.error ?? 'CodeBuddy 执行失败' };
      if (state.status === 'timeout') return { status: 'timeout', error: state.error ?? 'CodeBuddy 执行超时' };
      return { status: 'running' };
    }
    try {
      const data = await requestJson(`/runs/${encodeURIComponent(ticket)}`, config);
      if (data.active === true) {
        startRunState(ticket, config);
        return { status: 'running' };
      }
      return {
        status: 'failed',
        error: '结果流已结束且未捕获（可能执行过快或 MTask 服务重启）——请检查 WorkBuddy 网关登录态，必要时转 MCP 就绪池兜底',
      };
    } catch (e) {
      return { status: 'failed', error: `查询 CodeBuddy 执行状态失败：${describeError(e)}` };
    }
  }

  /** 通用对话：走一次真实 Agent 执行并等待终态（供 AI 摘要/优化等通用入口选择本工具时使用） */
  async chat(system: string, user: string, config: ToolConfig, signal?: AbortSignal): Promise<JobResult> {
    const result = await this.submitAndWait({
      taskId: 'chat',
      title: '通用对话',
      description: `${system ? `${system}\n\n` : ''}${user}`,
      projectName: '',
    }, config, signal);
    return result;
  }

  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void, signal?: AbortSignal): Promise<StreamResult> {
    const result = await this.chat(system, user, config, signal);
    if (result.ok && result.content) onDelta(result.content);
    return result as StreamResult;
  }

  /** 同步语义：submit + 轮询到终态，供 send/chat 使用 */
  private async submitAndWait(context: TaskContext, config: ToolConfig, signal?: AbortSignal): Promise<JobResult> {
    const sub = await this.submit(context, config);
    if (!sub.ok || !sub.ticket) return { ok: false, error: sub.error ?? '提交失败' };
    const limit = Math.max(1_000, config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const started = Date.now();
    for (;;) {
      if (signal?.aborted) return { ok: false, error: '已取消' };
      const p = await this.poll(sub.ticket, config);
      if (p.status === 'success') return { ok: true, content: p.content };
      if (p.status === 'failed') return { ok: false, error: p.error };
      if (p.status === 'timeout') return { ok: false, error: p.error, timedOut: true };
      if (Date.now() - started > limit) return { ok: false, error: `等待 CodeBuddy 执行超过 ${limit}ms`, timedOut: true };
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    return this.submitAndWait(context, config);
  }
}
