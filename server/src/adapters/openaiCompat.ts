import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines } from './netutil';
import { streamTruncatedError, outputStoppedError } from './types'; // T00779：流式截断统一错误文案

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
      context.prdContext ? `【PRD 需求上下文】${context.prdContext}` : '', // T00763
      context.workspacePath ? `【工作空间】${context.workspacePath}（项目上下文根路径）` : '', // T00771
      context.attachments?.length ? `【附件】${context.attachments.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return this.chat(system, user, config);
  }

  /** 通用单轮对话：复用 /chat/completions，供 send 与提示词优化等场景共用 */
  async chat(system: string, user: string, config: ToolConfig, signal?: AbortSignal): Promise<JobResult> {
    // T00838：把外部取消信号与内部超时信号合并，避免两者竞争覆盖同一个 ctrl.abort
    const ctrl = signal ? new AbortController() : undefined;
    if (signal && ctrl) signal.addEventListener('abort', () => ctrl.abort());
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
          ...(ctrl ? { signal: ctrl.signal } : {}),
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
      // 走查 M-2：文案统一改调 streamTruncatedError（与流式/claude/ollama 一套口径）
      // 走查 M-3：content_filter（安全策略切断）与截断同类，半截内容同样不作完整结果
      if (choice?.finish_reason === 'length') {
        return { ok: false, error: streamTruncatedError(content.length) };
      }
      if (choice?.finish_reason === 'content_filter') {
        return { ok: false, error: outputStoppedError('finish_reason=content_filter', content.length) };
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
      // T00838：外部主动中止（用户点「停止」）归因到「任务已停止」，而非笼统的连接错误
      if (signal?.aborted) return { ok: false, error: '任务已停止' };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 流式通用单轮对话：stream:true，逐块取 choices[0].delta.content 增量回调，供 AI 周报 SSE 实时输出 */
  async chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void, signal?: AbortSignal): Promise<StreamResult> {
    const ctrl = new AbortController();
    // 流式期间同样受超时约束：超时则中断流，避免长耗时任务无限挂起
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000);
    // T00838：外部取消信号（用户点「停止」）同样 abort 底层流请求，与超时共用 ctrl
    if (signal) signal.addEventListener('abort', () => ctrl.abort());
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
      let finish = '';
      await readStreamLines(res, (line) => {
        const trimmed = line.trim();
        // OpenAI 兼容以 data: 前缀承载事件；跳过注释/id 等无内容行
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; error?: { message?: string } };
          if (json.error?.message) throw new Error(json.error.message);
          // T00779：记录最后一个 finish_reason——触顶截断（length）时流里已有大量内容，
          // 若只看 text 非空会误判成功，导致半截结果被上层当完整结果入库
          const fr = json.choices?.[0]?.finish_reason;
          if (typeof fr === 'string' && fr) finish = fr;
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
      // T00779：触顶截断仍按失败处理（防半截结果入库）；T00814 起额外携带 partial，
      // 供"用户会逐条复核"的长文场景（当前仅 PRD 生成）选择性采纳
      if (finish === 'length') return { ok: false, error: streamTruncatedError(text.length), partial: text };
      if (finish === 'content_filter') return { ok: false, error: outputStoppedError('finish_reason=content_filter', text.length), partial: text }; // 走查 M-3
      return { ok: true, content: text };
    } catch (e) {
      // T00838：区分「外部主动停止」与「超时」——stop 场景不再误报为连接超时
      if (signal?.aborted) return { ok: false, error: '任务已停止' };
      if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: `连接超时（超过 ${config.timeoutMs ?? 60000}ms）` };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
