/**
 * T02770：门体「用了但解析不到的标识符」静态自检器（AST 级，非 grep）。
 *
 * 立项缘由（批㉛ 实测）：给 `verify-t01875.mjs` 加残留判据时写了 `existsSync(...)` 却漏加
 * `import { existsSync } from 'node:fs'`。`node --check` 只做**语法**解析，查不出这类未定义标识符，
 * 于是门跑到 `finally` 才抛 `existsSync is not defined`——PASS/FAIL 汇总整行丢失、判据一条没落，
 * 红看起来像「门自身崩溃的既有噪声」。本自检器把这一类做成**可机械判定的加载面缺陷**。
 *
 * ⚠ 为什么必须是 AST（母单点名的三类 grep 假阳，本轮手写正则粗扫 109 支报了 23 个文件、逐条核对全假）：
 *   ① `import fs from 'node:fs'` 命名空间形式——调用写作 `fs.existsSync`，读用的根标识符是 `fs`；
 *   ② `const { existsSync } = require('node:fs')` 解构绑定；
 *   ③ 门体内嵌的**夹具字符串**（如 `verify-t02071` 的 ``script: `const fs=require('fs');…` ``）
 *      里的标识符不属于门体作用域。
 * 这三类在 AST 下天然不成问题：① 成员链只取最左根、② 绑定名进 declared 集、③ 字符串字面量整体不解析。
 *
 * 口径与诚实边界（供判据引用）：
 *   - **保守**判定：只做「读位置的根标识符 ∉ 全篇绑定名 ∪ 全局表」。不做作用域层级解析，
 *     因此「块内声明块外使用」「TDZ 内先读后声明」这类不在本判据射程内（它们是另一类错，
 *     混进来会让本判据的红因重新不可归因）。反过来说：报出来就意味着**全篇没有任何绑定**，
 *     这类必然是加载即 ReferenceError。
 *   - 语法层失败（`parseDiagnostics`）单独回传为 `parseError`，不产出命中——那是 `--check` 的射程。
 *   - TypeScript 类型位不 descend（类型名不是运行时读用）；`interface`/`type`/`enum`/`namespace`
 *     声明整体跳过，故漏 `import type` 把类型当值用的情形仍会命中（这是要抓的）。
 *   - CJS/ESM 不判：`.mjs` 里出现 `require`/`__dirname` 不报红（放行进全局表），同属另一族问题。
 *
 * 跑法（随仓库 tsx）：
 *   `npx tsx scripts/lib/undefined-identifier-check.mts`              # 无参：扫 git HEAD 的 verify-* 与 lib/*
 *   `npx tsx scripts/lib/undefined-identifier-check.mts <file...>`    # 有参：按工作树逐文件扫
 */

import * as ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface UndefinedHit {
  name: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
}

export interface CheckResult {
  fileName: string;
  hits: UndefinedHit[];
  /** 语法层原因；有它时 `hits` 必为空（AST 已不可信，行号不报） */
  parseError?: string;
}

/** ECMAScript + Node + 常见宿主全局；只用于放行，不是「允许乱用全局」的背书。 */
const GLOBALS = new Set([
  // JS 内建
  'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'DataView', 'Date', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'Error', 'EvalError', 'escape', 'eval', 'FinalizationRegistry', 'Float16Array', 'Float32Array',
  'Float64Array', 'Function', 'globalThis', 'Infinity', 'Intl', 'isFinite', 'isNaN', 'JSON', 'Map',
  'Math', 'NaN', 'Number', 'Object', 'parseFloat', 'parseInt', 'Promise', 'Proxy', 'RangeError',
  'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol',
  'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
  'undefined', 'unescape', 'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'arguments',
  // Node / 边缘运行时
  'AbortController', 'AbortSignal', 'AsyncLocalStorage', 'Blob', 'BroadcastChannel', 'Buffer',
  'ByteLengthQueuingStrategy', 'CloseEvent', 'CompressionStream', 'console', 'CountQueuingStrategy',
  'crypto', 'CustomEvent', 'DOMException', 'Event', 'EventSource', 'EventTarget', 'fetch', 'File',
  'FormData', 'global', 'Headers', 'Image', 'location', 'localStorage', 'MessageChannel',
  'MessageEvent', 'MessagePort', 'navigator', 'onmessage', 'performance', 'postMessage', 'process',
  'queueMicrotask', 'ReadableByteStreamController', 'ReadableStream', 'ReadableStreamBYOBReader',
  'ReadableStreamDefaultController', 'ReadableStreamDefaultReader', 'Request', 'Response', 'self',
  'sessionStorage', 'Storage', 'structuredClone', 'TextDecoder', 'TextDecoderStream', 'TextEncoder',
  'TextEncoderStream', 'TransformStream', 'TransformStreamDefaultController', 'URL', 'URLPattern',
  'URLSearchParams', 'WebSocket', 'Window', 'Worker', 'WritableStream',
  'WritableStreamDefaultController', 'WritableStreamDefaultWriter', 'WebAssembly',
  // 定时器与剩余typed array（首轮实测漏收 `setTimeout`/`Int32Array`，被当成未定义标识符）
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
  'Int8Array', 'Int16Array', 'Int32Array',
  // CJS / 加载器注入（见文件头：模块体系不属本判据射程）
  'require', 'module', 'exports', '__dirname', '__filename',
]);

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (/\.(mts|cts)$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.(mjs|cjs|js)$/.test(fileName)) return ts.ScriptKind.JS;
  if (/\.ts$/.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** 递归收绑定名（标识符 / 数组与对象解构 / 绑定元素） */
function addBindings(node: ts.Node, declared: Set<string>): void {
  if (ts.isIdentifier(node)) {
    declared.add(node.text);
    return;
  }
  if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) {
    for (const el of node.elements) addBindings(el, declared);
    return;
  }
  if (ts.isBindingElement(node)) {
    addBindings(node.name, declared);
    // 解构默认值里的读用（`const { a = b } = obj`）本函数不管，交给读扫描
    return;
  }
}

