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
 * 批㊳（T02795 裁决）：上述三类留白**各立独立档**判据（`checkBlockScope` / `checkTdz` /
 * `checkModuleMix`），与主判据同族不同判——每档各自配**双向**夹具（注入必红、合法写法必绿），
 * 红因归因互不掺混；不扩 TS Program 全量作用域解析（批㉝ 实测纯 AST 扫 106 支 7079ms，
 * 上 Program 会把审计门推离「随手可跑」定位）。**产品源码面（server/src·web/src）不纳入本普查**，
 * TS 侧未定义标识符归 `npm run typecheck` 门下；本 lib 射程只有 `scripts/verify-*` 与
 * `scripts/lib/*`（门体与门用 lib 的加载面）。
 *
 * 三档判据口径（普查 0 读数的**逐类剔除留痕**，实测语料 108 支 HEAD 门体）：
 *   档一 `checkBlockScope`——只判「块内 let/const/class 在块外读用」。登记面按宿主分三类：
 *     函数体块按**体顶层**登记（var/具名声明有提升语义、不造词法面），语句宿主块按**花括号层**登记，
 *     `switch` 按 **CaseClause 段**登记（case 后的声明对 switch 后读点是逃逸），`for` 头声明可见整条 for。
 *     剔除的四类过度敏感读数：① 箭头/函数参数是**函数层**绑定不是块绑定；② `var` 泄漏；
 *     ③ 重命名解构 `const { a: b } = …` 里的 `a` 是取键不是读用（`isNonReadPosition` 补 BindingElement.propertyName）；
 *     ④ `catch (e) {…}` 的体块宿主是 CatchClause（不是 Statement），须按 face=CatchClause 登记才不把
 *     体内正常读 `e` 报成逃逸。CJS 包装语义（`.js`/`.cjs` 顶层块声明会泄漏）整类不判。
 *   档二 `checkTdz`——只判**同一执行容器内**语句级先读后声明。容器 = 模块顶层 / 各函数体 /
 *     各 `{}` 块（if·try·catch·分组块）/ 各 case 段；读点向上若遇到自带同名绑定的内层容器即**遮蔽**
 *     （门体族普遍写法是每个分组块 `const L = …` 逐段复用同名，批㊳ 首版正是把它读成 84 处假阳）。
 *     延后执行体（函数/箭头体内的读、初始化式里的箭头自递归 `const fn = () => fn(…)`）不判；
 *     `let x = x` 这类同语句自读单独成规（通用「读点<声明点」在它身上判不住）。`var` 不判。
 *   档三 `checkModuleMix`——`.mjs`/`.mts` 里的 CJS 运行时记号（`require`/`__dirname`/`__filename`/
 *     `module.exports`）与 `import x = require(…)`；`.cjs`/`.cts` 顶层的静态 `import`/`export`。
 *     剔除的一类：**文件内自建同名垫片**（`const require = createRequire(import.meta.url)`）后的读用
 *     是合法 ESM 惯用法——普查 18 处读数逐支取证，全部命中在本仓门体的 createRequire 垫片形上，
 *     故加 `localDeclNames` 遮蔽；字符串字面量与属性名位（`{ require: s }`）由读位置判定天然排除。
 *   三档共用 `parseTierSf`：AST 有 parseDiagnostics 即返 null、一律 0 命中（与主判据 L-03 同口径，
 *     语法坏的行号不能报）。
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
  if (ts.isBindingElement(parent) && parent.propertyName === ident) return true; // `{ a: b }` 的 a 是取键，非读用
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

// =====================================================================
// 批㊳（T02795）三档独立判据：主判据的三类留白各立一档，不掺混红因。
// 每档必须配双向夹具（注入必红 + 合法写法必绿）才可当判据用——反模式 58 的口径。
// =====================================================================

export interface TierHit {
  name: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  why: string;
}

const parseTierSf = (code: string, fileName: string): ts.SourceFile | null => {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  return (sf.parseDiagnostics ?? []).length > 0 ? null : sf;
};

/** 同一顶层函数/模块内才可比执行顺序（跨函数的读用不属 TDZ 射程） */
const topScopeOf = (node: ts.Node): ts.Node => {
  let cur: ts.Node = node;
  for (;;) {
    const p = cur.parent;
    if (!p || p.kind === ts.SyntaxKind.SourceFile) return cur;
    cur = p;
  }
};

