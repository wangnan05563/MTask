import { Bot, Check, Download, FileSpreadsheet, FileText, ListTodo, Loader2, Moon, RotateCw, ScanSearch, Sun, Upload } from 'lucide-react';

/**
 * T00708：各菜单向导的轻量 CSS 动画演示（对齐项目管理向导 T00665 的 StepDemo 水准）。
 * 约束：无录屏、纯 CSS、随组件复用；keyframes 沿用 `pg-` 前缀规范（本文件统一 `pgd-` 二级前缀），
 * 颜色全部走主题 CSS 变量，亮暗主题下均可见。
 */

const box: React.CSSProperties = {
  background: 'var(--surface-2, rgba(0,0,0,.03))', border: '1px solid var(--border)', borderRadius: 8,
  padding: 10, minHeight: 108, position: 'relative', overflow: 'hidden', fontSize: 11,
};
const line = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 6px', ...extra,
});
const DemoStyle = ({ css }: { readonly css: string }) => <style>{css}</style>;

/** 任务菜单 · 步骤1：待办行逐条滑入 + 完成勾选 */
export function TaskRowsDemo() {
  return (
    <div style={box} aria-label="任务列表流转演示">
      <DemoStyle css={`@keyframes pgd-row-in { 0% { opacity:0; transform:translateX(-10px) } 30%,85% { opacity:1; transform:none } 100% { opacity:.35 } }
        .pgd-row { animation: pgd-row-in 3.6s ease-out infinite both; }`} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="pgd-row" style={{ ...line({ marginTop: i ? 5 : 0, display: 'flex', alignItems: 'center', gap: 6, animationDelay: `${i * 0.5}s` }) }}>
          <Check size={11} style={{ color: i === 2 ? 'var(--success)' : 'var(--text-muted)' }} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {['T007xx 修复导入关联覆盖', 'T007xx 跨项目关联校验', 'T007xx 超大文件 413 提示'][i]}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>{['high', 'normal', 'high'][i]}</span>
        </div>
      ))}
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>按项目分组 → 逐条处理 → 完成归入「已完成」</div>
    </div>
  );
}

/** 任务菜单 · 步骤2：AI 状态流转（转圈 → 绿点 → 红标循环） */
export function AiStateDemo() {
  const st = (extra?: React.CSSProperties): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, ...line(), ...extra });
  return (
    <div style={box} aria-label="AI 状态流转演示">
      <DemoStyle css={`@keyframes pgd-cycle { 0%,28% { opacity:1 } 33%,61% { opacity:.18 } 66%,94% { opacity:.18 } 100% { opacity:1 } }
        @keyframes pgd-cycle2 { 0%,28% { opacity:.18 } 33%,61% { opacity:1 } 66%,94% { opacity:.18 } 100% { opacity:.18 } }
        @keyframes pgd-cycle3 { 0%,28% { opacity:.18 } 33%,61% { opacity:.18 } 66%,94% { opacity:1 } 100% { opacity:.18 } }
        .pgd-c1 { animation: pgd-cycle 3.6s infinite; } .pgd-c2 { animation: pgd-cycle2 3.6s infinite; } .pgd-c3 { animation: pgd-cycle3 3.6s infinite; }
        @keyframes pgd-spin { to { transform: rotate(360deg) } } .pgd-spin { animation: pgd-spin 1s linear infinite; }`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span className="pgd-c1" style={st()}><Loader2 size={12} className="pgd-spin" style={{ color: 'var(--accent)' }} /> running · AI 处理中</span>
        <span className="pgd-c2" style={st()}><span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--success)', display: 'inline-block' }} /> unread · 完成待查看</span>
        <span className="pgd-c3" style={st()}><span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--danger)', display: 'inline-block' }} /> failed · 中断可重试</span>
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}><ScanSearch size={11} style={{ verticalAlign: '-2px' }} /> 「AI回写待审核」单：展开结果 → 人工审核转正</div>
    </div>
  );
}

