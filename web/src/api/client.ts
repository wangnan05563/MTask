/** 轻量 API 客户端：统一前缀 /api，错误统一抛出 */

/** Electron 壳（file:// 页面）走 api:// 自定义协议，由主进程转发到本地服务；浏览器访问用同源相对路径 */
/** API 基础路径导出：供 EventSource/文件下载等无法走统一 request 的场景构建 URL */
export const apiBase =
  typeof location !== 'undefined' && !/^https?:$/.test(location.protocol) ? 'api://mtask' : '/api';

// 访问令牌：启用内网穿透后，所有数据接口需携带 X-Access-Token。模块加载时从本地恢复，重启后仍生效
const TOKEN_KEY = 'mtask.accessToken';
let accessToken = (() => {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
})();

export function setAccessToken(token: string): void {
  accessToken = token;
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

/** 从 Content-Disposition 提取 RFC 5987 的 UTF-8 文件名（filename*=UTF-8''… 格式） */
function filenameFromDisposition(cd: string): string {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 代理未透传 Content-Disposition 时按内容类型兜底扩展名，避免下载成 report.bin */
function extFromContentType(ct: string): string {
  if (ct.includes('spreadsheet')) return 'xlsx';
  if (ct.includes('wordprocessing')) return 'docx';
  if (ct.includes('presentation')) return 'pptx';
  if (ct.includes('pdf')) return 'pdf';
  return 'bin';
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data), ...(signal ? { signal } : {}) }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) }),
  del: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'DELETE', body: data === undefined ? undefined : JSON.stringify(data) }),
  /** GET 二进制下载（xlsx 导出/模板等）：返回原始 ArrayBuffer，由调用方触发保存 */
  async getBinary(path: string): Promise<ArrayBuffer> {
    const res = await fetch(`${apiBase}${path}`, { headers: accessToken ? { 'X-Access-Token': accessToken } : {} });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return res.arrayBuffer();
  },
  /** POST 二进制上传（xlsx 导入等），Content-Type 固定 octet-stream 以跳过全局 JSON 解析 */
  async postBinary<T>(path: string, data: ArrayBuffer): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
      body: data,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as T;
  },
  /**
   * T00444：订阅后端数据变更 SSE 通知（/api/events）。token 经 query 传递
   * （EventSource 无法自定义请求头）；EventSource 原生断线重连。返回取消订阅函数。
   */
  openChangeStream(onChange: (kind: string) => void): () => void {
    const tokenQuery = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
    const url = `${apiBase}/events${tokenQuery}`;
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      try { onChange(String(JSON.parse(ev.data).kind ?? '')); } catch { onChange(''); }
    };
    return () => es.close();
  },
  /** 生成类接口的二进制下载：POST 返回文件流，附带 Content-Disposition 文件名 */
  async download(path: string, data: unknown): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      // 与 request() 一致地附带访问令牌：启用内网穿透后 accessTokenGuard 校验 X-Access-Token，缺失会返回 401 报 unauthorized
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
      body: JSON.stringify(data ?? {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    let filename = filenameFromDisposition(res.headers.get('Content-Disposition') ?? '');
    if (!filename) filename = `report.${extFromContentType(res.headers.get('Content-Type') ?? '')}`;
    return { blob, filename };
  },
};

export interface Project {
  id: string;
  name: string;
  description: string;
  sort_weight: number;
  /** T00496：每项目待办/未验证计数（徽标展示） */
  todo_count?: number;
  unverified_count?: number;
  /** T00505：计划任务统计（计划菜单下拉徽标） */
  plan_done?: number;
  plan_doing?: number;
  plan_open?: number;
}

export interface TaskImage {
  id: string;
  task_id: string;
  mime_type: string;
  size: number;
  created_at: string;
}

/** 图片直链（<img src> 直接用；Electron 壳内由 api:// 协议转发到本地服务） */
export const imageUrl = (id: string) => `${apiBase}/images/${id}`;

