/**
 * 适配器共享工具：超时控制、HTTP 错误解析、模型列表归一化。
 * 参考 19_Karpathy 项目 ai.ts 的 normalizeModels / formatHttpError 实现。
 */

/** 超时控制：Node 22 全局 fetch 与超时 Promise 竞速 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`连接超时（超过 ${ms}ms），请检查 Endpoint 或网络`)), ms)),
  ]);
}

/** 解析厂商 HTTP 错误响应：优先提取 OpenAI 兼容协议的 error.message（error 为对象或字符串两种形态） */
export function formatHttpError(status: number, errText: string): string {
  let detail = `API 返回 ${status}`;
  try {
    const errJson = JSON.parse(errText) as { error?: { message?: string } | string };
    const msg = typeof errJson.error === 'string' ? errJson.error : errJson.error?.message;
    if (msg) detail += `: ${msg}`;
  } catch {
    if (errText) detail += `: ${errText.slice(0, 200)}`;
  }
  return detail;
}

/** 归一化服务商返回的模型列表为统一的 string[]。
 *
 * 兼容两种主流形态：
 *   - OpenAI 兼容 / Anthropic：{ data: [{ id: 'gpt-4o' }] }
 *   - Ollama 原生：{ models: [{ name: 'qwen2.5:7b' }] }
 * 未知形态或空列表返回 []，调用方据此提示"不支持模型列表接口"。
 */
export function normalizeModels(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;

  const pick = (list: unknown[]): string[] =>
    list
      .map((m) => {
        if (typeof m === 'string') return m;
        const rec = m as Record<string, unknown> | null;
        const v = rec?.id ?? rec?.name;
        return typeof v === 'string' ? v : undefined;
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (Array.isArray(obj.data)) return pick(obj.data);
  if (Array.isArray(obj.models)) return pick(obj.models);
  return [];
}

/**
 * 逐行读取 HTTP 响应流：将 response body 按行回调（按 \n 切分，去除行尾 \r）。
 * OpenAI 兼容（data: 行）、Claude（data: 行）与 Ollama（纯 JSON 行）的流式响应均可复用。
 * 超时/中断由调用方用 AbortController 控制，此处不做额外竞速。
 */
export async function readStreamLines(res: Response, onLine: (line: string) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  }
  if (buf) onLine(buf);
}
