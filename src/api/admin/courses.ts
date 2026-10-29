import { request } from '@/api/request';

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
}

export interface AdminCourseQuery {
  keyword?: string;
  semester?: string;
  schoolId?: string;
  status?: string;
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

/** C-23 删除课程：软删主记录 + 级联软删该课程名下全部课次（后端 Service 内做） */
export function deleteCourse(courseId: string | number) {
  return request<boolean>({ url: `/api/v1/admin/courses/${courseId}`, method: 'delete' });
}
