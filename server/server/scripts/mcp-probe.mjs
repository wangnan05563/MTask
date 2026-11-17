import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const c = new Client({ name: 'probe', version: '1.0' }, { capabilities: {} });
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:39876/api/mcp')));
try {
  const r = await c.callTool({ name: 'mtask_gather_report_data', arguments: { period: 'year' } });
  console.log('TSX_RESULT isError=', r.isError, JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.log('TSX_THREW:', e?.message ?? e);
}
await c.close().catch(() => {});
