import { request, requestBlob } from '@/api/request';
import type { ImportResultVo } from '@/types/admin';
import type { AdminUserVo, FootprintVo, PageResult, UserCreateVo, UserQuery, UserSaveBo } from '@/types/admin';

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

/** B-7 导出账号 Excel（按当前筛选；返回文件流）
 *  后端 AdminAccountServiceImpl.buildExportRows 收的是与列表同一个 UserQueryBo，
 *  并在内部强制 page=1 / pageSize=1000 ⇒ 这里只传筛选项，分页参数发过去也会被覆盖。 */
export function exportUsers(query: UserQuery) {
  return requestBlob({ url: `${BASE}/export`, method: 'post', data: query });
}

/** B-8a 下载账号导入模板（返回文件流） */
export function downloadImportTemplate() {
  return requestBlob({ url: `${BASE}/import-template`, method: 'get' });
}

/** B-8 批量导入账号（multipart 上传） */
export function importUsers(file: File, updateSupport: boolean) {
  const form = new FormData();
  form.append('file', file);
  form.append('updateSupport', String(updateSupport));
  return request<ImportResultVo>({ url: `${BASE}/import`, method: 'post', data: form });
}

/** F-1 账号足迹（登录记录 + 操作记录，复用若依自带日志表） */
export function getUserFootprint(userId: number) {
  return request<FootprintVo>({ url: `${BASE}/${userId}/footprint`, method: 'get' });
}
