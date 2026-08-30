import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines } from './netutil';

interface ChatResp {
  message?: { content?: string };
  error?: string;
}

/** Ollama 本地模型适配器（POST /api/chat，stream=false）。endpoint 形如 http://127.0.0.1:11434。 */
export class OllamaAdapter implements AIAdapter {
  readonly type = 'ollama' as AdapterType;

  private baseUrl(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
  }

  async testConnection(config: ToolConfig) {
    try {
      const url = `${this.baseUrl(config.endpoint)}/api/tags`;
      const res = await withTimeout(fetch(url), config.timeoutMs ?? 10000) as Response;
      return res.ok
        ? { ok: true, message: '连接成功' }
        : { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** GET /api/tags 拉取本地已拉取的模型清单（Ollama 返回 { models: [{ name }] }） */
  async listModels(config: ToolConfig): Promise<ModelsResult> {
    try {
      const url = `${this.baseUrl(config.endpoint)}/api/tags`;
      const res = await withTimeout(fetch(url), config.timeoutMs ?? 15000) as Response;
      if (!res.ok) return { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
      const models = normalizeModels(await res.json().catch(() => null));
      if (models.length === 0) return { ok: false, message: 'Ollama 未返回模型列表（可能尚未拉取任何模型）' };
      return { ok: true, models };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    const user = [
      `【项目】${context.projectName}`,
      `【任务】${context.title}`,
      context.description ? `【描述】${context.description}` : '',
      context.aiSummary ? `【AI 梳理摘要】${context.aiSummary}` : '',
      '',
      '你是 MTask 的开发任务执行者。请产出可直接交付的开发成果文本：实现思路(简短)、完整代码/配置/操作步骤(可复制)、关键风险与验证方式。只输出最终成果。',
    ].filter(Boolean).join('\n');
    return this.chat('', user, config);
  }

  /** 通用单轮对话：复用 /api/chat，供 send 与提示词优化等场景共用 */
  async chat(system: string, user: string, config: ToolConfig): Promise<JobResult> {
    try {
      const url = `${this.baseUrl(config.endpoint)}/api/chat`;
      const prompt = system ? `${system}\n\n${user}` : user;

      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model ?? 'qwen2.5-coder:7b',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            options: { temperature: config.temperature ?? 0.2 },
          }),
        }),
        config.timeoutMs ?? 60000,
      ) as Response;

      const data = (await res.json()) as ChatResp;
      if (!res.ok || data.error) {
        return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      }
      if (!data.message?.content) return { ok: false, error: 'AI 返回内容为空' };
      return { ok: true, content: data.message.content };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 流式通用单轮对话：stream:true，逐行取 message.content 增量回调，供 AI 周报 SSE 实时输出 */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void): Promise<StreamResult> {
    const ctrl = new AbortController();
    // 流式期间受超时约束：超时即中断，避免长耗时任务无限挂起
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000);
    try {
      const url = `${this.baseUrl(config.endpoint)}/api/chat`;
      const prompt = system ? `${system}\n\n${user}` : user;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model ?? 'qwen2.5-coder:7b',
          messages: [{ role: 'user', content: prompt }],
          // 请求流式，逐块返回 message.content
          stream: true,
          options: { temperature: config.temperature ?? 0.2 },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: res.ok ? 'AI 未返回流式内容' : formatHttpError(res.status, await res.text().catch(() => '')) };
      }
      let text = '';
      await readStreamLines(res, (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const json = JSON.parse(trimmed) as { message?: { content?: string }; error?: string; done?: boolean };
          if (json.error) throw new Error(json.error);
          const delta = json.message?.content;
          // Ollama 增量与最终残留都可能为空，仅对非空增量回调
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // 忽略协议偶发的非 JSON 行，交由完整流结束后判断结果
        }
      });
      if (!text) return { ok: false, error: 'AI 返回内容为空' };
      return { ok: true, content: text };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: `连接超时（超过 ${config.timeoutMs ?? 60000}ms）` };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
