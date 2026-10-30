import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * T03215（PM-304）任务列表窗口化：DOM 行数只随视口高度增长，不再随已加载条数线性增长。
 * 窗口数学与 testCaseModel 的 computeWindow 同契约（start/end + padTop/padBottom 占位），
 * 但有两处是本列表特有的：
 * ① 滚动宿主是 document（App 主区不设滚动容器），故窗口位置 = window.scrollY 减掉列表在文档中的顶偏移；
 * ② 行高不固定（实测 34~78px），故按「已观测行的累计平均」实测替代写死行高，行高变了窗口跟着重算
 *    （口径与理由见 refreshGeometry：不用窗口中位数，否则占位总高随窗口位置跳变）。
 */

/** 低于该条数不窗口化：小列表窗口化只带来定位与滚动的不确定性，收益为零（与既有「勿过度设计」口径一致） */
export const TASK_VIRTUAL_THRESHOLD = 150;
/** 首次实测前的行高估算（px，实测中位数为 71） */
export const TASK_ROW_H = 72;
/** 视口上下各多渲染的行数：须 ≥ TASK_WINDOW_STEP 才能盖住一个步长的位移，余下 2 行抗抖动 */
export const TASK_OVERSCAN = 4;
/**
 * 窗口位移步长（行）：滚动时不必每越过一行就重渲染整页——只要新窗口与已渲染窗口错开不足 STEP 行，
 * overscan 余量仍能盖住视口，就把这次重渲染攒着。
 * 实测（5000 条、每 70ms 滚 420px、1440×900）：换窗成本主要随「一次渲染的行数」走，不是频次——
 * 一次渲染 28 行（overscan 4）稳在 56~59fps，35~41 行（overscan 5 / 10）掉到 42~49fps。
 * 故取小窗口 + 小步长，让每帧都落在 16.7ms 预算内；步长再大只会让单帧更重。
 */
export const TASK_WINDOW_STEP = 2;

export interface TaskWindow { start: number; end: number; padTop: number; padBottom: number; }

/** 是否需要窗口化 */
export function shouldVirtualizeTasks(count: number): boolean {
  return count > TASK_VIRTUAL_THRESHOLD;
}

/**
 * 纯窗口计算：`scrollY` 为文档滚动位，`listTop` 为列表在文档中的顶偏移。
 * 未过阈值恒返回整表区间（占位为 0），调用方不必再分支判断。
 * 占位总高恒等于 count×rowH，滚动条长度与全量渲染一致，不会「滚到底发现还有一截」。
 */
export function computeTaskWindow(input: {
  scrollY: number; listTop: number; viewportH: number; count: number; rowH?: number; overscan?: number;
}): TaskWindow {
  const { scrollY, listTop, viewportH, count } = input;
  const rowH = input.rowH ?? TASK_ROW_H;
  const overscan = input.overscan ?? TASK_OVERSCAN;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (!shouldVirtualizeTasks(count)) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, scrollY - listTop) / rowH);
  const visible = Math.ceil(viewportH / rowH);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowH, padBottom: Math.max(0, (count - end) * rowH) };
}

/** 把第 index 行滚到视口上沿下方约 1/3 处（定位/徽标跳转用） */
export function scrollOffsetForIndex(index: number, listTop: number, rowH: number, viewportH: number): number {
  return Math.max(0, listTop + Math.max(0, index) * rowH - Math.floor(viewportH / 3));
}

/** 强制窗口：以定位行为首行，渲染行数上界与常规窗口同级 */
export function computePinnedWindow(pin: number, count: number, viewportH: number, rowH = TASK_ROW_H, overscan = TASK_OVERSCAN): TaskWindow {
  const start = Math.min(Math.max(0, count), Math.max(0, pin - overscan));
  const end = Math.min(count, start + Math.ceil(viewportH / rowH) + overscan * 2);
  return { start, end, padTop: start * rowH, padBottom: Math.max(0, (count - end) * rowH) };
}

export interface TaskListWindowApi {
  /** 挂到列表容器（ul）上，用于取文档顶偏移与实测行高 */
  setListEl: (el: HTMLElement | null) => void;
  win: TaskWindow;
  /** 窗口是否真的生效（供门与探针断言） */
  virtualized: boolean;
  /** 强制把第 index 行纳入窗口并滚动到位 */
  revealIndex: (index: number) => void;
  /** reveal 后自增，供定位类 effect 放进依赖数组——滚过去之后还能再认一次该行 */
  nonce: number;
  /** 实测行高（探针断言用） */
  rowH: number;
}

