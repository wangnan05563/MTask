/**
 * T03262（PRD AI-101 ①④）：非报表卡的溯源面板 + 产物条。
 *
 * 报表卡（ReportPage）的溯源行随 SSE done 下发；其余卡（PRD/用例/讲稿/两张 PPT）的生成端点
 * 分散在 routes/index.ts 与 plans.ts，改动面太大，改为「生成端落库快照 + 面板按 cardKey 取回」：
 * 这里的 rows 与导出稿、ai_artifacts.provenance 是同一份 `recordCardProvenance` 落下的数据，逐字同源。
 *
 * 展开态按卡记忆（localStorage `card.prov.<cardKey>`），窄屏默认折叠；有截断时该行标警示色。
 */
import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import { CopyButton } from '../ui/CopyButton';
import { desktopApi } from '../ui/desktop';
import { usePersistentState } from '../ui/session';
import type { ReportArtifactView } from '../reportStream';

/** 与服务端 CardProvenance 逐字段对齐（plans.ts GET /ai-card-provenance 的原样返回） */
export interface CardProvenanceView {
  cardKey: string;
  generatedAt: string;
  truncated: boolean;
  rows: ReadonlyArray<{ label: string; value: string }>;
}

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia?.('(max-width: 820px)').matches ?? false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.('(max-width: 820px)');
    if (!mq) return undefined;
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** 溯源面板：行文案来自 `buildCardProvenance`（与导出稿逐字一致） */
export function CardProvenancePanel({ provenance }: { readonly provenance: CardProvenanceView }) {
  const narrow = useNarrowViewport();
  const [remembered, setRemembered] = usePersistentState<boolean | null>(`card.prov.${provenance.cardKey}`, null);
  const expanded = remembered ?? !narrow;
  // 宽度变化/默认值驱动的 open 改写也会触发 toggle 事件——那不是用户选择，记下来会让窄屏永远打不开
  const lastExpanded = useRef(expanded);
  useEffect(() => { lastExpanded.current = expanded; }, [expanded]);
  return (
    <details open={expanded} data-t03262="provenance" data-card={provenance.cardKey}
      onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open;
        if (open === lastExpanded.current) return;
        setRemembered(open);
      }}
      style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', background: 'var(--surface-1)' }}>
      <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', fontWeight: 600 }}>
        溯源（数据来源 / 时间窗 / 截断 / 模型）{provenance.truncated ? '⚠' : ''}
      </summary>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-s)', lineHeight: 1.5 }}>
        {provenance.rows.map((r) => (
          <div key={r.label}>
            <span style={{ color: 'var(--text-muted)' }}>{r.label}：</span>
            <span style={{ color: r.label === '截断' && provenance.truncated ? 'var(--warn)' : 'var(--text-secondary)' }}>{r.value}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

/** 产物条：路径常驻 + 复制路径 + 打开目录；文件被清理时照实提示（AI-101 ⑥：不给死链） */
export function CardArtifactStrip({ artifact }: { readonly artifact: ReportArtifactView }) {
  const revealPath = desktopApi()?.revealPath;
  const gone = artifact.exists === false;
  return (
    <div data-t03262="artifact" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
      <div style={{ wordBreak: 'break-all' }}>产物路径：<code style={{ fontSize: 'var(--fs-xs)' }}>{artifact.path}</code></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <CopyButton getText={() => artifact.path} title="复制产物路径" ariaLabel="复制产物路径" />
        <button
          onClick={() => void revealPath?.(artifact.path)}
          disabled={!revealPath || gone}
          title={gone ? '文件已不在（可能已被清理）' : revealPath ? '在文件管理器中定位该产物' : '仅桌面端可用'}
          aria-label="打开目录"
          style={{ padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: revealPath && !gone ? 'pointer' : 'not-allowed', color: revealPath && !gone ? 'var(--text-secondary)' : 'var(--text-muted)' }}
        >
          <FolderOpen size={12} /> 打开目录
        </button>
        {gone && <span style={{ color: 'var(--danger)' }}>文件已不在</span>}
      </div>
    </div>
  );
}

/**
 * 卡片结果区的溯源 + 产物一体块：按 cardKey 取最近一次生成落下的快照与最近一份产物。
 * `refreshKey` 由面板在生成结束时变化（如 done 的文件名），触发重取；无历史时整块不渲染。
 */
export function AiProvenanceSection({ cardKey, projectId, refreshKey }: {
  readonly cardKey: string;
  readonly projectId?: string | null;
  readonly refreshKey?: string | number | null;
}) {
  const [prov, setProv] = useState<CardProvenanceView | null>(null);
  const [artifact, setArtifact] = useState<ReportArtifactView | null>(null);
  useEffect(() => {
    let alive = true;
    const pid = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
    api.get<{ ok: boolean; provenance: CardProvenanceView | null }>(`/plans/ai-card-provenance?cardKey=${encodeURIComponent(cardKey)}${pid}`)
      .then((r) => { if (alive) setProv(r.provenance ?? null); })
      .catch(() => { /* 无快照或接口异常：不渲染即可，不打断主流程 */ });
    api.get<{ ok: boolean; artifacts: ReportArtifactView[] }>(`/report/artifacts?cardKey=${encodeURIComponent(cardKey)}&limit=1`)
      .then((r) => { if (alive) setArtifact(r.artifacts?.[0] ?? null); })
      .catch(() => { /* 同上 */ });
    return () => { alive = false; };
  }, [cardKey, projectId, refreshKey]);
  if (!prov && !artifact) return null;
  return (
    <div data-t03262="card-provenance" data-card={cardKey}>
      {artifact && <CardArtifactStrip artifact={artifact} />}
      {prov && <CardProvenancePanel provenance={prov} />}
    </div>
  );
}
