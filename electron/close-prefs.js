/**
 * T03776：关闭交互（最小化到托盘 / 直接关闭 +「记住此选择」）的决策内核（不依赖 electron，可单测）。
 *
 * 拆出本模块的原因与 T02071 update-state 相同：验收面在真机弹窗与托盘图标，隔离实例覆盖不到；
 * 但「默认值取什么、只有勾选记住才落盘、设置页改动算不算记住、坏配置怎么回退」是纯函数，
 * 先在这里钉住并被 scripts/tests/t03776-close-prefs-test.mjs 断言，主进程只保留 IO 与 IPC 接线。
 */
const fs = require('node:fs');
const path = require('node:path');

/** close_action 的合法枚举（与工单约定一致）；未知值一律按默认处理 */
const CLOSE_ACTIONS = ['minimize_to_tray', 'exit_app'];
/** 首次运行（无历史配置）：不记住选择、每次询问；建议默认行为为最小化到托盘 */
const DEFAULT_PREFS = Object.freeze({ closeAction: 'minimize_to_tray', rememberChoice: false });

function normalizeAction(value) {
  return CLOSE_ACTIONS.includes(value) ? value : DEFAULT_PREFS.closeAction;
}

/** 配置只认两个字段：脏值（未知枚举/非布尔）回默认，避免一个坏文件把关闭行为钉死 */
function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    closeAction: normalizeAction(src.closeAction),
    rememberChoice: Boolean(src.rememberChoice),
  };
}

/** 读配置：文件缺失或 JSON 损坏一律回默认（关闭交互不能因为配置文件坏了就失效） */
function readClosePrefs(file) {
  try {
    if (!file || !fs.existsSync(file)) return { ...DEFAULT_PREFS };
    return normalizePrefs(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。Windows 上同卷 rename 覆盖是原子的，
 * 崩溃/并发读只会拿到「旧配置完整」或「新配置完整」，不会读到半截 JSON。
 */
function writeClosePrefs(file, prefs) {
  const target = String(file);
  const next = normalizePrefs(prefs);
  const tmp = path.join(path.dirname(target), `.close-prefs.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件已不在：无需回收 */ }
    throw e;
  }
  return next;
}

/** 关闭请求裁决：记住过 → 直接按配置执行（场景 B）；没记住 → 弹窗询问（场景 A） */
function decideOnClose(prefs) {
  const p = normalizePrefs(prefs);
  return p.rememberChoice ? { ask: false, action: p.closeAction } : { ask: true, action: null };
}

/**
 * 弹窗后的落盘裁决（约束 1）：勾选「记住」才写配置，并把 rememberChoice 置 true；
 * 未勾选则本次照做、配置原样返回（persist=false），下次关闭仍询问。
 */
function outcomeAfterDialog(prefs, { action, rememberChecked }) {
  const chosen = normalizeAction(action);
  const remember = Boolean(rememberChecked);
  return {
    action: chosen,
    persist: remember,
    prefs: remember ? { closeAction: chosen, rememberChoice: true } : normalizePrefs(prefs),
  };
}

/**
 * 设置页改动的落盘裁决（约束 3）：切换「关闭窗口行为」即视为记住了选择（下次不再弹窗）；
 * 单独拨「关闭时询问」开关只改 rememberChoice，不动已选行为。
 * 两个字段同时给时以显式的 rememberChoice 为准（用户意图优先于推断）。
 */
function prefsFromSettings(current, patch) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = normalizePrefs(current);
  if (src.closeAction !== undefined) {
    next.closeAction = normalizeAction(src.closeAction);
    next.rememberChoice = true;
  }
  if (src.rememberChoice !== undefined) next.rememberChoice = Boolean(src.rememberChoice);
  return next;
}

module.exports = {
  CLOSE_ACTIONS,
  DEFAULT_PREFS,
  normalizePrefs,
  readClosePrefs,
  writeClosePrefs,
  decideOnClose,
  outcomeAfterDialog,
  prefsFromSettings,
};
