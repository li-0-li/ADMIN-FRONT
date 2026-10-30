/** 后端出参类型：字段名严格照 OpenAPI（/v3/api-docs）里的 schema，不自行改名 */

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** AdminUserVo */
export interface AdminUserVo {
  /** 19 位雪花主键：后端 10-26 起按字符串下发（`@JsonFormat(shape = STRING)`），按数字比较会打在不存在的行上 */
  userId: string;
  username: string;
  nickName: string;
  email: string;
  phone: string;
  status: string;
  deptId: string;
  deptName: string;
  schoolId: string;
  schoolName: string;
  userNo: string;
  bizStatus: string;
  mustChangePwd: boolean;
  createTime: string;
  /** 最近登录时间（sys_user.login_date），从未登录为 null */
  loginDate?: string | null;
  /** 备注（sys_user.remark），未填为 null */
  remark?: string | null;
  roleKeys: string[];
  /** 角色 ID 是基线里的手工小整数（1 超管 / 100 平台管理员），后端显式登记为不发字符串，故保持数字 */
  roleIds: number[];
}

/** UserQueryBo */
export interface UserQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  roleKey?: string;
  status?: string;
  deptId?: string;
}

/** UserSaveBo —— 注意：PUT /users 没有 path，userId 在 body 里 */
export interface UserSaveBo {
  userId?: string;
  username?: string;
  nickName?: string;
  email?: string;
  phone?: string;
  roleKeys?: string[];
  /**
   * 编号 66：后端 mapper 的 `if test="deptId != 0"` 把**显式 null** 落成「清空所属院系」，
   * 缺省=保持原值。契约里原来只有 `string`，页面无法表达「主动摘掉院系」⇒ 甲本轮故意不提供该项。
   */
  deptId?: string | null;
  userNo?: string;
  remark?: string;
}

/** BasicDataQueryBo */
export interface BasicDataQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  parentId?: number;
}

/*
 * ⚠️ 基础数据五域的主键/外键一律 string（对齐后端 @JsonFormat(shape=STRING)，10-28 eb3400b 入库）。
 * 后端是 19 位雪花 id，写 number 会在 JSON.parse 阶段就被截断（Number.MAX_SAFE_INTEGER = 2^53-1），
 * 之后无论怎么修都救不回来——所以契约层面必须是 string，而不是「用时再 String()」。
 * 现役 10-26 运行包还没有这个注解（返回裸数字），页面层用 isSafeInteger 探测做旧包降级。
 */
export interface School {
  schoolId?: string;
  name?: string;
  code?: string;
  domain?: string;
  bindMode?: string;
  status?: string;
  remark?: string;
}

export interface Major {
  majorId?: string;
  deptId?: string;
  name?: string;
  majorCode?: string;
  sortNo?: number;
  status?: string;
  remark?: string;
}

export interface Clazz {
  clazzId?: string;
  schoolId?: string;
  deptId?: string;
  majorId?: string;
  majorName?: string;
  clazzName?: string;
  clazzCode?: string;
  gradeYear?: number;
  headStudentId?: number;
  studentCount?: number;
  status?: string;
  remark?: string;
}

export interface Term {
  termId?: string;
  schoolId?: string;
  name?: string;
  code?: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: number;
  status?: string;
  remark?: string;
}

/** classroom 表（C-21 教室 4 件套，2026-10-15） */
export interface Classroom {
  classroomId?: string;
  schoolId?: string;
  name?: string;
  code?: string;
  /** physical 物理教室 / virtual 虚拟教室（线上直播间） */
  roomType?: string;
  capacity?: number;
  location?: string;
  device?: string;
  status?: string;
  remark?: string;
}

/** /api/v1/admin/dashboard/summary */
export interface DashboardSummary {
  totalCourses: number;
  teacherCount: number;
  activeStudents: number;
  pendingHomework: number;
  updatedAt: string;
}

/** 创建类接口返回的一次性临时口令 */
export interface UserCreateVo {
  userId: string;
  tempPassword: string;
}

/* ================= 课程审核（C-13 列表 / C-14 详情 / C-15 裁决） ================= */

/**
 * GET /api/v1/certifications —— 按**课程**聚合的一行（认证表是一个材料一行，后端做了聚合）。
 * 枚举口径来自后端 SQL：certStatus = rejected | approved | pending，aiDecision = manual | pass | none。
 */
export interface CertReviewItem {
  /** = min(cert_id)，裁决时用它反查 courseId */
  certId: number;
  courseId: number;
  courseName: string;
  teacherName?: string;
  submittedAt?: string;
  /** rejected | approved | pending */
  certStatus: string;
  /** manual | pass | none */
  aiDecision: string;
}

