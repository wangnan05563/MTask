/**
 * 八期 §3.2 任务详情抽屉「Git」页：提交卡（五层）+ 变更文件清单（懒加载）+ 手动绑定/解绑 + 子任务折叠区。
 *
 * 口径要点（PRD 定死）：
 *  - 首屏只取摘要 + 统计（`GET /tasks/:id/git`），文件清单与 diff 按选中提交懒加载（`?diff=1`）；
 *  - 每次打开该标签实时查询；点「刷新」时**保留旧内容**，不闪烁清空（§3.2.2）；
 *  - 失败按 `no-git / not-a-repo / no-remote / timeout / too-large / no-workspace` 分类给可操作指引，
 *    未绑定工作空间直接给 `WorkspaceSelect` 入口；
 *  - 解绑仅 `source='manual'`，二次确认；AI 回写的关联由服务端 409 点名原因，前端如实回显不假装成功。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GitCommitCard, type GitFilesResult, type GitTaskView, type Project, type Task } from '../api/client';
import { CopyButton } from '../ui/CopyButton';
import { DiffFileView } from '../ui/DiffView';
import { GitTreePickerModal } from '../ui/GitTreePickerModal';
import { WorkspaceSelect } from '../ui/WorkspaceSelect';
import { askConfirm } from '../ui/dialogs';
import { gitDegradedText } from '../ui/gitBadge';
import { fullTime, relTime } from '../ui/format';
import { PILL } from '../ui/primitives';
import { ExternalLink, GitBranch, Loader2, RefreshCw, Unlink, User } from 'lucide-react';

const FONT_MONO = 'Consolas, Menlo, monospace';

/** 变更状态：字母 + 颜色双通道（§4.4 可访问性——不只靠颜色） */
const FILE_STATUS: Record<string, { color: string; label: string }> = {
  A: { color: 'var(--success)', label: '新增' },
  M: { color: 'var(--warn)', label: '修改' },
  D: { color: 'var(--danger)', label: '删除' },
  R: { color: 'var(--accent)', label: '重命名' },
  C: { color: 'var(--accent)', label: '复制' },
  T: { color: 'var(--warn)', label: '类型变更' },
};

const PLATFORM_LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee' };

