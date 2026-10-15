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

/**
 * T02207：厂商 HTTP 错误体的原文抽取。
 * 各家形状并不统一：OpenAI 兼容 `{error:{message}}`（`error` 也可能是字符串）、
 * 硅基流动等国内网关 `{code,message}` / `{msg}` / `{error_message}`，网关拦截干脆是 HTML/纯文本。
 * 只认 OpenAI 形状会让 402「账户门禁」退化成裸状态码，用户无从判断是计费还是请求问题（T02197 实测）。
 * 抽不到具名信息时回退原始文本前 200 字符——「厂商原文 + 状态码同时可见」是本函数的底线口径。
 */
export function extractVendorError(errText: string): string {
  if (!errText) return '';
  try {
    const j = JSON.parse(errText) as Record<string, unknown>;
    const pick = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const err = j.error as Record<string, unknown> | string | undefined;
    const msg = pick(err)
      || (err && typeof err === 'object' ? pick(err.message) || pick(err.type) : '')
      || pick(j.message) || pick(j.msg) || pick(j.error_message) || pick(j.detail);
    if (msg) {
      const code = typeof j.code === 'string' || typeof j.code === 'number' ? `（code ${j.code}）` : '';
      return msg + code;
    }
  } catch { /* 非 JSON：落到原始文本 */ }
  return errText.slice(0, 200);
}

/**
 * T02207：状态码定向提示——只给「用户自己就能核对」的方向，不替厂商下结论。
 * 402 是计费/余额门禁（请求本身没问题，重试无意义）；401/403 高发原因是密钥与 Endpoint 厂商不匹配。
 * 404 的排障文案由调用方各自维持（措辞已成形，不在此重排），429 保留厂商原文不加戏。
 */
export function statusHint(status: number): string {
  if (status === 402) return '402 为厂商侧计费/余额门禁（请求本身无误，重试无效）：请到厂商控制台确认额度或充值后重试';
  if (status === 401 || status === 403) return '401/403 多为密钥与该 Endpoint 的厂商不匹配：OpenRouter 须 sk-or-v1- 前缀、Groq 须 gsk_ 前缀，另核对是否漏填/重复 Bearer 前缀';
  return '';
}

/** 解析厂商 HTTP 错误响应：优先提取错误体原文（多形状兼容），并附状态码定向提示 */
export function formatHttpError(status: number, errText: string): string {
  const detail = extractVendorError(errText);
  let out = detail ? `API 返回 ${status}: ${detail}` : `API 返回 ${status}`;
  // T01346：404 多为 Base URL 路径不对（多/少版本段），补一句可操作提示
  if (status === 404) out += '（404 多为 Base URL 路径不对：请检查是否重复/缺失版本段）';
  else {
    const hint = statusHint(status);
    if (hint) out += `（${hint}）`;
  }
  return out;
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
 * T02208：「连接测试」成功文案的统一口径。
 * 这条通道只做目录型探测（GET /models、GET /api/tags、中继 ping），而各厂商该接口的
 * 鉴权/计费门禁并不统一——实测：OpenRouter 行填 Groq 密钥仍「连接成功」（/models 近乎公开目录）、
 * 硅基流动欠费 402 时 /models 依旧 200（不受余额门禁约束）。
 * 因此文案只声明它真正证明过的东西（网关可达 + 目录可读），不写「连接成功」这种
 * 会被读成「可以调用」的字样，并把能否实调显式指向「实调探测」。
 */
export function probeOkMessage(scope: string, extra = ''): string {
  return `${scope}${extra}——仅代表服务可达与目录可读，不代表该模型可调用；请用「实调探测」确认`;
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
