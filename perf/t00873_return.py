import importlib.util
import sys

SCRIPT = r"c:\Users\hspcadmin\.trae-cn\skills\mtask\scripts\mcp-direct-call.py"
spec = importlib.util.spec_from_file_location("mdc", SCRIPT)
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)

sid = mc.ensure_session()
t = mc.unwrap(mc.call(sid, "mtask_get_task", {"taskNo": "T00873"}, 2))
cur = (t.get("handle_result") or "").rstrip()

append = """## 复验（2026-09-22 处理【验证失败】反馈，三轮）

### 根因
弹窗确认逻辑 `confirmMove` 对「仅改动通用需求分类、提示词分组保持不变」场景的变更检测缺失，
被判成「未选择变更项」直接拦截，未能提交只有 reqCategoryId 变化的合法操作。

### 修复
`D:\\code\\otherProjects\\26_MTask\\web\\src\\pages\\PromptsPage.tsx` `confirmMove`：
1. 两个维度独立比较：`catId !== p.category_id` → 提交 categoryId；`reqId !== (p.req_category_id ?? '')` → 提交 reqCategoryId；任一项已变即进入提交。
2. 仅当两维度都未变（patch 为空）才提示「未选择变更项，未做改动」，不再误读"目标分组没动=无改动"。
3. 反馈文案按实际变更给出：只改通用需求分类 → 「已将「标题」归入通用需求分类「名称」」，避免误导成移动了提示词分组。
4. 撤销快照 `lastMove/undoMove` 仍只记录实际变更字段，语义不变。

### 验证（UI 实测，隔离实例：后端 http://127.0.0.1:39576 + 前端 http://127.0.0.1:5175）
1. 浏览器打开提示词页面，对一条测试提示词点「移动」按钮。
2. 弹窗中「目标分组」保持当前值不动，仅把「通用需求分类」从空选为某一分类，点确认。
3. 页面右上角 flash 文案为：已将「…」归入通用需求分类「…」，不再是「未选择变更项，未做改动」。
4. 浏览器 fetch `/api/prompts` 断言：该条目的 `req_category_id` 已从空值写入所选分类 id（b6870dcf-e40a-4082-a3c7-4046c55e4562），数据落库成功。
5. `web` 端 `tsc --noEmit` 0 错误（前几轮已复核）。
结论：验证失败反馈已彻底修复并 UI 实测复验通过。
"""

merged = cur + "\n\n" + append if cur else append
mc.call(sid, "mtask_update_task_result", {"taskNo": "T00873", "result": merged}, 3)
print("OK result written, old_len=%d new_len=%d" % (len(cur), len(merged)))