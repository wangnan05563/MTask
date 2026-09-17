import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines } from './netutil';

interface ChatCompletionResp {
  choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  error?: { message?: string };
}

/**
 * OpenAI 兼容协议适配器：OpenAI、DeepSeek、通义、本地 vLLM 等 /chat/completions 端点。
 * 系统提示固定要求输出可合并的开发文本；结果仅回传文本，不写入任何文件（FR4.4「保存文本待人工合并」）。
 */
export class OpenAICompatAdapter implements AIAdapter {
  readonly type = 'openai-compatible' as AdapterType;

  private baseUrl(endpoint: string): string {
    const e = endpoint.replace(/\/+$/, '');
    // OpenAI 兼容端点要求 /v1 前缀：兼容「填根域名」与「填到 /v1」两种习惯
    return e.endsWith('/v1') ? e : `${e}/v1`;
  }

  async testConnection(config: ToolConfig) {
    try {
      const url = `${this.baseUrl(config.endpoint)}/models`;
      const res = await withTimeout(fetch(url, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      }), config.timeoutMs ?? 10000);
      return res.ok
        ? { ok: true, message: '连接成功' }
        : { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** GET /models 拉取可用模型清单（OpenAI 兼容协议 { data: [{ id }] }） */
  async listModels(config: ToolConfig): Promise<ModelsResult> {
    try {
      const url = `${this.baseUrl(config.endpoint)}/models`;
      const res = await withTimeout(fetch(url, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      }), config.timeoutMs ?? 15000);
      if (!res.ok) return { ok: false, message: formatHttpError(res.status, await res.text().catch(() => '')) };
      const models = normalizeModels(await res.json().catch(() => null));
      if (models.length === 0) return { ok: false, message: '服务商未返回模型列表（可能不支持 /models 接口）' };
      return { ok: true, models };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(context: TaskContext, config: ToolConfig): Promise<JobResult> {
    const system = [
      '你是 MTask 的开发任务执行者。请根据任务信息产出可直接交付的开发成果文本。',
      '输出要求：',
      '1. 给出实现思路（简短）',
      '2. 给出完整代码/配置/操作步骤（可复制）',
      '3. 列出关键风险与验证方式',
      '只输出最终成果，不要寒暄。',
    ].join('\n');
    const user = [
      `【项目】${context.projectName}`,
      `【任务】${context.title}`,
      context.description ? `【描述】${context.description}` : '',
      context.aiSummary ? `【AI 梳理摘要】${context.aiSummary}` : '',
      context.attachments?.length ? `【附件】${context.attachments.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return this.chat(system, user, config);
  }

  /** 通用单轮对话：复用 /chat/completions，供 send 与提示词优化等场景共用 */
  async chat(system: string, user: string, config: ToolConfig): Promise<JobResult> {
    try {
      const url = `${this.baseUrl(config.endpoint)}/chat/completions`;
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model ?? 'gpt-4o-mini',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: config.temperature ?? 0.2,
            max_tokens: config.maxTokens ?? 4096,
          }),
        }),
        config.timeoutMs ?? 60000,
      );

      const data = (await res.json()) as ChatCompletionResp;
      if (!res.ok || data.error) {
        return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
      }
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      // T00714（D-6 修复）：输出被 token 上限截断（finish_reason=length）时显式报错——
      // 不再把残缺/空输出静默交给上层做 JSON 解析（曾表现为「AI 未返回有效的 PRD 解析结果」误导排障）；
      // 记 ok=false 进 ai_usage，错误文案可区分「输出被截断」与「模型不行」。
      // 注意顺序：触顶时 content 可能为空串，必须先判 finish_reason 再判空（maxTokens 极小时实测）
      if (choice?.finish_reason === 'length') {
        return { ok: false, error: `AI 输出超长被截断（finish_reason=length，已输出 ${content.length} 字符）——请精简文档内容或调大输出上限/分块解析后重试` };
      }
      if (!content) {
        // T00721：思考型模型（如 agnes-2.5-flash）可能把输出预算全部耗在 reasoning_content（思考）上，
        // 正文为空（实测 20~44s 长耗时 + 0 字符）。给出可操作提示而非笼统的「AI 返回内容为空」
        const reasoning = choice?.message?.reasoning_content;
        if (reasoning) {
          return { ok: false, error: `模型仅输出了思考过程（reasoning ${reasoning.length} 字符），正文为空——多为思考耗尽输出上限所致，请调大该工具的 max_tokens 或更换非思考型模型后重试` };
        }
        return { ok: false, error: 'AI 返回内容为空' };
      }
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 流式通用单轮对话：stream:true，逐块取 choices[0].delta.content 增量回调，供 AI 周报 SSE 实时输出 */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void): Promise<StreamResult> {
    const ctrl = new AbortController();
    // 流式期间同样受超时约束：超时则中断流，避免长耗时任务无限挂起
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000);
    try {
      const url = `${this.baseUrl(config.endpoint)}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: config.temperature ?? 0.2,
          max_tokens: config.maxTokens ?? 4096,
          // 请求流式，逐 delta 返回增量文本
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: res.ok ? 'AI 未返回流式内容' : formatHttpError(res.status, await res.text().catch(() => '')) };
      }
      let text = '';
      await readStreamLines(res, (line) => {
        const trimmed = line.trim();
        // OpenAI 兼容以 data: 前缀承载事件；跳过注释/id 等无内容行
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
          if (json.error?.message) throw new Error(json.error.message);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // 忽略协议偶发的非 JSON / 错误校验行，交由完整流结束后判断
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
