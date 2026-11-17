/**
 * T01494（M2 验收回归）：A8「双输入通道」服务端契约断言（PRD §13 A8）。
 *
 * 复用 m1-checks-api.mjs 的 mkHttp/mkReport（同一隔离实例基址、同一 http 客户端，勿另造轮子）。
 * A8 的本质是「内部 PRD 选择」与「外部文件上传」两条通道并存、各自解析并校验，确认后才触发流式生成。
 * 这些「通道选择 + 前置校验」分支都在 SSE 头 flush 之前 return，因此可在 HTTP 层确定性地打，
 * 无需真实模型；而「两条通道都能把内容喂进 pipeline」的正向，用外部通道一份合法 .md → 200 SSE 佐证。
 */
import { mkHttp, mkReport } from './m1-checks-api.mjs';

const ROUTE = '/plans/testcase-generate-stream';

export async function runM2ApiChecks({ base }) {
  const rep = mkReport();
  const { raw, call } = mkHttp(base);
  const proj = await call('POST', '/projects', { name: `M2-A8-${Date.now()}` });
  const pid = proj.id;

  rep.section('A8 双输入通道（内部 PRD / 外部上传并存 + 前置校验）', ['A8']);
  // 必填守卫
  let r = await raw('POST', `${ROUTE}?toolId=t1`, {});
  rep.t('A8_missing_projectId_400', r.status === 400 && /projectId/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await raw('POST', `${ROUTE}?projectId=${pid}`, {});
  rep.t('A8_missing_toolId_400', r.status === 400 && /模型|toolId/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await raw('POST', `${ROUTE}?projectId=nope-x&toolId=t1`, {});
  rep.t('A8_unknown_project_400', r.status === 400 && /项目不存在/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  // 内部通道：prdDocId 不存在 → 明确命中「内部 PRD 文档」分支的校验
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=t1`, { prdDocId: 'no-such-doc' });
  rep.t('A8_internal_channel_branch', r.status === 400 && /PRD 文档不存在/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  // 外部通道：非法格式 / 老式 .doc / 空来源
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=t1`, { filename: 'req.pdf', contentBase64: b64('x') });
  rep.t('A8_external_bad_ext_400', r.status === 400 && /不支持的文件格式/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=t1`, { filename: 'req.doc', contentBase64: b64('x') });
  rep.t('A8_external_legacy_doc_400', r.status === 400 && /老式 \.doc/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=t1`, {});
  rep.t('A8_no_source_400', r.status === 400 && /PRD 来源|请提供/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  // 外部通道正向：合法 .md + 任意 toolId → 通过全部前置校验、进入 SSE（200 + text/event-stream）
  // （toolId 未配置时 pipeline 在流内报错、以 SSE error 事件收尾——仍是 200 流式，证明“通道接通、内容已喂入”）
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=stub-tool`, { filename: 'prd.md', contentBase64: b64('# PRD\nREQ-001 用户登录；REQ-002 订单取消。') });
  rep.t('A8_external_channel_streams_sse', r.status === 200 && /text\/event-stream/.test(r.ct || ''), `status=${r.status} ct=${r.ct}`);

  // 通道优先级（“两类可共存”）：同时给 prdDocId 与 contentBase64 → 走内部分支（doc 不存在即报内部错，不处理文件）
  r = await raw('POST', `${ROUTE}?projectId=${pid}&toolId=t1`, { prdDocId: 'no-such-doc', filename: 'prd.md', contentBase64: b64('# x') });
  rep.t('A8_internal_takes_precedence', r.status === 400 && /PRD 文档不存在/.test(JSON.stringify(r.data)), `status=${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

  // 「确认后才触发」属前端交互（卡片勾选→点确认才发 POST），HTTP 层无从判定，如实标 SKIP 交 UI/人工
  rep.skip('A8_confirm_then_trigger', '前端「确认后才触发」为交互语义（草稿勾选→点确认才 POST），HTTP 契约层不可判定；由 UI 实测/人工抽查承接（见 T01496 全量验收）。');

  // 清理本段自建项目（隔离库随后整体销毁，删不掉不影响判定）
  try { await call('DELETE', `/projects/${pid}`); } catch { /* 忽略 */ }
  return rep.groups;
}
