import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult, SubmitResult, PollResult } from './types';
import { withTimeout, formatHttpError } from './netutil';

/**
 * 回调/中继型适配器（骨架）：面向 WorkBuddy 等 Agent 平台。
 *
 * 为什么做成"中继器而非直连"：2026-08 核查确认这类平台不暴露可由第三方稳定
 * 注入任务并取回执的公开 API，因此把 endpoint 视为"任务派发目标 URL"（后续接入
 * WorkBuddy relay / 自建中继时填入即可），刻意不硬编码任何第三方私有路径，避免虚构协议。
 *
 * 约定 JSON 契约（POST {endpoint}）：
 *   - action='ping' → 连通探测，期望 { ok, message? }
 *   - action='chat' → 通用对话 { system, user }，期望 { ok, content|error|accepted }
 *   - action='send' → 派发任务上下文，期望同上
 * 响应三类：同步结果 / 异步占位（accepted，结果依赖回调）/ 错误。
 */
export class WorkBuddyAdapter implements AIAdapter {
  readonly type = 'workbuddy' as AdapterType;

  private endpoint(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
  }

  async testConnection(config: ToolConfig) {
    try {
      const res = await withTimeout(
        fetch(this.endpoint(config.endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ping' }),
        }),
        config.timeoutMs ?? 10000,
      );
      if (!res.ok) return { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
      const data = (await res.json()) as { ok?: boolean; message?: string };
      return data.ok
        ? { ok: true, message: data.message ?? '连接成功' }
        : { ok: false, message: data.message ?? '返回异常' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 平台侧模型清单由中继层决定支撑，本适配器不做 /models 探测 */
  async listModels(_config: ToolConfig): Promise<ModelsResult> {
    return { ok: false, message: '中继型适配器不支持拉取模型列表' };
  }

  /** 派发任务上下文到中继；响应 accepted 时返回"待回调"占位而非伪造平台内容 */
  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    const user = [
      `【项目】${context.projectName}`,
      `【任务】${context.title}`,
      context.description ? `【描述】${context.description}` : '',
      context.aiSummary ? `【AI 梳理摘要】${context.aiSummary}` : '',
      context.prdContext ? `【PRD 需求上下文】${context.prdContext}` : '', // T00763
      context.workspacePath ? `【工作空间】${context.workspacePath}（项目上下文根路径）` : '', // T00771
    ].filter(Boolean).join('\n');
    return this.post({ action: 'send', jobId: context.taskId, taskTitle: context.title, user }, config);
  }

  async chat(system: string, user: string, config: ToolConfig): Promise<JobResult> {
    return this.post({ action: 'chat', system, user }, config);
  }

  /** 流式：中继器通常为异步 Agent，不实现增量流，回退为完整结果一次性回调（见 types.ts 契约注释） */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void): Promise<StreamResult> {
    const r = await this.chat(system, user, config);
    if (r.ok && r.content) onDelta(r.content);
    return r as StreamResult;
  }

  /** 异步受理：提交后返回回执标识（ticket），结果待 poll 轮询收敛；若平台同步返回则直接给 content */
  async submit(context: TaskContext, config: ToolConfig): Promise<SubmitResult> {
    const user = [
      `【项目】${context.projectName}`,
      `【任务】${context.title}`,
      context.description ? `【描述】${context.description}` : '',
      context.aiSummary ? `【AI 梳理摘要】${context.aiSummary}` : '',
      context.prdContext ? `【PRD 需求上下文】${context.prdContext}` : '', // T00763
      context.workspacePath ? `【工作空间】${context.workspacePath}（项目上下文根路径）` : '', // T00771
    ].filter(Boolean).join('\n');
    const body = { action: 'send_submit', jobId: context.taskId, taskTitle: context.title, user };
    try {
      const { res, data, text } = await this.request(body, config);
      if (!res.ok) return { ok: false, error: formatHttpError(res.status, text) };
      const d = data as { ok?: boolean; accepted?: boolean; ticket?: string; content?: string; error?: string } | null;
      if (!d) return { ok: false, error: '中继返回空响应' };
      if (d.ok === false) return { ok: false, error: d.error ?? `HTTP ${res.status}` };
      if (d.accepted) return { ok: true, accepted: true, ticket: d.ticket };
      if (typeof d.content === 'string' && d.content) return { ok: true, content: d.content };
      return { ok: false, error: d.error ?? '中继返回异常（缺少 content/ticket）' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 异步轮询：按回执标识查询执行结果；非 success/failed 一律视为 running 继续等待 */
  async poll(ticket: string, config: ToolConfig): Promise<PollResult> {
    try {
      const { res, data, text } = await this.request({ action: 'send_poll', ticket }, config);
      if (!res.ok) return { status: 'failed', error: formatHttpError(res.status, text) };
      const d = data as { status?: string; content?: string; error?: string } | null;
      if (!d) return { status: 'failed', error: '中继返回空响应' };
      if (d.status === 'success') return { status: 'success', content: d.content };
      if (d.status === 'failed') return { status: 'failed', error: d.error ?? '执行失败' };
      return { status: 'running' };
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 统一请求：返回响应对象与解析后的 JSON（可能为 null）、原始文本，供 post/submit/poll 各自解释 */
  private async request(body: Record<string, unknown>, config: ToolConfig): Promise<{ res: Response; data: unknown; text: string }> {
    const res = await withTimeout(
      fetch(this.endpoint(config.endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      config.timeoutMs ?? 60000,
    );
    const text = await res.text().catch(() => '');
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { res, data, text };
  }

  private async post(body: Record<string, unknown>, config: ToolConfig): Promise<JobResult> {
    try {
      const { res, data, text } = await this.request(body, config);
      if (!res.ok) return { ok: false, error: formatHttpError(res.status, text) };
      const d = data as { ok?: boolean; content?: string; error?: string; accepted?: boolean } | null;
      if (!d) return { ok: false, error: '中继返回空响应' };
      if (d.ok === false) return { ok: false, error: d.error ?? `HTTP ${res.status}` };
      // accepted：已提交、结果依赖平台回调，返回明确占位，避免把"已受理"误当"已完成"
      if (d.accepted) {
        // typeof 收窄：body 字段为 unknown，直接 String() 会把对象字符串化成 [object Object]
        const raw: unknown = body.taskTitle ?? body.system;
        const hint = typeof raw === 'string' ? raw : '';
        return { ok: true, content: `已提交至 WorkBuddy（结果待回调）：${hint}` };
      }
      if (typeof d.content === 'string' && d.content) return { ok: true, content: d.content };
      return { ok: false, error: d.error ?? '中继返回异常（缺少 content）' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}