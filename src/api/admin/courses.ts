import { request, requestBlob } from '@/api/request';

/**
 * 管理端课程列表（C-12 GET /api/v1/admin/courses，权限 admin:courses:list）。
 * 与 C-23 同模块：都作用于 /api/v1/admin/courses。
 *
 * ★ 实测口径（2026-10-29，8080 运行包）：
 * - `status` 过滤有效（status=active 时 total 10 / 全集 11，另一条是 creating）；
 * - `courseId` / `teacherId` 都是字符串（后端 @JsonFormat STRING），比较一律用字符串；
 * - 返回体是分页壳 { list, total, page, pageSize }，不是裸数组。
 */
export interface AdminCourseVo {
  courseId: string;
  courseName: string;
  courseCode: string;
  teacherId: string;
  teacherName: string;
  semester: string;
  studentCount: number;
  /** 实测枚举：active（审核通过/可上课）、creating（创建中）；后端按审核结果置位 */
  status: string;
  /** 专业（列表已下发；专业筛选参数见 major） */
  major?: string;
  /**
   * 课次数。★ 是否存在的判断只能靠 `'scheduleCount' in row`，不能靠真值/undefined 比较：
   * - 新包（后端 5edbfbb 起）行里带这个字段，值可能是 0（真·未排课）
   * - 旧包（8080 当前运行的 10-26 包）**完全没有这个 key**
   * 用 `=== undefined` 判断会把"字段存在但值为 null"也算成旧包，所以统一用 in。
   * 旧包下前端仍靠课次接口自算兜底（见 courses/index.vue 的 loadScheduleCounts）。
   */
  scheduleCount?: number;
}

/**
 * 排序字段白名单 —— 直接抄后端 XML 的 <choose>（AdminCourseMapper.xml:48-56）：
 *   semester / studentCount / scheduleCount，其它值一律回退 courseId desc。
 * 前端不要传白名单外的字段：会被静默忽略，表现为"点了排序但没反应"。
 */
export type AdminCourseOrderBy = 'semester' | 'studentCount' | 'scheduleCount';

export interface AdminCourseQuery {
  keyword?: string;
  semester?: string;
  schoolId?: string;
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

/**
 * C-12b 导出课程清单（POST /api/v1/admin/courses/export，权限 admin:courses:export）。
 * ★ 查询体在 **body** 里（与列表同构），不是 query —— 用 GET 会得到
 *   「Request method 'POST' is not supported」（实测旧包/错方法的返回就是这个）。
 * 走 requestBlob：后端直接回文件流；业务错误（如 403 无权限）会是
 * HTTP 200 + JSON 壳，requestBlob 内部按 content-type 识别后抛错。
 */
export function exportCourses(query: AdminCourseQuery = {}) {
  return requestBlob({ url: '/api/v1/admin/courses/export', method: 'post', data: query });
}

/** C-23 删除课程：软删主记录 + 级联软删该课程名下全部课次（后端 Service 内做） */
export function deleteCourse(courseId: string | number) {
  return request<boolean>({ url: `/api/v1/admin/courses/${courseId}`, method: 'delete' });
}
