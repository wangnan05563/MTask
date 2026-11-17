/**
 * T03316（G-3）：一次页面会话内稳定的 jobId（刷新即换）。
 *
 * 生成入口随每轮请求带上它，服务端优先采用——同一次生成的重试/续作因此合到同一个 job，
 * 不会被算成多个样本；服务端缺省时才回落到 UUID。
 */
export const sessionJobId: string = crypto.randomUUID();
