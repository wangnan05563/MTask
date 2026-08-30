/**
 * MCP streamable HTTP 传输层：挂载在 /api/mcp（已由现有 accessToken 中间件保护）。
 *
 * 会话模型（与 MCP 官方 express 示例一致）：
 * - 首次 initialize 请求：创建新 transport（内部生成 sessionId）并 connect 新 MCP server；
 *   经 `onsessioninitialized` 把 transport 登记到 Map，避免请求与服务端登记间的竞态。
 * - 后续请求：凭 `mcp-session-id` 头复用同一 transport（已 connect，无需重连）。
 * - DELETE / 终止会话：由 transport.handleRequest 处理并关闭。
 *
 * 选择为每个会话新建 MCP server（工具注册幂等）：保证多客户端互不串会话、无共享状态。
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from './server';

const transports = new Map<string, StreamableHTTPServerTransport>();

export function mcpRouter(): Router {
  const r = Router();

  const handle = async (req: Request, res: Response): Promise<void> => {
    // express.json 已解析 JSON-RPC 请求体；GET/DELETE 无 body 亦安全
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      // 无会话头，则必须是首次 initialize，否则拒绝
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
        return;
      }
      let transport: StreamableHTTPServerTransport | undefined;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { if (transport) transports.set(sid, transport); },
      });
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) transports.delete(sid);
      };
      const server = await createMCPServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mtask] MCP request failed:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  r.post('/', handle);
  r.get('/', handle);   // SSE 流（GET 建立时已有会话）
  r.delete('/', handle); // 终止会话
  return r;
}

/** 关闭所有会话（进程退出时调用，避免句柄残留） */
export async function closeAllMcpTransports(): Promise<void> {
  await Promise.allSettled([...transports.values()].map((t) => t.close()));
  transports.clear();
}