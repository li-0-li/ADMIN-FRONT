import { request } from '@/api/request';
import type { AdminRoleVo, PermissionNodeVo } from '@/types/admin';

const BASE = '/api/v1/admin';

/** R-1 角色列表（带成员数 / 菜单数） */
export function listRoles() {
  return request<AdminRoleVo[]>({ url: `${BASE}/roles`, method: 'get' });
}

/** B-7 权限点树（可授权全集） */
export function fetchPermissionTree() {
  return request<PermissionNodeVo[]>({ url: `${BASE}/permissions`, method: 'get' });
}

/** R-2 某角色已授权 menu_id 集合（权限树回显） */
export function fetchRoleMenuIds(roleId: number) {
  return request<number[]>({ url: `${BASE}/roles/${roleId}/menu-ids`, method: 'get' });
}

/** B-8 分配角色权限（重建 sys_role_menu） */
export function assignRolePermissions(roleId: number, menuIds: number[]) {
  return request<boolean>({
    url: `${BASE}/role-permissions`,
    method: 'put',
    data: { roleId, menuIds }
  });
}
