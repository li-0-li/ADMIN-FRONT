import axios, { type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';

/**
 * 后端存在**两套响应壳**（实测确证，不是猜的）：
 *   ① 若依原生（/login、/getInfo、/captchaImage 等）：{ code: 200, msg, ... 其余字段平铺 }
 *   ② 项目模块（/api/v1/admin/**）：{ code: 0, message, data }
 * 两套的 HTTP 状态码**都是 200**，成功与否只能看 body 里的 code ⇒ 这里统一判。
 */
const SUCCESS_CODES = new Set([0, 200]);

export const TOKEN_KEY = 'zk_admin_token';

export interface ApiEnvelope<T = unknown> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

const http = axios.create({ baseURL: '/', timeout: 30000 });

http.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

function gotoLogin() {
  localStorage.removeItem(TOKEN_KEY);
  // 登录页跟随部署 base（子路径 /admin/ 下为 /admin/login），不能写死根路径 /login（那是后端 POST 接口）
  const loginPath = import.meta.env.BASE_URL + 'login';
  if (!location.pathname.startsWith(loginPath)) {
    location.href = loginPath;
  }
}

/** 拿原始响应体（需要读平铺字段，比如 /login 的 token 时用它） */
export async function rawRequest<T = unknown>(config: AxiosRequestConfig): Promise<ApiEnvelope<T>> {
  try {
    const res = await http.request<ApiEnvelope<T>>(config);
    return res.data ?? {};
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      ElMessage.error('登录已失效，请重新登录');
      gotoLogin();
    } else {
      ElMessage.error((error as Error)?.message ?? '网络异常');
    }
    throw error;
  }
}

/** 统一解包：成功返回 data；业务失败抛错并提示 */
export async function request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
  const body = await rawRequest<T>(config);
  const code = body.code;
  if (code === undefined || SUCCESS_CODES.has(code)) {
    return body.data as T;
  }
  const message = String(body.message ?? body.msg ?? '请求失败');
  if (code === 401) {
    ElMessage.error(message || '登录已失效，请重新登录');
    gotoLogin();
  } else {
    ElMessage.error(message);
  }
  throw new Error(message);
}

/**
 * 二进制下载（Excel 导出/模板）：后端直接回文件流（无 JSON 壳），
 * 所以这里不能走 request 的解包逻辑，直接拿 Blob。
 * 注意：若后端报业务错（如 403），HTTP 层是 200 + JSON 壳 —— 此时返回的 Blob
 * 是 JSON 文本，靠 type 判别后抛错。
 */
export async function requestBlob(config: AxiosRequestConfig): Promise<Blob> {
  let res: Awaited<ReturnType<typeof http.request<Blob>>>;
  try {
    res = await http.request<Blob>({ ...config, responseType: 'blob' });
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      ElMessage.error('登录已失效，请重新登录');
      gotoLogin();
    } else {
      ElMessage.error((error as Error)?.message ?? '下载失败');
    }
    throw error;
  }
  const blob = res.data;
  if (blob instanceof Blob && blob.type.includes('application/json')) {
    // 业务错误被包成了 JSON：解析并提示
    const text = await blob.text();
    try {
      const body = JSON.parse(text) as { code?: number; message?: string; msg?: string };
      const message = String(body.message ?? body.msg ?? '下载失败');
      ElMessage.error(message);
      throw new Error(message);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('下载失败');
      throw e;
    }
  }
  return blob;
}

export default http;