/** 档一：块内词法声明、块外读用（运行期 ReferenceError；var/函数声明有提升语义，不入本档） */
export function checkBlockScope(code: string, fileName: string): TierHit[] {
  const sf = parseTierSf(code, fileName);
  if (!sf) return [];
  const topBindings = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) ||
        ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) ||
        ts.isVariableStatement(st)) {
      addBindings(st, topBindings);
    }
  }
  const lexicalBlocks: Array<{ name: string; start: number; end: number; esc: ts.Node }> = [];
  const directBinds = new Map<ts.Node, Set<string>>();
  const bindFace = new Map<ts.Node, Set<string>>(); // 含参数/catch/具名表达式的递归绑定面，只作抑制
  const enclosingFnOf = (node: ts.Node): ts.Node => {
    for (let a: ts.Node | undefined = node.parent; a; a = a.parent) if (ts.isFunctionLike(a)) return a;
    return sf;
  };
  const cjsWrapped = /\.(js|cjs)$/.test(fileName); // CJS 顶层有函数包装：顶层块声明会泄漏，不判
  const isBlockNode = (node: ts.Node): boolean =>
    node.kind === ts.SyntaxKind.Block || node.kind === ts.SyntaxKind.CaseBlock ||
    node.kind === ts.SyntaxKind.ModuleBlock || node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration;
  const stmtsOfBlock = (node: ts.Node): readonly ts.Statement[] =>
    node.kind === ts.SyntaxKind.CaseBlock
      ? (node as ts.CaseBlock).clauses.flatMap((c) => c.statements)
      : (node as ts.Block).statements;
  const collectAllBindings = (node: ts.Node, sink: Set<string>): void => {
    // 本层直接绑定：声明/参数/catch/具名声明；**不**下探嵌套块与函数体
    //（内层块的 let 不是本层绑定，否则逃逸判定会被宿主函数体的递归面吞掉）
    if (ts.isVariableDeclaration(node)) addBindings(node.name, sink);
    else if (ts.isParameter(node)) addBindings(node.name, sink);
    else if (ts.isCatchClause(node) && node.declaration) addBindings(node.declaration.name, sink);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) sink.add(node.name.text);
    if (ts.isBlock(node) || ts.isFunctionLike(node)) return; // 嵌套块/函数体是另一层绑定面
    ts.forEachChild(node, (c) => collectAllBindings(c, sink));
  };
  const registerHost = (host: ts.Node, face: ts.Node, stmts: readonly ts.Statement[], esc: ts.Node, vis?: { start: number; end: number }): void => {
    // 只登记 stmts 层的块作用域声明（let/const/class；var 与函数声明有提升语义、不造词法面）。
    // host = directBinds 键（读点上溯先碰到的登记节点）；vis = 可见区间，缺省 = host 全范围；
    // esc = 声明逃逸面（函数节点 / sf）。
    if (!bindFace.get(face)) { const s = new Set<string>(); collectAllBindings(face, s); bindFace.set(face, s); }
    const v = vis ?? { start: host.getStart(sf), end: host.getEnd() };
    const sink = directBinds.get(host) ?? new Set<string>();
    if (ts.isCatchClause(face)) {
      // catch 参数不在 stmts 层，单独入词法面（vis=块体）。TS5.9 该子节点为 variableDeclaration，
      // 公开 typings 的 .declaration 可能为 undefined，统一走子节点扫描。
      const names = new Set<string>();
      face.forEachChild((ch) => { if (ts.isVariableDeclaration(ch)) addBindings(ch.name, names); });
      for (const nm of names) { sink.add(nm); lexicalBlocks.push({ name: nm, start: v.start, end: v.end, esc }); }
    }
    for (const st of stmts) {
      if (ts.isVariableStatement(st)) {
        const flag = (st.declarationList.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped;
        if (flag !== ts.NodeFlags.None) {
          for (const d of st.declarationList.declarations) {
            const names = new Set<string>();
            addBindings(d.name, names);
            for (const nm of names) { sink.add(nm); lexicalBlocks.push({ name: nm, start: v.start, end: v.end, esc }); }
          }
        }
      } else if (ts.isClassDeclaration(st) && st.name) {
        sink.add(st.name.text);
        lexicalBlocks.push({ name: st.name.text, start: v.start, end: v.end, esc });
      }
    }
    directBinds.set(host, sink);
  };
  const stmtsOfForHead = (node: ts.Node): readonly ts.Statement[] => {
    const f = node as ts.ForStatement | ts.ForOfStatement | ts.ForInStatement;
    const init = ts.isForOfStatement(f) || ts.isForInStatement(f) ? f.initializer : f.initializer;
    const decl = init && ts.isVariableDeclarationList(init)
      ? init : (init && ts.isAwaitExpression(init) && ts.isVariableDeclarationList(init.initializer)) ? init.initializer : undefined;
    // 伪装成 VariableStatement 走同一登记逻辑（flags/declarations 字段一致）
    return decl ? [{ kind: ts.SyntaxKind.VariableStatement, declarationList: decl } as unknown as ts.Statement] : [];
  };
  const blockWalk = (node: ts.Node): void => {
    // 函数/箭头体块：按体顶层登记（host=函数体本身，读点嵌在任何内层块都合法；
    // 顶层 var/具名声明不登——提升语义）。语句宿主块：花括号层登记（host=块本身）。
    if (isBlockNode(node) && node.parent && ts.isFunctionLike(node.parent)) {
      registerHost(node, node, stmtsOfBlock(node), node.parent,
        { start: node.parent.getStart(sf), end: node.parent.getEnd() });
    } else if (isBlockNode(node) && node.parent && !ts.isFunctionLike(node.parent) &&
      (ts.isStatement(node.parent) || node.parent.kind === ts.SyntaxKind.SwitchStatement ||
        ts.isCaseClause(node.parent) || ts.isDefaultClause(node.parent) || node.parent === sf)) {
      // node.parent === sf：模块顶层的分组块 `{ … }`（LabeledStatement 之外的独立语句块）
      // vis = 花括号自身（switch 的 case 声明对 switch 后顶层读点是逃逸，不能按宿主语句全幅算可见）
      if (node.kind === ts.SyntaxKind.CaseBlock) {
        // case 冒号后的直接语句：可见域=该 CaseClause 段（switch 体内读它合法，switch 后读它逃逸）
        for (const cl of (node as ts.CaseBlock).clauses) {
          registerHost(cl, cl, cl.statements, enclosingFnOf(node.parent),
            { start: cl.getStart(sf), end: cl.getEnd() });
        }
      } else {
        registerHost(node, node, stmtsOfBlock(node), enclosingFnOf(node.parent),
          { start: node.getStart(sf), end: node.getEnd() });
      }
    } else if (node.kind === ts.SyntaxKind.Block && node.parent && ts.isCatchClause(node.parent)) {
      // catch 体块：face=CatchClause（含 catch 参数绑定），vis=块自身；体内读 e 合法、体后读 e 逃逸
      registerHost(node, node.parent, stmtsOfBlock(node), enclosingFnOf(node.parent),
        { start: node.getStart(sf), end: node.getEnd() });
    } else if (node.kind === ts.SyntaxKind.ForStatement || node.kind === ts.SyntaxKind.ForOfStatement ||
      node.kind === ts.SyntaxKind.ForInStatement) {
      // for 头/await 初始化式声明：可见域=for 语句整体（含循环体），读点在任何循环体内都合法
      const body = (node as ts.ForStatement).statement;
      const face = ts.isBlock(body) ? body : node;
      registerHost(face, body, stmtsOfForHead(node), enclosingFnOf(node), { start: node.getStart(sf), end: node.getEnd() });
    }
    ts.forEachChild(node, blockWalk);
  };
  blockWalk(sf);
  {
    // 顶层声明：可见整模块（esc=sf）；读点在任一顶层语句内都合法（块层登记覆盖）
    const names = new Set<string>();
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        const flag = (st.declarationList.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped;
        if (flag !== ts.NodeFlags.None) for (const d of st.declarationList.declarations) addBindings(d.name, names);
      } else if (ts.isClassDeclaration(st) && st.name) names.add(st.name.text);
    }
    for (const nm of names) lexicalBlocks.push({ name: nm, start: sf.getStart(sf), end: sf.getEnd(), esc: sf });
  }
  const hits: TierHit[] = [];
  const seen = new Set<string>();
  const readWalk = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (isSkippedSubtree(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
    if (ts.isIdentifier(node)) {
      if (!isNonReadPosition(node, parent) && !GLOBALS.has(node.text) && !topBindings.has(node.text)) {
        const pos = node.getStart(sf);
        const decls = lexicalBlocks.filter((l) => l.name === node.text);
        // 判定链（夹具五轮互搏后的收敛口径）：
        // ① 递归绑定面（参数/catch/具名表达式，含嵌套收集）覆盖读点 → 读本层绑定，合法
        let boundFace = false;
        for (let a: ts.Node | undefined = node.parent; a && !boundFace; a = a.parent) {
          if (bindFace.get(a)?.has(node.text)) boundFace = true;
        }
        // ② 可见区间：读点落在某条同名声明的 vis（= 声明所在花括号/for 语句/函数体/模块全幅）内 → 合法
        const inVis = decls.some((d) => pos >= d.start && pos <= d.end);
        // ③ 逃逸面：从读点向上，先碰到 esc 本体 = 同面逃逸（真炸）；先碰到其它函数/sf = 闭包读，交主判据
        const escOk = (d: { esc: ts.Node }): boolean => {
          if (cjsWrapped && d.esc === sf) return false; // CJS 顶层泄漏，不判
          for (let a: ts.Node | undefined = node.parent; a; a = a.parent) {
            if (a === d.esc) return true;
            if (ts.isFunctionLike(a) || a === sf) return false;
          }
          return false;
        };
        const escapeHit = decls.length > 0 && !boundFace && !inVis &&
          decls.some((d) => escOk(d) && !decls.some((e) => e.start > d.start && e.end < d.end && pos >= e.start && pos <= e.end));
        if (escapeHit) {
          const { line, character } = sf.getLineAndCharacterOfPosition(pos);
          const key = `${node.text}@${line}:${character}`;
          if (!seen.has(key)) {
            seen.add(key);
            hits.push({ name: node.text, line: line + 1, column: character + 1, why: `块内声明（${node.text}）在块外读用` });
          }
        }
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = chainRoot(node);
      if (ts.isIdentifier(root)) readWalk(root, node); else readWalk(root, node);
      if (ts.isElementAccessExpression(node)) readWalk(node.argumentExpression, node);
      return;
    }
    ts.forEachChild(node, (c) => readWalk(c, node));
  };
  readWalk(sf, undefined);
  return hits;
}

/** 档二：同一顶层函数/模块体内，语句级先读后声明（真 TDZ；嵌套进函数的读用是延后的，不判） */
export function checkTdz(code: string, fileName: string): TierHit[] {
  const sf = parseTierSf(code, fileName);
  if (!sf) return [];
  const hits: TierHit[] = [];
  const seen = new Set<string>();
  const stmtNamesBoundBy = (st: ts.Statement): string[] => {
    const sink = new Set<string>();
    if (ts.isVariableStatement(st)) {
      const flag = (st.declarationList.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped;
      if (flag !== ts.NodeFlags.None) for (const d of st.declarationList.declarations) addBindings(d.name, sink);
    } else if (ts.isClassDeclaration(st) && st.name) sink.add(st.name.text);
    return [...sink];
  };
  // 内层块自有同名绑定 ⇒ 该读点绑的是内层声明，不与本容器声明比先后（分组块 { const L=… } 逐段复用同名惯用法）
  const layerBinds = (node: ts.Node, name: string): boolean => {
    const s = new Set<string>();
    const addSt = (n: ts.Node): void => {
      if (ts.isVariableStatement(n)) {
        const flag = (n.declarationList.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped;
        if (flag !== ts.NodeFlags.None) for (const d of n.declarationList.declarations) addBindings(d.name, s);
      } else if (ts.isClassDeclaration(n) && n.name) s.add(n.name.text);
    };
    if (ts.isBlock(node)) node.statements.forEach(addSt);
    else if (node.kind === ts.SyntaxKind.CaseBlock) (node as ts.CaseBlock).clauses.forEach((c) => c.statements.forEach(addSt));
    else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) node.statements.forEach(addSt);
    else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const init = (node as ts.ForStatement).initializer;
      const list = init && ts.isVariableDeclarationList(init) ? init
        : (init && ts.isAwaitExpression(init) && ts.isVariableDeclarationList(init.initializer)) ? init.initializer : undefined;
      if (list && ((list.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.None) {
        for (const d of list.declarations) addBindings(d.name, s);
      }
    }
    return s.has(name);
  };
  const shadowedBefore = (read: ts.Node, name: string, boundary: ts.Node): boolean => {
    for (let a: ts.Node | undefined = read.parent; a && a !== boundary.parent; a = a.parent) {
      if (ts.isFunctionLike(a)) return true; // 读本函数自己的作用域，交该函数容器
      if (layerBinds(a, name)) return true;
    }
    return false;
  };
  const walkContainer = (statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void => {
    const decls: Array<{ name: string; pos: number }> = [];
    for (const st of statements) for (const nm of stmtNamesBoundBy(st)) decls.push({ name: nm, pos: st.getStart(sf) });
    // 同语句自引用（let x = x）：读点落在绑定它自己的声明语句区间内，
    // 通用「读点 < 声明点」判不住（位置差在初始化表达式内部），单独成规。
    for (const st of statements) {
      if (!ts.isVariableStatement(st)) continue;
      const flag = (st.declarationList.flags as ts.NodeFlags) & ts.NodeFlags.BlockScoped;
      if (flag === ts.NodeFlags.None) continue;
      for (const d of st.declarationList.declarations) {
        const bound = new Set<string>();
        addBindings(d.name, bound);
        if (!d.initializer || bound.size === 0) continue;
        const selfWalk = (node: ts.Node, parent: ts.Node | undefined): void => {
          if (isSkippedSubtree(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
          // 初始化式里的函数/箭头体是延后执行（自递归 const f = (…) => {… f(…) …} 合法），不判
          if (ts.isFunctionLike(node)) return;
          if (ts.isIdentifier(node)) {
            if (bound.has(node.text) && !isNonReadPosition(node, parent)) {
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              const key = `${node.text}@${line}:${character}`;
              if (!seen.has(key)) {
                seen.add(key);
                hits.push({ name: node.text, line: line + 1, column: character + 1, why: 'TDZ：词法声明初始化式内自读' });
              }
            }
            return;
          }
          if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            selfWalk(chainRoot(node), node);
            if (ts.isElementAccessExpression(node)) selfWalk(node.argumentExpression, node);
            return;
          }
          ts.forEachChild(node, (c) => selfWalk(c, node));
        };
        selfWalk(d.initializer, d);
      }
    }
    for (const st of statements) {
      const readWalk = (node: ts.Node, parent: ts.Node | undefined): void => {
        if (isSkippedSubtree(node)) return;
        // 延后执行体（函数/箭头/方法）内的读用不判——定义后才被调用是合法惯用法
        if (ts.isFunctionLike(node)) return;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
        if (ts.isIdentifier(node)) {
          if (!isNonReadPosition(node, parent) && !GLOBALS.has(node.text)) {
            const mine = decls.find((d) => d.name === node.text);
            if (mine && node.getStart(sf) < mine.pos && topScopeOf(node) === topScopeOf(st) &&
              !shadowedBefore(node, node.text, st)) {
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              const key = `${node.text}@${line}:${character}`;
              if (!seen.has(key)) {
                seen.add(key);
                hits.push({ name: node.text, line: line + 1, column: character + 1, why: 'TDZ：词法声明之前语句级读用' });
              }
            }
          }
          return;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          readWalk(chainRoot(node), node);
          if (ts.isElementAccessExpression(node)) readWalk(node.argumentExpression, node);
          return;
        }
        ts.forEachChild(node, (c) => readWalk(c, node));
      };
      readWalk(st, st.parent);
    }
  };
  walkContainer(sf.statements);
  const containerWalk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) walkContainer(node.body.statements);
    // if / try / catch / 分组块 体：各自成容器，内层先读后声明同样真炸（CaseBlock 不并入容器，按 case 段判）
    if (ts.isBlock(node) && node.parent && !ts.isFunctionLike(node.parent)) walkContainer(node.statements);
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) walkContainer(node.statements);
    ts.forEachChild(node, containerWalk);
  };
  containerWalk(sf);
  return hits;
}

/** 档三：模块体系错配（.mjs/.mts 里的 CJS 运行时记号；.cjs/.cts 里的静态 import/export） */
export function checkModuleMix(code: string, fileName: string): TierHit[] {
  const sf = parseTierSf(code, fileName);
  if (!sf) return [];
  const esm = /\.(mjs|mts)$/.test(fileName);
  const cjs = /\.(cjs|cts)$/.test(fileName);
  const hits: TierHit[] = [];
  const pos = (n: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { line: line + 1, column: character + 1 };
  };
  if (esm) {
    // 本地同名绑定（如 `const require = createRequire(import.meta.url)`）合法：
    // 该文件里的 require/__dirname/module/exports 读的是自家绑定，不是 CJS 全局记号
    const localDeclNames = new Set<string>();
    const collectDecl = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addBindings(node.name, localDeclNames);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) localDeclNames.add(node.name.text);
      else if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)) {
        const bn = (node as { name?: ts.BindingName }).name;
        if (bn) addBindings(bn, localDeclNames);
      }
      ts.forEachChild(node, collectDecl);
    };
    collectDecl(sf);
    const walk = (node: ts.Node, parent: ts.Node | undefined): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
      if (ts.isIdentifier(node) && !isNonReadPosition(node, parent) && !localDeclNames.has(node.text)) {
        if (node.text === 'require') hits.push({ name: 'require', ...pos(node), why: 'ESM 文件（.mjs/.mts）里使用 CJS require' });
        if (node.text === '__dirname' || node.text === '__filename') hits.push({ name: node.text, ...pos(node), why: `ESM 文件里使用 CJS ${node.text}` });
        if (node.text === 'module' || node.text === 'exports') {
          const p = parent;
          const isExportAccess = p && ts.isPropertyAccessExpression(p) && p.name.text === 'exports' && p.expression === node;
          if (isExportAccess || node.text === 'exports') hits.push({ name: node.text, ...pos(node), why: 'ESM 文件里使用 CJS 导出面' });
        }
      }
      if (ts.isImportEqualsDeclaration(node)) hits.push({ name: node.name.text, ...pos(node), why: 'ESM 文件里使用 CJS import= 语法' });
      ts.forEachChild(node, (c) => walk(c, node));
    };
    walk(sf, undefined);
  }
  if (cjs) {
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st)) hits.push({ name: 'import', ...pos(st), why: 'CJS 文件（.cjs/.cts）里的静态 import 运行时不可用' });
      if (ts.isExportDeclaration(st) || (ts.isVariableStatement(st) && (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) hits.push({ name: 'export', ...pos(st), why: 'CJS 文件里的静态 export 运行时不可用' });
      if (ts.isFunctionDeclaration(st) && (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) hits.push({ name: 'export', ...pos(st), why: 'CJS 文件里的静态 export 运行时不可用' });
      if (ts.isClassDeclaration(st) && (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) hits.push({ name: 'export', ...pos(st), why: 'CJS 文件里的静态 export 运行时不可用' });
    }
  }
  return hits;
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
    const tierBad: Record<string, string[]> = { 块作用域: [], TDZ: [], 模块体系: [] };
    const tierHits: Record<string, number> = { 块作用域: 0, TDZ: 0, 模块体系: 0 };
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
      // 批㊳ 三档独立判据（T02795）：与主判据同族不同判，红因分档点名、不并账
      const bl = checkBlockScope(code, f);
      const td = checkTdz(code, f);
      const mm = checkModuleMix(code, f);
      if (bl.length) { tierBad['块作用域'].push(f); tierHits['块作用域'] += bl.length; for (const h of bl) console.log(`块作用域档 ${f}:${h.line}:${h.column} ${h.name} — ${h.why}`); }
      if (td.length) { tierBad['TDZ'].push(f); tierHits['TDZ'] += td.length; for (const h of td) console.log(`TDZ档 ${f}:${h.line}:${h.column} ${h.name} — ${h.why}`); }
      if (mm.length) { tierBad['模块体系'].push(f); tierHits['模块体系'] += mm.length; for (const h of mm) console.log(`模块体系档 ${f}:${h.line}:${h.column} ${h.name} — ${h.why}`); }
    }
    console.log(`扫 ${files.length} 支：未定义标识符 ${bad.length} 支 · 语法层 ${syntax.length} 支`);
    // 读数口径：括号前＝命中文件数（进退出码），括号内＝判定点数（明细行数）——两者混记会读不出「1 支 30 处」
    console.log(`三档读数（文件数/判定点数）：块作用域 ${tierBad['块作用域'].length}/${tierHits['块作用域']} · TDZ ${tierBad['TDZ'].length}/${tierHits['TDZ']} · 模块体系 ${tierBad['模块体系'].length}/${tierHits['模块体系']}`);
    if (bad.length) console.log(`点名：${bad.join(' ')}`);
    const tierTotal = tierBad['块作用域'].length + tierBad['TDZ'].length + tierBad['模块体系'].length;
    process.exitCode = bad.length > 0 || tierTotal > 0 ? 1 : 0;
  } else {
    for (const f of args) {
      const r = checkSource(readFileSync(f, 'utf8'), f);
      const tag = r.parseError ? `语法层: ${r.parseError}` : r.hits.map((h) => `${h.line}:${h.column} ${h.name}`).join(', ');
      console.log(`${r.hits.length || r.parseError ? '未通过' : '通过'} ${f}${tag ? ' — ' + tag : ''}`);
    }
    process.exitCode = 0;
  }
}
