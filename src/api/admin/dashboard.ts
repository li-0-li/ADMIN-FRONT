import { request } from '@/api/request';
import type { DashboardSummary } from '@/types/admin';

/** 工作台概览：后端直接给聚合数（不拆成多次调用） */
export function getDashboardSummary() {
  return request<DashboardSummary>({ url: '/api/v1/admin/dashboard/summary', method: 'get' });
}

/** 课程列表（工作台「最近课程」用）。
 *  ★ 2026-10-15 实测：`/api/v1/courses` 已是死路径（后端 500「No static resource」），
 *  同事为学生端让路改的 `/api/v1/admin/courses` 现已在后端产物里 ⇒ 对齐新路径。 */
export function listCourses(params: { keyword?: string; page?: number; pageSize?: number } = {}) {
  return request<{ list: Record<string, unknown>[]; total: number }>({
    url: '/api/v1/admin/courses',
    method: 'get',
    params: { page: 1, pageSize: 5, ...params }
  });
}
