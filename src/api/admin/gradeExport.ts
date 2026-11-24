import { request, requestBlob } from '@/api/request';

/**
 * 成绩导出（管理端）
 * ============================================================================
 * 后端 `/api/v1/admin/grade-export`：
 * | 端点 | 用途 |
 * |---|---|
 * | GET  /options   | 学期 / 课程 / 教师 / 班级下拉 + 六类数据集定义（含「一行是什么」与口径） |
 * | GET  /offerings | 某课程的教学班（一个教学班 = 一位教师 + 一组班级） |
 * | GET  /tasks     | 某课程的作业 / 实验任务（「某次实验」精确导出用） |
 * | POST /preview   | 分页预览；total 是全量行数，不是当前页 |
 * | POST /download  | 全量 Excel 文件流 |
 *
 * ★ 列由后端下发（columns + rows 的 key 一一对应），前端不写死字段：
 *   六类数据集列不同，前端再抄一份就会在口径调整后分叉。
 */

const BASE = '/api/v1/admin/grade-export';

/** 六类数据集定义（与后端 GradeExportDataset 同源） */
export interface GradeExportDatasetOption {
  code: string;
  label: string;
  /** 一行是什么 —— 必须显示在屏上，否则会把汇总表当明细表读 */
  rowMeaning: string;
  /** 口径说明 */
  caliber: string;
}

export interface GradeExportOptions {
  terms: Array<Record<string, unknown>>;
  courses: Array<Record<string, unknown>>;
  teachers: Array<Record<string, unknown>>;
  classes: Array<Record<string, unknown>>;
  datasets: GradeExportDatasetOption[];
}

export interface GradeExportOffering {
  offeringId: string | number;
  teacherId?: string | number | null;
  teacherName: string;
  teacherNo: string;
  classText: string;
  offeringIndex: number;
  studentCount?: number | null;
}

export interface GradeExportTask {
  taskId: string | number;
  taskType: 'homework' | 'experiment';
  title: string;
  totalScore?: number | null;
  deadline?: string;
  label: string;
}

export interface GradeExportQuery {
  dataset: string;
  termId?: string | number;
  courseId?: string | number;
  offeringId?: string | number;
  teacherId?: string | number;
  classId?: string | number;
  studentId?: string | number;
  taskType?: 'homework' | 'experiment' | 'all';
  taskId?: string | number;
  status?: 'all' | 'unsubmitted' | 'pending' | 'graded' | 'late';
  startDate?: string;
  endDate?: string;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
}

export interface GradeExportColumn {
  key: string;
  label: string;
}

export type GradeExportRow = Record<string, unknown>;

export interface GradeExportResult {
  dataset: string;
  datasetLabel: string;
  rowMeaning: string;
  caliber: string;
  columns: GradeExportColumn[];
  rows: GradeExportRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: Record<string, unknown>;
  generatedAt: string;
}

export function getGradeExportOptions(params?: {
  termId?: string | number;
  courseKeyword?: string;
  teacherKeyword?: string;
  classKeyword?: string;
}): Promise<GradeExportOptions> {
  return request<GradeExportOptions>({ url: `${BASE}/options`, method: 'get', params });
}

export function listGradeExportOfferings(courseId: string | number): Promise<GradeExportOffering[]> {
  return request<GradeExportOffering[]>({ url: `${BASE}/offerings`, method: 'get', params: { courseId } });
}

export function listGradeExportTasks(
  courseId: string | number,
  taskType?: string
): Promise<GradeExportTask[]> {
  return request<GradeExportTask[]>({ url: `${BASE}/tasks`, method: 'get', params: { courseId, taskType } });
}

export function previewGradeExport(query: GradeExportQuery): Promise<GradeExportResult> {
  return request<GradeExportResult>({ url: `${BASE}/preview`, method: 'post', data: query });
}

export function downloadGradeExport(query: GradeExportQuery): Promise<Blob> {
  return requestBlob({ url: `${BASE}/download`, method: 'post', data: query });
}