/**
 * 文档滚动 + 变高行的窗口化钩子。
 * `count` 为当前可见条数；`hasMore` 表示服务端还有下一页；窗口末端触到已加载末尾时经 `onReachEnd` 自动续取。
 * 滚动帧只在「窗口区间真的变了」时才 setState——同一区间内的滚动不触发 React 重渲染。
 */
export function useTaskListWindow(count: number, hasMore: boolean, onReachEnd?: () => void, canLoadMore = true): TaskListWindowApi {
  const listElRef = useRef<HTMLElement | null>(null);
  const [geom, setGeom] = useState({ scrollY: 0, listTop: 0, viewportH: 900, rowH: TASK_ROW_H });
  const geomRef = useRef(geom);
  const [pin, setPin] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const renderedRef = useRef<TaskWindow>({ start: -1, end: -1, padTop: -1, padBottom: -1 });
  const rafRef = useRef<number | null>(null);
  const pinTimerRef = useRef<number | null>(null);
  const autoLoadedAtCountRef = useRef<number>(-1);
  /** 行高累计观测（见 refreshGeometry）；条数回落（换项目/换筛选）时清零重测 */
  const rowAccRef = useRef<{ sum: number; n: number }>({ sum: 0, n: 0 });
  const prevCountRef = useRef(0);

  const setListEl = useCallback((el: HTMLElement | null) => {
    listElRef.current = el;
  }, []);

  /**
   * 滚动帧只做「读 scrollY → 比窗口 → 必要时 setState」：
   * listTop 与 rowH 都不随滚动变化，故缓存在 geomRef 里，不在每帧去碰 getBoundingClientRect/offsetHeight
   * ——那会在每帧强制同步布局，实测把帧成本从个位数拉高到 40ms 以上。缓存值在窗口真正变化后统一刷新。
   */
  const measure = useCallback(() => {
    const scrollY = window.scrollY;
    const { listTop, viewportH, rowH } = geomRef.current;
    const next = computeTaskWindow({ scrollY, listTop, viewportH, count, rowH });
    const cur = renderedRef.current;
    const sameRange = cur.start === next.start && cur.end === next.end;
    // 贴边（列表顶/已加载末尾）不允许攒：窗口在边界上时，浏览器会把 scrollY 钳在文档最大滚动位，
    // 而占位总高随窗口微调会漂几十像素——实测底部差 70px 恰好不足一个步长，被步进门控吞掉后
    // win.end 永远差一行到 count，触底续取就再也不触发（列表卡死在已加载 200 条）。
    const atEdge = next.start === 0 || next.end >= count;
    if (sameRange) {
      // 区间没变但占位总高变了（条数增加或行高重估）→ 必须更新，否则滚动条长度与真实内容不符
      if (cur.padTop === next.padTop && cur.padBottom === next.padBottom) return;
    } else if (!atEdge && Math.abs(next.start - cur.start) < TASK_WINDOW_STEP && Math.abs(next.end - cur.end) < TASK_WINDOW_STEP) {
      // 错开不足一个步长：overscan 仍完整盖住视口，这次重渲染攒着不做（帧成本的大头在重渲染，不在滚动本身）
      return;
    }
    const g = { scrollY, listTop, viewportH, rowH };
    geomRef.current = g;
    // 换窗必须是紧急更新：实测把这里改成 startTransition 反而更差（45.7fps → 31fps，整屏跳跃峰值 183ms，
    // 且出现过「视口内 0 行」的空帧）。延迟的那一帧留着的是上一个窗口，而窗口区间已与新滚动位错开一个步长，
    // overscan 的 2 行余量正好被吃掉——切换成本省不下，还多押上一帧的空白。
    setGeom(g);
  }, [count]);

  /**
   * 窗口落地后补一次几何与行高（此处才允许碰布局，一次只花在一个步长上）；
   * scrollY 不回写，避免与滚动更新互相打断形成渲染乒乓。
   * 行高用「已观测行的累计平均」而不是当前窗口的中位数：任务行有无描述差别很大（实测首屏 78px、后续 34px），
   * 用中位数会让占位总高随窗口位置在 2 倍之间跳变（5000 条 = 39 万 ↔ 17 万像素），滚动条长度与滚动位一起跳；
   * 累计平均只会随观察渐进移动，总量稳定。
   */
  const refreshGeometry = useCallback(() => {
    const el = listElRef.current;
    const viewportH = window.innerHeight;
    const listTop = el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY) : 0;
    let rowH = TASK_ROW_H;
    if (el) {
      const rows = el.querySelectorAll<HTMLElement>('li.task-item');
      const acc = rowAccRef.current;
      for (const r of rows) {
        const h = r.offsetHeight;
        if (h > 0) { acc.sum += h; acc.n += 1; }
      }
      if (acc.n > 0) rowH = Math.max(24, Math.round(acc.sum / acc.n));
    }
    const prev = geomRef.current;
    if (prev.listTop === listTop && prev.viewportH === viewportH && prev.rowH === rowH) return;
    // scrollY 沿用上一次 measure 的值：窗口区间由滚动驱动，这里回写会让区间再变一次
    const g = { scrollY: prev.scrollY, listTop, viewportH, rowH };
    geomRef.current = g;
    setGeom(g);
  }, []);

  useLayoutEffect(() => {
    // 条数回落 = 换了一批数据（换项目/切筛选/切 tab），累计行高要重测，否则旧数据的高度会把新列表撑歪
    if (count < prevCountRef.current) rowAccRef.current = { sum: 0, n: 0 };
    prevCountRef.current = count;
    refreshGeometry();
    measure();
    // count 变化（加载更多/切 tab）后立即重算，不让窗口停在旧区间
  }, [measure, refreshGeometry, count]);

  useEffect(() => {
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        measure();
      });
    };
    const onResize = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        refreshGeometry();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [measure, refreshGeometry]);

  const win = pin == null
    ? computeTaskWindow({ ...geom, count })
    : computePinnedWindow(pin, count, geom.viewportH, geom.rowH);
  renderedRef.current = win;

  // 窗口落地后补一次几何（行高/列表顶偏移）：这里才允许碰布局，且每个步长只花一次
  useEffect(() => {
    refreshGeometry();
  }, [refreshGeometry, win.start, win.end, count]);

  const revealIndex = useCallback((index: number) => {
    if (index < 0 || !shouldVirtualizeTasks(count)) return;
    const el = listElRef.current;
    const listTop = el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY) : 0;
    window.scrollTo(0, scrollOffsetForIndex(index, listTop, geomRef.current.rowH, window.innerHeight));
    setPin(index);
    setNonce((n) => n + 1);
    if (pinTimerRef.current != null) globalThis.clearTimeout(pinTimerRef.current);
    // 定位窗口期过后交回普通滚动窗口，否则用户往上滚会一直是空的
    pinTimerRef.current = window.setTimeout(() => setPin(null), 1500);
  }, [count]);

  useEffect(() => () => {
    if (pinTimerRef.current != null) globalThis.clearTimeout(pinTimerRef.current);
  }, []);

  // 触底续取（PM-304「分页查询下沉」的另一半：取数由滚动位置驱动，而不是让用户把按钮点到底）。
  // 幂等键是「已加载条数」：同一长度只发起一次；但调用方正忙（canLoadMore=false，手动「加载更多」在飞）时
  // 不占用这个额度——否则这一次触底被静默吞掉，同一长度再也不会有第二次触发，列表会卡在中间不再增长（实测卡在 2800/5000）。
  // 判据用「距估算末尾不足一屏」而不是 `win.end >= count`：变高行下占位总高会随窗口漂几十像素，
  // 浏览器把 scrollY 钳在文档最大滚动位后窗口区间永远差一两行到 count，用区间判据会让触底续取彻底失灵（实测卡在 200/5000）。
  const nearEnd = count > 0
    && geom.listTop + count * geom.rowH - (geom.scrollY + geom.viewportH) < geom.viewportH;
  useEffect(() => {
    if (!hasMore || !canLoadMore || !onReachEnd || !nearEnd) return;
    if (autoLoadedAtCountRef.current === count) return;
    autoLoadedAtCountRef.current = count;
    onReachEnd();
  }, [hasMore, canLoadMore, onReachEnd, count, nearEnd]);

  return { setListEl, win, virtualized: shouldVirtualizeTasks(count), revealIndex, nonce, rowH: geom.rowH };
}
