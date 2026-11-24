import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { type TaskView } from './TaskService';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';
import { logService } from './LogService';
import { getSetting } from './AppSettings';
import { TaskService } from './TaskService';
import { notifyChange } from './ChangeBus';
import type { SubmitResult, PollResult } from '../adapters/types';

/** 队列列表 TTL：读多写少，5s 内允许过期值，写操作会主动 cacheClear 保证一致 */
const LIST_TTL_MS = 5000;

export interface QueueRow {
  id: string;
  name: string;
  date: string;
  status: string;
  created_at: string;
  /** T01434：队列级暂停——true 时拒绝 send/submit，移动端可半操作 */
  paused?: number;
  /** T06245：manual=人工编排队列；dispatch=CodeBuddy 网关 / MCP 就绪池内部派发；relay=监督中继 */
  kind?: 'manual' | 'dispatch' | 'relay';
}

export type QueueKind = 'manual' | 'dispatch' | 'relay';

export interface QueueJobRow {
  id: string;
  queue_id: string;
  task_id: string;
  tool_id: string;
  order_index: number;
  status: string;
  request_payload: string | null;
  response_payload: string | null;
  error: string | null;
  sent_at: string | null;
  finished_at: string | null;
  ticket: string | null;
  submitted_at: string | null;
  /** T06076：回执被采纳、写入任务处理结果的时刻；空 = 尚未采纳 */
  adopted_at?: string | null;
  /** 采纳前快照（status/handle_result/ai_state 的 JSON）——撤回时恢复 */
  adopt_snapshot?: string | null;
}

/** 回执质量提示：自述非实时 / 任务要求来源但正文无链接 / 占位内容 */
export interface ReceiptWarning {
  code: 'stale' | 'no_source' | 'placeholder' | 'format';
  label: string;
  detail: string;
  /** 阻断采纳：必须显式 force 才能写入 */
  blocking: boolean;
}

type WebSearchState = 'off' | 'ok' | 'empty';

/** T06060：描述里没有“来源”二字，不代表可以不给来源；资讯/热点类任务默认要求可核验链接 */
function isNewsLikeText(text: string): boolean {
  // “动态”单独出现时可能是开发任务的“动态表单/动态加载”，只有行业/AI/技术等限定词后的动态才算资讯。
  return /新闻|资讯|日报|周报|早报|晚报|简报|热点|行业动态|市场动态|AI动态|技术动态/i.test(text);
}

/** URL 只在 scheme/host 上做归一；path 通常大小写敏感，不能整体 lowerCase */
function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.replace(/[.,;:!?)\]}）】。，、；："'”’]+$/g, '').replace(/\/$/, '');
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** 按“条目起始行”切块：- / 1. / **1. / 第1条 / ① 都算一条，续行归入同一条 */
function splitReceiptEntries(text: string): string[] {
  const startRe = /^[-*]\s+|^\*\*\d+[.、)]|^\d+[.、)]|^[①②③④⑤⑥⑦⑧⑨⑩]|^\*\*第\d+条|^第\d+条/;
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (startRe.test(trimmed)) {
      if (current) blocks.push(current.join('\n'));
      current = [trimmed];
    } else if (current) {
      current.push(trimmed);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

/** 从 buildQueueWebContext 的编号行提取标题/URL，供格式门判断“发布类来源”而不只看 URL 关键词 */
function parseWebContextItems(webContext: string): Array<{ title: string; url: string }> {
  const items: Array<{ title: string; url: string }> = [];
  const re = /^\s*\d+\.\s*(.+?)\n\s*(https?:\/\/[^\s]+)/gm;
  for (const match of webContext.matchAll(re)) {
    const title = match[1].trim();
    const url = match[2].replace(/[.,;:!?)\]}）】。，、；："'”’]+$/g, '');
    if (title && url) items.push({ title, url });
    if (items.length >= 20) break;
  }
  return items;
}

/**
 * T06076 质量门：队列回执不是「有字就合格」。
 * 当前工具都是普通 LLM（无联网），「今日资讯」类任务最容易产出自述知识截止的假时效内容；
 * 这里在采纳前把风险显式化，由用户确认后再写入处理结果，避免把不可核验内容变成正式结论。
 */
