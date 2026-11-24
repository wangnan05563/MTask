import assert from 'node:assert/strict';
import { QueueService, receiptWarnings } from '../src/services/QueueService';
import { systemPromptFor } from '../src/adapters/types';

const desc60 = '扫描最近三天的技术热点：GitHub 上近期冒头的项目（看增速而非总 star 数）、常用技术栈的重要版本发布或重大特性、值得关注的行业动态或开源事件。全文 10 行以内；每个项目一句话说清它做什么、为什么突然火、和我的关系；没有值得看的内容直接说没有，不要凑数。按「新项目」「版本更新」「其他动态」分段，无内容写「本期无」。';

function payload(description: string, webSources: string[]) {
  return JSON.stringify({
    title: description.slice(0, 8),
    description,
    webSources,
    webSearchState: webSources.length ? 'ok' : 'empty',
    webItems: webSources.map((url) => ({ title: 'source', url })),
  });
}

const full = `**新项目**
- a/b 做 A，本周新增 1,000 stars。https://github.com/a/b
- c/d 做 B，本周新增 200 stars。https://github.com/c/d
**版本更新**
- Gemini 4 Neon 正式推出。https://deepmind.google/blog/introducing-gemini-4-neon/
**其他动态**
- E 动态。https://github.com/a/b
- F 动态。https://github.com/c/d`;
const sources = [
  'https://github.com/a/b',
  'https://github.com/c/d',
  'https://deepmind.google/blog/introducing-gemini-4-neon/',
];

const noLink = receiptWarnings({
  request_payload: payload(desc60, sources),
  response_payload: '**新项目**\n- a/b 做 A。\n**版本更新**\n本期无\n**其他动态**\n本期无',
});
assert(noLink.some((w) => w.code === 'no_source'), 'T06060 无链接应被拦截');

const complete = receiptWarnings({ request_payload: payload(desc60, sources), response_payload: full });
assert.deepEqual(complete, [], `完整回执不应有警告：${JSON.stringify(complete)}`);

const emptyNew = receiptWarnings({
  request_payload: payload(desc60, sources),
  response_payload: '**新项目**\n本期无\n**版本更新**\n- Gemini 4 Neon 正式推出。https://deepmind.google/blog/introducing-gemini-4-neon/\n**其他动态**\n本期无',
});
assert(!emptyNew.some((w) => w.label === '新项目段缺少 GitHub 仓库'), '新项目本期无不应被误判');

const devContext = {
  taskId: 'x',
  title: '修复发布流程',
  description: '实现发布接口的修复，补充测试和部署步骤。',
  projectName: 'p',
  webContext: '<untrusted_search_results>检索结果</untrusted_search_results>',
};
assert(systemPromptFor(devContext).includes('开发任务执行者'), '开发任务不应切换为资讯提示词');
assert(!systemPromptFor(devContext).includes('资讯研究执行者'), '开发任务不应包含资讯研究角色');

const emptySearch = receiptWarnings({
  request_payload: payload(desc60, []),
  response_payload: '今天发现一条新闻。https://fake-news.example/item',
});
assert(emptySearch.some((w) => w.label === '检索失败但回执仍带链接'), '检索失败但回执带链接应被拦截');

// no-source 诊断里带 URL 时，状态仍必须是 empty，不能被 URL 数量误判为 ok。
const noSourceSnapshot = QueueService.snapshotTaskContext({
  id: 'fixture-task',
  title: '技术热点简报',
  description: desc60,
  priority: 0,
} as never, 'fixture', '联网检索：已尝试公开搜索，但没有获取到可用来源（已过滤广告/无关结果）。\n检索词：AI；日期：2026-11-18\n检索诊断：Bing：https://error.example/404');
const noSourceState = JSON.parse(noSourceSnapshot).webSearchState;
assert.equal(noSourceState, 'empty', 'no-source 诊断含 URL 时仍应标记 empty');

const partialSource = receiptWarnings({
  request_payload: payload(desc60, sources),
  response_payload: '**新项目**\n- a/b 做 A。https://github.com/a/b\n- c/d 做 B，无来源\n**版本更新**\n- Gemini 正式推出。https://deepmind.google/blog/introducing-gemini-4-neon/\n**其他动态**\n本期无',
});
assert(partialSource.some((w) => w.label === '部分条目缺少来源'), '部分条目无来源应被拦截');

const releaseByTitle = receiptWarnings({
  request_payload: JSON.stringify({
    title: '技术热点简报',
    description: desc60,
    webSources: ['https://example.com/articles/gemini'],
    webSearchState: 'ok',
    webItems: [{ title: 'Gemini 4 Neon 正式推出', url: 'https://example.com/articles/gemini' }],
  }),
  response_payload: '**新项目**\n本期无\n**版本更新**\n本期无\n**其他动态**\n本期无',
});
assert(releaseByTitle.some((w) => w.label === '版本更新段误报本期无'), '标题含发布类词时应命中版本更新检查');

console.log('queue-quality-check: 8 fixtures passed');
