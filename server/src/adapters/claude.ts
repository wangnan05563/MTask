import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines } from './netutil';
import { streamTruncatedError, outputStoppedError } from './types'; // T00779：流式截断统一错误文案

interface MessagesResp {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null; // 走查 M-2/M-3：非流式同样判定触顶/拒绝
  error?: { message?: string };
}

/** 流式行的累积态：文本与 Anthropic 侧的 stop_reason（T00779：max_tokens 即触顶截断） */
interface ClaudeStreamAcc {
  text: string;
  stopReason: string;
}

/**
 * M6-6.1：Anthropic 流式事件行的累积器（原 chatStream 内联回调）。
 * 只解析 `data:` 有效载荷；非 JSON / 错误校验行静默跳过，交由流结束后的整体裁决处理。
 */
function claudeLineCollector(onDelta: (text: string) => void): { acc: ClaudeStreamAcc; collect: (line: string) => void } {
  const acc: ClaudeStreamAcc = { text: '', stopReason: '' };
  const collect = (line: string): void => {
    const trimmed = line.trim();
    // Anthropic 事件以 data: 前缀承载 JSON；跳过 event 行为减少无意义解析
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    try {
      const json = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string | null }; error?: { message?: string } };
      if (json.error?.message) throw new Error(json.error.message);
      // message_delta 事件携带 stop_reason，max_tokens 表示触顶截断
      if (json.type === 'message_delta' && typeof json.delta?.stop_reason === 'string' && json.delta.stop_reason) {
        acc.stopReason = json.delta.stop_reason;
      }
      // 仅取文本增量块：content_block_delta 且 delta 类型为 text_delta
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
        acc.text += json.delta.text;
        onDelta(json.delta.text);
      }
    } catch {
      // 忽略协议偶发的非 JSON 行，交由完整流结束后判断结果
    }
  };
  return { acc, collect };
}

/** M6-6.1：流式结束后的成败裁决（触顶截断带 partial；拒答为走查 M-3 的输出中断口径） */
function claudeStreamVerdict(text: string, stopReason: string): StreamResult | null {
  if (stopReason === 'max_tokens') return { ok: false, error: streamTruncatedError(text.length), partial: text };
  if (stopReason === 'refusal') return { ok: false, error: outputStoppedError('stop_reason=refusal', text.length) };
  return null;
}

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic Messages API 适配器。endpoint 填写形如 https://api.anthropic.com 的根地址。 */
export class ClaudeAdapter implements AIAdapter {
  readonly type = 'claude' as AdapterType;

  private baseUrl(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
  }

