import { request, requestBlob } from '@/api/request';
import type { AdminCourseDetailVo, AdminOfferingVo, OfferingCreateBo } from '@/types/admin';

/**
 * 管理端基础课程层（T-01，2026-11-06）。
 * ============================================================================
 * C-12 列表改为**基础课程口径**：一门课可开 N 个学期/N 个老师，
 * 课程代码/教师/学期/人数四列从行上移除（开课明细走 GET /courses/{id}/offerings）。
 * 新增 courseNo（课程编号，校内唯一）与 offeringCount（开课记录数）。
 *
 * ★ 实测口径（T-00a/T-00b 落库后）：
 * - courseId / termId 等主键是字符串（后端 @JsonFormat STRING），比较一律用字符串；
 * - 返回体是分页壳 { list, total, page, pageSize }，不是裸数组；
 * - scheduleCount 改走 schedule.offering_id 计数（T-00a 已回填）；
 * - status 词表：active 启用 / disabled 已停用（creating/certifying 是课程审核状态，
 *   T-01 起不再对外，管理端只写 active/disabled）。
 */
export interface AdminCourseVo {
  courseId: string;
  /** 课程编号（校内唯一；KC + 6 位为自动取号格式） */
  courseNo: string;
  courseName: string;
  major?: string;
  /** 学分（0~9.9 一位小数） */
  credit?: number | null;
  hours?: number | null;
  /** required/elective/core/public/practice/general；历史脏值前端按未知显示 */
  courseType?: string | null;
  /** active 启用 / disabled 已停用 */
  status: string;
  /**
   * 课次数（走 schedule.offering_id）。★ 是否存在的判断只能靠 `'scheduleCount' in row`，
   * 不能靠真值/undefined 比较 —— 旧包（8080 的 10-26 包）完全没有这个 key，
   * 页面据此做能力探测降级（见 courses/index.vue 的 loadScheduleCounts）。
   */
  scheduleCount?: number;
  /** 开课记录数；0 = 只建了基础课程还没开课（两步建课第一步完成后的合法状态） */
  offeringCount?: number;
  /** 是否三项认证全过（窗口期仍按 certification.course_id 算；不能用 status 判"是否过审"） */
  certPassed?: boolean;
}

/**
 * 排序字段白名单 —— 直接抄后端 XML 的 <choose>（AdminCourseMapper.xml）：
 *   courseNo / scheduleCount / offeringCount，其它值一律回退 courseId desc。
 * ★ T-01：semester / studentCount 列已从行上移除，白名单同步删 ——
 *   传了会被静默忽略，表现为"点了排序但没反应"。
 */
export type AdminCourseOrderBy = 'courseNo' | 'scheduleCount' | 'offeringCount';

