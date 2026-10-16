import { request } from '@/api/request';
import type { AdminUserVo, PageResult, UserCreateVo, UserQuery, UserSaveBo } from '@/types/admin';

const BASE = '/api/v1/admin/users';

/** 列表：分页参数是 page / pageSize（不是 pageNum） */
export function listUsers(query: UserQuery) {
  return request<PageResult<AdminUserVo>>({
    url: BASE,
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}

/** 新增：返回一次性临时口令 */
export function createUser(body: UserSaveBo) {
  return request<UserCreateVo>({ url: BASE, method: 'post', data: body });
}

/** 编辑：★ 没有 path 段，userId 放在 body 里 */
export function updateUser(body: UserSaveBo) {
  return request<boolean>({ url: BASE, method: 'put', data: body });
}

export function deleteUser(userId: number) {
  return request<boolean>({ url: `${BASE}/${userId}`, method: 'delete' });
}

/** 启停：★ status 走 query，不是 body */
export function updateUserStatus(userId: number, status: string) {
  return request<boolean>({ url: `${BASE}/${userId}/status`, method: 'put', params: { status } });
}

/** 重置密码：返回一次性临时口令 */
export function resetUserPassword(userId: number) {
  return request<UserCreateVo>({ url: `${BASE}/${userId}/password/reset`, method: 'post' });
}
