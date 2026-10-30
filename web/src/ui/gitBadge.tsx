/**
 * 八期 §3.1 任务列表 Git 提交徽标（元信息行 + 看板卡）。
 *
 * 三条实现纪律（PRD 评审 #1/#3/#4 裁定，不要“顺手”改回去）：
 *  1. 列表是卡片行、没有表格列 → 徽标进**元信息行**（状态开关之后），看板卡是拖拽宿主，
 *     卡内**不得出现 `<a>` 或按钮**（T03213 判据），只放纯文本并由点击卡片进抽屉 Git 页；
 *  2. 列表行的悬浮摘要已由多行 `title` 升级为 HoverCard（Q14/REQ-071，批次 4）；**看板卡仍用 `title`**——
 *     卡内不得出现链接/按钮（判据 #1），富卡片的两个下钻入口在卡内是违规的；
 *  3. 外链只在平台可识别（GitHub/GitLab/Gitee/自建 GitLab）时渲染，前缀由服务端给出
 *     （凭据已剥离）；识别不出只显示「站内查看」，避免点了才发现是坏链。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react'; // T03393（§3.5 UI）：图标统一 lucide，不用字符图标与第三方品牌色
import { CopyButton } from './CopyButton';
import { HoverCard } from './HoverCard';
import { relTime, fullTime } from './format';
import type { GitCommitSummary, GitLinkSource, GitSummaryGroup, Task } from '../api/client';
import { api } from '../api/client';
import type { GitSummaries } from '../utils/gitSummaries';

/** 取数失败分类 → 可操作指引（§3.2.2 与列表降级共用一份，避免两处文案漂移） */
export const GIT_DEGRADED_HINT: Record<string, string> = {
  'no-git': '本机未安装 git 或不在 PATH — 安装后刷新即可显示提交信息',
  'not-a-repo': '绑定的目录不是 Git 仓库 — 请在项目里改绑正确的仓库目录',
  'no-remote': '该仓库未配置 origin 远端，已在站内展示',
  timeout: 'git 取数超时（30s）— 仓库过大或磁盘繁忙，请稍后重试',
  'too-large': 'git 输出超出上限（8MB）— 请缩小范围或改用抽屉单提交查看',
  failed: 'git 取数失败 — 详见抽屉 Git 页',
  'no-workspace': '项目未绑定工作空间 — 请先绑定仓库目录',
};

export function gitDegradedText(kind: string, message?: string): string {
  const hint = GIT_DEGRADED_HINT[kind] ?? 'Git 取数不可用';
  return message ? `${hint}（${message}）` : hint;
}

const SOURCE_LABEL: Record<GitLinkSource, string> = { agent: 'AI 回写', manual: '手动绑定', ci: 'CI 回写' };

/** §3.1.2 悬浮四要素：作者 · 绝对时间（相对时间） / 主题 / 来源 */
export function gitSummaryTitle(subject: GitInlineSubject, sha: string): string {
  const when = subject.date ? `${fullTime(subject.date)}（${relTime(subject.date)}）` : '时间未知';
  const lines = [
    `${subject.author || '作者未知'} · ${when}`,
    subject.subject || '（无提交主题）',
    `来源：${SOURCE_LABEL[subject.source] ?? subject.source}`,
  ];
  if (!subject.commitUrl) lines.push(subject.noRemote ? GIT_DEGRADED_HINT['no-remote'] : '未识别平台 — 仅站内查看');
  lines.push(`提交 ${sha}`);
  return lines.join('\n');
}

interface GitInlineSubject {
  author: string;
  date: string;
  subject: string;
  source: GitLinkSource;
  commitUrl?: string;
  noRemote?: boolean;
}

