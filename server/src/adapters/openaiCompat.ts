import type { AIAdapter, TaskContext, ToolConfig, JobResult, AdapterType, ModelsResult, StreamResult, TokenUsage } from './types';
import { withTimeout, formatHttpError, normalizeModels, readStreamLines, TIMEOUT_CODE, extractVendorError, statusHint } from './netutil';
import { streamTruncatedError, outputStoppedError, describeError } from './types'; // T00779：流式截断统一错误文案

interface ChatCompletionResp {
  choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  /** T01289：协议原生为 snake_case，在 readUsage 内归一为 camelCase 后向上暴露 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/** 流式行收集器的累积态：文本与最后一个 finish_reason */
interface StreamAcc {
  text: string;
  finish: string;
}

/**
 * T01289：把 OpenAI 兼容响应里的 usage 归一为 TokenUsage。
 * 三项缺一（或为负数/非数字）即视为「未提供」返回 undefined——宁可无计量，
 * 也不能用半截数据污染预算护栏的累计值（错值会直接导致多拦或少拦）。
 */
function readUsage(u: ChatCompletionResp['usage']): TokenUsage | undefined {
  if (!u) return undefined;
  const p = u.prompt_tokens;
  const c = u.completion_tokens;
  const t = u.total_tokens;
  if (typeof p !== 'number' || typeof c !== 'number' || typeof t !== 'number') return undefined;
  if (p < 0 || c < 0 || t < 0) return undefined;
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

/**
 * M6-6.1：非流式 HTTP 失败体换算（原 chat() 内联分支）。
 * T02207：改为吃「错误体原文」而非已解析对象——厂商形状不统一（`{code,message}`/纯文本/HTML），
 * 原先只认 `data.error?.message`，硅基流动 402 只剩裸 `HTTP 402`；现在原文与状态码同时可见，
 * 并对 402/401/403 追加定向提示（404 的既有排障文案保持不变）。
 */
function httpFailure(status: number, errText: string): JobResult {
  const detail = extractVendorError(errText);
  const base = detail
    ? status === 200 ? detail : `${detail}（HTTP ${status}）`
    : `HTTP ${status}`;
  const hint = status === 404
    ? '404 多为 Base URL 路径不对：请检查是否重复/缺失版本段（自带版本者如智谱应填 https://open.bigmodel.cn/api/paas/v4，不要再补 /v1）'
    : statusHint(status);
  return { ok: false, error: hint ? `${base} — ${hint}` : base };
}

/**
 * M6-6.1：把「请求成功但输出不完整」的三种情形归一为失败（原 chat() 内联判定链）。
 * 返回 null 表示正文可用、交由调用方走成功分支。
 *
 * 顺序不可调换：触顶时 content 可能为空串，必须先判 finish_reason 再判空。
 */
type ChatChoice = NonNullable<ChatCompletionResp['choices']>[number];

function stoppedFailure(choice: ChatChoice | undefined, content: string): JobResult | null {
  // content_filter（安全策略切断）与截断同类，半截内容同样不作完整结果（走查 M-3）
  const reason = choice?.finish_reason;
  if (reason === 'length') return { ok: false, error: streamTruncatedError(content.length) };
  if (reason === 'content_filter') return { ok: false, error: outputStoppedError('finish_reason=content_filter', content.length) };
  if (content) return null;
  // T00721：思考型模型（如 agnes-2.5-flash）可能把输出预算全部耗在 reasoning_content（思考）上，
  // 正文为空（实测 20~44s 长耗时 + 0 字符）。给出可操作提示而非笼统的「AI 返回内容为空」
  const reasoning = choice?.message?.reasoning_content;
  if (reasoning) {
    return { ok: false, error: `模型仅输出了思考过程（reasoning ${reasoning.length} 字符），正文为空——多为思考耗尽输出上限所致，请调大该工具的 max_tokens 或更换非思考型模型后重试` };
  }
  return { ok: false, error: 'AI 返回内容为空' };
}

/** M6-6.1：流式结束后的成败裁决（截断/安全策略均带 partial，供长文场景选择性采纳） */
function streamVerdict(text: string, finish: string): StreamResult | null {
  if (finish === 'length') return { ok: false, error: streamTruncatedError(text.length), partial: text };
  if (finish === 'content_filter') return { ok: false, error: outputStoppedError('finish_reason=content_filter', text.length), partial: text };
  return null;
}

/**
 * M6-6.1：流式 SSE 行的累积器（原 chatStream 的内联回调）。
 * 只解析 `data:` 有效载荷，非 JSON / 错误校验行静默跳过——交由流结束后的整体裁决处理。
 */
function openaiLineCollector(onDelta: (text: string) => void): { acc: StreamAcc; collect: (line: string) => void } {
  const acc: StreamAcc = { text: '', finish: '' };
  const collect = (line: string): void => {
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
      if (typeof fr === 'string' && fr) acc.finish = fr;
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        acc.text += delta;
        onDelta(delta);
      }
    } catch {
      // 忽略协议偶发的非 JSON / 错误校验行，交由完整流结束后判断
    }
  };
  return { acc, collect };
}