/** 任务菜单 · 步骤3：多选批量操作 */
export function BatchDemo() {
  return (
    <div style={box} aria-label="多选批量操作演示">
      <DemoStyle css={`@keyframes pgd-check { 0%,35% { transform:scale(.4); opacity:.2 } 55%,100% { transform:scale(1); opacity:1 } }
        @keyframes pgd-bar { 0%,45% { opacity:0; transform:translateY(8px) } 65%,100% { opacity:1; transform:none } }
        .pgd-ck { animation: pgd-check 3.6s infinite both; } .pgd-bbar { animation: pgd-bar 3.6s infinite both; }`} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...line({ marginTop: i ? 5 : 0, display: 'flex', alignItems: 'center', gap: 6 }) }}>
          <span className="pgd-ck" style={{ width: 11, height: 11, border: '1px solid var(--accent)', borderRadius: 3, background: 'var(--accent-soft)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', animationDelay: `${i * 0.35}s` }}>
            <Check size={9} style={{ color: 'var(--accent)' }} />
          </span>
          待办任务 {['A', 'B', 'C'][i]}
        </div>
      ))}
      <div className="pgd-bbar" style={{ ...line({ marginTop: 7, borderColor: 'var(--accent)', color: 'var(--accent)', display: 'flex', gap: 8 }) }}>
        已选 3 项：改状态 · 归档 · 调优先级
      </div>
    </div>
  );
}

/** 模型菜单 · 步骤1：厂商配置卡 + 密钥掩码 */
export function ToolCardDemo() {
  return (
    <div style={box} aria-label="模型配置演示">
      <DemoStyle css={`@keyframes pgd-card { 0% { opacity:0; transform:translateY(-6px) } 25%,100% { opacity:1; transform:none } }
        @keyframes pgd-dots { 0%,30% { opacity:.2 } 50%,100% { opacity:1 } }
        .pgd-card { animation: pgd-card 3.6s ease-out infinite both; } .pgd-dots { animation: pgd-dots 2.4s infinite; }`} />
      <div className="pgd-card" style={{ ...line({ display: 'flex', alignItems: 'center', gap: 6 }) }}>
        <Bot size={12} style={{ color: 'var(--accent)' }} /> DeepSeek · chat模型
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>sk-<span className="pgd-dots">****</span>3f2a</span>
      </div>
      <div className="pgd-card" style={{ ...line({ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, animationDelay: '.5s' }) }}>
        <Bot size={12} style={{ color: 'var(--text-muted)' }} /> SiliconFlow · Qwen
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>sk-<span className="pgd-dots">****</span>9c1d</span>
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>API Key 编辑时保留原值，归档后列表隐藏但数据保留</div>
    </div>
  );
}