/** 取图片 blob（复制到剪贴板用）。经 api:// 代理返回，代理已加 CORS 头，渲染进程可跨源读取 */
export async function fetchImage(id: string): Promise<Blob> {
  const res = await fetch(imageUrl(id));
  if (!res.ok) throw new Error(`图片加载失败 HTTP ${res.status}`);
  return res.blob();
}

/** 取图片 dataURL（富文本复制时内嵌到 HTML 用） */
export async function imageDataURL(id: string): Promise<string> {
  const blob = await fetchImage(id);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(new Error("图片转 dataURL 失败"));
    r.readAsDataURL(blob);
  });
}

export interface Task {
  id: string;
  /** 任务编号：全局唯一（T+5位数字），供 AI Agent 通过 MCP 按编号定位 */
  task_no: string | null;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: 'todo' | 'done';
  /** 已完成任务的验证状态：true=已验证，false=未验证 */
  verified: boolean;
  archived: boolean;
  archived_at: string | null;
  ai_summary: string | null;
  /** 处理结果：AI 分析结论（根因/解决方案）等，可查看/编辑 */
  handle_result: string | null;
  /** T00462/T00451：项目计划联动任务——值为来源计划标题（区分徽标+反向引用） */
  fromPlanTitle?: string;
  /** T00446：手动排序权重（拖拽排序结果；manual 排序模式生效） */
  user_sort: number | null;
  /** 置顶：true=固定到列表顶部 */
  pinned: boolean;
  /** 所属任务分类 id；null 表示未分类 */
  category_id: string | null;
  /** T00450：父任务 id（epic→task 两级层级） */
  parent_id: string | null;
  /** T00490：记录字体颜色（Excel 风格颜色按钮），空串=默认色 */
  color?: string;
  created_at: string;
  updated_at: string;
  images: TaskImage[];
}

export interface TaskCategory {
  id: string;
  name: string;
  sort_weight: number;
  created_at: string;
  updated_at: string;
}

export interface AITool {
  id: string;
  name: string;
  type: string;
  purpose: string;
  endpoint: string;
  model: string | null;
  /** 模型配置说明 */
  model_notes: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  enabled: boolean;
  isDefaultOrganize: boolean;
  isDefaultDevelop: boolean;
  /** 置顶：true=固定到列表顶部 */
  pinned: boolean;
  /** 备注 */
  remark: string;
  /** 厂商官方控制台页面 URL */
  console_url: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
}

export interface QueueJob {
  id: string;
  queue_id: string;
  task_id: string;
  tool_id: string;
  order_index: number;
  status: string;
  request_payload: string | null;
  response_payload: string | null;
  error: string | null;
  /** 队列详情接口 JOIN 附带（可能为 null） */
  task_title?: string | null;
  tool_name?: string | null;
}

export interface Queue {
  id: string;
  name: string;
  date: string;
  status: string;
  created_at: string;
  jobs?: QueueJob[];
}

export interface PromptCategory {
  id: string;
  name: string;
  description: string;
  sort_weight: number;
  builtin: boolean;
  /** 分类列表接口附带的提示词数量 */
  promptCount?: number;
}

export interface Prompt {
  id: string;
  category_id: string;
  title: string;
  content: string;
  /** 置顶：true=固定到列表顶部（后端返回 0/1，前端按布尔使用） */
  pinned: boolean;
  /** T00494：手动排序权重（拖拽保存；0=默认序） */
  sort_weight: number;
  /** T00490：记录字体颜色，空串=默认色 */
  color?: string;
  created_at: string;
  updated_at: string;
}

export interface ReqCategory {
  id: string;
  name: string;
  sort_weight: number;
  created_at: string;
  updated_at: string;
  /** 分类列表接口附带的条目数量 */
  reqCount?: number;
}

export interface ReqEntry {
  id: string;
  category_id: string;
  title: string;
  content: string;
  /** 置顶：true=固定到列表顶部（后端返回 0/1，前端按布尔使用） */
  pinned: boolean;
  /** T00494：手动排序权重（拖拽保存；0=默认序） */
  sort_weight: number;
  /** T00490：记录字体颜色，空串=默认色 */
  color?: string;
  created_at: string;
  updated_at: string;
}
