/**
 * T03255（AI-203①⑤）：任务分类与优先级建议——只读接口，返回建议与理由，不写 tasks 表。
 * T03256（AI-203②③）：每条建议落 ai_suggestions 台账，前端回传采纳/不用/超时；采纳率分母为已展示数。
 * 单独成文件而不是并入 routes/index.ts：写入面（任务 CRUD）与建议面分离，验收门可直接断言「调用后任务行不变」。
 */
import { Router } from 'express';
import { AIService } from '../services/AIService';
import { markStatus, recordShown, setSuggestionsEnabled, suggestionStats, suggestionsEnabled } from '../services/aiSuggestion';
import { TaskCategoryService } from '../services/TaskCategoryService';
import { TaskService } from '../services/TaskService';

export const taskSuggestApi = Router();

const CARD_KEY = 'ai.category_suggest';

taskSuggestApi.post('/tasks/classify-suggest', async (req, res) => {
  const { title, description, projectId, taskId, toolId, categories } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  if (typeof toolId !== 'string' || !toolId.trim()) return res.status(400).json({ error: 'toolId 必填' });
  // 总开关关闭：不调模型、不记 shown——否则关闭期间的展示会污染采纳率分母
  if (!suggestionsEnabled()) return res.json({ ok: false, disabled: true, error: '任务分类建议已关闭（可在设置中开启）' });
  try {
    // 编辑场景只需 taskId：项目从任务反查，避免前端传错项目导致历史参考错项目
    const task = typeof taskId === 'string' && taskId ? TaskService.getById(taskId) : null;
    const pid = (typeof projectId === 'string' && projectId) || task?.project_id || null;
    const cats = Array.isArray(categories)
      ? (categories as Array<{ id?: unknown; name?: unknown }>)
          .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
          .map((c) => ({ id: c.id as string, name: c.name as string }))
      : TaskCategoryService.list().map((c) => ({ id: c.id, name: c.name }));
    const out = await AIService.suggestTaskClassification({
      title: title.trim(),
      description: typeof description === 'string' ? description : '',
      projectId: pid,
      taskId: task?.id ?? null,
      categories: cats,
    }, toolId);
    if (!out.ok || !out.suggestion) return res.json(out);
    // 建议已实际返回给用户 → 记 shown；前端后续事件都必须带这个 id 回传
    const suggestionId = recordShown({
      cardKey: CARD_KEY,
      projectId: pid,
      taskId: task?.id ?? null,
      categoryId: out.suggestion.categoryId,
      priority: out.suggestion.priority,
      reason: out.suggestion.reason,
    });
    res.json({ ...out, suggestionId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 建议状态回传：accepted / dismissed / timeout——重复上报幂等，已终态不被改写 */
taskSuggestApi.post('/tasks/classify-suggest/feedback', (req, res) => {
  const { suggestionId, event } = req.body ?? {};
  if (typeof suggestionId !== 'string' || !suggestionId.trim()) return res.status(400).json({ error: 'suggestionId 必填' });
  const r = markStatus(suggestionId, typeof event === 'string' ? event : '');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, status: r.status });
});

/** 采纳率统计：分母为已展示数（shown+accepted+dismissed+timeout），另回带开关状态供入口显隐 */
taskSuggestApi.get('/ai/suggestions/stats', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
  res.json({ ok: true, enabled: suggestionsEnabled(), cardKey: CARD_KEY, ...suggestionStats({ cardKey: CARD_KEY, projectId }) });
});

/** 功能开关：关闭后不再生成建议、不记 shown；台账历史保留（统计不因关闭清零） */
taskSuggestApi.put('/ai/suggestions/enabled', (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须为布尔值' });
  res.json({ ok: true, enabled: setSuggestionsEnabled(enabled) });
});