/** 模型菜单 · 步骤2：默认开发 / 默认整理切换 */
export function DefaultToggleDemo() {
  return (
    <div style={box} aria-label="默认工具切换演示">
      <DemoStyle css={`@keyframes pgd-t1 { 0%,40% { box-shadow:0 0 0 1px var(--accent) inset; color:var(--accent) } 55%,100% { box-shadow:none; color:var(--text) } }
        @keyframes pgd-t2 { 0%,40% { box-shadow:none; color:var(--text) } 55%,100% { box-shadow:0 0 0 1px var(--accent) inset; color:var(--accent) } }
        .pgd-t1 { animation: pgd-t1 3.6s infinite; } .pgd-t2 { animation: pgd-t2 3.6s infinite; }`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span className="pgd-t1" style={line({ display: 'flex', justifyContent: 'space-between' })}>DeepSeek · chat模型 <b>默认开发</b></span>
        <span className="pgd-t2" style={line({ display: 'flex', justifyContent: 'space-between' })}>SiliconFlow · Qwen <b>默认整理</b></span>
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>点一次即切换默认，全局立即生效（开发类 / 整理类分开指定）</div>
    </div>
  );
}

/** 提示词 / 通用需求 · 步骤1：条目滑入 + 复制闪烁 */
export function LibraryDemo({ noun }: { readonly noun: '提示词' | '需求' }) {
  return (
    <div style={box} aria-label={`${noun}库演示`}>
      <DemoStyle css={`@keyframes pgd-lib { 0% { opacity:0; transform:translateX(-8px) } 25%,85% { opacity:1; transform:none } 100% { opacity:.4 } }
        @keyframes pgd-copy { 0%,55% { color:var(--text-muted) } 70%,90% { color:var(--accent) } 100% { color:var(--text-muted) } }
        .pgd-lib { animation: pgd-lib 3.6s infinite both; } .pgd-copy { animation: pgd-copy 3.6s infinite; }`} />
      {[0, 1].map((i) => (
        <div key={i} className="pgd-lib" style={{ ...line({ marginTop: i ? 5 : 0, display: 'flex', alignItems: 'center', gap: 6, animationDelay: `${i * 0.4}s` }) }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {noun === '提示词' ? ['代码评审 · 严重度分级', '周报 · 洞察提炼'][i] : ['导出列序与导入解析同步', '悬浮交互禁止灰显降级'][i]}
          </span>
          <span className="pgd-copy" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><FileText size={11} /> 复制</span>
        </div>
      ))}
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>分类组织 · 排序检索 · 一键复制</div>
    </div>
  );
}

/** 提示词 / 通用需求 · 步骤2：复制到待办的流动动画 */
export function ToTaskFlowDemo({ noun }: { readonly noun: '提示词' | '需求' }) {
  return (
    <div style={box} aria-label="复制到待办演示">
      <DemoStyle css={`@keyframes pgd-fly { 0%,15% { opacity:0; transform:translateX(0) } 45%,80% { opacity:1; transform:translateX(46px) } 100% { opacity:0; transform:translateX(46px) } }
        .pgd-fly { animation: pgd-fly 3.6s ease-in-out infinite; }`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...line(), borderColor: 'var(--accent)' }}>{noun}条目</span>
        <span className="pgd-fly" style={{ position: 'absolute', left: 56, top: 34, color: 'var(--accent)', fontSize: 14 }}>➜</span>
        <span style={{ marginLeft: 46, ...line(), display: 'inline-flex', alignItems: 'center', gap: 4 }}><ListTodo size={11} /> 收件箱待办</span>
      </div>
      <div style={{ marginTop: 22, color: 'var(--text-muted)' }}>「复制到待办任务」→ 选目标项目 → 生成待办，衔接 AI 执行链路</div>
    </div>
  );
}

/** AI 工作台 · 步骤1：周报生成（数据聚合 → 打字输出） */
export function ReportGenDemo() {
  return (
    <div style={box} aria-label="周报生成演示">
      <DemoStyle css={`@keyframes pgd-type { 0%,20% { width:0 } 70%,100% { width:86% } }
        @keyframes pgd-spin { to { transform:rotate(360deg) } }
        .pgd-type { animation: pgd-type 3.6s ease-out infinite both; overflow:hidden; white-space:nowrap; display:inline-block; vertical-align:bottom }
        .pgd-rspin { animation: pgd-spin 1s linear infinite; display:inline-flex; }`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)' }}><Loader2 size={12} className="pgd-rspin" /> AI 周报生成中…</div>
      <div style={{ marginTop: 6, ...line() }}><span className="pgd-type">▍本周完成 12 项，风险 2 项，改进建议 3 条…</span></div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>结合真实任务数据（聚合一键注入）→ 按内置 skill 版式合成</div>
    </div>
  );
}

/** AI 工作台 · 步骤2：文档上传 → AI 解析流动 */
export function PrdFlowDemo() {
  return (
    <div style={box} aria-label="PRD 导入流程演示">
      <DemoStyle css={`@keyframes pgd-flow { 0% { opacity:0; transform:translateX(-6px) } 40%,80% { opacity:1; transform:none } 100% { opacity:0 } }
        .pgd-flow { animation: pgd-flow 3.6s infinite; }`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...line(), display: 'inline-flex', alignItems: 'center', gap: 4 }}><Upload size={11} /> PRD.docx</span>
        <span className="pgd-flow" style={{ color: 'var(--accent)', fontSize: 14 }}>➜</span>
        <span style={{ ...line({ borderColor: 'var(--accent)', color: 'var(--accent)' }) }}>AI 拆 WBS + 提取需求</span>
      </div>
      <div className="pgd-flow" style={{ ...line({ marginTop: 8, animationDelay: '.5s', display: 'flex', gap: 8 }) }}>
        <FileSpreadsheet size={11} /> 计划草稿可编辑 → 确认入库 → 需求跟踪矩阵自动生成
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>支持 .md / .docx / .xlsx 等；超过 30MB 友好提示 413</div>
    </div>
  );
}

