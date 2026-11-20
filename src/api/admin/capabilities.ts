import { request } from '@/api/request';

/**
 * 教师可授课程（teacher_course_capability，T-04 · 会议 #10，2026-11-10 前端接线）
 * ============================================================================
 * 来源三口径（T-01 设计 §1.2-⑩ 上游）：教研室默认 / 教师自设 / 管理员代设。
 * 管理端这里是「管理员代设」入口：读某教师当前的可授课程集合，整组覆盖保存。
 *
 * ★ 8080 实测（2026-11-10 首次接线，2026-11-20 复核更正）：
 * - GET  /teachers/{teacherId}/capabilities ⇒ `{ code:0, data: [{capabilityId, courseId, courseName, …}] }`
 *   （未设置时为空数组）——是对象数组，不是课程 id 集合。
 * - POST /teachers/{teacherId}/capabilities，body { courseIds: string[] } ⇒ 返回**实际新增数**；
 *   已存在的自动跳过（INSERT IGNORE）⇒ 这是追加语义，撤销要另走 DELETE。
 * - DELETE /capabilities/{capabilityId} ⇒ 按资格行主键撤销一条。
 * - 课程维度反查 `GET /courses/{courseId}/capability-teachers` 已具备（菜单 3364）。
 *
 * ★ 权限点已定档（sys_menu 2026-11-20 核对）：
 *   admin:capabilities:add(3347) / :remove(3348) / :courseTeachers(3364) / :list(3387)，均已授权 admin 角色。
 *   页面侧用 store.hasPermi 做门禁，非超管账号按真实权限显示或隐藏入口。
 */

/**
 * 某教师当前的可授课程资格行。
 *
 * ★ 2026-11-20 更正：这个端点返回的是**对象数组**
 *   `[{capabilityId, courseId, courseName, courseNo, source, createTime, teacherId}]`，
 *   不是课程 id 字符串数组。旧声明写成 `string[]`，账号页 `ids.map(String)` 回显时
 *   会把对象 String 成 "[object Object]" ⇒ 打开弹窗原有勾选全丢。
 *   需要 id 集合的地方一律 `list.map(c => String(c.courseId))`。
 */
export interface TeacherCapabilityVo {
  /** 资格行主键，撤销时按它 DELETE */
  capabilityId: string;
  courseId: string;
  courseName?: string;
  courseNo?: string;
  /** 来源三口径：dept_default / self / admin / course */
  source?: string;
  createTime?: string;
  teacherId?: string;
}

export function getTeacherCapabilities(teacherId: string | number) {
  return request<TeacherCapabilityVo[]>({
    url: `/api/v1/admin/teachers/${teacherId}/capabilities`,
    method: 'get'
  });
}

/**
 * 追加授予可上课资格。
 *
 * ★ 语义是 **INSERT IGNORE 追加**，不是「整组覆盖」（源码 AdminCapabilityServiceImpl#grant：
 *   `grantCapabilities(teacherId, courseIds, source, …)` + 「已存在自动跳过，返回实际新增数」）。
 *   所以取消勾选**不会**被这里删掉 —— 必须调 {@link revokeTeacherCapability} 逐条撤销。
 */
export function saveTeacherCapabilities(teacherId: string | number, courseIds: string[]) {
  return request<number>({
    url: `/api/v1/admin/teachers/${teacherId}/capabilities`,
    method: 'post',
    data: { courseIds }
  });
}

/** 撤销一条资格（按资格行主键，不是课程 id）。权限点 admin:capabilities:remove（菜单 3348）。 */
export function revokeTeacherCapability(capabilityId: string | number) {
  return request<boolean>({
    url: `/api/v1/admin/capabilities/${capabilityId}`,
    method: 'delete'
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
