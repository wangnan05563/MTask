/**
 * 适配器共享工具：超时控制、HTTP 错误解析、模型列表归一化。
 * 参考 19_Karpathy 项目 ai.ts 的 normalizeModels / formatHttpError 实现。
 */

/**
 * T01289：超时错误的机器可读标记。上层据此把「超时」与其它网络失败区分开——
 * 超时属于链路级失败，重试往往只是把等待时间翻倍（监督决策要求「超时即降级」，见 NFR-1）。
 */
export const TIMEOUT_CODE = 'ETIMEDOUT';

/** 超时控制：Node 22 全局 fetch 与超时 Promise 竞速 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => {
      const err = new Error(`连接超时（超过 ${ms}ms），请检查 Endpoint 或网络`) as Error & { code?: string };
      err.code = TIMEOUT_CODE;
      rej(err);
    }, ms);
  });
  // 竞速结束即清掉定时器：原实现让每次调用都残留一个最长 60s 的待触发定时器，
  // 长会话下持续累积，还会拖住进程退出（脚本/测试尤为明显）
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
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
  // T01346：404 多为 Base URL 路径不对（多/少版本段），补一句可操作提示
  if (status === 404) detail += '（404 多为 Base URL 路径不对：请检查是否重复/缺失版本段）';
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
