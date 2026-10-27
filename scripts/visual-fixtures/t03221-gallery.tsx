/**
 * T03221（PM-302 ②）视觉回归夹具：六类组件的单源渲染样张（+ 优先级 ③ 的取值面）。
 *
 * 只由 `scripts/visual-components.mjs` 用 esbuild 打成 iife 后在 headless Chrome 里截图，
 * 不参与产品构建链（vite/electron 都不会引它）。
 * 主题令牌由脚本从 `web/src/settings.tsx` 抽出真实 `themeCss` 注入页面，所以基线画的就是产品那套变量。
 *
 * 每个 cell 一个组件类；`?theme=light|dark` 决定主题，`?cell=` 决定渲染哪一个。
 * 挂载完成后置 `window.__READY`，脚本轮询它再截图（避免半渲染假绿）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge } from '../../web/src/ui/Badge';
import { EmptyState } from '../../web/src/ui/EmptyState';
import { SlideOver } from '../../web/src/components/SlideOver';
import {
  BADGE, BTN_DANGER, BTN_ICON, BTN_PRIMARY, BTN_SECONDARY, FIELD, FIELD_INLINE, SELECT, SELECT_MINI, type BadgeTone,
} from '../../web/src/ui/primitives';
import {
  PRIORITY_LEVELS, priorityBadgeLabel, priorityColor, priorityShort, priorityTone, priorityWithP,
} from '../../web/src/ui/priority';

declare global {
  interface Window { __READY?: boolean }
}

const q = new URLSearchParams(location.search);
const cell = q.get('cell') ?? 'button';
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;

const wrap: React.CSSProperties = { padding: 10, background: 'var(--app-bg)', color: 'var(--text)', fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box', width: 320 };

function Demo() {
  if (cell === 'button') {
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={BTN_PRIMARY}>主按钮</button>
        <button style={BTN_SECONDARY}>次按钮</button>
        <button style={BTN_DANGER}>危险</button>
        <button style={BTN_ICON} aria-label="图标按钮">✎</button>
      </div>
    );
  }
  if (cell === 'input') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input style={{ ...FIELD, width: '100%' }} defaultValue="输入框" />
        <input style={FIELD_INLINE} defaultValue="行内编辑" />
        <textarea style={{ ...FIELD, width: '100%', height: 34 }} defaultValue="多行" />
      </div>
    );
  }
  if (cell === 'select') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select style={SELECT} defaultValue="normal">
          <option value="low">低优先级</option>
          <option value="normal">普通优先级</option>
          <option value="high">高优先级</option>
          <option value="urgent">极高优先级</option>
        </select>
        <select style={SELECT_MINI} defaultValue="P1">
          <option value="P1">P1</option>
          <option value="P2">P2</option>
        </select>
      </div>
    );
  }
  if (cell === 'badge') {
    const tones: BadgeTone[] = ['neutral', 'accent', 'success', 'warning', 'danger'];
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tones.map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
        <span style={BADGE}>裸样式</span>
      </div>
    );
  }
  if (cell === 'empty') {
    return <EmptyState icon="◇" title="还没有任务" hint="新建一条任务，或切换项目查看" action={{ label: '新建任务', onClick: () => {} }} />;
  }
  if (cell === 'priority') {
    // ③ 的取值面：同一映射在徽标色调、徽标文案、圆点短标签、P 档标注、看板左边框上的五个体观
    const dirty = ['urgent', 'high', 'normal', 'low', '', 'bogus'];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {dirty.map((p) => (
          <div key={p || 'empty'} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Badge tone={priorityTone(p)}>{priorityBadgeLabel(p)}</Badge>
            <span style={{ borderLeft: `3px solid ${priorityColor(p)}`, paddingLeft: 6, color: priorityColor(p), fontSize: 'var(--fs-xs)' }}>
              ●{priorityShort(p)} · {priorityWithP(p)}
            </span>
          </div>
        ))}
        <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>末两行为空值/脏值兜底（normal 与灰）；档位共 {PRIORITY_LEVELS.length}</div>
      </div>
    );
  }
  // 抽屉：真组件（SlideOver）常开渲染，面板收窄到夹具宽度以内
  return (
    <div style={{ position: 'relative', height: 180 }}>
      <SlideOver open title="任务详情" onClose={() => {}} width={200}>
        <div style={{ fontSize: 'var(--fs-s)' }}>抽屉内容</div>
      </SlideOver>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={wrap}><Demo /></div>
  </StrictMode>,
);
requestAnimationFrame(() => requestAnimationFrame(() => { window.__READY = true; }));
