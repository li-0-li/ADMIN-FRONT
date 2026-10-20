import { request } from '@/api/request';
import type { ReportFileVo, SchoolAnalyticsVo } from '@/types/admin';

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

/** 报表导出：后端生成并登记报表文件，返回可下载地址与文件名 */
export function exportReport(params: { reportType?: string; format?: string; semester?: string } = {}) {
  return request<ReportFileVo>({ url: '/api/v1/admin/export/report', method: 'get', params });
}
