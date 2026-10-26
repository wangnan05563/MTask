import type { Tab } from './tabs';
import { TABS } from './tabs';

/**
 * T03187（PM-103③ / D-13）：深链与面板路由契约单源。
 *
 * 稳定性契约：`#/project/<projectId>/<tab>?/<anchor>?`
 *  - tab 取 `TABS` 的一级导航键（未知值忽略，回落项目默认页）——菜单改名不改路由；
 *  - anchor 是**面板级稳定锚点**（不是行号、不是标题），见 `PLAN_ANCHORS`；
 *  - 只认「存在性」，不认顺序：缺省段一律可省，多余段忽略，保证老链接在面板重构后仍能落位。
 *
 * 为什么要单源：此前跳转散落在 `mtaskNavigate` 事件（只带 tab）与各页自己的 sessionStorage 键里，
 * 命令面板、通知、执行会话各拼一套；UX-08 把面板改 Tab/抽屉后，任何一处重写跳转都会让链接失效。
 * 本模块把「生成链接 / 解析链接 / 交付给页面」收成三条出口，页面只实现 `consumeDeepLink` + 事件监听。
 */

export interface DeepLink {
  projectId: string;
  tab?: Tab;
  anchor?: string;
}

/**
 * 项目管理页的稳定锚点。取「面板身份」而非位置：
 * 后续把面板改成 Tab / 抽屉时，只要面板还在，锚点名不变、链接不失效（D-13）。
 */
export const PLAN_ANCHORS = {
  /** WBS 主表（默认落位；显式写出来是为了「指向主表」不被其它面板的展开态劫持） */
  wbs: 'wbs',
  prd: 'prd',
  matrix: 'matrix',
  testcases: 'testcases',
  sprint: 'sprint',
} as const;

export type PlanAnchor = (typeof PLAN_ANCHORS)[keyof typeof PLAN_ANCHORS];

/** 待交付链接的暂存键：页面未挂载时由导航先存，挂载后 `consumeDeepLink` 取走并清空 */
const PENDING_KEY = 'deeplink.pending';

/** 页面已挂载时的即时交付事件（挂载读暂存 / 已挂载收事件，两条路径互斥不重复落位） */
export const DEEP_LINK_EVENT = 'mtaskDeepLink';

const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

function decodeSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * 解析 hash。宽容口径：非法/空/未知 tab 都退回可用的最弱形式，只有「不是项目路由」才返回 null，
 * 使调用方能区分「这条链接与我无关」与「这条链接有效但字段不全」。
 */
export function parseDeepLink(hash: string | null | undefined): DeepLink | null {
  const raw = String(hash ?? '').trim().replace(/^#/, '').replace(/^\/+/, '');
  if (!raw) return null;
  const parts = raw.split('/').map(decodeSeg);
  if (parts[0] !== 'project') return null;
  const projectId = (parts[1] ?? '').trim();
  if (!projectId) return null;
  const tabSeg = (parts[2] ?? '').trim();
  const anchorSeg = (parts[3] ?? '').trim();
  return {
    projectId,
    tab: TAB_KEYS.has(tabSeg) ? (tabSeg as Tab) : undefined,
    anchor: anchorSeg || undefined,
  };
}

/** 生成链接。空字段省略，避免出现 `#/project/x//` 这类只有本应用能认的畸形串 */
export function buildDeepLink(link: DeepLink): string {
  const seg = ['project', encodeURIComponent(link.projectId)];
  if (link.tab) seg.push(link.tab);
  if (link.anchor) seg.push(encodeURIComponent(link.anchor));
  return `#/${seg.join('/')}`;
}

function readPending(): DeepLink | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    return parseDeepLink(raw);
  } catch { return null; }
}

/** 挂载时取走属于本页（或无 tab）的待交付链接；不属于本页的原样保留，避免互相吃掉 */
export function consumeDeepLink(tab: Tab): DeepLink | null {
  const link = readPending();
  if (!link || !link.tab || link.tab !== tab) return null;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 配额异常忽略 */ }
  return link;
}

/**
 * 交付给页面：已挂载 → 直接派事件；未挂载 → 存暂存、由目标页挂载时 `consumeDeepLink` 取走。
 * 两条路都走，且由页面侧按「是否已应用过同一链接」自行去重（见 PlanPage）。
 */
function deliver(link: DeepLink): void {
  if (link.projectId) {
    try { sessionStorage.setItem(PENDING_KEY, buildDeepLink(link)); } catch { /* 忽略 */ }
  }
  globalThis.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: link }));
}

/** 切到链接指向的页签（一级导航已挂载时即时生效；页面内容由 delivery 承接） */
function switchTab(tab: Tab | undefined): void {
  if (!tab) return;
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab } }));
}

/**
 * 应用一条链接：切页 + 交付。emit 侧唯一入口（focusTask / focusPlanNode / 命令面板都走这里）。
 * `replace` 用 replaceState 而非赋值 `location.hash`：通知/面板跳转很频繁，不该在浏览器历史里留一串垃圾条目。
 */
export function applyDeepLink(link: DeepLink, opts: { replace?: boolean } = {}): void {
  // 项目未知（如通知只带任务编号）时不写地址栏：契约里 projectId 是必填段，写空段会生成别人解析不了的串；
  // 切页与交付照常进行，页面仍按各自会话键落位。
  if (!link.projectId) {
    switchTab(link.tab);
    deliver(link);
    return;
  }
  const hash = buildDeepLink(link);
  try {
    if (opts.replace === false) location.hash = hash;
    else history.replaceState(null, '', hash);
  } catch { /* 非浏览器环境（测试/SSR）忽略 URL 副作用，交付与切页仍然生效 */ }
  switchTab(link.tab);
  deliver(link);
}

/** 从当前 URL 取链接（首次进入 / 手改地址 / 外部 a 标签跳转） */
export function readDeepLinkFromLocation(): DeepLink | null {
  return parseDeepLink(location.hash);
}
