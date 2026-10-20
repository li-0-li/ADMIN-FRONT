import { request } from '@/api/request';
import type { ReportFileVo, SchoolAnalyticsVo } from '@/types/admin';

/** 全校学情聚合（#13）：一次拉全看板数据，termId / schoolId / major（专业名，空=全部）可选过滤 */
export function getSchoolAnalytics(params: { termId?: number; schoolId?: number; major?: string } = {}) {
  return request<SchoolAnalyticsVo>({ url: '/api/v1/admin/analytics/school', method: 'get', params });
}

/** 报表导出：后端生成并登记报表文件，返回可下载地址与文件名 */
export function exportReport(params: { reportType?: string; format?: string; semester?: string } = {}) {
  return request<ReportFileVo>({ url: '/api/v1/admin/export/report', method: 'get', params });
}