/** 认证材料（后端已把 cert_type 归一成 type：video | doc | table） */
export interface CertMaterial {
  materialId: number;
  /** video 说课视频 | doc 教学教案 | table 教学进度表 */
  type: string;
  title: string;
  desc?: string;
  /** pass | doubt | none */
  aiResult: string;
  /** 预览地址（后端取 playUrl || fileUrl，可能为空） */
  previewUrl?: string;
}

/**
 * GET /api/v1/courses/{courseId}/certifications
 * ★ 出参是 VO 对象本身，**不是分页壳**（契约点，勿套 .list）。
 */
export interface CertDetail {
  certId?: number;
  courseId: number;
  courseName?: string;
  teacherName?: string;
  /** rejected | approved | pending */
  certStatus: string;
  materials?: CertMaterial[];
  /** 各材料 aiComment 拼接而成 */
  aiSuggestion?: string;
}

/** PUT /api/v1/certifications/{certId}/review —— 按课程整体裁决 */
export interface CertReviewBo {
  /** approve 逐项通过并解锁备课 | reject 驳回 */
  action: 'approve' | 'reject';
  /** 驳回时**必填**，否则后端 500「驳回必须填写原因」 */
  rejectReason?: string;
}

export interface CertReviewResult {
  certId: number;
  status: string;
}

/* ================= 智能排课（C-16 周课表 / C-17 新建课次） ================= */

/**
 * 课程池用到的课程摘要。取自 `GET /api/v1/courses` 的 list 行（实测字段）。
 * ★ teacherId / teacherName 是课程自带的授课教师 —— 拖动排课时默认用它预选教师。
 * 编号 66：两个 id 转 string（后端 CourseVo 带 `@JsonFormat(STRING)`，实测响应体就是带引号字符串）。
 */
export interface CourseBrief {
  courseId: string;
  courseName: string;
  courseCode?: string;
  teacherId?: string;
  teacherName?: string;
  studentCount?: number;
  /** active | certifying | archived */
  status?: string;
  semester?: string;
}

/** GET /api/v1/schedules —— 一行 = 一个课次（后端按 class_time 排序，无按格聚合） */
export interface ScheduleCell {
  /**
   * 编号 66：五个 id 转 string —— 后端 ScheduleCellVo 对应字段全带 `@JsonFormat(STRING)`，
   * 实测响应体为带引号字符串；此处继续声明 number 会诱导后来的人写 `Number()`，
   * 19 位雪花 id 一旦过 `Number()` 就丢精度（课排到不存在的行上）。
   * `deleted`（软删标记 0/1）与 weekday/periodNo 不是 id，保持 number。
   */
  scheduleId: string;
  courseId: string;
  /** 所属学期（course.term_id）——待排池「已排」判定按学期口径用 */
  termId?: string;
  /** 软删标记（1=已放回待排）：仅 includeDeleted 查询返回的行带值 */
  deleted?: number;
  courseName?: string;
  courseCode?: string;
  /** 上课班级（后端取 schedule.target_class，是冗余字符串，非 join 班级表） */
  clazzName?: string;
  teacherId?: string;
  teacherName?: string;
  classroomId?: string;
  /** 后端取 classroom.name */
  roomName?: string;
  /** 1 周一 ~ 7 周日 */
  weekday?: number;
  /** 节次序号，= class_period.seq（1 起） */
  periodNo?: number;
  /**
   * 冲突文案。⚠️ 实测后端 selectScheduleList **未 select 该列** ⇒ 恒为空；
   * 保留字段仅为对齐 VO 契约，页面按空值渲染（不显示冲突样式）。
   */
  conflict?: string;
  /**
   * 发布状态（C-24 起）：draft=未发布（学生/教师端不可见，卡片带「未发布」标识）、
   * published=已发布、normal=历史存量（与 published 同义）。
   */
  status?: string;
  /** 后端取 schedule.remark */
  note?: string;
}

/** 周课表查询入参。★ startDate / endDate **必填**，缺则 code=422 */
export interface ScheduleQuery {
  startDate: string;
  endDate: string;
  termId?: string | number;
  /** 院系过滤（course.school_id），空 = 全部 */
  schoolId?: string | number;
  courseId?: string | number;
  teacherId?: string | number;
  classroomId?: string | number;
  page?: number;
  pageSize?: number;
  /** true = 连同软删（放回待排）的课次一并返回：待排池据此判定「课程已回池」 */
  includeDeleted?: boolean;
}

