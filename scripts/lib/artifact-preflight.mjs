/**
 * T02751：UI 类验收门「前置件就位」守卫的统一口径（纯判定 + 零依赖，各门自取措辞）。
 *
 * 背景：批㉚ U-00e 在 verify-t02046-ui 首立此守卫、批㉟（T02767）在 verify-t01674/
 * verify-t02624 各抄了一份——三份时间戳比较各写各的（时区、秒/毫秒精度、worktree 场景
 * HEAD 提交时间取法），本模块把它收成单源。判定只有三态：
 *   missing —— 产物文件不在：考卷没发，属前置件缺失而非判据失守，整门 SKIP + exit≠0；
 *   stale   —— 产物早于 HEAD 提交：旧产物测新代码，红绿不可归因，同样 SKIP + exit≠0；
 *   ok      —— 就位，正常跑门。
 * 时间口径（本单第 2 条要统一的坑）：
 *   · HEAD 提交时间取 `git log -1 --format=%ct`——unix 秒，天然无时区问题；在 `git worktree`
 *     副本里跑取的就是该副本 HEAD，无需特判。
 *   · dist mtime 是毫秒精度，与秒级 %ct 比较前**双侧一律截秒**（floor(/1000)）：
 *     否则「提交与构建同发生在提交那一秒内」会因毫秒截尾被误判 stale（假红）。
 *   · %ct 取不到（非 git 环境）记 0 ⇒ 不判 stale（无证据不拦），仍判 missing。
 * SKIP 道 exit 码约定：非 0 但不等于 FAIL——汇总行仍要打印（PASS=0 FAIL=0 SKIP=n），
 * 不打印汇总的退出会让人以为门崩了（批㉛口径：前置腿自证、下游整族 SKIP）。
 * 产物为被测对象的门（如 verify-packaged-shell 考装机壳）不属本口径：那不是「考卷没发」，
 * 而是「考卷就是要考的旧卷」，新鲜度只作 note 不作拦门。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** HEAD 提交时间（unix 毫秒）；取不到返回 0 */
export function headCommitMs(root) {
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).toString().trim() || 0) * 1000;
  } catch {
    return 0;
  }
}

/** 前端产物（web/dist/index.html 为伺服锚）就位三态判定。
 *  返回 distIso/headIso 为人类可读 ISO 串（missing 时 distIso=null），供各门写自己的措辞。 */
export function frontendArtifactState(root, { distRel = join('web', 'dist', 'index.html') } = {}) {
  const distPath = join(root, distRel);
  const present = existsSync(distPath);
  const distMtimeMs = present ? statSync(distPath).mtimeMs : 0;
  const headMs = headCommitMs(root);
  const distSec = Math.floor(distMtimeMs / 1000);
  const headSec = Math.floor(headMs / 1000);
  const state = !present ? 'missing' : (headSec > 0 && distSec < headSec ? 'stale' : 'ok');
  return {
    state,
    ready: state === 'ok',
    missing: state === 'missing',
    stale: state === 'stale',
    distPath,
    distMtimeMs,
    headMs,
    distIso: present ? new Date(distMtimeMs).toISOString() : null,
    headIso: headMs > 0 ? new Date(headMs).toISOString() : null,
  };
}

/** 供门日志统一展示的「当时状态」一行（留痕用，不做判定） */
export function describeArtifactState(st) {
  return `dist=${st.distPath}(${st.distIso ?? '不在'}) · HEAD=${st.headIso ?? '取不到'}`;
}
