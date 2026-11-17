/**
 * T02311：失败诊断旁证落盘（与报告产物通道分立，单列本 util）。
 *
 * 为什么不在 kickoffService 里直接写：T02103 的 S-03 门禁钉住「kickoffService 不自己碰
 * 文件系统落盘（只经 saveReportBuffer）」——报告产物走令牌通道（随机名、下载即删、TTL 清扫），
 * 而诊断旁证要的是「可读名 + 错误文本可直接引用 + 事后人工可找」，两者生命周期不同。
 * 只由失败路径触发；写盘失败静默返回空串，不阻断主流程（证据面优先，但不能为留档把功能搞挂）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../db/connection';

/** 把诊断文本落盘到数据目录（与库同源），返回文件绝对路径；失败返回空串 */
export function dumpDiagText(prefix: string, text: string): string {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${prefix}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.txt`);
    writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    return '';
  }
}
