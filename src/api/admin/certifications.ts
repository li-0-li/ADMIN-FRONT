import { request } from '@/api/request';
import type { CertDetail, CertReviewBo, CertReviewItem, CertReviewResult } from '@/types/admin';

export interface CertListQuery {
  /** pending 时后端只取 status in ('pending','reviewing')；不传 = 全部聚合 */
  status?: string;
  courseId?: number;
  page?: number;
  pageSize?: number;
}

/** C-13 待审核课程列表（按课程聚合） */
export function listCertifications(params: CertListQuery = {}) {
  return request<{ list: CertReviewItem[]; total: number; page: number; pageSize: number }>({
    url: '/api/v1/certifications',
    method: 'get',
    params: { page: 1, pageSize: 10, ...params }
  });
}

/** C-14 认证详情：三项材料 + AI 初审建议。★ 出参是 VO 本身，不是分页壳 */
export function getCertDetail(courseId: number) {
  return request<CertDetail>({
    url: `/api/v1/courses/${courseId}/certifications`,
    method: 'get'
  });
}

/**
 * C-15 审核裁决。★ 按**课程**整体裁决 —— 后端会一次改掉该课程下所有材料，
 * 且 approve 后若三项全部通过，会把 course.status 置为 active（解锁备课）。
 */
export function reviewCertification(certId: number, data: CertReviewBo) {
  return request<CertReviewResult>({
    url: `/api/v1/certifications/${certId}/review`,
    method: 'put',
    data
  });
}
