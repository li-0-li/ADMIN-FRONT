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
  if (!location.pathname.startsWith('/login')) {
    location.href = '/login';
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

export default http;
