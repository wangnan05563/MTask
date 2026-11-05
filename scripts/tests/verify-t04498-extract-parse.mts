// T04498 门脚本：真实 AI 输出的 JSON 围栏容错 + W1「一事一条」可判定口径（防回归）。
// 运行：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t04498-extract-parse.mts
const { parseAiJson } = await import('../../server/src/services/MemoryService');
const { validateWriting } = await import('../../server/src/util/memoryRewrite');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

// ---- parseAiJson：真实模型常见的三种包裹形态 ----
const payload = '{"memories":[{"title":"网关限流","content":"429 需指数退避","action":"ADD"}]}';
check('纯 JSON 直接解析', (parseAiJson<{ memories: unknown[] }>(payload).memories.length === 1));
check('```json 围栏（实测失败形态）可解析',
  parseAiJson<{ memories: unknown[] }>('```json\n' + payload + '\n```').memories.length === 1);
check('无语言标记围栏可解析',
  parseAiJson<{ memories: unknown[] }>('```\n' + payload + '\n```').memories.length === 1);
check('围栏前后带解释文字可解析',
  parseAiJson<{ memories: unknown[] }>('以下是抽取结果：\n```json\n' + payload + '\n```\n请核对。').memories.length === 1);
check('无围栏但前后有说明可截取',
  parseAiJson<{ memories: unknown[] }>('好的，结果如下：' + payload + ' 以上。').memories.length === 1);
let threw = false;
try { parseAiJson('不是 JSON'); } catch { threw = true; }
check('不可解析时明确抛错（不静默吞）', threw);

// ---- W1「一事一条」可判定口径：1~2 个句末标点合格，3 个及以上违规 ----
check('单句合格', validateWriting({ title: 't', content: '服务端改为指数退避，初始 1s、上限 30s，并发阈值抬到 50 以避免瞬时抖动触发限流的完整说明。' }).length === 0,
  JSON.stringify(validateWriting({ title: 't', content: '服务端改为指数退避，初始 1s、上限 30s，并发阈值抬到 50 以避免瞬时抖动触发限流的完整说明。' })));
const twoSentences = '服务端改为指数退避，初始 1s、上限 30s；并发阈值抬到 50，避免瞬时抖动触发限流并保持 P95 延迟在 120ms 以内的完整说明。';
check('同主题两句（做法+效果）合格', validateWriting({ title: 't', content: twoSentences }).length === 0, JSON.stringify(validateWriting({ title: 't', content: twoSentences })));
const threeSentences = '服务端改为指数退避。初始 1s、上限 30s。并发阈值抬到 50 以避免瞬时抖动触发限流并保持延迟稳定的完整说明。';
check('三句（多事拼条）判 W1', validateWriting({ title: 't', content: threeSentences }).includes('W1'), JSON.stringify(validateWriting({ title: 't', content: threeSentences })));
check('W8 长度 30-120 字仍生效', validateWriting({ title: 't', content: '太短。' }).includes('W8'));
check('W2 代词开头仍违规', validateWriting({ title: 't', content: '它需要在 50 并发以上开始指数退避并保持延迟稳定的完整说明。' }).includes('W2'));

console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
