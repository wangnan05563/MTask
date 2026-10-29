/**
 * 八期 §3.4.1 / §4.2：设置页 SonarQube 子页的四个端点。
 *
 *  - `GET  /settings/sonar`：配置视图（Token 只回「是否已配置 + 掩码」，绝不回明文）；
 *  - `PUT  /settings/sonar`：保存配置（字段语义同 `update/config`：不传=不改动、空串=清除）；
 *  - `POST /settings/sonar/reveal`：查看 Token 原文——必须带 `confirm:true`，且服务端写审计；
 *  - `GET  /settings/sonar/audit`：查看审计（写入即要可读，否则「审计」只是没人核对过的行）；
 *  - `POST /settings/sonar/test`：三项连接测试，支持用未保存的草稿地址/Token 试（不落库）。
 *
 * 错误口径：校验类失败回 400 + `{error, kind}`，前端按 `error` 直接行内回显。
 */
import { Router } from 'express';
import {
  SonarConfigError,
  getSonarConfigView,
  listRevealAudit,
  revealSonarToken,
  saveSonarConfig,
  testSonarConnection,
} from '../services/sonarSettings';

export const sonarSettingsApi = Router();

/** 服务层校验失败 → 400；其余异常按 500 交由 Express 兜底，不静默吞 */
function fail(res: import('express').Response, e: unknown): void {
  if (e instanceof SonarConfigError) {
    res.status(400).json({ error: e.message, kind: e.kind });
    return;
  }
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

sonarSettingsApi.get('/settings/sonar', async (_req, res) => {
  try {
    res.json(await getSonarConfigView());
  } catch (e) {
    fail(res, e);
  }
});

sonarSettingsApi.put('/settings/sonar', async (req, res) => {
  try {
    res.json(await saveSonarConfig(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});

sonarSettingsApi.post('/settings/sonar/reveal', (req, res) => {
  try {
    res.json(revealSonarToken(req.body?.confirm));
  } catch (e) {
    fail(res, e);
  }
});

sonarSettingsApi.get('/settings/sonar/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  res.json({ rows: listRevealAudit(limit) });
});

sonarSettingsApi.post('/settings/sonar/test', async (req, res) => {
  try {
    res.json(await testSonarConnection(req.body ?? {}));
  } catch (e) {
    fail(res, e);
  }
});
