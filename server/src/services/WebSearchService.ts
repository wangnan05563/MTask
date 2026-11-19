/**
 * T06076：队列任务的轻量联网检索。
 *
 * 为什么放在服务端而不是适配器：队列工具有多家（OpenAI 兼容 / Claude / Ollama / CLI 等），
 * 逐个适配器加搜索会重复且难维护。这里先取公开网页摘要，再作为 TaskContext.webContext
 * 注入统一提示词，所有适配器都能用，且回执里能保留来源链接。
 *
 * 供应商选择：Bing RSS 优先（结构稳定、无需 Key），DuckDuckGo HTML 兜底。
 * 只读取公开搜索结果，不登录、不抓取需要授权的页面。
 */
import { getSetting } from './AppSettings';

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  provider: 'bing' | 'duckduckgo';
  items: WebSearchItem[];
  error?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 5;
const cache = new Map<string, { at: number; value: WebSearchResult }>();

/** 只在有时效性诉求的任务上自动检索，避免所有队列任务都多等一次网络请求 */
const AUTO_TRIGGER = /最新|实时|今日|近期|本周|本月|新闻|资讯|政策|法规|行情|价格|发布|上线|版本|截至|目前|最近|检索|搜索|来源|引用/;

export type WebSearchMode = 'off' | 'auto' | 'always';

export function webSearchMode(): WebSearchMode {
  const raw = (getSetting('queue.webSearch') || 'auto').trim();
  return raw === 'off' || raw === 'always' ? raw : 'auto';
}

export function shouldSearchQueueTask(title: string, description: string): boolean {
  const mode = webSearchMode();
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return AUTO_TRIGGER.test(`${title}\n${description}`);
}

/**
 * 把任务标题 + 描述压成一条适合搜索的短查询。
 * 长描述直接塞给搜索引擎会稀释关键词，这里只保留前 140 字并去掉换行/列表符号。
 */
export function buildSearchQuery(title: string, description: string): string {
  const cleanTitle = title
    .replace(/^[【\[]?T\d{5}[】\]]?/i, '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanDesc = description
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const query = `${cleanTitle}${cleanDesc ? ` ${cleanDesc.slice(0, 140)}` : ''}`.trim();
  return query.slice(0, 220);
}

function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(decodeEntities(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs = 10000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchBing(query: string): Promise<WebSearchItem[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-Hans`;
  const xml = await fetchText(url);
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, MAX_ITEMS);
  const items: WebSearchItem[] = [];
  for (const block of blocks) {
    const body = block[1];
    const title = stripHtml((body.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '');
    const link = safeUrl((body.match(/<link>([\s\S]*?)<\/link>/i) ?? [])[1] ?? '');
    const snippet = stripHtml((body.match(/<description>([\s\S]*?)<\/description>/i) ?? [])[1] ?? '');
    if (title && link && !/bing\.com\/search/i.test(link)) items.push({ title, url: link, snippet });
  }
  return items;
}

async function searchDuckDuckGo(query: string): Promise<WebSearchItem[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  const links = [...html.matchAll(/result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/result__snippet[^>]*>([\s\S]*?)<\/a>/gi)];
  const items: WebSearchItem[] = [];
  for (let i = 0; i < links.length && items.length < MAX_ITEMS; i++) {
    const raw = links[i][1];
    // DDG 外链是 /l/?uddg=<encoded>，需要解出真实目标
    let href = raw;
    try {
      const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) href = uddg;
    } catch { /* 保持原值，交给 safeUrl 校验 */ }
    const link = safeUrl(href.replace(/&amp;/g, '&'));
    const title = stripHtml(links[i][2]);
    const snippet = stripHtml(snippets[i]?.[1] ?? '');
    if (title && link && !/duckduckgo\.com/i.test(link)) items.push({ title, url: link, snippet });
  }
  return items;
}

/** 查询并归一化搜索结果；任一供应商失败自动切换，全部失败返回空 + error（不阻断队列发送） */
export async function searchWeb(query: string): Promise<WebSearchResult> {
  const q = query.trim();
  const cached = cache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let provider: 'bing' | 'duckduckgo' = 'bing';
  let items: WebSearchItem[] = [];
  let error = '';
  try {
    items = await searchBing(q);
  } catch (e) {
    error = `Bing：${e instanceof Error ? e.message : String(e)}`;
  }
  if (items.length === 0) {
    provider = 'duckduckgo';
    try {
      items = await searchDuckDuckGo(q);
      if (items.length > 0) error = '';
    } catch (e) {
      const ddgError = e instanceof Error ? e.message : String(e);
      error = error ? `${error}；DuckDuckGo：${ddgError}` : `DuckDuckGo：${ddgError}`;
    }
  }
  const value: WebSearchResult = { query: q, provider, items, error: error || undefined };
  cache.set(q, { at: Date.now(), value });
  return value;
}

/**
 * 生成注入提示词的检索上下文。返回空串表示本次不需要检索/没有结果，
 * 调用方不因此失败；有结果时要求模型保留来源链接，便于质量门核验。
 */
export async function buildQueueWebContext(title: string, description: string): Promise<string> {
  if (!shouldSearchQueueTask(title, description)) return '';
  const query = buildSearchQuery(title, description);
  if (!query) return '';
  const result = await searchWeb(query);
  if (result.items.length === 0) return '';
  const lines = result.items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet || '（无摘要）'}`);
  return [
    `检索词：${result.query}（来源：${result.provider === 'bing' ? 'Bing' : 'DuckDuckGo'} 公开搜索）`,
    '以下是自动检索到的公开网页摘要，可能不完整或已过期；如引用其中信息，回执中必须保留对应链接，不得编造来源。',
    '',
    ...lines,
  ].join('\n');
}
