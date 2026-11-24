/**
 * T06076 / T06090：队列任务的轻量联网检索与结果质量治理。
 *
 * 供应商：Bing RSS 优先（无需 Key）、DuckDuckGo HTML 兜底。
 * T06090 起不再把原始搜索结果直接注入提示词：
 * - 域名黑/白名单、广告/垃圾标题过滤；
 * - 与任务关键词的相关性打分，低于阈值丢弃；
 * - 无可用来源时注入「未获取到可用来源」的强约束，禁止模型编造新闻/链接；
 * - 权威源、关键词、日期与来源链接写入上下文，便于质量门核验。
 *
 * 只读取公开搜索结果，不登录、不抓取需要授权的页面。
 */
import { getSetting } from './AppSettings';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProxyAgent } from 'undici';

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  provider?: 'bing' | 'duckduckgo';
  /** 权威 RSS/官方来源名称（如 OpenAI News） */
  source?: string;
  score?: number;
}

export interface WebSearchResult {
  query: string;
  provider: 'bing' | 'duckduckgo';
  items: WebSearchItem[];
  error?: string;
  /** 过滤前条数（诊断用） */
  rawCount?: number;
  /** 被过滤掉的条数（诊断用） */
  droppedCount?: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 5;
const MAX_RAW_ITEMS = 12;
const cache = new Map<string, { at: number; value: WebSearchResult }>();

/** 默认权威源；可用 `queue.webSearchTrustedDomains` 或 `MTASK_WEBSEARCH_TRUSTED_DOMAINS` 覆盖 */
const DEFAULT_TRUSTED_DOMAINS = [
  'openai.com',
  'anthropic.com',
  'deepmind.google',
  'ai.meta.com',
  'github.blog',
  'github.com',
  'huggingface.co',
  'arxiv.org',
  'nature.com',
  'science.org',
  'technologyreview.com',
  'theverge.com',
  'techcrunch.com',
  'wired.com',
  'reuters.com',
  'bloomberg.com',
  'ft.com',
  'jiqizhixin.com',
  'qbitai.com',
  '36kr.com',
  'infoq.cn',
  'leiphone.com',
];

/** 默认垃圾/广告域名片段；可用 `queue.webSearchBlockedPatterns` 或 `MTASK_WEBSEARCH_BLOCKED` 覆盖 */
const DEFAULT_BLOCKED_PATTERNS = [
  'mrds',
  'daswang',
  '91u',
  'doubleclick',
  'googlesyndication',
  'taboola',
  'outbrain',
  'adservice',
  'casino',
  'betting',
  'lottery',
];

/** 权威 AI 新闻 RSS：优先于通用搜索，保证来源可核验 */
const AUTHORITATIVE_FEEDS = [
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
  { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
  { name: 'Google DeepMind Blog', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI' },
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
];

/** 明显的广告/竞赛/赌博/下载诱导标题与摘要，直接丢弃（不依赖域名） */
const SPAM_RE = /每日大赛|竞赛平台|比赛平台|赛事平台|注册(领|送|充值)|下载APP|博彩|赌场|彩票|真人视讯|棋牌|返利|招商代理|优惠充值|色情|成人内容/i;

/** 任务相关性关键词；命中越多分越高 */
const AI_TERMS = [
  'AI coding',
  'AI agent',
  'AI agents',
  '人工智能',
  '大模型',
  '具身智能',
  '机器人',
  '智能体',
  '多模态',
  '生成式',
  'OpenAI',
  'Anthropic',
  'DeepMind',
  'Gemini',
  'Claude',
  'GPT',
  'LLM',
  'NVIDIA',
  'arXiv',
  'Hugging Face',
];

const EN_MAP: Record<string, string> = {
  'AI coding': 'AI coding',
  'AI agent': 'AI agents',
  'AI agents': 'AI agents',
  人工智能: 'artificial intelligence',
  大模型: 'large language model',
  具身智能: 'embodied intelligence',
  机器人: 'robotics',
  智能体: 'AI agents',
  多模态: 'multimodal',
  生成式: 'generative AI',
  OpenAI: 'OpenAI',
  Anthropic: 'Anthropic',
  DeepMind: 'DeepMind',
  Gemini: 'Gemini',
  Claude: 'Claude',
  GPT: 'GPT',
  LLM: 'LLM',
  NVIDIA: 'NVIDIA',
  arXiv: 'arXiv',
  'Hugging Face': 'Hugging Face',
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have',
  'will', 'would', 'can', 'could', 'should', 'about', 'into', 'over', 'under', 'than',
  '每日', '新闻', '推送', '今日', '资讯', '动态', '任务', '关注', '筛选', '简要', '说明',
  '事件', '内容', '原因', '尽量', '不要', '重复', '之前', '结合', '方向', '领域', '重要',
]);

/** 只在有时效性诉求的任务上自动检索，避免所有队列任务都多等一次网络请求 */
const AUTO_TRIGGER = /最新|实时|今日|近期|本周|本月|新闻|资讯|政策|法规|行情|价格|发布|上线|版本|截至|目前|最近|检索|搜索|来源|引用/;

export type WebSearchMode = 'off' | 'auto' | 'always';

function readSetting(key: string): string | null {
  try {
    return getSetting(key);
  } catch {
    // 只读检索服务不应因设置库未初始化/被锁而整体失败
    return null;
  }
}

export function webSearchMode(): WebSearchMode {
  const raw = (readSetting('queue.webSearch') || 'auto').trim();
  return raw === 'off' || raw === 'always' ? raw : 'auto';
}

export function shouldSearchQueueTask(title: string, description: string): boolean {
  const mode = webSearchMode();
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return AUTO_TRIGGER.test(`${title}\n${description}`);
}

function splitList(raw: string | null | undefined): string[] {
  return (raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
    .filter(Boolean);
}

export function trustedDomains(): string[] {
  const env = process.env.MTASK_WEBSEARCH_TRUSTED_DOMAINS;
  const setting = readSetting('queue.webSearchTrustedDomains');
  const list = splitList(env || setting);
  return list.length ? list : DEFAULT_TRUSTED_DOMAINS;
}

export function blockedPatterns(): string[] {
  const env = process.env.MTASK_WEBSEARCH_BLOCKED;
  const setting = readSetting('queue.webSearchBlockedPatterns');
  const list = splitList(env || setting);
  return list.length ? list : DEFAULT_BLOCKED_PATTERNS;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.replace(/^www\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

function isTrustedHost(host: string, domains: string[]): boolean {
  return domains.some((d) => matchesDomain(host, d));
}

function isBlockedHost(host: string, patterns: string[]): boolean {
  return patterns.some((p) => p && host.includes(p));
}

/** 短词用词边界，避免 AI 命中 daily/email 等；中文长词直接包含 */
function matchesTerm(text: string, term: string): boolean {
  if (term.length <= 3 && /^[a-z0-9]+$/i.test(term)) {
    return new RegExp(`\\b${term}\\b`, 'i').test(text);
  }
  return text.includes(term);
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

/** 外部网页文本进入提示词前去掉可能在数据段落里伪造边界的标签和控制字符 */
function sanitizePromptText(input: string): string {
  return input
    .replace(/<\/?untrusted_search_results>/gi, '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
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

function extractDateToken(input: string): string {
  const m = input.match(/20\d{2}\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return '';
  return `20${m[0].slice(2, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** T06060：把“最近三天/最近 3 天”转成检索窗口，不能一律按 7 天新闻处理 */
function parseRecentDays(input: string): number | undefined {
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = input.match(/最近\s*([一二三四五六七八九十]|\d{1,2})\s*天/);
  if (!m) return undefined;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : cn[raw];
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从任务标题/描述提取相关关键词。优先 AI 领域词，其次英文实体词；
 * 不把整段中文描述切碎塞进 query，避免稀释搜索意图。
 */
export function buildRelevanceTerms(title: string, description: string): string[] {
  const text = `${title}\n${description}`;
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const term of AI_TERMS) {
    if (term === 'AI') continue;
    if (lower.includes(term.toLowerCase())) terms.add(term);
  }
  const en = text.match(/[A-Za-z][A-Za-z0-9.+-]{2,}/g) || [];
  for (const word of en) {
    const w = word.toLowerCase();
    if (w.length < 3 || STOP_WORDS.has(w) || w.includes('.')) continue;
    // 已有组合词时不再重复添加其中的泛词，避免 query 被 coding / agent 稀释
    if (terms.has('AI coding') && w === 'coding') continue;
    if (terms.has('AI agents') && (w === 'agent' || w === 'agents')) continue;
    if (w === 'ai' && terms.size > 0) continue;
    if (terms.size >= 12) break;
    terms.add(word);
  }
  if (/\bAI\b/.test(text)) terms.add('AI');
  return [...terms].slice(0, 12);
}

/**
 * 把任务压成一条短查询：关键词 + （新闻类）新闻 + 日期。
 * 不再把描述前 140 字直接拼进 query。
 */
export function buildSearchQuery(title: string, description: string): string {
  const taskText = `${title}\n${description}`;
  const cleanTitle = title
    .replace(/^[【[]?T\d{5}[】\]]?/i, '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = extractDateToken(taskText);
  const terms = buildRelevanceTerms(title, description);
  const isNews = /新闻|资讯|动态|日报|周报|早报|晚报|简报/.test(taskText);
  // T06060：GitHub 冒头/增速/新项目类任务，直接查 trending/new projects/releases，
  // 不再退化成“GitHub star 新闻”这种会被 star 总量榜单淹没的查询。
  const githubHot = /GitHub/i.test(taskText) && /冒头|新项目|star|star 数|趋势|trending|增速/i.test(taskText);
  const techHot = /技术热点|技术栈|版本发布|重大特性|开源事件|release/i.test(taskText);
  // 「AI」是泛词，已有 AI coding / 具身智能等具体词时不再单列，避免稀释 query
  const specific = terms.filter((t) => t !== 'AI');
  let core = specific.length ? specific.slice(0, 6).join(' ') : (terms.includes('AI') ? 'AI' : '');
  if (githubHot) {
    core = 'GitHub 热门项目 新项目 版本发布 开源';
  } else if (techHot) {
    core = '技术热点 版本发布 开源';
  } else if (!specific.length && isNews) {
    // T06058 这类“今日资讯阅读”没有领域词：用 AI 行业资讯兜底，
    // 不能把“今日资讯阅读（日期）”本身当查询词。
    core = 'AI 行业资讯';
  }
  if (!core) core = cleanTitle;
  const suffix = isNews ? ' 新闻' : '';
  const query = `${core}${suffix}${date ? ` ${date}` : ''}`.trim();
  return query.slice(0, 180);
}

/** 英文检索查询：给 Bing/DDG 一个不被中文泛结果淹没的入口 */
export function buildEnglishQuery(title: string, description: string): string {
  const taskText = `${title}\n${description}`;
  const githubHot = /GitHub/i.test(taskText) && /冒头|新项目|star|star 数|趋势|trending|增速/i.test(taskText);
  const techHot = /技术热点|技术栈|版本发布|重大特性|开源事件|release/i.test(taskText);
  if (githubHot) {
    const date = extractDateToken(taskText);
    return `GitHub trending repositories new projects releases open source news${date ? ` ${date}` : ''}`.trim().slice(0, 180);
  }
  if (techHot) {
    const date = extractDateToken(taskText);
    return `technology news releases open source${date ? ` ${date}` : ''}`.trim().slice(0, 180);
  }
  const terms = buildRelevanceTerms(title, description)
    .map((t) => EN_MAP[t] || (/^[A-Za-z]/.test(t) && t.length >= 3 ? t : ''))
    .filter(Boolean);
  const date = extractDateToken(taskText);
  const core = terms.slice(0, 5).join(' ') || 'AI';
  return `${core} news${date ? ` ${date}` : ''}`.trim().slice(0, 180);
}

let cachedProxyUrl: string | undefined;
let proxyDispatcher: ProxyAgent | null = null;
const execFileAsync = promisify(execFile);

/** 读取本机代理：设置项 > 环境变量 > Windows 系统代理；GitHub 在部分网络下只能经代理访问 */
async function webProxyUrl(): Promise<string> {
  if (cachedProxyUrl !== undefined) return cachedProxyUrl;
  const configured = (getSetting('queue.webSearchProxy') || '').trim();
  if (configured) return (cachedProxyUrl = configured);
  const env = (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  if (env) return (cachedProxyUrl = env);
  if (process.platform === 'win32') {
    try {
      const { stdout: out } = await execFileAsync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const raw = (out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1] ?? '').trim();
      if (raw) {
        const https = raw.match(/https=([^;]+)/i)?.[1];
        const value = (https || raw).replace(/^["']|["']$/g, '');
        return (cachedProxyUrl = /^http[s]?:\/\//i.test(value) ? value : `http://${value}`);
      }
    } catch { /* 读取失败则按直连处理 */ }
  }
  return (cachedProxyUrl = '');
}

async function fetchText(url: string, timeoutMs = 10000, viaProxy = false): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const proxy = viaProxy ? await webProxyUrl() : '';
    if (proxy && !proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      ...(proxy && proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function pickTag(body: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const m = body.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i'));
    if (m?.[1]) return m[1];
  }
  return '';
}

/** 解析 RSS 2.0 / Atom；只取标题、链接、摘要、发布时间 */
function parseFeedItems(xml: string, source: string): WebSearchItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, 24);
  const items: WebSearchItem[] = [];
  for (const block of blocks) {
    const body = block[2];
    const title = stripHtml(pickTag(body, ['title']));
    const rssLink = stripHtml(pickTag(body, ['link']));
    const atomLink = body.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i)?.[1] ?? '';
    const link = safeUrl(rssLink || atomLink);
    if (!title || !link) continue;
    const snippet = stripHtml(pickTag(body, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 500);
    const publishedAt = stripHtml(pickTag(body, ['pubDate', 'published', 'updated', 'dc:date']));
    items.push({
      title,
      url: link,
      snippet,
      source,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return items;
}

/** 拉取权威 RSS 并过滤；单个源失败不影响其他源 */
async function searchAuthoritativeFeeds(
  terms: string[],
  maxAgeDays: number,
  referenceDate: string,
): Promise<{ items: WebSearchItem[]; errors: string[] }> {
  const settled = await Promise.allSettled(
    AUTHORITATIVE_FEEDS.map(async (feed) => {
      const xml = await fetchText(feed.url, 8000);
      return parseFeedItems(xml, feed.name);
    }),
  );
  const items: WebSearchItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'rejected') {
      errors.push(`${AUTHORITATIVE_FEEDS[i].name}：${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
      continue;
    }
    items.push(...s.value);
  }
  const ranked = rankWebSearchItems(items, terms, referenceDate, { maxAgeDays, referenceDate });
  return { items: ranked.items, errors };
}

/**
 * T06060：GitHub 上「冒头」的项目看的是近期增速，不是总 star。
 * GitHub Trending 页面直接给出「stars this week」，比通用搜索更容易拿到真实新项目；
 * 解析失败/限流时静默返回空，不阻断队列发送。
 */
async function searchGithubTrending(maxItems = 3, windowDays = 0, errors?: string[]): Promise<WebSearchItem[]> {
  // GitHub 偶发 429/连接抖动；空结果不缓存，短暂退避后重试一次，
  // 避免「新项目」段因为一次抓取失败整段变成“本期无”。
  // 3 天窗口优先 daily；daily 无结果时第二次回落到 weekly，避免直接空段。
  const initialSince = windowDays > 0 && windowDays <= 3 ? 'daily' : 'weekly';
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const since = attempt === 0 ? initialSince : 'weekly';
    try {
      const html = await fetchText(`https://github.com/trending?since=${since}`, 12000, true);
      const articles = [...html.matchAll(/<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g)];
      const out: WebSearchItem[] = [];
      for (const article of articles) {
        const body = article[1];
        const hrefMatch = body.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"/]+)\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!hrefMatch) continue;
        const owner = hrefMatch[1];
        const repo = hrefMatch[2];
        if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) continue;
        const title = stripHtml(hrefMatch[3]).replace(/\s+/g, ' ').trim() || `${owner}/${repo}`;
        const descMatch = body.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        const desc = stripHtml(descMatch?.[1] ?? '');
        const stars = body.match(/([\d,]+)\s+stars (?:this week|today)/i)?.[1] ?? '';
        const periodLabel = since === 'daily' ? '今日' : '本周';
        const snippet = `${desc}${stars ? ` · ${periodLabel}新增 ${stars} stars` : ''}`.slice(0, 500);
        out.push({
          title,
          url: `https://github.com/${owner}/${repo}`,
          snippet,
          source: 'GitHub Trending',
          score: 90,
        });
        if (out.length >= maxItems) break;
      }
      if (out.length > 0) return out;
      lastError = `GitHub Trending（${since}）：未解析到条目（页面结构可能变化）`;
    } catch (e) {
      lastError = `GitHub Trending（${since}）：${e instanceof Error ? e.message : String(e)}`;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (lastError) errors?.push(lastError);
  return [];
}

async function searchBing(query: string): Promise<WebSearchItem[]> {
  // 中文查询用 zh-Hans，英文查询用 en-US；此前固定 zh-Hans 会让英文 query 也回中文泛结果
  const lang = /[\u4e00-\u9fa5]/.test(query) ? 'zh-Hans' : 'en-US';
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=${lang}`;
  const xml = await fetchText(url);
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, MAX_RAW_ITEMS);
  const items: WebSearchItem[] = [];
  for (const block of blocks) {
    const body = block[1];
    const title = stripHtml((body.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '');
    const link = safeUrl((body.match(/<link>([\s\S]*?)<\/link>/i) ?? [])[1] ?? '');
    const snippet = stripHtml((body.match(/<description>([\s\S]*?)<\/description>/i) ?? [])[1] ?? '');
    const pubDate = stripHtml((body.match(/<(pubDate|published)>([\s\S]*?)<\/\1>/i) ?? [])[2] ?? '');
    if (title && link && !/bing\.com\/search/i.test(link)) {
      items.push({ title, url: link, snippet, ...(pubDate ? { publishedAt: pubDate } : {}) });
    }
  }
  return items;
}

async function searchDuckDuckGo(query: string): Promise<WebSearchItem[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  const links = [...html.matchAll(/result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/result__snippet[^>]*>([\s\S]*?)<\/a>/gi)];
  const items: WebSearchItem[] = [];
  for (let i = 0; i < links.length && items.length < MAX_RAW_ITEMS; i++) {
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

export interface RankOptions {
  trustedDomains?: string[];
  blockedPatterns?: string[];
  /** 发布时间窗口（天）；0/缺省表示不做时间过滤 */
  maxAgeDays?: number;
  /** 时间窗口参照日（YYYY-MM-DD）；缺省用查询里的日期，再缺省用今天 */
  referenceDate?: string;
}

function publishedDateToken(raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  // Bing 中文 RSS 的 pubDate 形如「周四, 19 11月 2026 13:00:00 GMT」，Date.parse 不认
  const cn = raw.match(/(\d{1,2})\s+(\d{1,2})月\s+(20\d{2})/);
  if (cn) return `${cn[3]}-${cn[2].padStart(2, '0')}-${cn[1].padStart(2, '0')}`;
  return '';
}

/**
 * 过滤 + 打分：垃圾域名/广告标题直接丢弃；权威源加分；关键词命中加分；超出时间窗口丢弃。
 * 返回按分数倒序的前 5 条，并带 raw/dropped 计数供日志与诊断。
 */
export function rankWebSearchItems(
  items: WebSearchItem[],
  terms: string[],
  dateToken = '',
  options: RankOptions = {},
): { items: WebSearchItem[]; rawCount: number; droppedCount: number } {
  const trusted = options.trustedDomains ?? trustedDomains();
  const blocked = options.blockedPatterns ?? blockedPatterns();
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const rawCount = items.length;
  const maxAgeDays = options.maxAgeDays ?? 0;
  const reference = options.referenceDate || dateToken;
  const referenceMs = reference
    ? Date.parse(`${reference}T00:00:00Z`)
    : Date.now();
  const scored = items.map((it) => {
    const host = hostOf(it.url);
    const text = `${it.title} ${it.snippet}`.toLowerCase();
    const blockedItem = isBlockedHost(host, blocked) || SPAM_RE.test(text);
    const published = (it.publishedAt ? publishedDateToken(it.publishedAt) : '') || extractDateToken(`${it.title} ${it.snippet}`);
    let stale = false;
    if (maxAgeDays > 0 && published && Number.isFinite(referenceMs)) {
      const ageDays = (referenceMs - Date.parse(`${published}T00:00:00Z`)) / 86400000;
      // 晚于参照日 1 天以上也视为时间异常（避免未来日期）
      if (ageDays > maxAgeDays || ageDays < -1) stale = true;
    }
    let score = 0;
    let hits = 0;
    if (blockedItem || stale) score = -100;
    if (isTrustedHost(host, trusted)) score += 40;
    if (it.source) score += 6; // 官方 RSS 优先于同域名的通用搜索结果
    if (lowerTerms.length) {
      for (const t of lowerTerms) if (matchesTerm(text, t)) hits += 1;
      score += Math.min(hits * 8, 32);
    }
    const aiSignal = /\b(AI|LLM|GPT|Claude|Gemini|OpenAI|Anthropic|DeepMind|NVIDIA|robot|agent)\b/i.test(it.title);
    if (aiSignal) score += 8;
    // 权威域名本身不等于相关：有任务关键词时，零命中且无 AI 信号的权威页同样丢弃
    if (lowerTerms.length && hits === 0 && !aiSignal) score -= 30;
    if (dateToken && text.includes(dateToken)) score += 4;
    if (published) score += 3;
    if (/\/(news|blog|article|post|research|paper|press)/i.test(it.url)) score += 4;
    if (it.snippet.length >= 40) score += 2;
    if (it.title.length < 8) score -= 4;
    return { ...it, score, dropped: blockedItem || stale };
  });
  const threshold = lowerTerms.length ? 18 : 0;
  const kept = scored
    .filter((it) => !it.dropped && it.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS)
    .map(({ dropped: _dropped, ...it }) => it);
  return { items: kept, rawCount, droppedCount: rawCount - kept.length };
}

function dedupeKey(raw: string): string {
  try {
    const url = new URL(raw);
    // 同源去重只看 host/path/search；path 大小写在部分站点有语义，不能整体转小写。
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  }
}

function dedupeItems(items: WebSearchItem[]): WebSearchItem[] {
  const seen = new Set<string>();
  const out: WebSearchItem[] = [];
  for (const it of items) {
    const key = dedupeKey(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 查询并归一化搜索结果；任一供应商失败自动切换，全部失败返回空 + error（不阻断队列发送） */
export async function searchWeb(
  query: string,
  terms: string[] = [],
  maxAgeDays = 0,
  referenceDate = '',
  allowDdg = true,
): Promise<WebSearchResult> {
  const q = query.trim();
  const cacheKey = `${q}|${terms.join(',')}|${maxAgeDays}|${referenceDate}|${allowDdg ? 'ddg' : 'bing'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const dateToken = extractDateToken(q) || referenceDate;
  const rankOptions = { maxAgeDays, referenceDate: referenceDate || dateToken };
  let provider: 'bing' | 'duckduckgo' = 'bing';
  let items: WebSearchItem[] = [];
  let rawCount = 0;
  let droppedCount = 0;
  let error = '';

  try {
    const raw = await searchBing(q);
    rawCount = raw.length;
    const ranked = rankWebSearchItems(raw, terms, dateToken, rankOptions);
    items = ranked.items;
    droppedCount = ranked.droppedCount;
  } catch (e) {
    error = `Bing：${e instanceof Error ? e.message : String(e)}`;
  }
  if (items.length === 0 && allowDdg && rawCount === 0) {
    provider = 'duckduckgo';
    try {
      const raw = await searchDuckDuckGo(q);
      rawCount = Math.max(rawCount, raw.length);
      const ranked = rankWebSearchItems(raw, terms, dateToken, rankOptions);
      items = ranked.items;
      droppedCount = Math.max(droppedCount, ranked.droppedCount);
      if (items.length > 0) error = '';
    } catch (e) {
      const ddgError = e instanceof Error ? e.message : String(e);
      error = error ? `${error}；DuckDuckGo：${ddgError}` : `DuckDuckGo：${ddgError}`;
    }
  }
  const value: WebSearchResult = { query: q, provider, items, error: error || undefined, rawCount, droppedCount };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** 测试/设置变更后清缓存；代理缓存也必须一起清，否则改了设置仍走旧代理 */
export function clearWebSearchCache(): void {
  cache.clear();
  cachedProxyUrl = undefined;
  proxyDispatcher = null;
}

/**
 * 无可用来源时的负向上下文：明确告知模型检索失败，禁止编造新闻/链接。
 * 独立导出便于单测，不依赖真实网络。
 */
export function buildNoSourceContext(queries: string[], dateToken = '', errors: string[] = []): string {
  return [
    '联网检索：已尝试公开搜索，但没有获取到可用来源（已过滤广告/无关结果）。',
    `检索词：${sanitizePromptText(queries.join(' / '))}${dateToken ? `；日期：${dateToken}` : ''}`,
    '请勿编造新闻、日期或链接。如任务要求时效性内容，回执中必须明确写「未获取到可用来源」，并说明建议补充的检索源（如 OpenAI/Anthropic 官方博客、arXiv、机器之心、量子位）。',
    errors.length ? `检索诊断：${sanitizePromptText(errors.join('；'))}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 生成注入提示词的检索上下文。
 * 有结果时只列过滤后的权威/相关来源；无结果时明确「无可用来源」并禁止编造。
 */
export async function buildQueueWebContext(title: string, description: string): Promise<string> {
  if (!shouldSearchQueueTask(title, description)) return '';
  const taskText = `${title}\n${description}`;
  const terms = buildRelevanceTerms(title, description);
  const dateToken = extractDateToken(taskText);
  const isNews = /新闻|资讯|动态|日报|周报|早报|晚报|简报/.test(taskText);
  const recentDays = parseRecentDays(taskText);
  // “当天/今日”必须按当天；每日推送可放宽到 2 天；明确写了“最近 N 天”则按 N 天。
  const exactToday = /当天|当日|今日|今天/.test(taskText) && !/每日/.test(taskText);
  const maxAgeDays = recentDays ?? (isNews ? (exactToday ? 0.5 : 2) : 0);
  const primary = buildSearchQuery(title, description);
  const english = buildEnglishQuery(title, description);
  if (!primary && !english) return '';
  // T06060：GitHub 冒头项目要增速榜，单独拉 Trending 页面，和通用搜索并行。
  const githubHot = /GitHub/i.test(taskText) && /冒头|新项目|star|star 数|趋势|trending|增速/i.test(taskText);
  const techHot = /技术热点|技术栈|版本发布|重大特性|开源事件|release/i.test(taskText);

  const queries = [...new Set([primary, english].filter(Boolean))];
  // 权威源定向补检：通用搜索被广告站占据时，直接查官方博客/研究站点
  const siteQuery = primary
    ? `${english || primary} (site:openai.com OR site:anthropic.com OR site:github.blog OR site:arxiv.org OR site:jiqizhixin.com OR site:qbitai.com)`
    : '';
  const queryList = [...new Set([...queries, siteQuery].filter(Boolean))];
  const merged: WebSearchItem[] = [];
  const errors: string[] = [];
  // 权威 RSS 与通用搜索并行：RSS 快且可核验，通用搜索只做兜底
  const feedPromise = searchAuthoritativeFeeds(terms, maxAgeDays, dateToken);
  const githubPromise = githubHot
    ? searchGithubTrending(2, maxAgeDays, errors).catch((e: unknown) => {
      errors.push(`GitHub Trending：${e instanceof Error ? e.message : String(e)}`);
      return [] as WebSearchItem[];
    })
    : Promise.resolve([] as WebSearchItem[]);
  // 三条查询并行，最多等一轮网络超时；只有主查询允许 DDG 兜底，控制队列等待时间
  const searchPromise = Promise.allSettled(
    queryList.map((q, i) => searchWeb(q, terms, maxAgeDays, dateToken, i === 0)),
  );
  const [feedResult, searchResults, githubItems] = await Promise.all([feedPromise, searchPromise, githubPromise]);
  merged.push(...feedResult.items.map((it) => ({
    ...it,
    // T06060：任务明确要「版本发布/重大特性」时，官方发布类条目要压过泛行业观察，
    // 否则 Gemini 这类发布稿会被 GitHub 动态挤到第 6 条之外。
    score: (it.score ?? 0) + (techHot && /introducing|release|发布|版本|重大特性/i.test(`${it.title} ${it.snippet}`) ? 12 : 0),
  })));
  errors.push(...feedResult.errors);
  merged.push(...githubItems);
  for (const settled of searchResults) {
    if (settled.status === 'rejected') {
      errors.push(settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
      continue;
    }
    const result = settled.value;
    if (result.error) errors.push(result.error);
    merged.push(...result.items.map((it) => ({ ...it, provider: result.provider })));
  }

  const finalItems = dedupeItems(merged)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, MAX_ITEMS);

  if (finalItems.length === 0) {
    return buildNoSourceContext(queries, dateToken, errors);
  }

  const lines = finalItems.map((it, i) => {
    const source = it.source || (it.provider === 'duckduckgo' ? 'DuckDuckGo 公开搜索' : 'Bing 公开搜索');
    const published = it.publishedAt ? (publishedDateToken(it.publishedAt) || sanitizePromptText(it.publishedAt)) : '';
    return `${i + 1}. ${sanitizePromptText(it.title)}\n   ${sanitizePromptText(it.url)}\n   ${sanitizePromptText(it.snippet || '（无摘要）')}\n   来源：${sanitizePromptText(source)}${published ? `（${published}）` : ''}（已过滤）`;
  });
  return [
    '<untrusted_search_results>',
    `检索词：${sanitizePromptText(queries.join(' / '))}${dateToken ? `；日期：${dateToken}` : ''}`,
    '以下结果已按域名/标题/关键词过滤并按相关度排序，只保留权威或相关来源。',
    '只能引用以下链接中的信息；不得编造新闻、日期或来源。若结果不足以回答，请直接说明缺口。',
    errors.length ? `检索诊断：${sanitizePromptText(errors.join('；'))}` : '',
    '',
    ...lines,
    '</untrusted_search_results>',
  ].filter(Boolean).join('\n');
}
