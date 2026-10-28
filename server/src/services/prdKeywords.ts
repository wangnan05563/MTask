/**
 * T03442：PRD 侧检索词的「中文 → 代码标识符」桥。
 *
 * 背景：`WorkspaceService.extractKeywords` 主路径只抓拉丁标识符且凑到 3 个就返回，中文仅在其不足时
 * 用 2~4 字定步长滑窗补——产出「承兑签」「签收此」这类跨词碎片，而代码里几乎不出现中文标识符。
 * 本模块**不改** `extractKeywords`（其他调用方仍在用），只给 PRD 生成一条新链路：
 *   1. 词表命中（`references/domain-vocab.md`）：中文术语 → 英文标识符候选（weight 3）
 *   2. 拉丁标识符：沿用原正则与 Word 域码过滤（weight 2）
 *   3. 中文短语：按标点/换行切段**不切词**，保留 2~12 字业务短语原文（weight 1），靠注释/文案命中
 * 不做向量检索（与「本地、零外部依赖」定位冲突）。
 */
import { isWordFieldToken } from '../util/wordFields';

export type NeedleKind = 'latin' | 'phrase' | 'symbol';

export interface Needle {
  text: string;
  kind: NeedleKind;
  /** 3=词表映射 2=拉丁标识符 1=中文短语；排序与裁剪按它优先 */
  weight: number;
}

export interface VocabEntry {
  /** 中文术语（原样出现在需求里即命中） */
  term: string;
  /** 对应的代码标识符候选（小写） */
  aliases: string[];
}

export interface ExtractResult {
  needles: Needle[];
  /** 被上限裁掉/被停用词滤掉的候选（供 stage 回显「这次没检索哪些词」） */
  dropped: string[];
}

/** 词表文件缺失时的兜底（与 `skills/prd-generate/references/domain-vocab.md` 同内容，正常路径不走到这里） */
export const FALLBACK_VOCAB: VocabEntry[] = [
  { term: '承兑', aliases: ['accept', 'acceptance'] },
  { term: '背书', aliases: ['endorse', 'endorsement'] },
  { term: '贴现', aliases: ['discount'] },
  { term: '质押', aliases: ['pledge'] },
  { term: '追索', aliases: ['recourse'] },
  { term: '出票', aliases: ['issue', 'draw'] },
  { term: '票据', aliases: ['bill', 'ticket', 'draft'] },
  { term: '到期', aliases: ['maturity', 'due'] },
  { term: '利率', aliases: ['rate', 'interest'] },
  { term: '签收', aliases: ['receipt', 'sign'] },
  { term: '结算', aliases: ['settle', 'settlement'] },
  { term: '审批', aliases: ['approve', 'approval'] },
];

/** 解析词表 Markdown：每行 `中文 | alias1, alias2`；`#` 注释与空行忽略，格式不符的行跳过 */
export function parseDomainVocab(md: string): VocabEntry[] {
  const out: VocabEntry[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('|')) continue;
    const [termPart, aliasPart] = line.split('|');
    const term = termPart.trim();
    const aliases = aliasPart.split(/[,，]/).map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 2);
    if (!term || aliases.length === 0) continue;
    out.push({ term, aliases });
  }
  return out;
}

/** 中文检索词条数上限（与检索命中上限 12 同量级：再多只会拖慢 memo 匹配而不增召回） */
export const NEEDLE_LIMIT = 12;

/** 泛词停用集：它们在任何需求里都出现，当成检索词只会命中满屏无关代码 */
const STOP_PHRASES = new Set([
  '需求', '功能', '系统', '支持', '页面', '管理', '流程', '信息', '相关', '进行', '提供', '实现',
  '增加', '修改', '优化', '问题', '内容', '数据', '用户', '操作', '处理', '设计', '说明', '如下',
  '以上', '需要', '可以', '应该', '以及', '或者', '然后', '并且', '我们', '你们', '这个', '那个',
  '文档', '版本', '测试', '开发', '上线', '要求', '主要是', '包括', '对应', '同时', '如果', '否则',
]);
const STOP_LATIN = new Set(['the', 'and', 'for', 'with', 'const', 'let', 'function', 'return', 'this']);

/**
 * 泛词单字集：整段里一个「非泛词字」都没有时才算噪声（如「本需求的功能」「系统页面管理」）。
 * 阈值取「零个」而非比例——中文双字业务词（对账、贴现）往往含通用字，按比例会误杀。
 */
const GENERIC_CHARS = new Set(
  ('的了与和在是为对把被及等或并也都就要会可以有无不这那个些上下中后前时次条件本其之此'
    + [...STOP_PHRASES].join('')).split(''),
);

/** 整段都是泛词字 → 噪声（没有检索价值） */
function isNoisePhrase(phrase: string): boolean {
  if (STOP_PHRASES.has(phrase)) return true;
  for (const ch of phrase) if (!GENERIC_CHARS.has(ch)) return false;
  return true;
}

/** 中文短跑切段长度上限：超过就按 6 字窗滑切（比 2~4 字定步长滑窗碎片少得多） */
const PHRASE_MAX_LEN = 12;
const PHRASE_WINDOW = 6;

/**
 * 从需求文本抽检索词。
 * @param vocab 领域词表（默认空 = 只做拉丁 + 中文短语）
 */
export function extractNeedles(text: string, vocab: VocabEntry[] = [], limit = NEEDLE_LIMIT): ExtractResult {
  if (!text) return { needles: [], dropped: [] };
  const picked = new Map<string, Needle>();
  const dropped: string[] = [];
  const push = (raw: string, kind: NeedleKind, weight: number): void => {
    const key = raw.toLowerCase();
    if (key.length < 2) return;
    const prev = picked.get(key);
    if (!prev) { picked.set(key, { text: raw, kind, weight }); return; }
    if (weight > prev.weight) picked.set(key, { text: raw, kind, weight });
  };

  // 1) 词表命中优先级最高：中文术语 → 英文标识符
  for (const entry of vocab) {
    if (!text.includes(entry.term)) continue;
    for (const alias of entry.aliases) push(alias, 'latin', 3);
  }

  // 2) 拉丁标识符（沿用 extractKeywords 的正则与过滤口径，但不设「凑够 3 个就停」）
  for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) {
    const w = m[0];
    if (isWordFieldToken(w)) continue;
    if ((w.match(/\d/g)?.length ?? 0) >= Math.ceil(w.length / 2)) continue;
    if (STOP_LATIN.has(w.toLowerCase())) continue;
    push(w, 'latin', 2);
  }

  // 3) 中文短语：按标点/换行切段，段内不切词
  for (const run of text.split(/[^\u4e00-\u9fa5]+/)) {
    if (run.length < 2) continue;
    const phrases = run.length <= PHRASE_MAX_LEN
      ? [run]
      : Array.from({ length: Math.ceil((run.length - PHRASE_WINDOW) / PHRASE_WINDOW) + 1 }, (_, i) =>
        run.slice(i * PHRASE_WINDOW, i * PHRASE_WINDOW + PHRASE_WINDOW)).filter((p) => p.length >= 2);
    for (const p of phrases) {
      if (isNoisePhrase(p)) { dropped.push(p); continue; }
      push(p, 'phrase', 1);
    }
  }

  const ordered = [...picked.values()].sort((a, b) => b.weight - a.weight);
  const needles = ordered.slice(0, limit);
  for (const n of ordered.slice(limit)) dropped.push(n.text);
  return { needles, dropped };
}
