#!/usr/bin/env node
/**
 * T05796 fake CLI：用于 CLI Process Adapter 的可重复验收，不触达真实平台。
 *
 * 用法：
 *   node scripts/fake-cli-agent.mjs --success
 *   node scripts/fake-cli-agent.mjs --fail
 *   node scripts/fake-cli-agent.mjs --empty
 *   node scripts/fake-cli-agent.mjs --sleep 3000 --success
 *   node scripts/fake-cli-agent.mjs --json
 *   node scripts/fake-cli-agent.mjs --version
 *
 * 输入：TaskContext prompt 从 stdin 读取；输出：Markdown（或 --json 的 JSON）。
 */
import process from 'node:process';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    // 没有 stdin 管道时（例如手工 `node fake-cli-agent.mjs --success`），不要永久等待。
    if (process.stdin.isTTY) resolve('');
  });
}

const mode = process.argv.includes('--fail')
  ? 'fail'
  : process.argv.includes('--empty')
    ? 'empty'
    : process.argv.includes('--version')
      ? 'version'
      : 'success';
const sleepMs = Number(argValue('--sleep', '0')) || 0;

if (mode === 'version') {
  process.stdout.write('fake-cli-agent 1.0.0\n');
  process.exit(0);
}

const prompt = await readStdin();
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

if (mode === 'fail') {
  process.stderr.write('fake-cli-agent: simulated platform failure\n');
  process.exit(2);
}
if (mode === 'empty') {
  process.exit(0);
}

const taskNo = (prompt.match(/【任务编号】\s*(\S+)/) || [])[1] || 'unknown';
const title = (prompt.match(/【标题】\s*(.+)/) || [])[1]?.trim() || 'unknown';
const content = [
  '## 根因',
  `fake-cli-agent 成功执行任务「${title}」（${taskNo}），验证 stdout → handle_result → done 链路。`,
  '',
  '## 影响范围',
  '仅限隔离验收环境；未触达真实平台、未修改生产配置。',
  '',
  '## 修复',
  '- 通用 CLI Process Adapter 已实现 submit/poll/send；',
  '- stdout 作为 Markdown 结果，stderr 与 exitCode 作为失败原因；',
  '- 失败/超时由 AIService 回退 A 就绪池。',
  '',
  '## 验证',
  '- fake-cli-agent 退出码 0，stdout 非空；',
  '- MTask 队列 Job 成功完成并写入 handle_result。',
  '',
  '## 本次回写',
  '无派生任务；本结果为 fake CLI 隔离验收。',
].join('\n');

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ content })}\n`);
} else {
  process.stdout.write(`${content}\n`);
}