/** AI 工作台 · 步骤3：控制台日志滚动 */
export function ConsoleLogDemo() {
  const rows = ['[09:41:02] 阶段1 提取文档文本…', '[09:41:18] 阶段2 AI 解析需求 10 条', '[09:41:37] 阶段3 导入计划 8 条 ✓', '[09:41:38] 完成，耗时 36s'];
  return (
    <div style={box} aria-label="控制台日志演示">
      <DemoStyle css={`@keyframes pgd-log { 0% { opacity:0; transform:translateY(6px) } 20%,100% { opacity:1; transform:none } }
        .pgd-log { animation: pgd-log 4s infinite both; }`} />
      <div style={{ ...line({ background: 'var(--surface-2, rgba(0,0,0,.05))', fontFamily: 'monospace', fontSize: 10 }) }}>
        {rows.map((r, i) => (
          <div key={r} className="pgd-log" style={{ marginTop: i ? 3 : 0, animationDelay: `${i * 0.7}s`, color: i === 3 ? 'var(--success)' : 'var(--text)' }}>{r}</div>
        ))}
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>阶段 + 时间戳，滚动到底；「收起文档区」可全屏观察</div>
    </div>
  );
}

/** 历史资产 · 步骤1：项目 → 快照沉淀 */
export function SnapshotDemo() {
  return (
    <div style={box} aria-label="快照沉淀演示">
      <DemoStyle css={`@keyframes pgd-snap { 0%,20% { opacity:1; transform:none } 55%,85% { opacity:.15; transform:translateY(10px) scale(.86) } 100% { opacity:.15; transform:translateY(10px) scale(.86) } }
        @keyframes pgd-seal { 0%,50% { opacity:0; transform:scale(1.6) rotate(-14deg) } 68%,100% { opacity:1; transform:scale(1) rotate(-8deg) } }
        .pgd-snap { animation: pgd-snap 3.6s infinite; } .pgd-seal { animation: pgd-seal 3.6s infinite both; }`} />
      <div style={{ position: 'relative', height: 62 }}>
        <div className="pgd-snap" style={{ ...line({ position: 'absolute', inset: '0 22% auto', textAlign: 'center' }) }}>📦 项目「xx系统」<br /><small style={{ color: 'var(--text-muted)' }}>任务 43 · 计划 12</small></div>
        <span className="pgd-seal" style={{ position: 'absolute', right: '18%', top: 12, border: '2px solid var(--success)', color: 'var(--success)', borderRadius: 6, padding: '1px 6px', fontWeight: 700 }}>已沉淀</span>
      </div>
      <div style={{ color: 'var(--text-muted)' }}>整体沉淀为只读快照；「恢复」可整体还原为活跃项目</div>
    </div>
  );
}

