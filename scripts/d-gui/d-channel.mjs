#!/usr/bin/env node
/**
 * T05749 D 通道人工闸门与审计器。
 *
 * 只做三件事：强制人工确认、拒绝敏感提示词、把 GUI 操作步骤写成 JSONL 审计日志。
 * 不做 GUI 自动化本身——GUI 由操作者按 skills/workbuddy-mtask-dgui/SKILL.md 用
 * Playwright MCP / computer-use 执行，保证 D 通道始终有人在场。
 *
 * 用法：
 *   node scripts/d-gui/d-channel.mjs start --task T05749 --task-title "..." --prompt-file p.txt \
 *     --page-title "..." --account "hs***" --workspace "..." --operator "..." --confirm
 *   node scripts/d-gui/d-channel.mjs step --session d-... --action browser_snapshot --result ok --note "..."
 *   node scripts/d-gui/d-channel.mjs finish --session d-... --status success --note "..."
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = { maxSteps: 40, maxSeconds: 900 };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(message) {
  console.error(`拒绝：${message}`);
  process.exit(2);
}

function logDir(args) {
  return path.resolve(args['log-dir'] || path.join(process.cwd(), 'logs', 'd-channel'));
}

function sessionFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

function appendEvent(dir, id, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
}

function loadSession(dir, id) {
  const file = sessionFile(dir, id);
  if (!fs.existsSync(file)) die(`未找到 D 会话 ${id}（${file}）`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveSession(dir, id, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile(dir, id), JSON.stringify(state, null, 2), 'utf8');
}

// 只拦「赋值形态」的敏感值，避免把任务描述里正常的 “token 校验” 误判成泄漏。
const SECRET_PATTERNS = [
  /(password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
  /(api[_-]?key|access[_-]?token|secret[_-]?key|token)\s*[:=]\s*\S{8,}/i,
  /bearer\s+[a-z0-9._~+\/=-]{16,}/i,
  /sk-[a-z0-9]{16,}/i,
  /ghp_[a-z0-9]{20,}/i,
];

function assertPromptSafe(text) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) die('提示词疑似包含密码/token 赋值，请先脱敏（D 通道禁止把凭据写入 prompt）');
  }
}

function requireField(args, key, label) {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) die(`缺少 ${label}（--${key}）`);
  return v.trim();
}

function cmdStart(args) {
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, message: '仅校验参数，未写日志' }));
    return;
  }
  if (args.confirm !== true) die('缺少 --confirm：D 通道每次运行前必须人工确认，禁止无人值守');
  const task = requireField(args, 'task', '任务号');
  if (!/^T\d{5,}$/.test(task)) die(`任务号格式应为 Txxxxx，收到 ${task}`);
  const taskTitle = requireField(args, 'task-title', '任务标题');
  const promptFile = requireField(args, 'prompt-file', '提示词文件');
  if (!fs.existsSync(promptFile)) die(`提示词文件不存在：${promptFile}`);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  if (!prompt.trim()) die('提示词为空');
  assertPromptSafe(prompt);
  const pageTitle = requireField(args, 'page-title', '页面标题（只读快照）');
  const account = requireField(args, 'account', '登录账号（脱敏）');
  const workspace = requireField(args, 'workspace', '工作空间');
  const operator = requireField(args, 'operator', '操作者');
  const maxSteps = Number(args['max-steps'] || DEFAULTS.maxSteps);
  const maxSeconds = Number(args['max-seconds'] || DEFAULTS.maxSeconds);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) die('--max-steps 需为 1~100 整数');
  if (!Number.isInteger(maxSeconds) || maxSeconds < 60 || maxSeconds > 1800) die('--max-seconds 需为 60~1800 整数');

  const dir = logDir(args);
  const id = `d-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  const state = {
    sessionId: id,
    task,
    taskTitle,
    pageTitle,
    account,
    workspace,
    operator,
    promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
    promptLength: prompt.length,
    status: 'active',
    startedAt: new Date().toISOString(),
    maxSteps,
    maxSeconds,
    steps: 0,
    lastEventAt: null,
  };
  saveSession(dir, id, state);
  appendEvent(dir, id, {
    event: 'start', task, taskTitle, pageTitle, account, workspace, operator,
    promptSha256: state.promptSha256, promptLength: state.promptLength, maxSteps, maxSeconds,
    note: '人工确认已通过（--confirm）',
  });
  console.log(JSON.stringify({ ok: true, sessionId: id, logDir: dir, logFile: path.join(dir, `${id}.jsonl`), maxSteps, maxSeconds }));
}

function cmdStep(args) {
  const id = requireField(args, 'session', '会话 id');
  const dir = logDir(args);
  const state = loadSession(dir, id);
  if (state.status !== 'active') die(`会话 ${id} 已结束（${state.status}），不能再记步骤`);
  const action = requireField(args, 'action', '动作名');
  const result = typeof args.result === 'string' ? args.result : 'ok';
  const elapsed = Date.now() - new Date(state.startedAt).getTime();
  if (elapsed > state.maxSeconds * 1000) {
    finishState(dir, id, state, 'failed', `超时（>${state.maxSeconds}s），自动收口`);
    die(`已超过最大时长 ${state.maxSeconds}s，D 会话已置 failed`);
  }
  if (state.steps + 1 > state.maxSteps) {
    finishState(dir, id, state, 'failed', `超过最大步数 ${state.maxSteps}，自动收口`);
    die(`已超过最大步数 ${state.maxSteps}，D 会话已置 failed`);
  }
  state.steps += 1;
  state.lastEventAt = new Date().toISOString();
  saveSession(dir, id, state);
  const note = typeof args.note === 'string' ? args.note : '';
  appendEvent(dir, id, { event: 'step', step: state.steps, action, result, note });
  console.log(JSON.stringify({ ok: true, sessionId: id, step: state.steps, maxSteps: state.maxSteps, elapsedMs: elapsed }));
}

function finishState(dir, id, state, status, note) {
  state.status = status;
  state.finishedAt = new Date().toISOString();
  saveSession(dir, id, state);
  appendEvent(dir, id, { event: 'finish', status, note: note || '', steps: state.steps });
}

function cmdFinish(args) {
  const id = requireField(args, 'session', '会话 id');
  const dir = logDir(args);
  const state = loadSession(dir, id);
  if (state.status !== 'active') die(`会话 ${id} 已结束（${state.status}）`);
  const status = requireField(args, 'status', '结束状态');
  if (!['success', 'failed'].includes(status)) die('--status 只能是 success 或 failed');
  const note = typeof args.note === 'string' ? args.note : '';
  finishState(dir, id, state, status, note);
  console.log(JSON.stringify({
    ok: true, sessionId: id, status, steps: state.steps,
    startedAt: state.startedAt, finishedAt: state.finishedAt, logFile: path.join(dir, `${id}.jsonl`),
  }));
}

function main() {
  const action = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!action || !['start', 'step', 'finish'].includes(action)) {
    console.error('用法：d-channel.mjs start|step|finish [--参数]');
    process.exit(1);
  }
  if (action === 'start') return cmdStart(args);
  if (action === 'step') return cmdStep(args);
  return cmdFinish(args);
}

main();
