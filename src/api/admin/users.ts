import { rawRequest, request, requestBlob } from '@/api/request';
import type { ImportResultVo } from '@/types/admin';
import type { AdminUserVo, FootprintVo, PageResult, UserCreateVo, UserQuery, UserSaveBo } from '@/types/admin';

const BASE = '/api/v1/admin/users';

/**
 * 列表：分页参数是 page / pageSize（不是 pageNum）。
 * 排序键 sortField + sortOrder（值 asc/desc）已由后端 10-26 追认（编号 12 结案）：
 * 白名单 username/nickName/deptName/status/createTime/loginDate（AdminAccountServiceImpl.java:94-97），
 * 名单外的字段 WARN 后回落默认序；sortOrder 只对 'desc' 生效，其余一律 asc；先全局排序再分页。
 * 这里用交叉类型放开这两个键，不动全局 src/types/admin.ts（那是综合线的文件）。
 */
export function listUsers(query: UserQuery & { sortField?: string; sortOrder?: 'asc' | 'desc' }) {
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

/** 以下四个接口的 userId 是 19 位雪花主键：后端 10-26 起按字符串下发，形参跟契约走 `string`（编号 26）。
 *  走 URL 模板拼接，字符串原样进 path，不会再被 Number 精度截断。 */
export function deleteUser(userId: string) {
  return request<boolean>({ url: `${BASE}/${userId}`, method: 'delete' });
}

/** 启停：★ status 走 query，不是 body */
export function updateUserStatus(userId: string, status: string) {
  return request<boolean>({ url: `${BASE}/${userId}/status`, method: 'put', params: { status } });
}

/** 重置密码：返回一次性临时口令 */
export function resetUserPassword(userId: string) {
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
export function getUserFootprint(userId: string) {
  return request<FootprintVo>({ url: `${BASE}/${userId}/footprint`, method: 'get' });
}

/** 若依原生院系节点（账号页用三个键；基础数据页 B1 落地后编辑/详情还需要 orderNum/leader/phone/email） */
export interface DeptNodeVo {
  /** ★ 这个端点是若依原生控制器，deptId 没加 @JsonFormat ⇒ 实测仍是裸数字（现库 100~203，未触精度）。
      类型留成 number | string 并一律 String() 归一，是为了后端日后补注解时不用再改这里。 */
  deptId: number | string;
  deptName: string;
  parentId?: number | string;
  /** 祖先链，形如 "0" / "0,200" / "0,100,101" ⇒ 截子树靠它，不靠递归找 children */
  ancestors?: string;
  status?: string;
  delFlag?: string;
  /** 以下为若依 SysDept 原生字段，编辑回显/保存要带上（后端 PUT 全量收） */
  orderNum?: number | string;
  leader?: string;
  phone?: string;
  email?: string;
}

/**
 * 编号 23 · 院系候选改走全量：若依原生 GET /system/dept/list（后端路线②）。
 * 走 rawRequest 而不是 request：原生信封是 {code:200,msg,data:[...]}，data 直接是数组、没有分页壳，
 * 且这里的 code=200 是成功语义，不能按 admin 模块的 code=0 判。
 * 非 200（如未授权 403）返回 ok:false 让调用方显示缺口提示，不静默给一个空下拉。
 */
export async function listDeptTree(): Promise<{ ok: boolean; code?: number; list: DeptNodeVo[] }> {
  const body = await rawRequest<DeptNodeVo[]>({ url: '/system/dept/list', method: 'get' });
  const ok = body.code === undefined || body.code === 200;
  return { ok, code: body.code, list: ok && Array.isArray(body.data) ? body.data : [] };
}