export interface AdminCourseQuery {
  keyword?: string;
  /** 学期筛选（term.term_id）：命中"该学期有开课记录"的课程（B2 课程侧落点） */
  termId?: string;
  schoolId?: string;
  /** active / disabled；不传 = 全部（T-01 起不再固定 active） */
  status?: string;
  major?: string;
  /** 排序字段（白名单见 AdminCourseOrderBy）；不传 = 后端默认 courseId desc */
  orderBy?: AdminCourseOrderBy;
  /** 只认 'asc'，其它值一律 desc（后端 SQL 就是这么写的，别指望 'ASC' 也生效） */
  orderDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export function listCourses(params: AdminCourseQuery = {}) {
  return request<{ list: AdminCourseVo[]; total: number; page: number; pageSize: number }>({
    url: '/api/v1/admin/courses',
    method: 'get',
    params: { page: 1, pageSize: 10, ...params }
  });
}

/* ================= 建课第一步（T01-1，权限 admin:courses:add） ================= */

/** 建课第一步入参（编辑复用同一结构，schoolId 编辑时不传） */
export interface CourseCreateBo {
  /** ^[A-Z0-9][A-Z0-9-]{1,19}$；落库前后端会 toUpperCase + TRIM */
  courseNo: string;
  /** 1~100 字符；同校同名只警告不阻断（duplicateName 出参） */
  courseName: string;
  major?: string;
  /** 0~9.9 一位小数 */
  credit?: number | null;
  hours?: number | null;
  courseType?: string;
  description?: string;
  schoolId?: string;
}

/** 建课第一步出参（duplicateName=true ⇒ 前端弹"同名课程已存在"警告，非阻断） */
export interface CourseCreatedVo {
  courseId: string;
  courseNo: string;
  status: string;
  duplicateName: boolean;
}

export function createCourse(body: CourseCreateBo) {
  return request<CourseCreatedVo>({ url: '/api/v1/admin/courses', method: 'post', data: body });
}

/** 课程详情（含 offerings[] 内嵌 —— 详情抽屉「开课记录」区块的数据源） */
export function getCourse(courseId: string | number) {
  return request<AdminCourseDetailVo>({ url: `/api/v1/admin/courses/${courseId}`, method: 'get' });
}

/** 编辑基础信息（不含学期/教师/班级；courseNo 变更前端二次确认"不影响已开的课"） */
export function updateCourse(courseId: string | number, body: CourseCreateBo) {
  return request<void>({ url: `/api/v1/admin/courses/${courseId}`, method: 'put', data: body });
}

/** 停用/启用（幂等；不级联动开课记录与课次） */
export function changeCourseStatus(courseId: string | number, status: 'active' | 'disabled') {
  return request<void>({ url: `/api/v1/admin/courses/${courseId}/status`, method: 'put', data: { status } });
}

/**
 * 课程编号预检（mode=check，大小写不敏感，与 uk_course_no 同口径）。
 * ★ silent=true：预检失败只 throw 不弹 toast，红字提示由表单自己画（保输入）。
 */
export function checkCourseNo(schoolId: string, courseNo: string) {
  return request<{ available: boolean }>({
    url: '/api/v1/admin/courses/check-no',
    method: 'get',
    params: { schoolId, courseNo, mode: 'check' },
    silent: true
  });
}

/** 课程编号自动取号（KC + 6 位流水，跳过手工占用的号） */
export function nextCourseNo(schoolId = '0') {
  return request<{ courseNo: string }>({
    url: '/api/v1/admin/courses/check-no',
    method: 'get',
    params: { schoolId, mode: 'next' },
    silent: true
  });
}

/* ================= 建课第二步（T01-6/7，权限 admin:offerings:add/list） ================= */

/** 建课第二步：为课程开课（出参 {offeringId, joinCode, classKey, termCode}） */
export function createOffering(courseId: string | number, body: OfferingCreateBo) {
  return request<{ offeringId: string; joinCode: string; classKey: string; termCode: string }>({
    url: `/api/v1/admin/courses/${courseId}/offerings`,
    method: 'post',
    data: body
  });
}

/** 某课程的开课记录列表（T-02 在此扩翻页/编辑/归档/重置加课码） */
export function listCourseOfferings(courseId: string | number) {
  return request<AdminOfferingVo[]>({
    url: `/api/v1/admin/courses/${courseId}/offerings`,
    method: 'get'
  });
}

/**
 * 加课码预检（mode=check，大小写不敏感）。
 * ★ silent=true：红字提示由表单自己画。
 */
export function checkJoinCode(joinCode: string) {
  return request<{ available: boolean }>({
    url: '/api/v1/admin/offerings/check-join-code',
    method: 'get',
    params: { joinCode, mode: 'check' },
    silent: true
  });
}

/** 加课码自动生成（JM + 6 位流水） */
export function nextJoinCode() {
  return request<{ joinCode: string }>({
    url: '/api/v1/admin/offerings/check-join-code',
    method: 'get',
    params: { mode: 'next' },
    silent: true
  });
}

/**
 * C-12b 导出课程清单（POST /api/v1/admin/courses/export，权限 admin:courses:export）。
 * ★ 查询体在 **body** 里（与列表同构），不是 query —— 用 GET 会得到
 *   「Request method 'POST' is not supported」。走 requestBlob：后端直接回文件流。
 */
export function exportCourses(query: AdminCourseQuery = {}) {
  return requestBlob({ url: '/api/v1/admin/courses/export', method: 'post', data: query });
}

/**
 * C-23 删除课程（G5 定案语义，2026-11-06 起）：有开课记录或课次 ⇒ 业务码 40904 拒绝
 * （"如需下线请使用停用"）；都为 0 ⇒ 软删主记录。
 * ★ 级联软删课次已移除 —— 前端文案不得再说"课次会一并移除"。
 */
export function deleteCourse(courseId: string | number) {
  return request<boolean>({ url: `/api/v1/admin/courses/${courseId}`, method: 'delete' });
}
