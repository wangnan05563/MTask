/**
 * 在 Node 侧复用前端模块中**纯函数**（如 `buildPanelRows`、徽标枚举、形态阈值）所需的最小环境垫片。
 *
 * T02299(4)：`web/src/components/EstimatePanel.tsx` 会 transitively import `web/src/api/client.ts`，
 * 后者顶层要从 `document.baseURI` 推导 apiBase（内网穿透 pathPrefix 的修复，故意不能写死 '/api'）。
 * Node 没有 DOM，于是一进门就 `ReferenceError: document is not defined`，整段断言都没机会跑
 * （verify-t02039-estimate-e4a / verify-t02040-estimate-e4b 首轮即崩在此处）。
 *
 * 只补 apiBase 真正读取的那一个字段，不伪造整页 DOM：面板逻辑若开始依赖别的浏览器全局，
 * 这里不会替它兜住——报错会如实落在「取数逻辑需要 DOM」这件事上，而不是被垫片掩盖。
 */
export function shimWebDocumentForNode(port: number | string): void {
  if (!(globalThis as { document?: unknown }).document) {
    (globalThis as { document?: unknown }).document = { baseURI: `http://127.0.0.1:${port}/` };
  }
}
