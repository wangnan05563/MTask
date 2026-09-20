/**
 * AIAdapter 统一接口 —— 各 AI 工具（OpenAI 兼容 / Claude / Ollama 等）实现该接口。
 * 参考：Continue BYO-Model、LibreChat provider 抽象（见同类产品分析报告 4.1）。
 */

export interface TaskContext {
  taskId: string;
  title: string;
  description: string;
  aiSummary?: string;
  projectName: string;
  attachments?: string[];
  /** T00763：任务关联 PRD 的原文上下文（自动注入，适配器拼入用户消息） */
  prdContext?: string;
  /** T00771：项目工作空间根路径——AI 据此定位项目上下文（为空不注入） */
  workspacePath?: string;
}

export interface ToolConfig {
  endpoint: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 仅运行时由 ConfigService 解密后传入，绝不写日志 */
  apiKey?: string;
}

export interface JobResult {
  ok: boolean;
  content?: string;
  error?: string;
  rawMeta?: Record<string, unknown>;
}

/** 获取可用模型列表的结果 */
export interface ModelsResult {
  ok: boolean;
  models?: string[];
  message?: string;
}

/** 异步提交结果：供可选 submit() 使用，区分"异步受理"与"同步即返回"两种语义 */
export interface SubmitResult {
  ok: boolean;
  /** true=已受理、结果依赖后续轮询/回调；此时 ticket 作为回执标识 */
  accepted?: boolean;
  /** 异步回执标识：accepted=true 且拿到 ticket 时用于轮询定位 */
  ticket?: string;
  /** 同步即返回的完整内容（accepted=false 时存在） */
  content?: string;
  error?: string;
}

/** 轮询结果：供可选 poll() 使用，running=仍在执行，success/failed/timeout=终态 */
export interface PollResult {
  status: 'running' | 'success' | 'failed' | 'timeout';
  content?: string;
  error?: string;
}

/**
 * 流式单轮对话结果：onDelta 逐个文本增量回调（供 SSE 实时透传），收敛后通过返回值给出完整文本。
 * 与 chat 的结果语义一致，仅多出增量回调通道。
 */
export interface StreamResult {
  ok: boolean;
  content?: string;
  error?: string;
  /**
   * T00814：ok=false 时仍可带出的「已收到部分」——用于输出触顶（finish_reason=length）场景。
   * 默认调用方仍应把 ok=false 当失败（T00779 的防半截入库语义不变）；
   * 只有明确"用户会逐条复核"的长文生成（当前仅 PRD 生成）才可选择性采纳，并必须显式告警。
   */
  partial?: string;
}

export interface AIAdapter {
  readonly type: string;
  testConnection(config: ToolConfig): Promise<{ ok: boolean; message: string }>;
  /** 获取服务商可用模型列表（不支持 /models 接口的返回 ok:false） */
  listModels(config: ToolConfig): Promise<ModelsResult>;
  /** 通用单轮对话：提示词优化等轻量增强场景（system + user 单条文本） */
  chat(system: string, user: string, config: ToolConfig): Promise<JobResult>;
  /** 流式单轮对话：按增量回调透传文本，供 AI 周报 SSE 流式输出使用；不支持流式的实现需回退为完整回调 */
  chatStream(system: string, user: string, config: ToolConfig, onDelta: (text: string) => void): Promise<StreamResult>;
  send(context: TaskContext, config: ToolConfig): Promise<JobResult>;
  /** 可选：异步提交（受理后返回回执标识）。未实现表示工具为同步响应，适配层自动回退 send */
  submit?(context: TaskContext, config: ToolConfig): Promise<SubmitResult>;
  /** 可选：按回执标识轮询异步结果。仅当实现 submit 时配套使用 */
  poll?(ticket: string, config: ToolConfig): Promise<PollResult>;
}

/** 由 AI 工具类型映射到适配器实例 */
export type AdapterType = 'openai-compatible' | 'claude' | 'ollama' | 'workbuddy';

/**
 * T00779：流式输出触顶截断的统一错误文案（与 T00714 非流式 finish_reason=length 判定同语义）。
 * 各 adapter 流式收尾检测到截断标志时统一用它返回 ok:false——避免半截内容被上层当成完整结果写入库
 * （曾表现为：PRD 生成被 max_tokens 切断却 ok:true，半截文档可被直接录入 PRD 管理视图）。
 */
export function streamTruncatedError(chars: number): string {
  return `AI 输出超长被截断（已输出 ${chars} 字符）——请调大该工具的 max_tokens 或精简输入后重试`;
}

/**
 * 走查 M-3：输出被内容安全策略/模型拒绝提前终止（content_filter / refusal）——
 * 与触顶截断同类：半截内容不得当完整结果入库。与 streamTruncatedError 分文案以区分成因。
 */
export function outputStoppedError(label: string, chars: number): string {
  return `AI 输出提前终止（${label}，已输出 ${chars} 字符）——半截内容不作完整结果，请调整输入内容或更换模型后重试`;
}
