/**
 * @modelcontextprotocol/sdk 最小类型垫片。
 *
 * 为什么需要此文件：MTask 后端 tsconfig 使用 `moduleResolution: "Node"`（node10 解析），
 * 而 @modelcontextprotocol/sdk 为纯 ESM 包且未在根 package.json 提供 main/types 字段，
 * 仅通过 package.json 的 `exports` 暴露 dist/cjs 与 dist/esm 子路径。node10 解析不支持 exports，
 * 因此 tsc 无法解析该包的任何子路径模块。
 *
 * 解决方式：用 `declare module` 以精确字面量匹配 `@modelcontextprotocol/sdk/server/mcp.js`
 * 等导入说明符，为标签编译提供最小类型；运行时 Node 的 require() 走 exports.require → dist/cjs，
 * 从而同时满足 dev(tsx) 与打包(electron CJS) 双态加载。
 *
 * 仅声明本工程用到的极小 API 面，其余以宽松类型放行，避免随 SDK 版本升级频繁维护。
 */
declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export interface ToolAnnotations {
    title?: string;
    subtitle?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }

  export interface TextContent {
    type: 'text';
    text: string;
  }
  export type ContentBlock = TextContent | { type: string; [k: string]: unknown };

  export interface CallToolResult {
    content: ContentBlock[];
    /** 结构化结果：供具备 outputSchema 的客户端程序化消费 */
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }

  export class McpServer {
    constructor(info: { name: string; version: string });
    registerTool(
      name: string,
      config: {
        title?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: unknown;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
      },
      cb: (args: any, extra: any) => CallToolResult | Promise<CallToolResult>,
    ): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
  export interface StreamableHTTPServerTransportOptions {
    /** 会话 ID 生成器；undefined 表示无状态模式 */
    sessionIdGenerator?: (() => string) | undefined;
    /** 会话初始化完成后回调；用于在 transport 尚未挂到响应前安全登记会话 */
    onsessioninitialized?: (sessionId: string) => void;
    eventStore?: unknown;
  }

  export class StreamableHTTPServerTransport {
    constructor(options?: StreamableHTTPServerTransportOptions);
    readonly sessionId?: string;
    set onclose(handler: (() => void) | undefined);
    handleRequest(
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
      parsedBody?: unknown,
    ): Promise<void>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/types.js' {
  export function isInitializeRequest(message: unknown): boolean;
}