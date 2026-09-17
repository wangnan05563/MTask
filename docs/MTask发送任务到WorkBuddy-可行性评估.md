# MTask → WorkBuddy 任务直送 · 可行性评估

> 评估目标：MTask 应用能否通过界面按钮，把待办任务直接发送给 WorkBuddy 执行。
> 评估日期：2026-09-13 ｜ 结论：**可行**，MTask 侧能力已具备约 70%，唯一缺口是 WorkBuddy 的「入站接收端」。

---

## 一、结论速览

| 路线 | 方向 | 是否需新建接收端 | 代码量 | 稳定性 | 推荐度 |
|------|------|----------------|--------|--------|--------|
| **A. MCP 拉取**（推荐） | WorkBuddy 作为 MCP 客户端连 MTask | 否（MTask 已提供 `/api/mcp`） | 0（仅加一项 mcp.json） | 高（官方支持） | ★★★★★ |
| **B. Agent Mail 直推** | MTask 按钮 → 中继 → WB 收件箱 | 否（复用 Agent Mail） | 中 | 中（内测+额度） | ★★★ |
| **C. WB 本地 API 直推** | MTask 按钮 → WB 本地端口 | 需 WB 暴露本地 API（未证实） | 高/不确定 | 未知 | ★★ |

- **路线 A** 最稳、零新代码，触发方是 WorkBuddy（用户让 WB「处理 MTask 待办」）。
- **路线 B** 能做到真正的「MTask 按钮即触发 WB 收到任务」，但走邮件通道、有内测额度与确认限制。
- 两条路线都已验证技术可行，下面给出依据。

---

## 二、MTask 侧现状（已具备的能力）

1. **WorkBuddyAdapter（中继）** — `server/src/adapters/workbuddy.ts`
   - 已实现 `post / submit / poll`，POST `{action:'send'|'send_submit'|'send_poll', user, jobId, taskTitle}` 到**可配置 endpoint**，`submit` 拿回执 `ticket`、`poll` 轮询收敛。
   - 适配器注释明确：**「WorkBuddy 不暴露可由第三方稳定注入任务并取回执的公开 API」** → 接收端不存在，这是当前最大缺口。

2. **队列发送 UI 链路** — `QueueService` + `QueuePage`
   - 已有「组建今日队列 → 发送 → 回执落库（仅文本）→ 行展开审阅 + 采纳/复制」完整流程。
   - 只要把某个 AI 工具配成 `type=workbuddy` 并填 endpoint，按钮就会走 `WorkBuddyAdapter`。**按钮与发送逻辑已就绪**。

3. **MTask MCP 服务（反向拉取基础）** — `server/src/mcp/*`
   - 已注册 20+ `mtask_*` 工具：`mtask_list_tasks` / `mtask_get_task` / `mtask_update_task` / `mtask_update_task_result` / `mtask_create_task` 等。
   - 挂载 `app.use('/api/mcp', accessTokenGuard, mcpRouter())`，streamable HTTP 传输，复用现有 accessToken 鉴权。

4. **运行时确认** — `server/src/index.ts`
   - `PORT=39876`，`HOST='127.0.0.1'`，**仅本机监听**（同机 WorkBuddy 可直接访问）。
   - `accessTokenGuard`：未配置 accessToken（默认单机）时整体放行；配置后需 `X-Access-Token` 头匹配。

---

## 三、WorkBuddy 入站能力（核实结果）

- ✅ **官方支持接入外部 MCP 服务器**：`~/.workbuddy/mcp.json`（用户级）/ `<项目>/.workbuddy/mcp.json`（项目级），HTTP 模式：
  ```json
  { "mcpServers": { "your-mcp": { "url": "https://host/mcp?secret-key=KEY", "transport": "http" } } }
  ```
  → 即 **WorkBuddy 可作为 MCP 客户端**连接 MTask，方向为「WB 拉取 MTask」。路线 A 成立。
- ❌ 未检索到 WorkBuddy 公开的「任务注入」HTTP / CLI / URL scheme API。直推必须借助 Agent Mail 或（待证实的）本地 API。
- ✅ **Agent Mail（智能体邮箱，本会话已连接）**：REST `https://api.agentmail.to/v0`，MTask 可发信到 WorkBuddy 的 `xxx@agent.qq.com` 邮箱，WB 作为任务/邮件接收。内测限制：50 封/天、需 API Key、CLI 发送有二次确认 token（REST 直发需确认是否豁免）。路线 B 成立但有限制。

---

## 四、推荐落地方案

### 主链路：路线 A（零新代码，先接通）
在 WorkBuddy 侧 `~/.workbuddy/mcp.json` 增加：
```json
{
  "mcpServers": {
    "mtask": {
      "url": "http://127.0.0.1:39876/api/mcp",
      "transport": "http"
    }
  }
}
```
若 MTask 启用了 accessToken，则补请求头（取决于 WB MCP 配置的 headers 字段）：
`X-Access-Token: <MTask accessToken>`。

效果：WorkBuddy 可直接调用 `mtask_list_tasks` 拉待办、`mtask_update_task_result` 回写结论，形成「WB 处理 MTask 待办」闭环。

### 按钮 UX（二选一，按是否要「MTask 按钮即触发 WB 执行」）
- **A1（推荐，无需 WB 新接收端）**：MTask「发送给 WorkBuddy」按钮 = 标记 outbox（`sent_to_workbuddy=1`）+ 把 WB 提示词复制到剪贴板；用户在 WorkBuddy 说一句「处理 MTask 待办」即可。或把该指令做成 WB **自动化/Skill**，按钮触发本地唤醒。
- **B1（真·直推）**：按钮 → `WorkBuddyAdapter`（endpoint=中继地址）→ 中继调 Agent Mail REST 发到 WB 邮箱 → WB 收到即作为任务。需 Agent Mail API Key 并控制每日额度。

> 若要求 WorkBuddy **无人值守自动执行**，纯 inbound 邮件不会自动跑，需 WB 侧「自动化」配合消费收到的邮件/MCP 待办。

---

## 五、风险与待确认项

1. MTask server 须常驻且监听 `127.0.0.1:39876`（同机 WB 才能连）；WB 与 MTask 不在同一台机器时需走隧道/固定地址。
2. 启用 accessToken 后，必须把它配进 WB 的 MCP 请求头，否则 401。
3. Agent Mail 内测额度（50 封/天）不适合批量直推；CLI 二次确认、REST 是否豁免待实测。
4. 路线 C（WB 本地 API）未见公开文档，需向 WB 官方确认是否存在本地端口后再评估。

---

## 六、下一步建议

1. **先做路线 A**：在 WB 加一项 `mcp.json`，验证 WB 能否 list / act MTask 待办并回写（零代码、最快见效）。
2. 若坚持「MTask 按钮即触发 WB 执行」，再上 **路线 B 的 Agent Mail 中继**。
3. 评估期间 MTask 现有 `WorkBuddyAdapter` 与队列 UI 无需改动，仅 endpoint 指向不同接收端即可复用。