/**
 * M6-6.1：非流式异常归因（原 chat() catch 分支）。
 * 优先级：外部主动中止（用户点「停止」） > 超时标记（T01289：上层据此不再重试） > 原样透传。
 */
function failureFromError(e: unknown, signal?: AbortSignal): JobResult {
  if (signal?.aborted) return { ok: false, error: '任务已停止' };
  if (e instanceof Error && (e as Error & { code?: string }).code === TIMEOUT_CODE) {
    return { ok: false, error: e.message, timedOut: true };
  }
  return { ok: false, error: describeError(e) };
}

/**
 * OpenAI 兼容协议适配器：OpenAI、DeepSeek、通义、本地 vLLM 等 /chat/completions 端点。
 * 系统提示固定要求输出可合并的开发文本；结果仅回传文本，不写入任何文件（FR4.4「保存文本待人工合并」）。
 */
export class OpenAICompatAdapter implements AIAdapter {
  readonly type = 'openai-compatible' as AdapterType;

  private baseUrl(endpoint: string): string {
    const e = endpoint.replace(/\/+$/, '');
    // T01346：只在 URL **本身没有版本路径段**时才补 /v1（兼容「填根域名」与「填到 /v1」两种习惯）。
    // 旧实现「不以 /v1 结尾就补 /v1」会把自带版本号的厂商拼坏：
    // 智谱 https://open.bigmodel.cn/api/paas/v4 → .../api/paas/v4/v1/chat/completions → 上游 404；
    // 同理 /api/v1、/v2、/v1beta 等网关也会被多补一段。
    if (/\/v\d[\w.-]*$/i.test(e)) return e;
    return `${e}/v1`;
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

      // T02207：先取文本再试解析。原先直接 `res.json()`，厂商返回非 JSON 错误体（网关 HTML/纯文本）时
      // 抛的解析异常会顶替真实原因，错误文案与厂商原文完全无关；正文也只剩一次读取通道可用。
      const text = await res.text().catch(() => '');
      let data: ChatCompletionResp | null = null;
      try {
        data = text ? JSON.parse(text) as ChatCompletionResp : null;
      } catch {
        data = null;
      }
      if (!res.ok || data?.error) return httpFailure(res.status, text);
      const choice = data?.choices?.[0];
      const content = choice?.message?.content ?? '';
      // T00714（D-6 修复）：截断/风控/空正文一律显式报错，不再把残缺输出静默交给上层做 JSON 解析
      // （曾表现为「AI 未返回有效的 PRD 解析结果」误导排障）；记 ok=false 进 ai_usage。
      const stopped = stoppedFailure(choice, content);
      if (stopped) return stopped;
      // T01289：成功时带出 token 用量（服务商未回传则缺省），供监督器成本预算护栏累加
      return { ok: true, content, usage: readUsage(data?.usage) };
    } catch (e) {
      return failureFromError(e, signal);
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
      const { acc, collect } = openaiLineCollector(onDelta);
      await readStreamLines(res, collect);
      const { text, finish } = acc;
      if (!text) return { ok: false, error: 'AI 返回内容为空' };
      // T00779：触顶截断仍按失败处理（防半截结果入库）；T00814 起额外携带 partial，
      // 供"用户会逐条复核"的长文场景（当前仅 PRD 生成）选择性采纳
      const stopped = streamVerdict(text, finish);
      return stopped ?? { ok: true, content: text };
    } catch (e) {
      // T00838：区分「外部主动停止」与「超时」——stop 场景不再误报为连接超时
      if (signal?.aborted) return { ok: false, error: '任务已停止' };
      if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: `连接超时（超过 ${config.timeoutMs ?? 60000}ms）` };
      return { ok: false, error: describeError(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