/** 声明/类型位：整体跳过，不 descend（这些名字不是运行时读用） */
function isSkippedSubtree(node: ts.Node): boolean {
  // `ExpressionWithTypeArguments` 落在 TS 的类型节点 kind 区间里，但 `class B extends BaseSvc`
  // 的基类是**运行时取值**（漏 import 就是加载即崩）。接口继承同为此节点，却因
  // `InterfaceDeclaration` 整片被跳过而不会误报。夹具 F9 首跑即抓到这条。
  if (node.kind === ts.SyntaxKind.ExpressionWithTypeArguments) return false;
  if (ts.isTypeNode(node) || ts.isTypeElement(node)) return true;
  switch (node.kind) {
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.ImportDeclaration:
    case ts.SyntaxKind.ImportEqualsDeclaration:
    case ts.SyntaxKind.ExportDeclaration:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.JSDoc:
    case ts.SyntaxKind.MetaProperty:
    case ts.SyntaxKind.QualifiedName:
    case ts.SyntaxKind.NamedTupleMember:
      return true;
    default:
      return false;
  }
}

/**
 * 某个 Identifier 处在「非读位置」吗？靠 parent 判：成员名、声明名、对象字面量 key、label 等。
 * （简写属性 `{ x }` 例外——它是真读用，故不在非读位置里。）
 */
function isNonReadPosition(ident: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === ident) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return false; // 读用
  if (ts.isPropertyAssignment(parent) && parent.name === ident) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === ident) return true;
  if (ts.isPropertySignature(parent) && parent.name === ident) return true;
  if (ts.isMethodSignature(parent) && parent.name === ident) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === ident) return true;
  if (ts.isGetAccessorDeclaration(parent) && parent.name === ident) return true;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === ident) return true;
  if (ts.isEnumMember(parent) && parent.name === ident) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === ident) return true;
  if (ts.isBindingElement(parent) && parent.name === ident) return true;
  if (ts.isParameter(parent) && parent.name === ident) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === ident) return true;
  if (ts.isFunctionExpression(parent) && parent.name === ident) return true;
  if (ts.isClassDeclaration(parent) && parent.name === ident) return true;
  if (ts.isClassExpression(parent) && parent.name === ident) return true;
  if (ts.isLabeledStatement(parent) && parent.label === ident) return true;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === ident) return true;
  if (ts.isQualifiedName(parent)) return true; // 类型限定名（值位已排除）
  if (ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isBindingPattern(parent)) return true;
  return false;
}

/** 成员/下标链的最左根 */
function chainRoot(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression as ts.Expression;
      continue;
    }
    return cur;
  }
}

