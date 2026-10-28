import { request } from '@/api/request';
import type { SchoolAnalyticsVo } from '@/types/admin';

/** 全校学情聚合（#13）：一次拉全看板数据，termId / major / courseId / deptId / alertStatus 可选过滤（termId 由后端翻译成学期编码真正参与过滤）
 *  ID 入参写 `string | number`：10-26 实测后端已逐字段 @JsonFormat(shape=STRING)，出参里 deptId/courseId/termId/alertId 都是字符串；
 *  而 src/types/admin.ts 的契约仍是 number（等综合线翻），所以这里先两头都收，避免页内 String(x) 与契约 number 互相报错。
 *  切勿在页面对这些 ID 调 Number()：19 位雪花 ID 超过 2^53 会静默丢精度。 */
export function getSchoolAnalytics(params: { termId?: string | number; schoolId?: string | number; major?: string; courseId?: string | number; deptId?: string | number; alertStatus?: string } = {}) {
  return request<SchoolAnalyticsVo>({ url: '/api/v1/admin/analytics/school', method: 'get', params });
}

/** 预警闭环：把一条待处理预警标记为已处理（open → closed），可附处理备注
 *  出参字段是 handleNote（AlertRow 里没有 note），入参查询名是 note —— 两边不同名，勿混 */
export function handleAlert(alertId: string | number, note?: string) {
  return request<boolean>({
    url: `/api/v1/admin/analytics/alerts/${alertId}/handle`,
    method: 'put',
    params: note ? { note } : {}
  });
}

// 原 GET /api/v1/admin/export/report 已不接：它只认 reportType/format/semester，
// 不吃 deptId/major/courseId，用它导出整学期数据会与页内筛选口径不一致 ⇒ 学情页改为前端按当前筛选生成 CSV。