/** 外链仅允许 http/https（与服务端 `isSafeExternalUrl` 同口径的渲染层二次校验） */
function safeHref(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export function GitCommitTab({ task, projectId, projects, onBindChange, onBindWorkspace, flash }: {
  readonly task: Task;
  readonly projectId: string;
  readonly projects: Project[];
  /** 绑定/解绑成功后回报：父级据此就地刷新列表内联的 gitLinks/gitLinkCount */
  readonly onBindChange: () => void;
  /** 绑定工作空间走父级既有通道（含服务端绝对路径校验） */
  readonly onBindWorkspace?: (path: string) => Promise<void>;
  readonly flash: (m: string) => void;
}) {
  const [view, setView] = useState<GitTaskView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filesBySha, setFilesBySha] = useState<Record<string, GitFilesResult>>({});
  const [filesBusy, setFilesBusy] = useState<string>('');
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [foldedHunks, setFoldedHunks] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const firstLoad = useRef(true);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  /** 实时取数：`keepOld` 语义——刷新期间保留旧内容（§3.2.2 不闪烁清空） */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await api.get<GitTaskView>(`/tasks/${task.id}/git`);
      setView(next);
      // 选中态跟随：首屏默认选中第一张卡（主提交）；刷新后若原选中提交还在则保持
      setSelected((prev) => (prev && next.commits.some((c) => c.sha === prev) ? prev : next.commits[0]?.sha ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      firstLoad.current = false;
    }
  }, [task.id]);

  useEffect(() => { void load(); }, [load]);

  // 子任务折叠区（§3.2.1 新增）：Sonar 回写的子任务要在详情侧可见
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const all = await api.get<Task[]>(`/tasks?projectId=${encodeURIComponent(projectId)}&limit=500`, ac.signal);
        setSubtasks((Array.isArray(all) ? all : []).filter((t) => t.parent_id === task.id));
      } catch {
        setSubtasks([]);
      }
    })();
    return () => ac.abort();
  }, [projectId, task.id]);

  /** 文件清单 + diff 懒加载：只在选中提交时打一次，切走再回来复用已取到的结果 */
  const loadFiles = useCallback(async (sha: string) => {
    if (filesBySha[sha]) return;
    setFilesBusy(sha);
    try {
      const res = await api.get<GitFilesResult>(`/tasks/${task.id}/git/${sha}/files?diff=1`);
      setFilesBySha((prev) => ({ ...prev, [sha]: res }));
    } catch (e) {
      setFilesBySha((prev) => ({ ...prev, [sha]: { files: [], degraded: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } } }));
    } finally {
      setFilesBusy('');
    }
  }, [task.id, filesBySha]);

  useEffect(() => { if (selected) void loadFiles(selected); }, [selected, loadFiles]);

  async function bindShas(shas: string[]) {
    let ok = 0;
    const failed: string[] = [];
    for (const sha of shas) {
      try {
        await api.post(`/tasks/${task.id}/git/links`, { sha });
        ok += 1;
      } catch (e) {
        failed.push(`${sha.slice(0, 7)}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setPickerOpen(false);
    if (ok) {
      flash(`已关联 ${ok} 条提交${failed.length ? `，${failed.length} 条失败` : ''}`);
      onBindChange();
      await load();
    }
    if (failed.length) flash(`绑定失败：${failed.join('；')}`);
  }

  async function unlink(sha: string) {
    setUnlinkError('');
    // zIndex 1200：本组件在任务详情抽屉（SlideOver，z-index 1100）内，默认 1000 的确认面板会被抽屉盖住——
    // 「确定」点不着，且面板外 mousedown 即取消，解绑永远走不完二次确认（八期 §3.2.4，真机 UI-26 打回后修复）
    const sure = await askConfirm('解除该手动绑定？AI 回写的关联不受影响', { zIndex: 1200 });
    if (!sure) return;
    try {
      await api.del(`/tasks/${task.id}/git/links/${sha}`);
      flash('已解绑');
      onBindChange();
      await load();
    } catch (e) {
      // 409（agent 来源）/ 404 等原因如实点名，不静默
      const msg = e instanceof Error ? e.message : String(e);
      setUnlinkError(msg);
      flash(msg);
    }
  }

  function toggleFile(key: string) {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleHunk(key: string) {
    setFoldedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const degraded = view?.degraded;
  const cards = view?.commits ?? [];
  const remote = view?.remote;
  const platformLabel = remote?.platform ? PLATFORM_LABEL[remote.platform] ?? remote.platform : '';

  return (
    <div data-t03362="git-tab">
      {/* 区头：刷新（保留旧内容）+ 关联提交入口 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <button type="button" data-t03362="refresh" className="tbtn-anim" onClick={() => void load()} disabled={loading}
          aria-label="刷新 Git 数据" title="重新查询当前工作空间的 Git 数据（刷新期间保留旧内容）"
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {loading ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />}刷新
        </button>
        <button type="button" data-t03362="bind" className="tbtn-anim" onClick={() => setPickerOpen(true)}
          aria-label="关联提交" title="从 Git 树手动选择提交并关联本任务"
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <GitBranch size={13} />关联提交
        </button>
        {platformLabel && <span style={PILL} data-t03362="platform">{platformLabel}</span>}
        {remote?.display && (
          <span title={remote.display} style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', fontFamily: FONT_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
            {remote.display}
          </span>
        )}
        {loading && !cards.length && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>取数中…</span>}
      </div>

      {error && <p data-t03362="error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>{error}</p>}
      {unlinkError && <p data-t03362="unlink-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>{unlinkError}</p>}

      {/* 降级：分类原因 + 可操作指引（未绑定工作空间给 WorkspaceSelect） */}
      {degraded && (
        <div data-t03362="degraded" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: 8, marginBottom: 10 }}>
          {gitDegradedText(degraded.kind, degraded.message)}
          {degraded.kind === 'no-workspace' && project && onBindWorkspace && (
            <div style={{ marginTop: 6 }}><WorkspaceSelect project={project} onBind={onBindWorkspace} flash={flash} /></div>
          )}
        </div>
      )}

      {/* 解析不出的 SHA（工作空间换绑后的旧链接）——点名，不静默 */}
      {view && view.missing.length > 0 && (
        <p data-t03362="missing" style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)', margin: '4px 0' }}>
          提交已不在当前仓库（工作空间换绑或未 fetch）：{view.missing.map((s) => s.slice(0, 7)).join('、')}
        </p>
      )}

      {!degraded && !error && !loading && !cards.length && (
        <div data-t03362="empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: '8px 0' }}>
          该任务还没有关联提交。可点上方「关联提交」手动绑定，或由外部 AI Agent 通过 MCP <code>mtask_link_git_commit</code> 回写。
        </div>
      )}

      {/* 提交卡（时间倒序；首张为主提交） */}
      {cards.map((c, i) => (
        <CommitCard key={c.sha} card={c} primary={i === 0} platformLabel={platformLabel}
          selected={selected === c.sha} onSelect={() => setSelected(c.sha)} onUnlink={() => void unlink(c.sha)} />
      ))}

      {/* 选中提交的文件清单（懒加载） */}
      {selected && (
        <div data-t03362="files" style={{ marginLeft: 10, marginTop: 8 }}>
          {filesBusy === selected && <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>文件清单取数中…</p>}
          {renderFileList()}
        </div>
      )}

      {/* 子任务折叠区（仅存在子任务时出现） */}
      {subtasks.length > 0 && (
        <div data-t03362="subtasks" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <button type="button" onClick={() => setSubtasksOpen((v) => !v)} aria-expanded={subtasksOpen}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-s)', padding: 0 }}>
            {subtasksOpen ? '▾' : '▸'} 子任务 {subtasks.length}
          </button>
          {subtasksOpen && subtasks.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
              <span style={{ fontFamily: FONT_MONO }}>{s.task_no}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }} title={s.title}>{s.title}</span>
              <span>{s.status === 'done' ? '已完成' : '待办'}</span>
            </div>
          ))}
        </div>
      )}

      {pickerOpen && (
        <GitTreePickerModal projects={project ? [project] : []} activeProjectId={projectId}
          selectedByProject={{}} onConfirm={(_pid, shas) => void bindShas(shas)} onClose={() => setPickerOpen(false)}
          zIndex={1200} />
      )}
    </div>
  );

  function renderFileList() {
    const res = selected ? filesBySha[selected] : undefined;
    if (!res) return null;
    if (res.degraded) {
      return <p data-t03362="files-degraded" style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>{gitDegradedText(res.degraded.kind, res.degraded.message)}</p>;
    }
    if (!res.files.length) {
      return <p data-t03362="files-empty" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>该提交没有变更文件。</p>;
    }
    return (
      <>
        {res.truncated && <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>文件清单过大，已截断显示。</p>}
        {res.files.map((f) => {
          const key = `${selected}|${f.path}`;
          const open = openFiles.has(key);
          const d = selected ? res.diffs?.[f.path] : undefined;
          const tone = FILE_STATUS[f.status] ?? { color: 'var(--text-muted)', label: f.status };
          return (
            <div key={f.path} style={{ marginTop: 2 }}>
              <button type="button" data-t03362={`file-${f.status}`} onClick={() => toggleFile(key)} aria-expanded={open}
                title={`${tone.label} — 点击${open ? '收起' : '展开'}差异`}
                style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'var(--fs-xs)', width: '100%', textAlign: 'left', fontFamily: FONT_MONO }}>
                <span style={{ color: tone.color, fontWeight: 600, width: 14, flexShrink: 0 }} aria-label={`变更状态 ${f.status}（${tone.label}）`}>{f.status}</span>
                <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                </span>
                {f.binary
                  ? <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>二进制</span>
                  : <span style={{ flexShrink: 0 }}>
                    <span style={{ color: 'var(--success)' }}>+{f.additions ?? 0}</span>{' '}
                    <span style={{ color: 'var(--danger)' }}>-{f.deletions ?? 0}</span>
                  </span>}
              </button>
              {d && (
                <DiffFileView path={f.path} oldPath={f.oldPath} binary={f.binary}
                  additions={f.additions ?? 0} deletions={f.deletions ?? 0} hunks={d.hunks}
                  open={open} onToggleFile={() => toggleFile(key)}
                  foldedHunks={foldedHunks} onToggleHunk={toggleHunk} hunkKeyPrefix={key}
                  rowDomId={(hunkIndex, rowIndex) => `${key}|${hunkIndex}|${rowIndex}`}
                  rowAttr="data-t03362-row"
                  truncatedNote={d.truncated ? '差异过大，已保头保尾截断（单文件上限 2MB）' : undefined} />
              )}
            </div>
          );
        })}
      </>
    );
  }
}

/** 提交卡五层（§3.2.1）：作者·时间 / 主题 / 变更统计 / 分支标签胶囊 / SHA+复制+外链 */
function CommitCard({ card, primary, platformLabel, selected, onSelect, onUnlink }: {
  readonly card: GitCommitCard;
  readonly primary: boolean;
  readonly platformLabel: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onUnlink: () => void;
}) {
  const href = safeHref(card.commitUrl);
  const sourceLabel = card.source === 'agent' ? 'AI 回写' : card.source === 'manual' ? '手动绑定' : card.source;
  return (
    <div data-t03362="commit-card" data-sha={card.sha} role="button" tabIndex={0} onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      aria-label={`提交 ${card.sha}，作者 ${card.author}，${card.subject}`}
      aria-pressed={selected}
      style={{
        border: '1px solid var(--border-strong)', borderLeft: `3px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6, padding: '8px 10px', marginBottom: 8, cursor: 'pointer', background: 'var(--card-bg)',
      }}>
      {/* 角标行：主提交 / 来源 / 初始提交 / 新鲜度提示 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
        {primary && <span data-t03362="primary" style={{ ...PILL, background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>主提交</span>}
        <span data-t03362={`source-${card.source}`} style={PILL}>{sourceLabel}</span>
        {card.isInitial && <span data-t03362="initial" style={PILL}>初始提交</span>}
        {card.laterThanTask && <span data-t03362="later" style={{ ...PILL, color: 'var(--warn)' }} title="提交时间晚于任务更新时间——任务可能尚未记录本次改动">提交晚于任务更新时间</span>}
        {card.workspaceDrift && <span data-t03362="drift" style={{ ...PILL, color: 'var(--warn)' }} title="关联记录的工作空间与项目当前绑定不一致（换绑）">工作空间已换绑</span>}
      </div>
      {/* 1 作者 · 相对时间（绝对时间） */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        <User size={12} />
        <span title={fullTime(card.date)}>{card.author || '作者未知'} · {relTime(card.date)}（{fullTime(card.date)}）</span>
      </div>
      {/* 2 提交主题（单行截断，title 全文） */}
      <div data-t03362="subject" title={card.subject} style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
        {card.subject || '（无提交主题）'}
      </div>
      {/* 3 变更统计（首提交标「初始提交」，§3.2.1） */}
      <div data-t03362="stats" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
        {card.isInitial ? '初始提交：' : ''}已更改 {card.stats.files} 个文件, <span style={{ color: 'var(--success)' }}>{card.stats.additions ?? 0} 行插入(+)</span>
        {' / '}<span style={{ color: 'var(--danger)' }}>{card.stats.deletions ?? 0} 行删除(-)</span>
      </div>
      {/* 4 分支/标签胶囊（未知则省略） */}
      {card.refs.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          {card.refs.map((r) => <span key={r} data-t03362="ref" style={{ ...PILL, background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>{r}</span>)}
        </div>
      )}
      {/* 5 等宽简写 + 复制 + 外链（Gitee 无官方图标 → GitBranch + 文字） */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--accent)' }}>{card.shortSha}</span>
        <CopyButton getText={() => card.sha} size={13} title="复制完整提交 ID（40 位）" ariaLabel={`复制提交 ${card.sha} 完整 ID`} />
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" data-t03362="extlink"
            aria-label={`在${platformLabel || '远端'}打开提交 ${card.sha}`}
            title={`在${platformLabel || '远端'}打开提交`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textDecoration: 'none' }}>
            {platformLabel === 'Gitee' ? <GitBranch size={13} /> : <ExternalLink size={13} />}
            {platformLabel === 'Gitee' ? '在 Gitee 打开' : platformLabel || '打开'}
          </a>
        ) : (
          <span data-t03362="inapp" title={remoteHint(card)} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>站内查看</span>
        )}
        {card.source === 'manual' && (
          <button type="button" data-t03362="unlink" onClick={onUnlink}
            aria-label={`解绑手动绑定的提交 ${card.sha}`} title="解除该手动绑定（AI 回写的关联不可解绑）"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: 0 }}>
            <Unlink size={13} />解绑
          </button>
        )}
      </div>
    </div>
  );
}

function remoteHint(card: GitCommitCard): string {
  return card.commitUrl ? '外链不可用（仅允许 http/https）' : '未识别平台或仓库无 origin 远端 — 仅站内查看';
}