/** 主入口：源码进、命中出（无副作用，可直接被门体与夹具复用） */
export function checkSource(code: string, fileName: string): CheckResult {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindOf(fileName));
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const msg = typeof diags[0].messageText === 'string' ? diags[0].messageText : String(diags[0].messageText);
    return { fileName, hits: [], parseError: msg };
  }

  const declared = new Set<string>();
  const bindWalk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) addBindings(node.name, declared);
    else if (ts.isParameter(node)) addBindings(node.name, declared);
    else if (ts.isCatchClause(node) && node.declaration) addBindings(node.declaration.name, declared);
    else if (ts.isImportDeclaration(node) && node.importClause) {
      const ic = node.importClause;
      if (ic.name) declared.add(ic.name.text);
      const nb = ic.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) declared.add(nb.name.text);
      // 具名导入 `import { join, existsSync as ex } from 'node:fs'`：本地名是 `specifier.name`
      // （`propertyName` 是被导入方的名字，不是本文件的绑定）。首轮实测漏掉这一步，
      // 106 支门体里 102 支被误报成「用了没 import」——正是母单警告的 grep 式噪声的 AST 版本。
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const local = ts.isImportSpecifier(el) ? (el.name ?? el.propertyName) : el.name;
          if (local && ts.isIdentifier(local)) declared.add(local.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      declared.add(node.name.text);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declared.add(node.name.text);
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      declared.add(node.name.text);
    }
    ts.forEachChild(node, bindWalk);
  };
  bindWalk(sf);

  const hits: UndefinedHit[] = [];
  const seen = new Set<string>();
  const report = (ident: ts.Identifier, parent: ts.Node | undefined): void => {
    if (isNonReadPosition(ident, parent)) return;
    const name = ident.text;
    if (GLOBALS.has(name) || declared.has(name)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(ident.getStart(sf));
    const key = `${name}@${line}:${character}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ name, line: line + 1, column: character + 1 });
  };

  const useWalk = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (isSkippedSubtree(node)) return;
    // 绑定语法自身不是读用：`const { EstimateService: S } = …` 里 `EstimateService` 是**被导入方的名字**，
    // 只有 `S` 是本文件的绑定；默认值 `{ A: b = c }` 里的 `c` 才是读用。
    // （首轮实测 106 支只剩 4 支命中，7 处全是这一类重命名解构被误当读用。）
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      const init = (node as ts.VariableDeclaration | ts.PropertyDeclaration).initializer;
      if (init) useWalk(init, node);
      const bname = node.name;
      if (ts.isArrayBindingPattern(bname) || ts.isObjectBindingPattern(bname)) {
        ts.forEachChild(bname, (c) => useWalk(c, node)); // 解构默认值里可以有读用
      }
      return;
    }
    if (ts.isBindingElement(node)) {
      if (node.initializer) useWalk(node.initializer, node);
      return;
    }
    if (ts.isParameter(node)) {
      if (node.name && (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name))) {
        ts.forEachChild(node.name, (c) => useWalk(c, node));
      }
      if (node.initializer) useWalk(node.initializer, node);
      ts.forEachChild(node.decorators ?? [], (c) => useWalk(c, node));
      return;
    }
    // 字符串面与模板静默段不 descend（门体内嵌夹具字符串天然安全）；
    // 但 `${…}` 插值是门体自己的读用，故 TemplateExpression 走 forEachChild 只扫 span 的表达式
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) useWalk(span.expression, node);
      return;
    }
    if (ts.isIdentifier(node)) {
      report(node, parent);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // 只把最左根当读用；成员名由 parent 判定放行
      const root = chainRoot(node);
      if (ts.isIdentifier(root)) report(root, node);
      else useWalk(root, node);
      if (ts.isElementAccessExpression(node)) useWalk(node.argumentExpression, node);
      return;
    }
    ts.forEachChild(node, (c) => useWalk(c, node));
  };
  useWalk(sf, undefined);

  return { fileName, hits };
}

/** HEAD 里的 JS 系门体与 lib 清单（`scripts/verify-*` + `scripts/lib/*`） */
export function listHeadGateFiles(cwd: string): string[] {
  const out = execFileSync('git', ['--no-pager', 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'scripts'], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split(/\r?\n/)
    .filter((p) => /^scripts\/(verify-[^/]+|lib\/[^/]+)\.(js|mjs|cjs|mts|ts)$/.test(p))
    .sort();
}

export function headSource(rel: string, cwd: string): string {
  return execFileSync('git', ['--no-pager', 'show', `HEAD:${rel}`], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

// —— CLI ——
const invokedAsCli = !!process.argv[1] && /undefined-identifier-check\.(mts|ts|js|mjs)$/.test(process.argv[1]);
if (invokedAsCli) {
  const args = process.argv.slice(2);
  const root = process.env['UNDEF_CHECK_ROOT'] || process.cwd();
  if (args.length === 0) {
    const files = listHeadGateFiles(root);
    const bad: string[] = [];
    const syntax: string[] = [];
    for (const f of files) {
      let code: string;
      try {
        code = headSource(f, root);
      } catch {
        continue; // HEAD 里没有 ⇒ 不属本判据
      }
      const r = checkSource(code, f);
      if (r.parseError) {
        syntax.push(f);
        console.log(`语法层 ${f} :: ${r.parseError}`);
        continue;
      }
      if (r.hits.length) {
        bad.push(f);
        for (const h of r.hits) console.log(`未定义标识符 ${f}:${h.line}:${h.column} ${h.name}`);
      }
    }
    console.log(`扫 ${files.length} 支：未定义标识符 ${bad.length} 支 · 语法层 ${syntax.length} 支`);
    if (bad.length) console.log(`点名：${bad.join(' ')}`);
    process.exitCode = bad.length > 0 ? 1 : 0;
  } else {
    for (const f of args) {
      const r = checkSource(readFileSync(f, 'utf8'), f);
      const tag = r.parseError ? `语法层: ${r.parseError}` : r.hits.map((h) => `${h.line}:${h.column} ${h.name}`).join(', ');
      console.log(`${r.hits.length || r.parseError ? '未通过' : '通过'} ${f}${tag ? ' — ' + tag : ''}`);
    }
    process.exitCode = 0;
  }
}
