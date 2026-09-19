import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines } from './netutil';
import { streamTruncatedError, outputStoppedError } from './types'; // T00779：流式截断统一错误文案

interface MessagesResp {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null; // 走查 M-2/M-3：非流式同样判定触顶/拒绝
  error?: { message?: string };
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
  async chat(system: string, user: string, config: ToolConfig): Promise<JobResult> {
    if (!config.apiKey) return { ok: false, error: '缺少 API Key' };
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
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 流式通用单轮对话：stream:true，解析 content_block_delta 的 text 增量回调，供 AI 周报 SSE 实时输出 */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void): Promise<StreamResult> {
    if (!config.apiKey) return { ok: false, error: '缺少 API Key' };
    const ctrl = new AbortController();
    // 流式期间受超时约束：超时即中断，避免长耗时任务无限挂起
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000);
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
      let text = '';
      let stopReason = ''; // T00779：Anthropic 侧截断标志（max_tokens）
      await readStreamLines(res, (line) => {
        const trimmed = line.trim();
        // Anthropic 事件以 data: 前缀承载 JSON；跳过 event 行为减少无意义解析
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload) return;
        try {
          const json = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string | null }; error?: { message?: string } };
          if (json.error?.message) throw new Error(json.error.message);
          // T00779：message_delta 事件携带 stop_reason，max_tokens 表示触顶截断
          if (json.type === 'message_delta' && typeof json.delta?.stop_reason === 'string' && json.delta.stop_reason) {
            stopReason = json.delta.stop_reason;
          }
          // 仅取文本增量块：content_block_delta 且 delta 类型为 text_delta
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
            text += json.delta.text;
            onDelta(json.delta.text);
          }
        } catch {
          // 忽略协议偶发的非 JSON 行，交由完整流结束后判断结果
        }
      });
      if (!text) return { ok: false, error: 'AI 返回内容为空' };
      if (stopReason === 'max_tokens') return { ok: false, error: streamTruncatedError(text.length) }; // T00779
      if (stopReason === 'refusal') return { ok: false, error: outputStoppedError('stop_reason=refusal', text.length) }; // 走查 M-3
      return { ok: true, content: text };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: `连接超时（超过 ${config.timeoutMs ?? 60000}ms）` };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