/** 「+N」浮层：一条任务的**全部**关联提交（列表内联只带最新一条，故此处按需拉取）。经 Portal 挂 body，见下方注释 */
function GitLinksPopover({ task, anchor, onClose }: {
  readonly task: Task;
  /** 触发元素的位置（浮层贴着它显示） */
  readonly anchor: { top: number; left: number };
  readonly onClose: () => void;
}) {
  const [rows, setRows] = useState<{ sha: string; shortSha: string; source: GitLinkSource; createdAt: string }[]>([]);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await api.get<{ links: { sha: string; shortSha: string; source: GitLinkSource; createdAt: string }[] }>(
          `/tasks/${task.id}/git/links`, ac.signal,
        );
        setRows(res.links ?? []);
      } catch (e) {
        if (ac.signal.aborted) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ac.abort();
  }, [task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div ref={ref} role="dialog" aria-label={`任务 ${task.task_no ?? ''} 的全部关联提交`}
      style={{ position: 'fixed', zIndex: 1200, inset: 0, background: 'transparent' }}
      onClick={(e) => { e.stopPropagation(); if (e.target === ref.current) onClose(); }}>
      <div style={{
        position: 'absolute', top: anchor.top + 4, left: Math.max(8, Math.min(anchor.left, (globalThis.innerWidth ?? 800) - 440)),
        maxWidth: 420, maxHeight: '60vh', overflow: 'auto',
        background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: 8,
        boxShadow: '0 6px 20px var(--overlay)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 'var(--fs-s)' }}>关联提交 {rows.length} 条</strong>
          <button type="button" onClick={onClose} aria-label="关闭关联提交列表" title="关闭（Esc）"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><X size={14} aria-hidden /></button>
        </div>
        {err && <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', margin: '4px 0' }}>{err}</p>}
        {!err && !rows.length && <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', margin: '4px 0' }}>暂无关联提交。</p>}
        {rows.map((r) => (
          <div key={r.sha} data-t03343="git-popover-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 'var(--fs-xs)' }}>
            <span style={{ fontFamily: 'Consolas, Menlo, monospace', color: 'var(--accent-ink)' }}>{r.shortSha}</span>
            <span style={{ color: 'var(--text-muted)' }}>{SOURCE_LABEL[r.source] ?? r.source}</span>
            <span style={{ color: 'var(--text-muted)' }}>{relTime(r.createdAt)}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <CopyButton getText={() => r.sha} size={12} title="复制完整提交 ID" ariaLabel={`复制提交 ${r.sha} 完整 ID`} />
            </span>
          </div>
        ))}
      </div>
    </div>,
    // 与 HoverCard 同一理由：任务行 `.cv-auto` 会把 fixed 后代按行裁掉（T01299 踩过），浮层必须挂 body
    globalThis.document.body,
  );
}

/**
 * 分支/标签装饰的展示归一：`%D` 原文里标签带 `tag:` 前缀（`tag: v2.5`），分支就是引用名（`main` / `origin/main`）。
 * `HEAD -> main` 已由服务端 `parseRefs()` 剥成 `main`，这里不再重复处理；空串直接丢弃（不渲染空徽标）。
 */
export function refLabel(ref: string): string {
  const t = ref.trim();
  return t.startsWith('tag: ') ? `tag ${t.slice(5)}` : t;
}

/**
 * Q14 富悬浮卡内容：§3.1.2 悬浮四要素 + 两个下钻动作。
 * 与多行 `title` 的差别不只是好看——这里能放下**整 40 位 SHA**（可选中）和「在远端查看 / 打开任务 Git 页」
 * 两个入口，而原生提示既不能承载交互，也会在长主题处被系统截断。
 */
function GitSummaryCard({ summary, sha, source, commitUrl, noRemote, onOpenGit }: {
  readonly summary: Pick<GitCommitSummary, 'author' | 'date' | 'subject' | 'refs'>;
  readonly sha: string;
  readonly source: GitLinkSource;
  readonly commitUrl?: string;
  readonly noRemote?: boolean;
  readonly onOpenGit: () => void;
}) {
  const when = summary.date ? `${fullTime(summary.date)}（${relTime(summary.date)}）` : '时间未知';
  const decor = (summary.refs ?? []).map(refLabel).filter(Boolean);
  return (
    <span data-t03394="git-summary-card" style={{ display: 'block' }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <strong style={{ color: 'var(--text)' }}>{summary.author || '作者未知'}</strong>
        <span style={{ color: 'var(--text-muted)' }}>{when}</span>
      </span>
      <span style={{ display: 'block', marginTop: 4, color: 'var(--text)', whiteSpace: 'normal' }}>
        {summary.subject || '（无提交主题）'}
      </span>
      {decor.length > 0 && (
        /* Q14 P1「分支标签装饰」：只在 %D 真有装饰时渲染，游离提交不造空壳 */
        <span data-t03394="card-refs" style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
          {decor.map((d) => (
            <span key={d} style={{
              fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)',
              borderRadius: 4, padding: '0 4px', lineHeight: '16px', whiteSpace: 'nowrap',
            }}>{d}</span>
          ))}
        </span>
      )}
      <span style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)' }}>
        来源：{SOURCE_LABEL[source] ?? source}
      </span>
      <span data-t03394="card-sha" style={{
        display: 'block', marginTop: 2, fontFamily: 'Consolas, Menlo, monospace',
        color: 'var(--accent-ink)', wordBreak: 'break-all', userSelect: 'text',
      }}>
        {sha}
      </span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {commitUrl && (
          <a href={commitUrl} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent-ink)', textDecoration: 'none' }} aria-label={`在远端查看提交 ${sha}`}>
            在远端查看
          </a>
        )}
        <button type="button" onClick={onOpenGit}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-ink)', fontSize: 'var(--fs-xs)', fontFamily: 'inherit' }}>
          打开任务 Git 页
        </button>
        {!commitUrl && (
          <span style={{ color: 'var(--text-muted)' }}>
            {noRemote ? GIT_DEGRADED_HINT['no-remote'] : '未识别平台 — 仅站内查看'}
          </span>
        )}
      </span>
    </span>
  );
}

