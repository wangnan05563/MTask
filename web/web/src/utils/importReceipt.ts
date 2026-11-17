/** 预览阶段判定的问题行（服务端 /tasks/import-csv|import-json/preview 的 errors） */
export interface ImportPreviewErrorLine {
  row: number;
  message: string;
}

/** 合成回执所需的最小预览形状：不绑服务端类型，避免门内取数依赖整条 API 类型链 */
export interface ImportPreviewLike {
  kind: 'csv' | 'json';
  /** 预览判定可导入的条目数 */
  items: readonly unknown[];
  errors: readonly ImportPreviewErrorLine[];
}

/** 导入回执的输入：预览结果 + 服务端实际创建条数 */
export type ImportReceiptInput = ImportPreviewLike & { readonly created: number };

/** 回执里的单行：指代（行号/标题/条目）+ 原因 */
export interface ReceiptLine {
  ref: string;
  reason: string;
}

/** T03214 / UX-02 ④：导入结果分列成功 / 跳过 / 失败 */
export interface ImportReceipt {
  label: string;
  okCount: number;
  skipped: ReceiptLine[];
  /** 与批量回执同一形状，导入的失败没有任务 id/标题，用 ref 文案占位 */
  failed: Array<{ id: string; title: string; reason: string }>;
}

/**
 * 把「预览解析」与「服务端创建」两段结果合成一份可常驻回看的导入回执。
 * 预览阶段的问题行是确定性的跳过（带原因）；预览判定可导入但服务端没创建的条目
 * 属"无原因跳过"——必须显式列出，否则计数对不上却被当成成功。
 */
export function buildImportReceipt(input: ImportReceiptInput): ImportReceipt {
  const skipped: ReceiptLine[] = input.errors.map((e) => ({ ref: `第 ${e.row} 行`, reason: e.message }));
  const unaccounted = input.items.length - input.created;
  if (unaccounted > 0) {
    skipped.push({ ref: `预览可导入的 ${unaccounted} 条`, reason: '服务端未创建且未给出原因' });
  }
  return {
    label: input.kind === 'json' ? 'JSON 导入' : 'CSV 导入',
    okCount: input.created,
    skipped,
    failed: [],
  };
}

/** 导入请求整体失败（网络/服务端异常）时的回执：一条都没有，失败带原因 */
export function buildImportFailureReceipt(kind: 'csv' | 'json', reason: string): ImportReceipt {
  return {
    label: kind === 'json' ? 'JSON 导入' : 'CSV 导入',
    okCount: 0,
    skipped: [],
    failed: [{ id: '导入请求', title: '', reason }],
  };
}
