import { useCallback, useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import ForceAtlas2 from 'graphology-layout-forceatlas2';
import { api } from '../api/client';

/**
 * T05738：记忆图谱视图（Obsidian 式力导向图，sigma.js v4 + graphology + ForceAtlas2）。
 *
 * 数据源 `GET /memories/graph?productKey=`（服务端拼好 tag 共享边/替代链/项目聚簇，前端不做 N² 计算）。
 * 视觉：暗色画布 + type 四色节点 + 失效灰显 + 悬停高亮一跳邻域（其余淡出，Obsidian 同款）
 * + 缩放门控标签（labelRenderedSizeThreshold 即 Obsidian 的 text fade threshold）+ 点击节点开详情面板。
 * 画布本身是内容区（暗底发光风格为图谱语汇），不随亮/暗主题翻转；外层容器仍走主题变量。
 */

const TYPE_COLORS: Record<string, string> = {
  user: '#38bdf8',      // 用户偏好：蓝
  feedback: '#f472b6',  // 反馈纠正：粉
  project: '#34d399',   // 项目事实：绿
  reference: '#fbbf24', // 外部参考：黄
};
const PROJECT_NODE_COLOR = '#818cf8';
const DEAD_NODE_COLOR = '#526078';
const EDGE_TAG = 'rgba(96,165,250,0.30)';
const EDGE_PROJECT = 'rgba(129,140,248,0.45)';
const EDGE_SUPERSEDE = 'rgba(248,113,113,0.75)';
const EDGE_DIM = 'rgba(100,116,139,0.08)';
const EDGE_DIM_SUPERSEDE = 'rgba(248,113,113,0.15)';

const TYPE_LABELS: Record<string, string> = {
  user: '用户偏好', feedback: '反馈纠正', project: '项目事实', reference: '外部参考',
};

interface GraphNode {
  id: string;
  kind: 'memory' | 'project';
  type?: string;
  title: string;
  content?: string;
  tags?: string[];
  projectId?: string | null;
  size: number;
  invalidated?: boolean;
  supersededBy?: string | null;
  sourceTaskId?: string | null;
  accessCount?: number;
  updatedAt?: string;
}
interface GraphEdge { id: string; source: string; target: string; kind: 'tag' | 'supersede' | 'project'; tag?: string }
interface GraphData {
  ok: boolean; nodes: GraphNode[]; edges: GraphEdge[];
  stats: { memoryCount: number; projectCount: number; tagEdgeCount: number; supersedeCount: number };
}

function nodeColor(n: GraphNode): string {
  if (n.invalidated) return DEAD_NODE_COLOR;
  if (n.kind === 'project') return PROJECT_NODE_COLOR;
  return TYPE_COLORS[n.type ?? 'reference'] ?? '#94a3b8';
}

export function MemoryGraph({ productKey }: { productKey: string }) {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  // hover/邻域状态放 ref：变化只 sigma.refresh()，不触发 React 重渲染
  const hoveredRef = useRef<string | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const load = useCallback(async () => {
    if (!productKey) { setData(null); return; }
    setLoading(true);
    setSelected(null);
    try {
      const r = await api.get<GraphData>(`/memories/graph?productKey=${encodeURIComponent(productKey)}`);
      setData(r);
    } catch (e) {
      setData({ ok: false, nodes: [], edges: [], stats: { memoryCount: 0, projectCount: 0, tagEdgeCount: 0, supersedeCount: 0 }, error: e instanceof Error ? e.message : String(e) } as GraphData);
    } finally { setLoading(false); }
  }, [productKey]);

  useEffect(() => { void load(); }, [load]);

  // 图谱构建与渲染：数据变化时重建（量级 ≤ 数百节点，重建成本毫秒级）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data || data.nodes.length === 0) return;

    const graph = new Graph({ multi: false, type: 'undirected' });
    for (const n of data.nodes) {
      // 随机初始位置（FA2 assign 会覆盖为布局结果）
      graph.addNode(n.id, { x: Math.random() * 100, y: Math.random() * 100, size: n.size, color: nodeColor(n), label: n.title, nodeKind: n.kind });
    }
    for (const e of data.edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.id)) {
        graph.addEdgeWithKey(e.id, e.source, e.target, { edgeKind: e.kind, edgeTag: e.tag ?? '' });
      }
    }
    graphRef.current = graph;

    // ForceAtlas2 布局：运行即冻结（写死 x/y，无持续动画循环，空闲 CPU≈0）
    ForceAtlas2.assign(graph, {
      iterations: 120,
      settings: {
        gravity: 1.2,
        scalingRatio: 2.2,
        barnesHutOptimize: data.nodes.length > 300,
        strongGravityMode: false,
        edgeWeightInfluence: 0.4,
      },
    });

    // sigma v4：settings 与 styles 分层——门控/相机在 settings，标签颜色/字号在 styles.nodes
    const sigma = new Sigma(graph, container, {
      settings: {
        // Obsidian 同款「文字淡出门控」：缩放到足够大才显示标签
        labelRenderedSizeThreshold: 4,
        minCameraRatio: 0.08,
        maxCameraRatio: 8,
      },
      styles: {
        nodes: {
          labelColor: '#dbe4f3',
          labelSize: 12,
          labelFont: 'system-ui, sans-serif',
        },
      },
      nodeReducer: (node, attrs) => {
        const res = { ...attrs } as Record<string, unknown>;
        const hovered = hoveredRef.current;
        if (hovered && hovered !== node) {
          // 悬停高亮一跳邻域：其余节点淡出（Obsidian 同款）
          const isNeighbor = graph.areNeighbors(node, hovered);
          if (!isNeighbor) {
            res.color = 'rgba(100,116,139,0.18)';
            res.labelVisibility = 'hidden';
          } else {
            res.labelVisibility = 'visible';
          }
        }
        if (hovered === node || selected?.id === node) { res.labelVisibility = 'visible'; }
        return res;
      },
      edgeReducer: (edge, attrs) => {
        const res = { ...attrs } as Record<string, unknown>;
        const kind = String(res.edgeKind ?? 'tag');
        res.color = kind === 'supersede' ? EDGE_SUPERSEDE : kind === 'project' ? EDGE_PROJECT : EDGE_TAG;
        res.size = kind === 'supersede' ? 2 : 1;
        const hovered = hoveredRef.current;
        if (hovered) {
          const touching = graph.hasEdge(edge)
            && (graph.source(edge) === hovered || graph.target(edge) === hovered);
          if (!touching) res.color = kind === 'supersede' ? EDGE_DIM_SUPERSEDE : EDGE_DIM;
        }
        return res;
      },
    });
    sigmaRef.current = sigma;

    sigma.on('enterNode', ({ node }) => { hoveredRef.current = node; sigma.refresh(); });
    sigma.on('leaveNode', () => { hoveredRef.current = null; sigma.refresh(); });
    sigma.on('clickNode', ({ node }) => {
      const hit = data.nodes.find((n) => n.id === node);
      setSelected(hit ?? null);
    });
    sigma.on('clickStage', () => { setSelected(null); });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!productKey) return null;
  if (loading) return <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>图谱加载中…</div>;
  if (!data || data.nodes.length === 0) {
    return (
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>
        本产品暂无可视化记忆（需先有记忆条目）。图谱把「共享标签 / 替代链 / 项目归属」画成连线，记忆越多连线越密。
      </div>
    );
  }

  const legend: { color: string; label: string }[] = [
    ...Object.keys(TYPE_LABELS).map((t) => ({ color: TYPE_COLORS[t], label: TYPE_LABELS[t] })),
    { color: PROJECT_NODE_COLOR, label: '项目' },
    { color: DEAD_NODE_COLOR, label: '已失效' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {legend.map((l) => (
          <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: l.color, display: 'inline-block' }} />
            {l.label}
          </span>
        ))}
        <span>· 蓝细线=共享标签</span>
        <span style={{ color: '#f87171' }}>· 红线=被替代</span>
        <span style={{ color: PROJECT_NODE_COLOR }}>· 紫线=项目归属</span>
        <span>· 悬停看邻域，点击看详情</span>
        <span style={{ marginLeft: 'auto' }}>
          {data.stats.memoryCount} 条记忆 · {data.stats.projectCount} 个项目 · {data.stats.tagEdgeCount} 条标签连线
        </span>
        <button onClick={() => void load()} style={{
          fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)',
          borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: 'pointer',
        }}>重排布局</button>
      </div>
      <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div
          ref={containerRef}
          data-lck="memory-graph-canvas"
          aria-label="记忆关系图谱"
          style={{ width: '100%', height: 560, background: 'radial-gradient(ellipse at center, #101828 0%, #0b1020 70%)', cursor: 'default' }}
        />
        {selected && (
          <div style={{
            position: 'absolute', right: 12, top: 12, width: 300, maxHeight: 480, overflowY: 'auto',
            background: 'rgba(13,19,32,0.92)', border: '1px solid rgba(129,140,248,0.5)', borderRadius: 8,
            padding: 12, boxSizing: 'border-box', backdropFilter: 'blur(4px)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{
                fontSize: 'var(--fs-xs)', color: '#fff', padding: '1px 8px', borderRadius: 999,
                background: nodeColor(selected),
              }}>{selected.kind === 'project' ? '项目' : (TYPE_LABELS[selected.type ?? ''] ?? selected.type)}</span>
              <button onClick={() => setSelected(null)} aria-label="关闭详情" style={{
                background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 14, lineHeight: 1,
              }}>✕</button>
            </div>
            <div style={{ color: '#f1f5f9', fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 6, overflowWrap: 'anywhere' }}>
              {selected.title}
            </div>
            {selected.content && (
              <div style={{ color: '#b6c2d8', fontSize: 'var(--fs-xs)', lineHeight: 1.7, marginBottom: 8, overflowWrap: 'anywhere' }}>
                {selected.content}
              </div>
            )}
            <div style={{ color: '#8fa0b8', fontSize: 'var(--fs-xs)', display: 'grid', gap: 3 }}>
              {selected.kind === 'project' && <span>成员记忆：{data.nodes.filter((n) => n.kind === 'memory' && n.projectId === selected.projectId).length} 条</span>}
              {selected.kind === 'memory' && selected.tags && selected.tags.length > 0 && <span>标签：{selected.tags.join('、')}</span>}
              {selected.kind === 'memory' && <span>作用域：{selected.projectId ? '本期特有' : '产品级共享'}</span>}
              {selected.kind === 'memory' && selected.accessCount !== undefined && <span>访问：{selected.accessCount} 次</span>}
              {selected.kind === 'memory' && selected.sourceTaskId && <span>来源任务：{selected.sourceTaskId}</span>}
              {selected.kind === 'memory' && selected.updatedAt && <span>更新：{selected.updatedAt.slice(0, 16).replace('T', ' ')}</span>}
              {selected.invalidated && <span style={{ color: '#f87171' }}>已失效{selected.supersededBy ? '（被其它记忆替代）' : ''}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