export interface GitBadgeProps {
  readonly task: Task;
  readonly summaries: GitSummaries;
  /** 工具条「Git」开关（会话级）：关闭时整枚徽标不渲染 */
  readonly gitOn: boolean;
  /** 站内兜底：打开该任务抽屉的 Git 页 */
  readonly onOpenGit: (task: Task) => void;
  readonly flash?: (m: string) => void;
}

/** 元信息行徽标（§3.1.1 展示规则五行） */
export function GitBadge({ task, summaries, gitOn, onOpenGit }: GitBadgeProps) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  if (!gitOn) return null;

  const link = (task.gitLinks ?? [])[0];
  const extraCount = Math.max(0, (task.gitLinkCount ?? 0) - 1);

  if (!link) {
    if (task.status === 'done') {
      return (
        <span data-t03343="git-unlinked" title="任务已完成但未回写提交 ID，请 AI Agent 通过 MCP 回写或手动关联"
          aria-label="已完成但未回写提交"
          style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          未回写
        </span>
      );
    }
    return (
      <span data-t03343="git-none" title="该任务暂无关联提交" aria-label="暂无关联提交"
        style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        —
      </span>
    );
  }

  const degraded = summaries.degradedOfTask(task.id);
  if (degraded) {
    // 降级：灰字「不可用」+ 具体原因与指引；复制按钮隐藏（无摘要可复制）
    return (
      <span data-t03343="git-unavailable" title={gitDegradedText(degraded.kind, degraded.message)}
        aria-label={`Git 提交不可用：${gitDegradedText(degraded.kind, degraded.message)}`}
        style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        不可用
      </span>
    );
  }

  const summary = summaries.summaryOf(link.sha);
  if (!summary) {
    // 摘要未解析（本页请求尚未回来 / 该 SHA 已被截断或不在当前仓库）
    const group: GitSummaryGroup | undefined = summaries.groupOfTask(task.id);
    const gone = group?.missing.includes(link.sha);
    return (
      <span data-t03343="git-pending" title={gone ? `提交 ${link.shortSha} 已不在当前仓库（工作空间换绑或未 fetch）` : '提交摘要解析中…'}
        aria-label={gone ? '提交已不在当前仓库' : '提交摘要解析中'}
        style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {link.shortSha}
      </span>
    );
  }

  const remote = summaries.remoteOfTask(task.id);
  const commitUrl = remote?.commitBase ? `${remote.commitBase}/${link.sha}` : undefined;
  const aria = `${summary.author} ${relTime(summary.date)}：${summary.subject}；来源${SOURCE_LABEL[link.source] ?? link.source}；提交 ${link.sha}`;

  return (
    <span data-t03343="git-badge" data-ttask-git-sha={link.sha} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
      onClick={(e) => e.stopPropagation()}>
      {/* Q14（REQ-071）：列表内的悬浮详情从多行 title 升级成 HoverCard——原生提示放不下外链与整 SHA。
          title 因此摘掉（同一元素上两套提示会互相打架），读屏通道仍走 aria-label。 */}
      <HoverCard ariaLabel={`提交 ${link.sha} 摘要`} cardW={360} cardH={176}
        card={<GitSummaryCard summary={summary} sha={link.sha} source={link.source}
          commitUrl={commitUrl} noRemote={remote?.noRemote} onOpenGit={() => onOpenGit(task)} />}>
        {commitUrl ? (
          <a href={commitUrl} target="_blank" rel="noopener noreferrer" aria-label={`${aria} — 在远端查看`}
            style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'var(--fs-2xs)', color: 'var(--accent-ink)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
            {link.shortSha}
          </a>
        ) : (
          <button type="button" onClick={() => onOpenGit(task)} aria-label={aria}
            style={{ fontFamily: 'Consolas, Menlo, monospace', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--fs-2xs)', color: 'var(--accent-ink)', whiteSpace: 'nowrap' }}>
            {link.shortSha}
          </button>
        )}
      </HoverCard>
      <CopyButton getText={() => link.sha} size={12} title="复制完整提交 ID（40 位）" ariaLabel={`复制提交 ${link.sha} 完整 ID`} />
      {extraCount > 0 && (
        /* 与短 SHA 同一通道：悬停给样式化说明（原生 title 慢且不可控），点击仍开清单浮层 */
        <HoverCard ariaLabel={`另有 ${extraCount} 条关联提交`} cardW={260} cardH={64}
          card={<span style={{ color: 'var(--text)' }}>该任务另有 {extraCount} 条关联提交 — 点击查看清单</span>}>
          <button type="button" data-t03343="git-more"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setAnchor(anchor ? null : { top: r.bottom, left: r.left });
            }}
            aria-expanded={Boolean(anchor)}
            aria-label={`另有 ${extraCount} 条关联提交：点击查看清单`}
            style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            +{extraCount}
          </button>
        </HoverCard>
      )}
      {anchor && <GitLinksPopover task={task} anchor={anchor} onClose={() => setAnchor(null)} />}
    </span>
  );
}