/** POST /api/v1/schedules 入参（★ 无 remark 字段，备注后端不接收） */
export interface ScheduleCreateBo {
  /**
   * 编号 66：id 一律 string。页面从读接口拿到的就是字符串（后端 Vo 带 `@JsonFormat(STRING)`），
   * 再 `Number()` 回写就会在 19 位雪花 id 上丢精度、把课排到不存在的行上。
   */
  courseId: string;
  teacherId: string;
  classroomId?: string;
  /** yyyy-MM-dd HH:mm:ss */
  classTime: string;
  durationMin: number;
  /** 教学周 */
  weekRef?: number;
  /** 1-7 */
  weekday: number;
  /** 节次序号（= class_period.seq） */
  periodNo: number;
  /** 上课班级（schedule.target_class）：可不传 */
  targetClass?: string;
}

/** POST 出参：命中冲突时**不落库**，返回 conflict=true + conflictMsg */
export interface ScheduleCreateResult {
  scheduleId?: string | null;
  conflict: boolean;
  conflictMsg?: string | null;
}

/**
 * PUT /api/v1/schedules/{scheduleId} 入参（C-19 移动课次 · 表内拖动换到**空白格**）。
 * ★ 不传 courseId / teacherId —— 移动不改变所属课程与授课教师（教师由后端从原记录继承）；
 *   `classroomId` 不传则沿用原教室。
 */
export interface ScheduleUpdateBo {
  /** yyyy-MM-dd HH:mm:ss */
  classTime: string;
  durationMin: number;
  /** 1-7 */
  weekday: number;
  /** 节次序号（= class_period.seq） */
  periodNo: number;
  /** 编号 66：id 走字符串，理由同 `ScheduleCreateBo` */
  classroomId?: string;
  remark?: string;
  /** 上课班级（schedule.target_class）：null/缺省=不改，空串=清空 */
  targetClass?: string;
  /** 授课教师：null/缺省=沿用原教师 */
  teacherId?: string;
}

/**
 * PUT /api/v1/schedules/swap 入参（C-20 互换课次 · 表内拖动落到**已占用格**）。
 * ★ 只对调两节课的「时间坐标」（class_time / duration_min / weekday / period_no），
 *   课程 / 教师 / 教室**跟着课次本身走**、不随格子移动。
 */
export interface ScheduleSwapBo {
  /**
   * 编号 66：转 string。两枚值直接取自 `ScheduleCell.scheduleId`（Vo 已带 `@JsonFormat(STRING)`），
   * 保持 number 会逼页面写 `Number()` 回宽，19 位雪花 id 丢精度后互换到不存在的课次。
   */
  /** 被拖动的课次（源） */
  fromScheduleId: string;
  /** 被落在其上的课次（目标，格子里原有的那节） */
  toScheduleId: string;
}

/* ================= 全校学情（#13 GET /api/v1/admin/analytics/school） ================= */

/** 顶部统计卡聚合数 */
export interface AnalyticsSummary {
  avgScore: number;
  passRate: number;
  /** 较上期的变化量（带符号；平均分） */
  avgScoreDelta: number;
  passRateDelta: number;
  liveClassCount: number;
  alertCount: number;
  /** 预警学生去重人数（口径 distinct student_id where status='open'）；alertCount 是条数，两者可以不等 */
  alertStudents?: number;
  /** 预警数变化（负数 = 比上期减少） */
  alertDelta: number;
  courseCount: number;
  teacherCount: number;
  studentCount: number;
}

/** 课程分类统计行 */
export interface AnalyticsCategory {
  category: string;
  courseCount: number;
  studentCount: number;
  avgScore: number;
  passRate: number;
}

/** 成绩分布区间桶 */
export interface AnalyticsBucket {
  range: string;
  count: number;
}

/** 院系及格率行（按任课教师所属院系聚合） */
export interface AnalyticsDeptPass {
  deptId: number;
  deptName: string;
  /** 该口径下已批改成绩份数 */
  scoreCount: number;
  /** 0-100 */
  passRate: number;
}

/** 院系下拉选项（有任课教师的部门，供筛选条渲染） */
export interface AnalyticsDeptOption {
  deptId: number;
  deptName: string;
  courseCount: number;
}

/** 成绩趋势点（近 8 周） */
export interface AnalyticsTrendPoint {
  week: string;
  avgScore: number;
}

/** 教师教学排行行（按批改份数降序） */
export interface AnalyticsTeacherRank {
  teacherId: number;
  teacher: string;
  dept?: string | null;
  courseCount: number;
  scoreCount: number;
  avgScore: number;
  passRate: number;
}

/** 课程及格率排行行（倒数 TOP：薄弱课先冒头） */
export interface AnalyticsCourseRank {
  courseId: number;
  course: string;
  dept?: string | null;
  scoreCount: number;
  avgScore: number;
  passRate: number;
}

