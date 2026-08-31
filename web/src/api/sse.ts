/**
 * SSE 流式事件消费模块：供 AI 周报联动控制台实时读取后端推送的 stage / chunk / done / error 事件。
 * 与 client.ts 独立，避免在统一请求封装里混入流式语义；apiBase 与访问令牌规则保持一致。
 */

// Electron 壳（file:// 页面）走 api:// 自定义协议；浏览器访问用同源相对路径
const apiBase =
  typeof location !== 'undefined' && !/^https?:$/.test(location.protocol) ? 'api://mtask' : '/api';

// 访问令牌与 client.ts 对齐：启用内网穿透后需携带 X-Access-Token。
// 用函数读取而非模块加载时缓存一次，使 setAccessToken 变更后本模块也能拿到最新值。
const TOKEN_KEY = 'mtask.accessToken';
const getAccessToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
};

/** 解析单个 SSE 事件块：event: 行取事件名（缺省 message），data: 行拼接为负载 */
function parseSseBlock(block: string): { event: string; dataStr: string } {
  let event = 'message';
  let dataStr = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  return { event, dataStr };
}

/** 分发单个事件块：无负载的块（如心跳注释）直接跳过；坏 JSON 不应中断整条流 */
function dispatchSseBlock(block: string, onEvent: (name: string, payload: unknown) => void): void {
  const { event, dataStr } = parseSseBlock(block);
  if (!dataStr) return;
  try { onEvent(event, JSON.parse(dataStr)); } catch { /* 忽略非 JSON 事件体 */ }
}

/** 按空行切出完整事件块并逐块分发；返回未闭合的尾巴供下次继续拼接 */
function dispatchCompleteBlocks(buf: string, onEvent: (name: string, payload: unknown) => void): string {
  const parts = buf.split('\n\n');
  const tail = parts.pop() ?? '';
  for (const block of parts) dispatchSseBlock(block, onEvent);
  return tail;
}

/** 读取整个响应流，边读边解析 SSE 事件并分发 */
async function readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  onEvent: (name: string, payload: unknown) => void,
): Promise<void> {
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 以空行分隔事件块，流可能一次返回多条，按 \n\n 分块并保留未闭合尾巴
    buf = dispatchCompleteBlocks(buf, onEvent);
  }
}

/**
 * 建立流式 POST 请求并按 SSE 事件分发给 onEvent(eventName, payload)。
 * 承诺：读取完整个流后 resolve；HTTP 错误时 reject 并携带后端 error 文案。
 */
export async function streamEvents(
  path: string,
  data: unknown,
  onEvent: (name: string, payload: unknown) => void,
): Promise<void> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(getAccessToken() ? { 'X-Access-Token': getAccessToken() } : {}) },
    body: JSON.stringify(data ?? {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (!res.body) return;
  await readStream(res.body.getReader(), new TextDecoder('utf-8'), onEvent);
}