/** 历史资产 · 步骤2：归档软删除 */
export function ArchiveBoxDemo() {
  return (
    <div style={box} aria-label="归档软删除演示">
      <DemoStyle css={`@keyframes pgd-lid { 0%,30% { transform:none; opacity:1 } 60%,100% { transform:translateY(14px); opacity:.25 } }
        .pgd-lid { animation: pgd-lid 3.6s infinite both; }`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="pgd-lid" style={line({ textAlign: 'center' })}>🗂 项目内容 → 归档区（软删除）</div>
        <div style={{ ...line({ borderStyle: 'dashed', color: 'var(--text-muted)', textAlign: 'center' }) }}>数据完整保留 · 任何操作可追溯 · 支持恢复</div>
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>节奏建议：项目收口 → 沉淀快照 → 确认后归档</div>
    </div>
  );
}

/** 队列 · 步骤1：按序执行高亮下移 */
export function QueueRunDemo() {
  return (
    <div style={box} aria-label="队列按序执行演示">
      <DemoStyle css={`@keyframes pgd-q { 0%,23% { box-shadow:none } 30%,56% { box-shadow:0 0 0 1px var(--accent) inset } 63%,100% { box-shadow:none } }
        @keyframes pgd-ok { 0%,56% { opacity:0 } 63%,100% { opacity:1 } }
        .pgd-q { animation: pgd-q 3.6s infinite; } .pgd-ok { animation: pgd-ok 3.6s infinite both; }`} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="pgd-q" style={{ ...line({ marginTop: i ? 5 : 0, display: 'flex', alignItems: 'center', gap: 6, animationDelay: `${i * 0.6}s` }) }}>
          <span style={{ color: 'var(--text-muted)' }}>{i + 1}.</span> 任务 + AI 工具
          <Check size={11} className="pgd-ok" style={{ marginLeft: 'auto', color: 'var(--success)', animationDelay: `${i * 0.6 + 0.3}s` }} />
        </div>
      ))}
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>系统按序自动驱动，适合批量机械性任务</div>
    </div>
  );
}

/** 队列 · 步骤2：失败重试旋转 */
export function RetryDemo() {
  return (
    <div style={box} aria-label="重试与采纳演示">
      <DemoStyle css={`@keyframes pgd-rt { 0%,30% { transform:rotate(0); color:var(--danger) } 60%,100% { transform:rotate(360deg); color:var(--accent) } }
        .pgd-rt { animation: pgd-rt 3s infinite; display:inline-flex; }`} />
      <div style={{ ...line({ display: 'flex', alignItems: 'center', gap: 6 }) }}>
        <RotateCw size={12} className="pgd-rt" /> 失败任务 → 重置待发送 → 再次执行
      </div>
      <div style={{ ...line({ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }) }}>
        <Check size={12} style={{ color: 'var(--success)' }} /> 跑完点「采纳」，结果写回对应任务
      </div>
      <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>「复制」可取出内容，便于人工介入处理</div>
    </div>
  );
}

/** 设置 · 步骤1：主题切换滑块 */
export function ThemeToggleDemo() {
  return (
    <div style={box} aria-label="主题切换演示">
      <DemoStyle css={`@keyframes pgd-th { 0%,40% { transform:translateX(0); left:3px } 55%,95% { transform:translateX(46px) } 100% { transform:translateX(0) } }
        .pgd-th { animation: pgd-th 3.6s ease-in-out infinite; }`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Sun size={14} style={{ color: 'var(--text-muted)' }} />
        <span style={{ position: 'relative', width: 66, height: 20, borderRadius: 99, background: 'var(--surface-2, rgba(0,0,0,.08))', border: '1px solid var(--border-strong)', display: 'inline-block' }}>
          <span className="pgd-th" style={{ position: 'absolute', top: 2, width: 16, height: 14, borderRadius: 99, background: 'var(--accent)' }} />
        </span>
        <Moon size={14} style={{ color: 'var(--text-muted)' }} />
      </div>
      <div style={{ marginTop: 14, color: 'var(--text-muted)' }}>浅色 / 深色一键切换，全局即时生效</div>
    </div>
  );
}

/** 设置 · 步骤2：备份导出流动 */
export function BackupDemo() {
  return (
    <div style={box} aria-label="备份导出演示">
      <DemoStyle css={`@keyframes pgd-bk { 0%,20% { opacity:0; transform:translateY(-6px) } 50%,85% { opacity:1; transform:none } 100% { opacity:0 } }
        .pgd-bk { animation: pgd-bk 3.6s infinite; }`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={line()}>💾 全部用户数据</span>
        <span className="pgd-bk" style={{ color: 'var(--accent)' }}><Download size={14} /></span>
        <span style={{ ...line({ borderColor: 'var(--accent)', color: 'var(--accent)' }) }}>备份 JSON</span>
      </div>
      <div style={{ marginTop: 8, color: 'var(--text-muted)' }}>导入前请先导出；「检查更新」一键拉取最新 Release</div>
    </div>
  );
}
