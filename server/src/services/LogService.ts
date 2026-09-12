/**
 * 后台日志服务：在内存中维护一个环形日志缓冲，拦截 console 输出按级别入缓冲，
 * 供前端「日志」页面通过 GET /logs 增量拉取实时查看。
 * - 捕获不影响原 console 输出（记录后仍转调原始方法），保留开发态/打包态控制台日志；
 * - 来源字段当前统一标记为 'server'（后端单进程），预留后续按模块扩展。
 * - 环形：超出上限自动丢弃最旧日志，防止长时间运行内存无界增长。
 */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

export interface LogEntry {
  seq: number;      // 全局递增序号，前端据此做增量拉取的游标
  time: string;     // ISO 时间
  level: LogLevel;
  source: string;   // 来源模块说明
  message: string;
}

const MAX = 2000;

/** 把 console.* 的参数列表规整为单行文本；Error 取其 message+stack 便捷排查 */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
      if (typeof a === 'object' && a !== null) {
        // JSON.stringify 失败（循环引用等）时 String(a) 只会得到 [object Object]，改为可读占位
        try { return JSON.stringify(a); } catch { return '[unserializable object]'; }
      }
      return String(a);
    })
    .join(' ');
}

class LogService {
  private seq = 0;
  private readonly buffer: LogEntry[] = [];
  private initd = false;

  init(): void {
    if (this.initd) return;
    this.initd = true;
    // 按级别映射劫持 console；记录后仍调用原始方法，不破坏现有控制台输出
    const bindings: Array<{ method: keyof Console; level: LogLevel }> = [
      { method: 'error', level: 'ERROR' },
      { method: 'warn', level: 'WARN' },
      { method: 'debug', level: 'DEBUG' },
      { method: 'info', level: 'INFO' },
      { method: 'log', level: 'INFO' },
    ];
    for (const { method, level } of bindings) {
      // console 同名方法签名各异（union 不可直接调用），断言为通用签名后绑定保留原输出
      const orig = (console[method] as unknown as (...args: unknown[]) => void).bind(console);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (console as any)[method] = (...args: unknown[]) => {
        this.push(level, 'server', args);
        orig(...args);
      };
    }
  }

  private push(level: LogLevel, source: string, args: unknown[]): void {
    // 环形：达到上限清除最旧一条，保持内存有界
    if (this.buffer.length >= MAX) this.buffer.shift();
    this.seq += 1;
    this.buffer.push({ seq: this.seq, time: new Date().toISOString(), level, source, message: formatArgs(args) });
  }

  /** 业务结构化日志入口：供非 console 来源（AI 调用等模块）写入带独立 source 的日志，便于前端按来源筛选 */
  log(level: LogLevel, source: string, message: unknown): void {
    this.push(level, source, [message]);
  }

  latestSeq(): number {
    // .at(-1) 取末尾元素，缓冲为空时回退 0，语义与 buffer[length-1] 一致
    return this.buffer.at(-1)?.seq ?? 0;
  }

  /** 返回 seq 大于 since 的增量日志（首次传 0 返回全量缓冲） */
  list(since: number): { latestSeq: number; items: LogEntry[] } {
    const items = this.buffer.filter((e) => e.seq > since);
    return { latestSeq: this.latestSeq(), items };
  }
}

export const logService = new LogService();