  async testConnection(config: ToolConfig) {
    if (!config.apiKey) return { ok: false, message: '缺少 API Key' };
    try {
      const url = `${this.baseUrl(config.endpoint)}/v1/messages`;
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({ model: config.model ?? 'claude-3-5-sonnet-latest', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        }),
        config.timeoutMs ?? 10000,
      );
      return res.ok
        ? { ok: true, message: '连接成功' }
        : { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** GET /v1/models 拉取可用模型清单（Anthropic 返回 { data: [{ id }] }，需 x-api-key） */
  async listModels(config: ToolConfig): Promise<ModelsResult> {
    if (!config.apiKey) return { ok: false, message: '缺少 API Key' };
    try {
      const url = `${this.baseUrl(config.endpoint)}/v1/models`;
      const res = await withTimeout(
        fetch(url, {
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
        }),
        config.timeoutMs ?? 15000,
      );
      if (!res.ok) return { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
      const models = normalizeModels(await res.json().catch(() => null));
      if (models.length === 0) return { ok: false, message: '服务商未返回模型列表（可能不支持 /v1/models 接口）' };
      return { ok: true, models };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    const system = [
      '你是 MTask 的开发任务执行者。请根据任务信息产出可直接交付的开发成果文本。',
      '输出要求：1) 实现思路(简短) 2) 完整代码/配置/操作步骤(可复制) 3) 关键风险与验证方式。只输出最终成果。',
    ].join('\n');
    const user = [
      `【项目】${context.projectName}`,
      `【任务】${context.title}`,
      context.description ? `【描述】${context.description}` : '',
      context.aiSummary ? `【AI 梳理摘要】${context.aiSummary}` : '',
      context.prdContext ? `【PRD 需求上下文】${context.prdContext}` : '', // T00763
      context.workspacePath ? `【工作空间】${context.workspacePath}（项目上下文根路径）` : '', // T00771
    ].filter(Boolean).join('\n');
    return this.chat(system, user, config);
  }

  /** 通用单轮对话：复用 /v1/messages，供 send 与提示词优化等场景共用 */
  async chat(system: string, user: string, config: ToolConfig, signal?: AbortSignal): Promise<JobResult> {
    if (!config.apiKey) return { ok: false, error: '缺少 API Key' };
    // T00838：为外部取消信号生成内部 AbortController，随 fetch 透传
    const ctrl = signal ? new AbortController() : undefined;
    if (signal && ctrl) signal.addEventListener('abort', () => ctrl.abort());
    try {
      const url = `${this.baseUrl(config.endpoint)}/v1/messages`;
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: config.model ?? 'claude-3-5-sonnet-latest',
            max_tokens: config.maxTokens ?? 4096,
            temperature: config.temperature ?? 0.2,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          ...(ctrl ? { signal: ctrl.signal } : {}),
        }),
        config.timeoutMs ?? 60000,
      );

      const data = (await res.json()) as MessagesResp;
      if (!res.ok || data.error) {
        return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
      }
      const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      // 走查 M-2/M-3：非流式补齐截断/拒绝判定（原先只有 openai 侧 T00714 有）——
      // 先判 stop_reason 再判空：maxTokens 极小时 content 为空但 stop_reason=max_tokens，报「截断」比「内容为空」更可排障
      if (data.stop_reason === 'max_tokens') return { ok: false, error: streamTruncatedError(text?.length ?? 0) };
      if (data.stop_reason === 'refusal') return { ok: false, error: outputStoppedError('stop_reason=refusal', text?.length ?? 0) };
      if (!text) return { ok: false, error: 'AI 返回内容为空' };
      return { ok: true, content: text };
    } catch (e) {
      // T00838：外部主动中止归因到「任务已停止」
      if (signal?.aborted) return { ok: false, error: '任务已停止' };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 流式通用单轮对话：stream:true，解析 content_block_delta 的 text 增量回调，供 AI 周报 SSE 实时输出 */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void, signal?: AbortSignal): Promise<StreamResult> {
    if (!config.apiKey) return { ok: false, error: '缺少 API Key' };
    const ctrl = new AbortController();
    // 流式期间受超时约束：超时即中断，避免长耗时任务无限挂起
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000);
    // T00838：外部取消信号（用户点「停止」）同样 abort 底层流请求
    if (signal) signal.addEventListener('abort', () => ctrl.abort());
    try {
      const url = `${this.baseUrl(config.endpoint)}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: config.model ?? 'claude-3-5-sonnet-latest',
          max_tokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0.2,
          system,
          messages: [{ role: 'user', content: user }],
          // 请求流式事件（content_block_delta 等）
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: res.ok ? 'AI 未返回流式内容' : formatHttpError(res.status, await res.text().catch(() => '')) };
      }
      const { acc, collect } = claudeLineCollector(onDelta);
      await readStreamLines(res, collect);
      const { text, stopReason } = acc;
      if (!text) return { ok: false, error: 'AI 返回内容为空' };
      return claudeStreamVerdict(text, stopReason) ?? { ok: true, content: text };
    } catch (e) {
      // T00838：区分「外部主动停止」与「超时」
      if (signal?.aborted) return { ok: false, error: '任务已停止' };
      if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: `连接超时（超过 ${config.timeoutMs ?? 60000}ms）` };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
