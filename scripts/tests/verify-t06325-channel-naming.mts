/**
 * T06325：B0/A/D 通道命名一致性验收。
 *
 * 目标：机器值仍为 B0/A/D，但所有面向用户的展示统一为
 * CodeBuddy 网关 / MCP 就绪池 / 人工确认；任一页面不得再把代号当主标签。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t06325-channel-naming.mts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const server = await import('../../server/src/services/DispatchChannels.ts');
const web = await import('../../web/src/ui/dispatchChannel.ts');

const expected = [
  { code: 'B0', name: 'CodeBuddy 网关', shortName: '网关', englishName: 'Gateway' },
  { code: 'A', name: 'MCP 就绪池', shortName: '就绪池', englishName: 'ReadyPool' },
  { code: 'D', name: '人工确认', shortName: '人工', englishName: 'Manual' },
] as const;

for (const item of expected) {
  const meta = server.DISPATCH_CHANNELS[item.code];
  ok(`服务端 ${item.code} 主名称`, meta?.name === item.name, meta);
  ok(`服务端 ${item.code} 短名称`, meta?.shortName === item.shortName, meta);
  ok(`服务端 ${item.code} 英文名`, meta?.englishName === item.englishName, meta);
  ok(`前端 ${item.code} 主名称`, web.DISPATCH_CHANNELS[item.code]?.name === item.name, web.DISPATCH_CHANNELS[item.code]);
  ok(`前端 ${item.code} 短名称`, web.DISPATCH_CHANNELS[item.code]?.shortName === item.shortName, web.DISPATCH_CHANNELS[item.code]);
  ok(`前端 ${item.code} 英文名`, web.DISPATCH_CHANNELS[item.code]?.englishName === item.englishName, web.DISPATCH_CHANNELS[item.code]);
  ok(`名称函数 ${item.code}`, server.dispatchChannelLabel(item.code) === item.name && web.dispatchChannelName(item.code) === item.name);
}

ok('机器值契约保持 B0/A/D', server.DISPATCH_CHANNEL_CODE.GATEWAY === 'B0' && server.DISPATCH_CHANNEL_CODE.READY_POOL === 'A' && server.DISPATCH_CHANNEL_CODE.MANUAL === 'D');
ok('平台值契约保持 codebuddy-gateway/mcp/d-gui', server.DISPATCH_PLATFORM.GATEWAY === 'codebuddy-gateway' && server.DISPATCH_PLATFORM.READY_POOL === 'mcp' && server.DISPATCH_PLATFORM.MANUAL === 'd-gui');
ok('错误码可读化 B0_NOT_CONFIGURED', web.dispatchErrorCodeLabel('B0_NOT_CONFIGURED') === 'CodeBuddy 网关未配置');
ok('错误码可读化 A_NOT_READY', web.dispatchErrorCodeLabel('A_NOT_READY') === 'MCP 就绪池归位失败');
ok('错误码可读化 D_MANUAL_ONLY', web.dispatchErrorCodeLabel('D_MANUAL_ONLY') === '需人工确认');
ok('历史文案 B0 失败可读化', !web.humanizeDispatchText('B0 失败，回退 A 就绪池').includes('B0'), web.humanizeDispatchText('B0 失败，回退 A 就绪池'));

const legend = web.DISPATCH_CHANNEL_LEGEND as string;
ok('统一口径说明不含原始代号赋值', !/[BDA]0?\s*=\s*CodeBuddy|[BDA]\s*=\s*MCP|[BDA]\s*=\s*人工/.test(legend), legend);
ok('统一口径说明包含三通道主名', legend.includes('CodeBuddy 网关') && legend.includes('MCP 就绪池') && legend.includes('人工确认'), legend);

const uiFiles = [
  'web/src/components/DispatchMenu.tsx',
  'web/src/components/DispatchRecent.tsx',
  'web/src/pages/DispatchPolicyPanel.tsx',
  'web/src/pages/DispatchRecordsPanel.tsx',
  'web/src/pages/ExecSessionsPage.tsx',
  'web/src/pages/HelpTab.tsx',
  'web/src/pages/QueuePage.tsx',
  'web/src/pages/queuePanels.tsx',
];
const banned = /（B0）|（A）|（D）|Agent 就绪池|人工处理（|B0 派发|A 就绪池|D 通道|D 人工|B0 未配置/;
for (const rel of uiFiles) {
  const text = read(rel);
  const hit = text.match(banned)?.[0] ?? '';
  ok(`${rel} 无代号主标签`, !hit, hit);
}

const dispatcher = read('server/src/services/PushDispatcher.ts');
ok('PushDispatcher 不再暴露技术码括号', !/技术码\s*[BAD]0?/.test(dispatcher));
ok('PushDispatcher 详情使用三通道主名', dispatcher.includes('CodeBuddy 网关') && dispatcher.includes('MCP 就绪池') && dispatcher.includes('人工确认'));

const policy = read('server/src/services/DispatchPolicy.ts');
ok('DispatchPolicy 网关校验使用可读名称', policy.includes('CodeBuddy 网关工具不存在') && policy.includes('CodeBuddy 网关工具未启用'));

const errors = lines.filter((line) => line.startsWith('[FAIL]'));
console.log(lines.join('\n'));
console.log(`\nT06325 channel naming: ${pass} passed, ${fail} failed`);
if (errors.length) process.exitCode = 1;
