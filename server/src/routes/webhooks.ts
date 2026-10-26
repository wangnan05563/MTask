/**
 * T03196（PRD PM-401）：项目级 outbound Webhook 配置与投递日志。
 * 只做出站；密钥只回掩码，日志不含响应正文。
 */
import { Router } from 'express';
import { WebhookService } from '../services/WebhookService';

export const webhooksApi = Router();

function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

webhooksApi.get('/', (req, res) => {
  wrap(res, () => WebhookService.list(String(req.query.projectId ?? '')));
});

webhooksApi.post('/', (req, res) => {
  wrap(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return WebhookService.create({
      projectId: b.projectId == null ? undefined : String(b.projectId),
      url: b.url == null ? undefined : String(b.url),
      events: b.events,
      secret: b.secret == null ? undefined : String(b.secret),
      allowIntranet: b.allowIntranet === true,
    });
  });
});

webhooksApi.patch('/:id', (req, res) => {
  wrap(res, () => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return WebhookService.update(String(req.params.id), {
      url: b.url === undefined ? undefined : String(b.url),
      events: b.events,
      secret: b.secret === undefined ? undefined : String(b.secret),
      enabled: b.enabled === undefined ? undefined : b.enabled === true,
      allowIntranet: b.allowIntranet === undefined ? undefined : b.allowIntranet === true,
    });
  });
});

webhooksApi.delete('/:id', (req, res) => {
  wrap(res, () => ({ removed: WebhookService.remove(String(req.params.id)) }));
});

webhooksApi.get('/:id/deliveries', (req, res) => {
  wrap(res, () => WebhookService.deliveries(String(req.params.id), Number(req.query.limit ?? 20)));
});

webhooksApi.post('/:id/test', (req, res) => {
  wrap(res, () => WebhookService.test(String(req.params.id)));
});