export function receiptWarnings(job: Pick<QueueJobRow, 'request_payload' | 'response_payload'>): ReceiptWarning[] {
  const text = (job.response_payload ?? '').trim();
  if (!text) return [];
  const out: ReceiptWarning[] = [];
  if (/知识截止|无法实时|无法联网|无法访问实时|无法获取实时|不能联网|请提供.{0,16}(链接|来源)/.test(text)) {
    out.push({
      code: 'stale',
      label: '自述无实时数据',
      detail: '回执声称知识截止/无法实时检索，内容可能不是最新事实，采纳前应人工核对',
      blocking: true,
    });
  }
  // T06089：比「知识截止」更隐蔽的一类假时效——模型承认检索结果不相关后，
  // 仍用「当前趋势/模板/示例」补出一篇看似完整的资讯。此类回执不能计为成功。
  if (/检索结果.{0,16}(无关|不相关|不匹配)|与主题无关|与任务无关|基于当前.{0,12}(趋势|判断|认知)|建议补充.{0,12}(真实|可靠).{0,8}(检索|来源)|实际使用时.{0,12}(建议|请)|推送模板|内容模板|示例内容|以下为示例|截至.{0,6}(年中|年底|上半年|下半年)/.test(text)) {
    out.push({
      code: 'stale',
      label: '检索不可用，回执为推测/模板',
      detail: '回执自述检索结果与主题无关，或用趋势/模板补写；内容缺少可核验来源，采纳前应人工核对',
      blocking: true,
    });
  }
  if (/搜索(结果|返回).{0,20}(无关|不相关|偏差|非目标|不可用|失败)|都是无关|无关的.{0,10}(网站|结果)|需改用.{0,24}(关键词|检索|搜索)|可能命中非目标|检索.{0,10}(偏差|不准|不可用|失败)/.test(text)) {
    out.push({
      code: 'stale',
      label: '检索结果不可用',
      detail: '回执把任务答成「检索失败/改进检索步骤」，没有产出任务要求的资讯内容；采纳前应人工核对',
      blocking: true,
    });
  }
  if (/检索(结果|返回)?.{0,40}(广告页|无任何关联|无关联|无关|不相关|无法提取有效|未获取到|没有获取到|均.{0,8}广告)|未获取到.{0,20}(新闻|资讯|内容|可用来源)|没有获取到.{0,20}(新闻|资讯|内容|可用来源)|缺失内容|更换检索策略|需重新.{0,12}(检索|执行)/.test(text)) {
    out.push({
      code: 'stale',
      label: '检索结果与任务无关',
      detail: '回执明确说明检索结果与任务无关/未获取到内容，任务实际未完成；采纳前应人工核对',
      blocking: true,
    });
  }
  if (/YOUR_[A-Z_]{3,}|替换\s*YOUR|<\s*token\s*>|请填入?[^\n]{0,12}(Key|密钥|Token)/i.test(text)) {
    out.push({ code: 'placeholder', label: '含待填密钥/占位符', detail: '回执含 YOUR_*、<token> 等占位符，不是可直接使用的结论', blocking: true });
  }
  if (/TODO|待补充|暂无内容|未生成|（本节未生成）/.test(text)) {
    out.push({ code: 'placeholder', label: '疑似占位内容', detail: '回执含 TODO/待补充/未生成等占位词，可能不是完整结论', blocking: true });
  }
  let description = '';
  let title = '';
  let webSources: string[] = [];
  let webSearchState: WebSearchState = 'off';
  let webItemText = '';
  try {
    const payload = JSON.parse(job.request_payload ?? '{}') as {
      title?: unknown;
      description?: unknown;
      webSources?: unknown;
      webSearchState?: unknown;
      webItems?: unknown;
    };
    title = String(payload.title ?? '');
    description = String(payload.description ?? '');
    if (Array.isArray(payload.webSources)) webSources = payload.webSources.filter((url): url is string => typeof url === 'string');
    if (payload.webSearchState === 'ok' || payload.webSearchState === 'empty' || payload.webSearchState === 'off') {
      webSearchState = payload.webSearchState;
    } else if (webSources.length > 0) {
      // 兼容 276 之前没有 webSearchState 的旧快照
      webSearchState = 'ok';
    }
    if (Array.isArray(payload.webItems)) {
      webItemText = payload.webItems
        .filter((item): item is { title?: unknown; url?: unknown } => !!item && typeof item === 'object')
        .map((item) => `${String(item.title ?? '')} ${String(item.url ?? '')}`)
        .join(' ');
    }
  } catch { /* request_payload 不是 JSON 时只看回执本身 */ }
  const hasUrl = /https?:\/\//i.test(text);
  const wantsSource = /来源|出处|引用|链接|标注/.test(description);
  const newsLike = isNewsLikeText(`${title}\n${description}`);
  const requiresSource = wantsSource || newsLike;
  if (webSearchState === 'empty') {
    if (hasUrl) {
      out.push({
        code: 'no_source',
        label: '检索失败但回执仍带链接',
        detail: '本次检索没有可用来源，回执中的链接不可核验，疑似编造',
        blocking: true,
      });
    } else if (requiresSource) {
      out.push({
        code: 'no_source',
        label: '检索无可用来源且回执无来源',
        detail: '本次检索没有可用来源，任务又要求可核验信息，回执没有给出任何来源链接',
        blocking: true,
      });
    }
  } else {
    if (requiresSource && !hasUrl) {
      out.push({
        code: 'no_source',
        label: '回执没有可核验来源',
        detail: webSearchState === 'ok'
          ? '本次已注入检索结果，但回执没有任何来源链接'
          : '任务要求或属于资讯/热点类内容，回执正文没有 http(s) 链接',
        blocking: true,
      });
    }
    // 来源必须来自发送时注入的检索结果；模型改写仓库名/路径同样视为不可核验。
    if (webSources.length > 0 && hasUrl) {
      const allowed = new Set(webSources.map(normalizeSourceUrl));
      const cited = [...new Set((text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).map(normalizeSourceUrl))];
      const unknown = cited.filter((url) => !allowed.has(url));
      if (unknown.length > 0) {
        out.push({
          code: 'no_source',
          label: '来源链接不在检索结果',
          detail: `回执引用了未注入的来源：${unknown.slice(0, 3).join('、')}；链接必须原样复制检索结果，不得改写仓库名或路径`,
          blocking: true,
        });
      }
    }
  }
  // T06060/T06059：任务给出了硬格式（分段/行数），回执不能只“看起来像资讯”。
  // 这些格式规则只对资讯/热点类任务生效，避免开发任务的“整理 3 条/按模块分段”被误伤。
  if (newsLike) {
    const sectionMatch = description.match(/按((?:[「“][^」”]+[」”][、，,]?)+)分段/);
    if (sectionMatch) {
      const names = [...sectionMatch[1].matchAll(/[「“]([^」”]+)[」”]/g)].map((m) => m[1]);
      const missing = names.filter((name) => !text.includes(name));
      if (missing.length > 0) {
        out.push({
          code: 'format',
          label: '未按任务要求分段',
          detail: `任务要求分段：${names.join(' / ')}；回执缺少：${missing.join(' / ')}`,
          blocking: true,
        });
      }
      if (names.includes('新项目')) {
        const section = text.match(/新项目([\s\S]*?)(?=版本更新|其他动态|$)/)?.[1] ?? '';
        const sectionEmpty = /本期无|无符合条件|暂无/.test(section);
        if (section && !sectionEmpty && !/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/i.test(section)) {
          out.push({
            code: 'format',
            label: '新项目段缺少 GitHub 仓库',
            detail: '任务要求 GitHub 上冒头的项目，「新项目」段必须列出 github.com/owner/repo 形式的仓库链接',
            blocking: true,
          });
        }
      }
      if (names.includes('版本更新')) {
        const section = text.match(/版本更新([\s\S]*?)(?=其他动态|$)/)?.[1] ?? '';
        // 优先用标题/URL 文本判断发布类来源；旧快照没有 webItems 时回落到 URL 关键词。
        const releaseText = `${webItemText} ${webSources.join(' ')}`;
        const hasReleaseSource = /introducing|release|new-model|announcement|发布|上线|新版本|正式推出/i.test(releaseText);
        if (section && /本期无/.test(section) && hasReleaseSource) {
          out.push({
            code: 'format',
            label: '版本更新段误报本期无',
            detail: '检索结果中存在发布类条目，但「版本更新」写本期无；发布类条目应归入该段',
            blocking: true,
          });
        }
      }
    }
    const lineLimit = description.match(/全文\s*(\d+)\s*行以内/);
    if (lineLimit) {
      const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
      if (nonEmptyLines > Number(lineLimit[1])) {
        out.push({
          code: 'format',
          label: '超出任务行数限制',
          detail: `任务要求全文不超过 ${lineLimit[1]} 行，回执非空行数为 ${nonEmptyLines}`,
          blocking: true,
        });
      }
    }
    const countRange = description.match(/(\d+)\s*[-~至]\s*(\d+)\s*条/);
    const countExact = countRange ? null : description.match(/(?:整理|筛选|输出|列出)\s*(\d+)\s*条/);
    const entryBlocks = splitReceiptEntries(text);
    if (countRange || countExact) {
      const min = countRange ? Number(countRange[1]) : Number(countExact![1]);
      const max = countRange ? Number(countRange[2]) : min;
      if (entryBlocks.length < min || entryBlocks.length > max) {
        out.push({
          code: 'format',
          label: '条目数量不符合任务要求',
          detail: `任务要求 ${countRange ? `${min}–${max}` : min} 条，回执识别到 ${entryBlocks.length} 条`,
          blocking: true,
        });
      }
    }
    // 任务要求“每条”附来源时，逐条检查；只在检索成功时做，检索失败由上面的 empty 分支处理。
    if (requiresSource && webSearchState !== 'empty' && entryBlocks.length > 0) {
      const missing = entryBlocks
        .map((block, index) => (/https?:\/\//i.test(block) ? 0 : index + 1))
        .filter((index) => index > 0);
      if (missing.length > 0) {
        out.push({
          code: 'no_source',
          label: '部分条目缺少来源',
          detail: `第 ${missing.join('、')} 条没有来源链接；任务要求每条信息附来源`,
          blocking: true,
        });
      }
    }
  }
  return out;
}

/** 详情行：Job 全字段 + 关联任务的展示字段（LEFT JOIN 结果，关联对象已删时为 null） */
export type QueueJobDetailRow = QueueJobRow & {
  task_title: string | null;
  task_no: string | null;
  task_priority: string | null;
  task_status: string | null;
  task_project_id: string | null;
  task_project_name: string | null;
  tool_name: string | null;
};

export interface QueueJobSummaryRow {
  /** 队列 id（与 queues.id 对齐，便于前端按 id 合并） */
  id: string;
  job_total: number;
  job_success: number;
  job_failed: number;
  job_timeout: number;
  job_pending: number;
  /** 成功但尚未采纳的回执数（队列列表用，提示还有多少结果待人工确认） */
  job_unadopted: number;
  /** 最近一次活动时刻（finished_at 优先，其次 sent_at；全无则为 null） */
  last_activity_at: string | null;
}

export interface QueueItemInput {
  taskId: string;
  toolId: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * 同步发送/提交会在 buildSender/buildSubmitter 中更新 request_payload；
 * 调用方持有的 job 对象仍是发送前的旧快照。自动完成质量门前必须重新读库，
 * 否则 source/format 检查拿不到本次注入的 webSources。
 */
function latestRequestPayload(jobId: string, fallback: string | null): string | null {
  try {
    const latest = getDb()
      .prepare('SELECT request_payload FROM queue_jobs WHERE id = ?')
      .get(jobId) as { request_payload: string | null } | undefined;
    return latest?.request_payload ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 提交单个 Job 并落库状态；返回该 Job 是否进入异步在途（受理 ticket，等待 poller 收敛）。
 * 从 submitAll 拆出以降低其认知复杂度；单 Job 提交异常按 failed 落库而不上抛，
 * 保证队列循环内单点失败不影响其余 Job（与拆分前行为一致）。
 */
/**
 * 队列自动回写（T00453 / PRD INT-4）——T06076 起默认**不自动完成**。
 * 队列成功只代表「回执已产出」，采纳才是闭环：默认把任务标为 unread（结果待阅），
 * 状态保持待办，避免出现「done 但处理结果为空」的窗口期。
 * 老行为保留为显式开关：`queue.autoCompleteTask=1` 时仍按原逻辑置 done。
 */
function autoCompleteQueueTask(
  taskId: string,
  requestPayload: string | null,
  responsePayload: string | null,
): void {
  try {
    const t = getDb().prepare('SELECT status, ai_state FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; ai_state: string }
      | undefined;
    if (!t || t.status === 'done') return;
    // T06089：即使「成功后自动完成」开启，质量门命中的回执也不能自动 done。
    // 否则「AI 自述无实时数据」这类拒答会被计为成功并留下空处理结果，用户只能看到已完成。
    const blocking = receiptWarnings({
      request_payload: requestPayload,
      response_payload: responsePayload,
    }).filter((w) => w.blocking);
    if (blocking.length > 0) {
      TaskService.setAiState(taskId, 'unread');
      logService.log('WARN', 'queue', `队列回执质量待核，跳过自动完成：task=${taskId.slice(0, 8)}，${blocking.map((w) => w.label).join('、')}`);
      return;
    }
    if (getSetting('queue.autoCompleteTask') === '1') {
      // T05747：CodeBuddy 网关/Relay 派发在 armTask 时置 ai_state=running；队列成功回写若只改 status，
      // 任务会停在「已 done 但 AI 运行中」的互斥态（前端仍转圈、MCP 也认为在执行）。
      // 这里随完成一次性把 running 收口为 unread（用户未读），非 running 的旧路径保持原行为。
      if (t.ai_state === 'running') {
        TaskService.update(taskId, { status: 'done', ai_state: 'unread', ai_state_at: new Date().toISOString() });
      } else {
        TaskService.setStatus(taskId, 'done');
      }
      logService.log('INFO', 'queue', `队列自动回写：task=${taskId.slice(0, 8)} → done（queue.autoCompleteTask=1）`);
      return;
    }
    // 默认路径：只标记「结果待阅」，任务仍留在待办，等用户采纳后再 done
    TaskService.setAiState(taskId, 'unread');
    logService.log('INFO', 'queue', `队列回执待采纳：task=${taskId.slice(0, 8)} 保持 todo / unread`);
  } catch (e) {
    logService.log('ERROR', 'queue', `队列回写失败：task=${taskId.slice(0, 8)}，${e instanceof Error ? e.message : String(e)}`);
  }
}

async function submitOneJob(
  job: QueueJobRow,
  submit: (job: QueueJobRow) => Promise<SubmitResult>,
): Promise<boolean> {
  const db = getDb();
  db.prepare("UPDATE queue_jobs SET status = 'sending', sent_at = ? WHERE id = ?").run(now(), job.id);
  logService.log('INFO', 'queue', `队列任务提交：job=${job.id.slice(0, 8)}（task=${job.task_id.slice(0, 8)}）`);
  try {
    const result = await submit(job);
    if (result.ok && typeof result.content === 'string') {
      // 同步完成：直接置 success（ticket 清空、submitted_at 记为完成时刻）
      db.prepare(
        "UPDATE queue_jobs SET status = 'success', response_payload = ?, error = NULL, ticket = NULL, submitted_at = ?, finished_at = ? WHERE id = ?",
      ).run(result.content, now(), now(), job.id);
      logService.log('INFO', 'queue', `队列任务同步完成：job=${job.id.slice(0, 8)}（响应 ${result.content.length} 字符）`);
      autoCompleteQueueTask(job.task_id, latestRequestPayload(job.id, job.request_payload), result.content);
      notifyChange('queue');
      return false;
    }
    if (result.ok && result.accepted) {
      // 异步受理：记录回执标识与提交时间，等待 poller 收敛
      db.prepare("UPDATE queue_jobs SET status = 'sending', ticket = ?, submitted_at = ? WHERE id = ?")
        .run(result.ticket ?? null, now(), job.id);
      logService.log('INFO', 'queue', `队列任务已受理（异步）：job=${job.id.slice(0, 8)}，等待回执收敛`);
      return true;
    }
    db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(result.error ?? '提交失败', now(), job.id);
    logService.log('ERROR', 'queue', `队列任务提交失败：job=${job.id.slice(0, 8)}，原因=${result.error ?? '提交失败'}`);
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(msg, now(), job.id);
    logService.log('ERROR', 'queue', `队列任务提交异常：job=${job.id.slice(0, 8)}，${msg}`);
    return false;
  }
}

/**
 * M6-6.1：单 Job 的发送与状态落库（与 submitOneJob 同构；原 sendAll 内联的逐 job 逻辑）。
 * 抛错在内部收敛为 failed，不中断整轮队列——个别 Job 失败不应让后续 Job 不发。
 */
async function sendOneJob(
  job: QueueJobRow,
  send: (job: QueueJobRow) => Promise<{ ok: boolean; content?: string; error?: string }>,
): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE queue_jobs SET status = 'sending', sent_at = ? WHERE id = ?").run(now(), job.id);
  try {
    const result = await send(job);
    db.prepare(
      "UPDATE queue_jobs SET status = ?, response_payload = ?, error = ?, finished_at = ? WHERE id = ?",
    ).run(result.ok ? 'success' : 'failed', result.content ?? null, result.error ?? null, now(), job.id);
    if (result.ok) autoCompleteQueueTask(job.task_id, latestRequestPayload(job.id, job.request_payload), result.content ?? null);
    notifyChange('queue');
  } catch (e) {
    db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(e instanceof Error ? e.message : String(e), now(), job.id);
  }
}

/**
 * FR4 每日任务队列：构建 → 触发 → Job 状态机（queued/sending/success/failed/timeout）→ 回执落库。
 * 参考：OpenHands Agent 控制器 / LibreChat Subagents 的轻量编排（同类产品分析报告 4.3）。
 */
export const QueueService = {
  /** T06076：回执质量提示（供路由/详情复用；模块级函数挂在对象上便于统一调用） */
  receiptWarnings: receiptWarnings,

  /** FR4.1 创建队列；T06245 增加 kind，旧调用默认 manual */
  create(name: string, date: string, kind: QueueKind = 'manual'): QueueRow {
    const db = getDb();
    const id = uuid();
    db.prepare('INSERT INTO queues (id, name, date, status, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, date, 'draft', now(), kind);
    this.clearListCache();
    return this.getById(id)!;
  },

  getById(id: string): QueueRow | null {
    const row = getDb().prepare('SELECT * FROM queues WHERE id = ?').get(id) as QueueRow | undefined;
    return row ?? null;
  },

  /** T06245：默认只返回人工队列；kind=all 才返回内部派发/中继队列，供「派发记录」只读视图 */
  list(kind: 'manual' | 'all' = 'manual') {
    const cacheKey = `queues:${kind}`;
    const cached = cacheGet<QueueRow[]>(cacheKey);
    if (cached) return cached;
    const rows = kind === 'all'
      ? getDb().prepare('SELECT * FROM queues ORDER BY date DESC, created_at DESC').all() as QueueRow[]
      : getDb().prepare("SELECT * FROM queues WHERE COALESCE(kind, 'manual') = 'manual' ORDER BY date DESC, created_at DESC").all() as QueueRow[];
    cacheSet(cacheKey, rows, LIST_TTL_MS);
    return rows;
  },

  /** 列表缓存按 kind 分键，任何队列写操作都要同时清两份 */
  clearListCache(): void {
    cacheClear('queues:manual');
    cacheClear('queues:all');
  },

  /**
   * 队列消费汇总（列表页「每个队列跑得怎么样」的数据源）。
   *
   * 为什么不并进 list()：list 走 5s 缓存，而 job 状态每 5s 就可能被后台 poller 改动，
   * 把聚合塞进带缓存的列表会让「进度条」与「详情」长期不一致；本查询是一次 GROUP BY，
   * 成本远低于跑一次全量任务列表，故不带缓存、由前端按需刷新。
   */
  summary(): QueueJobSummaryRow[] {
    return getDb().prepare(
      `SELECT j.queue_id AS id,
              COUNT(*) AS job_total,
              SUM(CASE WHEN j.status = 'success' THEN 1 ELSE 0 END) AS job_success,
              SUM(CASE WHEN j.status = 'failed'  THEN 1 ELSE 0 END) AS job_failed,
              SUM(CASE WHEN j.status = 'timeout' THEN 1 ELSE 0 END) AS job_timeout,
              SUM(CASE WHEN j.status IN ('queued','sending') THEN 1 ELSE 0 END) AS job_pending,
              SUM(CASE WHEN j.status = 'success'
                         AND length(trim(COALESCE(j.response_payload, ''))) > 0
                         AND COALESCE(j.adopted_at, '') = '' THEN 1 ELSE 0 END) AS job_unadopted,
              MAX(COALESCE(j.finished_at, j.sent_at)) AS last_activity_at
         FROM queue_jobs j
        GROUP BY j.queue_id`,
    ).all() as QueueJobSummaryRow[];
  },

  /** 队列重命名——名称自定义的第二段（新建时可自定义，建后仍可改） */
  rename(queueId: string, name: string): QueueRow {
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    getDb().prepare('UPDATE queues SET name = ? WHERE id = ?').run(name, queueId);
    this.clearListCache();
    return this.getById(queueId)!;
  },

  /**
   * 向队列追加任务项（绑定目标 AI 工具，支持跨项目）。
   *
   * 追加门槛从「仅 draft」放宽为「非 running」：队列跑完（finished/failed）后继续加任务再发一次，
   * 是用户对「队列」最自然的心智模型（submitAll 会跳过 success 项，新加的 queued 项才会被执行）。
   * 仍禁止 running：提交循环正在按 order_index 取当前快照，中途插入会造成「看得到但本轮不执行」的错位。
   */
  addJobs(queueId: string, items: QueueItemInput[]): QueueJobRow[] {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status === 'running') throw new Error('队列正在发送中，暂不可追加任务');
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM queue_jobs WHERE queue_id = ?').get(queueId) as { m: number }).m;
    const insert = db.prepare(
      `INSERT INTO queue_jobs (id, queue_id, task_id, tool_id, order_index, status) VALUES (?, ?, ?, ?, ?, 'queued')`
    );
    const ids: string[] = [];
    db.transaction(() => {
      items.forEach((item, i) => {
        const jobId = uuid();
        insert.run(jobId, queueId, item.taskId, item.toolId, maxOrder + 1 + i);
        ids.push(jobId);
      });
    })();
    return ids.map((id) => this.getJob(id)!);
  },

  getJob(id: string): QueueJobRow | null {
    const row = getDb().prepare('SELECT * FROM queue_jobs WHERE id = ?').get(id) as QueueJobRow | undefined;
    return row ?? null;
  },

  listJobs(queueId: string): QueueJobRow[] {
    return getDb().prepare('SELECT * FROM queue_jobs WHERE queue_id = ? ORDER BY order_index').all(queueId) as QueueJobRow[];
  },

  /**
   * 队列详情用：LEFT JOIN 附带任务标题/编号/优先级/归属项目与工具名称
   * （task/工具/项目都可能已删，一律 LEFT JOIN 保行，前端按 null 展示占位）。
   */
  listJobsDetailed(queueId: string): QueueJobDetailRow[] {
    return getDb().prepare(
      `SELECT j.*,
              t.title       AS task_title,
              t.task_no     AS task_no,
              t.priority    AS task_priority,
              t.status      AS task_status,
              t.project_id  AS task_project_id,
              p.name        AS task_project_name,
              a.name        AS tool_name
       FROM queue_jobs j
       LEFT JOIN tasks t    ON t.id = j.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN ai_tools a ON a.id = j.tool_id
       WHERE j.queue_id = ?
       ORDER BY j.order_index`
    ).all(queueId) as QueueJobDetailRow[];
  },

  /**
   * T06076：采纳单条成功回执——写入任务「处理结果」并持久标记 adopted_at。
   * 旧前端只调 /tasks/:id/adopt，服务端无法回写队列行的采纳态，刷新后按钮又出现；
   * 这里把「写结果」与「记采纳」收在同一入口，重复点击幂等返回 already。
   * force=false 时质量门会拦截「自述非实时/占位/无来源」的回执，必须用户确认后带 force 再调。
   */
  adoptJob(queueId: string, jobId: string, force = false): { job: QueueJobRow; task: TaskView; already: boolean; warnings: ReceiptWarning[] } {
    const job = this.getJob(jobId);
    if (!job || job.queue_id !== queueId) throw new Error('任务项不存在');
    if (job.status !== 'success') throw new Error('只有成功回执才可以采纳');
    const payload = job.response_payload?.trim();
    if (!payload) throw new Error('该任务项没有可采纳的回执');
    const existing = TaskService.getById(job.task_id);
    if (!existing) throw new Error('关联任务已删除，无法采纳');
    const warnings = receiptWarnings(job);
    if (job.adopted_at) return { job, task: existing, already: true, warnings };
    const blocking = warnings.filter((w) => w.blocking);
    if (blocking.length > 0 && !force) {
      throw new Error(`回执质量待确认：${blocking.map((w) => w.label).join('、')}。请核对内容后勾选「仍要采纳」`);
    }
    // 撤回采纳的恢复基线：只存三个会被 adoptContent 改动的字段
    const snapshot = JSON.stringify({
      status: existing.status,
      handle_result: existing.handle_result ?? '',
      ai_state: existing.ai_state ?? '',
    });
    const task = TaskService.adoptContent(job.task_id, payload);
    getDb().prepare('UPDATE queue_jobs SET adopted_at = ?, adopt_snapshot = ? WHERE id = ?').run(now(), snapshot, jobId);
    this.clearListCache();
    notifyChange('queue');
    return { job: this.getJob(jobId)!, task, already: false, warnings };
  },

  /**
   * T06076 兼容旧入口：POST /tasks/:id/adopt 只带任务与正文，不带队列信息。
   * 若正文能匹配到该任务最近一条成功回执，则转走 adoptJob（补 adopted_at + 撤回快照）；
   * 匹配不到（正文来自别处）才回退旧 TaskService.adoptContent，保持原有调用方可用。
   */
  adoptTaskContent(taskId: string, content: string): TaskView {
    const trimmed = content.trim();
    // SQLite 的 trim() 只去空格，不去 \r\n；回执正文常带结尾换行，必须在 JS 侧按同一口径比对，
    // 否则旧入口会「看起来匹配」却落回 TaskService，漏写 adopted_at/撤回快照。
    const rows = getDb().prepare(
      `SELECT id, queue_id, response_payload FROM queue_jobs
        WHERE task_id = ?
          AND status = 'success'
          AND length(trim(COALESCE(response_payload, ''))) > 0
        ORDER BY COALESCE(finished_at, sent_at, '') DESC`,
    ).all(taskId) as Array<{ id: string; queue_id: string; response_payload: string | null }>;
    const job = rows.find((r) => (r.response_payload ?? '').trim() === trimmed);
    if (job) return this.adoptJob(job.queue_id, job.id, true).task;
    return TaskService.adoptContent(taskId, content);
  },

  /**
   * T06076：撤回采纳——恢复采纳前的处理结果/任务状态/AI 状态，并清空队列行采纳标记。
   * 安全阀：若采纳后用户又改过处理结果（与回执正文不一致），拒绝自动撤回，避免覆盖新内容。
   */
  unadoptJob(queueId: string, jobId: string): { job: QueueJobRow; task: TaskView } {
    const job = this.getJob(jobId);
    if (!job || job.queue_id !== queueId) throw new Error('任务项不存在');
    if (!job.adopted_at) throw new Error('该回执尚未采纳，无需撤回');
    const task = TaskService.getById(job.task_id);
    if (!task) throw new Error('关联任务已删除，无法撤回');
    const payload = (job.response_payload ?? '').trim();
    if ((task.handle_result ?? '').trim() !== payload) {
      throw new Error('处理结果在采纳后已被修改，无法自动撤回；请到任务详情手动恢复');
    }
    let snap: { status?: string; handle_result?: string; ai_state?: string };
    try {
      snap = JSON.parse(job.adopt_snapshot ?? '{}') as typeof snap;
    } catch {
      throw new Error('采纳前快照损坏，无法撤回');
    }
    // 历史采纳（启动期回填 adopted_at）没有快照：不能凭回执假装恢复，明确提示人工处理
    if (!job.adopt_snapshot) {
      throw new Error('该回执是历史采纳记录，没有可恢复快照；请到任务详情手动处理');
    }
    // 若采纳前就是「done + 空处理结果」（旧入口的典型坏状态），撤回后回 todo，
    // 避免把任务重新放回「已完成但处理结果为空」的矛盾态。
    const restoringEmpty = (snap.handle_result ?? '').trim() === '';
    const patch: { handle_result: string; status: 'todo' | 'done'; ai_state?: string } = {
      handle_result: snap.handle_result ?? '',
      status: restoringEmpty ? 'todo' : (snap.status === 'done' ? 'done' : 'todo'),
    };
    // running 是「处理中」的瞬时态，撤回后回不到运行中的进程；回落 unread 表示结果仍需人工看
    if (snap.ai_state === 'running') patch.ai_state = 'unread';
    else if (snap.ai_state === 'unread' || snap.ai_state === 'failed' || snap.ai_state === '') patch.ai_state = snap.ai_state;
    const restored = TaskService.update(job.task_id, patch);
    getDb().prepare("UPDATE queue_jobs SET adopted_at = '', adopt_snapshot = '' WHERE id = ?").run(jobId);
    this.clearListCache();
    notifyChange('queue');
    return { job: this.getJob(jobId)!, task: restored };
  },

  /** T01298：移除队列中的单个任务项——sending（在途）不可移除，避免后台 poller 更新已删行 */
  removeJob(queueId: string, jobId: string): void {
    const job = this.getJob(jobId);
    if (job?.queue_id !== queueId) return;
    if (job.status === 'sending') throw new Error('任务正在发送中，不可移除');
    getDb().prepare('DELETE FROM queue_jobs WHERE id = ? AND queue_id = ?').run(jobId, queueId);
  },

  /** T01298：删除整个队列——queue_jobs 随 FK ON DELETE CASCADE 级联清理；running 中禁止删除 */
  remove(queueId: string): void {
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.status === 'running') throw new Error('队列正在发送中，不可删除');
    getDb().prepare('DELETE FROM queues WHERE id = ?').run(queueId);
    this.clearListCache();
  },

  /** FR4.2 触发：逐 Job 发送（串行保序）。由 AIService 注入真实发送函数，便于测试。 */
  async sendAll(queueId: string, send: (job: QueueJobRow) => Promise<{ ok: boolean; content?: string; error?: string }>) {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.paused) throw new Error('队列已暂停，请先继续后再发送');
    if (queue.status === 'running') throw new Error('队列正在发送中');
    db.prepare("UPDATE queues SET status = 'running' WHERE id = ?").run(queueId);
    const jobs = this.listJobs(queueId);
    try {
      for (const job of jobs) {
        if (job.status === 'success') continue; // 已成功的不重复发送
        await sendOneJob(job, send);
      }
      db.prepare("UPDATE queues SET status = 'finished' WHERE id = ?").run(queueId);
      return this.listJobs(queueId);
    } catch (e) {
      db.prepare("UPDATE queues SET status = 'failed' WHERE id = ?").run(queueId);
      throw e;
    }
  },

  /** FR4.5 失败重试：将 failed/timeout Job 重置为 queued */
  resetFailed(queueId: string): void {
    getDb().prepare("UPDATE queue_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE queue_id = ? AND status IN ('failed', 'timeout')")
      .run(queueId);
  },

  /** T01434：队列级暂停/继续 */
  setPaused(queueId: string, paused: boolean): void {
    getDb().prepare('UPDATE queues SET paused = ? WHERE id = ?').run(paused ? 1 : 0, queueId);
  },

  /** T01434：失败 Job 单条重试——仅 failed/timeout 可重试，重置为 queued */
  retryJob(queueId: string, jobId: string): void {
    const r = getDb().prepare("UPDATE queue_jobs SET status = 'queued', error = NULL, response_payload = NULL, finished_at = NULL WHERE id = ? AND queue_id = ? AND status IN ('failed', 'timeout')")
      .run(jobId, queueId);
    if (r.changes === 0) throw new Error('仅失败/超时的 Job 可重试');
  },

  /**
   * 异步提交（FR4.2 异步路径）：逐 Job 调用 submit()，不再阻塞等待完整结果。
   * - 同步即返回（accepted=false + content）→ 直接置 success
   * - 异步受理（accepted=true + ticket）→ 保持 sending 并记录 ticket/submitted_at，交由 pollPending 轮询收口
   * - 提交失败 → failed
   * 由 AIService.buildSubmitter 注入实际提交函数；对不支持 submit 的同步工具，该闭包自动回退 send。
   */
  async submitAll(queueId: string, submit: (job: QueueJobRow) => Promise<SubmitResult>) {
    const db = getDb();
    const queue = this.getById(queueId);
    if (!queue) throw new Error('队列不存在');
    if (queue.paused) throw new Error('队列已暂停，请先继续后再发送');
    if (queue.status === 'running') throw new Error('队列正在发送中');
    db.prepare("UPDATE queues SET status = 'running' WHERE id = ?").run(queueId);
    const jobs = this.listJobs(queueId);
    let anySending = false;
    try {
      for (const job of jobs) {
        if (job.status === 'success') continue; // 已成功的不重复提交
        if (await submitOneJob(job, submit)) anySending = true;
      }
      // 仍有异步在途 → 队列保持 running，待 poller 收敛后再置 finished
      db.prepare("UPDATE queues SET status = ? WHERE id = ?").run(anySending ? 'running' : 'finished', queueId);
      return this.listJobs(queueId);
    } catch (e) {
      db.prepare("UPDATE queues SET status = 'failed' WHERE id = ?").run(queueId);
      throw e;
    }
  },

  /**
   * 异步收口（FR4.2 回调/轮询路径）：轮询所有"已受理待回执"（sending + 有 ticket）的 Job。
   * - success → 写回 response_payload 并完成
   * - failed/timeout → 写失败并打时间戳
   * - running → 保持 sending 继续等待（超时判定由 buildPoller 依据各工具 timeoutMs 完成）
   * 队列内无在途 sending 时收敛为 finished。
   */
  async pollPending(poll: (job: QueueJobRow, ticket: string) => Promise<PollResult>): Promise<void> {
    const db = getDb();
    const jobs = db
      .prepare("SELECT * FROM queue_jobs WHERE status = 'sending' AND ticket IS NOT NULL")
      .all() as QueueJobRow[];
    const affectedQueues = new Set<string>();
    for (const job of jobs) {
      affectedQueues.add(job.queue_id);
      try {
        const result = await poll(job, job.ticket!);
        if (result.status === 'success') {
          db.prepare("UPDATE queue_jobs SET status = 'success', response_payload = ?, error = NULL, finished_at = ? WHERE id = ?")
            .run(result.content ?? null, now(), job.id);
          autoCompleteQueueTask(job.task_id, latestRequestPayload(job.id, job.request_payload), result.content ?? job.response_payload);
          notifyChange('queue');
        } else if (result.status === 'failed' || result.status === 'timeout') {
          db.prepare("UPDATE queue_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?")
            .run(result.status, result.error ?? null, now(), job.id);
        }
        // running → 不动
      } catch (e) {
        db.prepare("UPDATE queue_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
          .run(e instanceof Error ? e.message : String(e), now(), job.id);
      }
    }
    for (const qid of affectedQueues) {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM queue_jobs WHERE queue_id = ? AND status = 'sending'").get(qid) as { c: number };
      if (pending.c === 0) db.prepare("UPDATE queues SET status = 'finished' WHERE id = ?").run(qid);
    }
  },

  /** 快照任务上下文到 request_payload（发送前固化，避免任务被改导致回执错位） */
  snapshotTaskContext(task: TaskView, projectName: string, webContext = ''): string {
    const webSources = [...new Set((webContext.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])
      .map((url) => url.replace(/[.,;:!?)\]}）】。，、；："'”’]+$/g, '')))];
    // no-source 上下文也可能包含诊断里的 URL；优先按上下文语义判定，不能只看 URL 数量。
    const noSourceContext = /^联网检索：已尝试公开搜索，但没有获取到可用来源/.test(webContext);
    const webSearchState: WebSearchState = !webContext ? 'off' : noSourceContext || webSources.length === 0 ? 'empty' : 'ok';
    return JSON.stringify({
      taskId: task.id,
      title: task.title,
      description: task.description,
      aiSummary: task.ai_summary,
      projectName,
      priority: task.priority,
      // 用于回执来源链接核验：只允许引用发送时注入的检索结果
      webSources,
      webSearchState,
      webItems: parseWebContextItems(webContext),
    }, null, 2);
  },
};
