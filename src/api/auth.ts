import { rawRequest, TOKEN_KEY, type ApiEnvelope } from '@/api/request';

export interface LoginPayload {
  username: string;
  password: string;
  code?: string;
  uuid?: string;
}

export interface CaptchaInfo {
  captchaEnabled?: boolean;
  uuid?: string;
  img?: string;
}

export interface UserInfoPayload {
  user?: Record<string, unknown>;
  roles?: string[];
  permissions?: string[];
}

/** 图形验证码。实测 captchaEnabled=false，此时后端不校验 code/uuid */
export function apiCaptcha(type: 'math' | 'char' = 'math') {
  return rawRequest<CaptchaInfo>({ url: '/captchaImage', method: 'get', params: { type } });
}

/** 登录：若依原生口径，token 平铺在响应体顶层（不在 data 里） */
export function apiLogin(data: LoginPayload) {
  return rawRequest<never>({ url: '/login', method: 'post', data });
}

/** 取用户信息：roles / permissions / user 也在顶层平铺 */
export function apiGetInfo() {
  return rawRequest<UserInfoPayload>({ url: '/getInfo', method: 'get' });
}

/**
 * 登出：api-docs 里**没有 /logout 路径**（后端未提供），所以只做本地登出。
 * 若后端后续补齐，这里换成真实调用即可。
 */
export function apiLogout(): ApiEnvelope {
  localStorage.removeItem(TOKEN_KEY);
  return { code: 200, msg: '本地登出' };
}
