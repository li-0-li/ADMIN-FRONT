import { request } from '@/api/request';
import type { SchoolAnalyticsVo } from '@/types/admin';

/** 全校学情聚合（#13）：一次拉全看板数据，termId / major / courseId / deptId / alertStatus 可选过滤（termId 由后端翻译成学期编码真正参与过滤） */
export function getSchoolAnalytics(params: { termId?: number; schoolId?: number; major?: string; courseId?: number; deptId?: number; alertStatus?: string } = {}) {
  return request<SchoolAnalyticsVo>({ url: '/api/v1/admin/analytics/school', method: 'get', params });
}

/** 预警闭环：把一条待处理预警标记为已处理（open → closed），可附处理备注 */
export function handleAlert(alertId: number, note?: string) {
  return request<boolean>({
    url: `/api/v1/admin/analytics/alerts/${alertId}/handle`,
    method: 'put',
    params: note ? { note } : {}
  });
}

// 原 GET /api/v1/admin/export/report 已不接：它只认 reportType/format/semester，
// 不吃 deptId/major/courseId，用它导出整学期数据会与页内筛选口径不一致 ⇒ 学情页改为前端按当前筛选生成 CSV。
