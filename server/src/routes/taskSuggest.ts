/**
 * T03255（AI-203①⑤）：任务分类与优先级建议——只读接口，返回建议与理由，不写 tasks 表。
 * 单独成文件而不是并入 routes/index.ts：写入面（任务 CRUD）与建议面分离，验收门可直接断言「调用后任务行不变」。
 */
import { Router } from 'express';
import { AIService } from '../services/AIService';
import { TaskCategoryService } from '../services/TaskCategoryService';
import { TaskService } from '../services/TaskService';

export const taskSuggestApi = Router();

taskSuggestApi.post('/tasks/classify-suggest', async (req, res) => {
  const { title, description, projectId, taskId, toolId, categories } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  if (typeof toolId !== 'string' || !toolId.trim()) return res.status(400).json({ error: 'toolId 必填' });
  try {
    // 编辑场景只需 taskId：项目从任务反查，避免前端传错项目导致历史参考错项目
    const task = typeof taskId === 'string' && taskId ? TaskService.getById(taskId) : null;
    const pid = (typeof projectId === 'string' && projectId) || task?.project_id || null;
    const cats = Array.isArray(categories)
      ? (categories as Array<{ id?: unknown; name?: unknown }>)
          .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
          .map((c) => ({ id: c.id as string, name: c.name as string }))
      : TaskCategoryService.list().map((c) => ({ id: c.id, name: c.name }));
    res.json(await AIService.suggestTaskClassification({
      title: title.trim(),
      description: typeof description === 'string' ? description : '',
      projectId: pid,
      taskId: task?.id ?? null,
      categories: cats,
    }, toolId));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
