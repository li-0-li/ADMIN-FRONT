import { request } from '@/api/request';

/**
 * 师生资料聚合详情（G6）—— 2026-11-10 派单。
 *
 * ★ 三条实测事实（现役包 a9c6a6e，比派单文档更细，以此为准）：
 *  1. 教师详情**带 `userId` / `userName`**（派单样例里没写，实际返回有）；
 *  2. **`PUT` 教师详情当前 100% 500**：`biz_user_ext.user_role` 是 NOT NULL 且无默认值，
 *     后端 mapper 走 `INSERT ... ON DUPLICATE KEY UPDATE` 却没带这一列 ⇒
 *     `Field 'user_role' doesn't have a default value`。前端无法绕过（body 里传 userRole 被忽略）。
 *     BUG 未修前，保存一律失败——页面据此给出可读提示，不把 SQL 原文丢给用户。
 *  3. 学生**没有 PUT 端点**（只有 GET），本期学生页只读。
 *
 * ★ `taughtCourses` 当前库里**只有 `26-27-1` 一个学期**（两个教师都是），
 *   派单验收要求的「26-27-1 / 25-26-2 两学期分开看」在本库造不出数据；
 *   分组与筛选逻辑按任意学期数实现，验收时用注入模拟第二学期。
 */

export interface TeacherTaughtCourse {
  courseId: string;
  courseName: string;
  offeringId?: string;
  /** 学期代码，形如 `26-27-1`（会议口径：教师要看"勾选几个学期上过哪些课"） */
  termCode?: string | null;
  studentCount?: number | null;
  weekCount?: number | null;
}

export interface TeacherProfile {
  userId: string;
  userName?: string | null;
  nickName?: string | null;
  deptName?: string | null;
  jobTitle?: string | null;
  /** 若依 status：'0' 正常 / '1' 停用 */
  status?: string | null;
  /** 可授课程。实测为 `[]`（能力表还没有数据），结构未定 ⇒ 宽松类型，页面按字段探测渲染 */
  capabilities?: Record<string, unknown>[];
  taughtCourses?: TeacherTaughtCourse[];
}

export interface StudentEnrolledCourse {
  courseId?: string;
  courseName?: string;
  /** ★ 实测字段：`enrollTime`（如 "2026-09-28 14:45:02"），**没有 termCode**。
   *  所以学生侧做不到按学期分组，只能按入学年份分组——这正好对得上会议口径
   *  「学生几年上过哪些课」。 */
  enrollTime?: string | null;
  /** 实测取值：`enrolled`（其余取值未在现有数据中出现，页面原样显示） */
  status?: string | null;
  [k: string]: unknown;
}

export interface StudentProfile {
  userId: string;
  userName?: string | null;
  nickName?: string | null;
  /** 班级名（实测为 null：该学生没绑班级） */
  className?: string | null;
  status?: string | null;
  /** 选课记录。实测为 `[]`，**结构无法从现有数据确认** ⇒ 宽松类型 */
  enrolledCourses?: StudentEnrolledCourse[];
}

/** 教师可编辑的扩展字段（PUT body；实测后端只认这几个里的 jobTitle，其余被忽略或导致同样 500） */
export interface TeacherProfileSaveBo {
  nickName?: string;
  deptName?: string | null;
  jobTitle?: string | null;
  status?: string;
}

export function getTeacherProfile(userId: string) {
  return request<TeacherProfile>({ url: `/api/v1/admin/teachers/${userId}/profile`, method: 'get' });
}

/** ★ 已知后端缺陷：见文件头注释 2。调用方必须能处理失败。
 *  用 silent：不让请求层把后端 SQL 原文（`### Error updating database...`）直接弹给用户，
 *  由页面判断错误类型后给可读文案。 */
export function updateTeacherProfile(userId: string, body: TeacherProfileSaveBo) {
  return request<boolean>({ url: `/api/v1/admin/teachers/${userId}/profile`, method: 'put', data: body, silent: true });
}

export function getStudentProfile(userId: string) {
  return request<StudentProfile>({ url: `/api/v1/admin/students/${userId}/profile`, method: 'get' });
}