/** 看板卡徽标：纯文本简写（卡内不得有链接/按钮），点击卡片由父级跳抽屉 Git 页 */
export function GitBoardBadge({ task, summaries, gitOn }: Omit<GitBadgeProps, 'onOpenGit'>) {
  if (!gitOn) return null;
  const link = (task.gitLinks ?? [])[0];
  if (!link) {
    if (task.status !== 'done') return null;
    return (
      <span data-t03343="board-git-unlinked" title="任务已完成但未回写提交 ID" style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
        未回写
      </span>
    );
  }
  const degraded = summaries.degradedOfTask(task.id);
  const summary = summaries.summaryOf(link.sha);
  const text = degraded ? '不可用' : link.shortSha;
  const title = degraded
    ? gitDegradedText(degraded.kind, degraded.message)
    : summary
      ? `${gitSummaryTitle({ author: summary.author, date: summary.date, subject: summary.subject, source: link.source }, link.sha)}\n点击卡片查看 Git 详情`
      : `提交 ${link.shortSha} — 摘要解析中`;
  return (
    <span data-t03343="board-git-badge" title={title} aria-label={`关联提交 ${link.sha}`}
      style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
      {text}{Math.max(0, (task.gitLinkCount ?? 0) - 1) > 0 ? ` +${(task.gitLinkCount ?? 1) - 1}` : ''}
    </span>
  );
}

/** 本页存在未解析摘要时的页脚提示（§3.1.6 与 T03214「分页剩余告知」同语言） */
export function gitTruncatedNote(summaries: GitSummaries): string {
  return summaries.anyTruncated ? '本页部分提交摘要未解析（单页唯一提交上限 200）' : '';
}
