import { request } from '@/api/request';

/**
 * 教师可授课程（teacher_course_capability，T-04 · 会议 #10，2026-11-10 前端接线）
 * ============================================================================
 * 来源三口径（T-01 设计 §1.2-⑩ 上游）：教研室默认 / 教师自设 / 管理员代设。
 * 管理端这里是「管理员代设」入口：读某教师当前的可授课程集合，整组覆盖保存。
 *
 * ★ 8080 实测（2026-11-10）：
 * - GET  /teachers/{teacherId}/capabilities ⇒ { code:0, data: [] }（未设置时为空数组）
 * - POST /teachers/{teacherId}/capabilities，body { courseIds: string[] }——
 *   ghost 教师报「教师账号不存在或已被删除」，说明路径与教师校验在；body 键名按
 *   REST 惯例取 courseIds，验收时用真实教师 set+revert 复核一次（见页面注释）。
 * - 课程维度反查端点（course → 可授教师）暂无 ⇒ 排课候选过滤待后端补，先不做 N+1。
 *
 * ★ 权限点后端未定档（未在 sys_menu 见 teacher capability 号段）⇒ 前端暂不做
 *   hasPermi 门禁，入口只对管理端账号可见（整页本就管理员专属）；权限点落定后补 v-if。
 */

/** 某教师当前可授课程 id 集合（元素为字符串雪花 id，与全站主键口径一致） */
export function getTeacherCapabilities(teacherId: string | number) {
  return request<string[]>({
    url: `/api/v1/admin/teachers/${teacherId}/capabilities`,
    method: 'get'
  });
}

/** 整组覆盖保存某教师的可授课程；空数组语义（清空/回退教研室默认）以后端实现为准 */
export function saveTeacherCapabilities(teacherId: string | number, courseIds: string[]) {
  return request<unknown>({
    url: `/api/v1/admin/teachers/${teacherId}/capabilities`,
    method: 'post',
    data: { courseIds }
  });
}

/** 可授课程反查返回的教师行（后端 CapabilityTeacherVo） */
export interface CapabilityTeacherVo {
  capabilityId?: string | number;
  teacherId: string | number;
  userName?: string;
  teacherName?: string;
  phonenumber?: string;
  /** 资格来源三口径：教研室默认 / 教师自设 / 管理员代设 */
  source?: string;
  createTime?: string;
}

/**
 * 课程 → 有授课资格的教师（2026-11-12 接线）
 * `GET /api/v1/admin/courses/{courseId}/capability-teachers`，权限点
 * `admin:capabilities:courseTeachers`（菜单 3364）。
 * 用途：排课「新建课次 / 自动排课」的教师候选过滤 —— 没有它就只能全量教师任选，
 * 也就是 11-11 录音里那句「他会把一个上英语的排去上数学」。
 */
export function getCourseCapabilityTeachers(courseId: string | number) {
  return request<CapabilityTeacherVo[]>({
    url: `/api/v1/admin/courses/${courseId}/capability-teachers`,
    method: 'get'
  });
}