/** 学期环比（当前学期 vs 上一学期；任一段无数据为 null，前端显示「无对比」） */
export interface AnalyticsTermCompare {
  prevSemester: string;
  curAvg?: number | null;
  curPass?: number | null;
  prevAvg?: number | null;
  prevPass?: number | null;
  /** 两学期各自的去重学生数（不是行数）；10-26 后端新增，数值是否有意义取决于成绩提交覆盖面 */
  curCount?: number | null;
  prevCount?: number | null;
}

/** 备课与实验进度明细（教师 × 课程，前端按院系/课程聚合） */
export interface AnalyticsPrepDetail {
  teacher: string;
  course: string;
  dept: string;
  prepDone: number;
  prepTotal: number;
  expDone: number;
  expTotal: number;
}

/** 当前上课课堂（实时） */
export interface AnalyticsLiveClass {
  course: string;
  teacher: string;
  room: string;
  slot: string;
  /** 如 "28/32" */
  online: string;
}

/** 预警名单行 */
export interface AnalyticsAlert {
  alertId?: number;
  student: string;
  course: string;
  dept: string;
  type: string;
  score: number;
  level: string;
  /** open 待处理 / closed 已处理（旧包无此字段时按 open 处理） */
  status?: string;
  /** 已处理时间，yyyy-MM-dd HH:mm */
  handledAt?: string | null;
  /** 处理备注（标记已处理时填写，可空；旧包无此字段） */
  handleNote?: string | null;
}

/** 全校学情聚合 VO */
export interface SchoolAnalyticsVo {
  summary: AnalyticsSummary;
  categories: AnalyticsCategory[];
  distribution: AnalyticsBucket[];
  /** 院系及格率对比（后端旧包无此字段，置空展示） */
  deptPassRates?: AnalyticsDeptPass[];
  /** 院系下拉选项（有任课教师的部门；后端旧包无此字段） */
  deptOptions?: AnalyticsDeptOption[];
  /** 教师教学排行（后端旧包无此字段，置空展示） */
  teacherRankings?: AnalyticsTeacherRank[];
  /** 课程及格率倒数 TOP（后端旧包无此字段，置空展示） */
  courseRankings?: AnalyticsCourseRank[];
  /** 学期环比（选中学期才有；后端旧包无此字段） */
  termCompare?: AnalyticsTermCompare | null;
  trend: AnalyticsTrendPoint[];
  /** 0-100 */
  experimentRate: number;
  prepDetails: AnalyticsPrepDetail[];
  liveClasses: AnalyticsLiveClass[];
  alerts: AnalyticsAlert[];
}

/** 报表导出（GET /api/v1/admin/export/report）返回 */
export interface ReportFileVo {
  fileUrl: string;
  fileName: string;
}

/** 权限点树节点（B-7 GET /api/v1/admin/permissions） */
export interface PermissionNodeVo {
  menuId: number;
  menuName: string;
  perms: string;
  /** M 目录 / C 菜单 / F 按钮 */
  menuType: 'M' | 'C' | 'F';
  parentId: number;
  path: string;
  icon: string;
  orderNum: number;
  children: PermissionNodeVo[];
}

/** 角色管理行（R-1 GET /api/v1/admin/roles） */
export interface AdminRoleVo {
  roleId: number;
  roleName: string;
  roleKey: string;
  status: string;
  remark: string;
  createTime: string;
  /** 成员数（关联该角色的未删账号数） */
  memberCount: number;
  /** 已授权菜单数（sys_role_menu 行数） */
  menuCount: number;
  /** 内置超级管理员（role_id=1）：禁用配置权限 */
  builtIn: boolean;
}

/** 账号批量导入结果（B-8 POST /api/v1/admin/users/import 出参） */
export interface ImportResultVo {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** 账号足迹 · 登录记录项（F-1，sys_logininfor 行） */
export interface FootprintLoginItem {
  infoId: number;
  ipaddr: string;
  browser: string;
  os: string;
  /** 0 成功 / 1 失败 */
  status: string;
  msg: string;
  loginTime: string;
}

/** 账号足迹 · 操作记录项（F-1，sys_oper_log 行） */
export interface FootprintOperItem {
  operId: number;
  /** 模块标题（如「账号管理」） */
  title: string;
  /** 业务类型：0 其它 1 新增 2 修改 3 删除 4 授权 5 导出 6 导入 7 强退 8 生成 9 清空 */
  businessType: number;
  requestMethod: string;
  operIp: string;
  /** 0 正常 / 1 异常 */
  status: string;
  errorMsg: string | null;
  operTime: string;
}

/** 账号足迹（F-1 GET /api/v1/admin/users/{userId}/footprint 出参） */
export interface FootprintVo {
  userName: string;
  loginTotal: number;
  weekOperCount: number;
  logins: FootprintLoginItem[];
  opers: FootprintOperItem[];
}
