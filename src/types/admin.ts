/** 后端出参类型：字段名严格照 OpenAPI（/v3/api-docs）里的 schema，不自行改名 */

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** AdminUserVo */
export interface AdminUserVo {
  userId: number;
  username: string;
  nickName: string;
  email: string;
  phone: string;
  status: string;
  deptId: number;
  deptName: string;
  schoolId: number;
  schoolName: string;
  userNo: string;
  bizStatus: string;
  mustChangePwd: boolean;
  createTime: string;
  roleKeys: string[];
  roleIds: number[];
}

/** UserQueryBo */
export interface UserQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  roleKey?: string;
  status?: string;
  deptId?: number;
}

/** UserSaveBo —— 注意：PUT /users 没有 path，userId 在 body 里 */
export interface UserSaveBo {
  userId?: number;
  username?: string;
  nickName?: string;
  email?: string;
  phone?: string;
  roleKeys?: string[];
  deptId?: number;
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

export interface School {
  schoolId?: number;
  name?: string;
  code?: string;
  domain?: string;
  bindMode?: string;
  status?: string;
  remark?: string;
}

export interface Major {
  majorId?: number;
  deptId?: number;
  name?: string;
  majorCode?: string;
  sortNo?: number;
  status?: string;
  remark?: string;
}

export interface Clazz {
  clazzId?: number;
  schoolId?: number;
  deptId?: number;
  majorId?: number;
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
  termId?: number;
  schoolId?: number;
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
  classroomId?: number;
  schoolId?: number;
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
  userId: number;
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
 */
export interface CourseBrief {
  courseId: number;
  courseName: string;
  courseCode?: string;
  teacherId?: number;
  teacherName?: string;
  studentCount?: number;
  /** active | certifying | archived */
  status?: string;
  semester?: string;
}

/** GET /api/v1/schedules —— 一行 = 一个课次（后端按 class_time 排序，无按格聚合） */
export interface ScheduleCell {
  scheduleId: number;
  courseId: number;
  /** 所属学期（course.term_id）——待排池「已排」判定按学期口径用 */
  termId?: number;
  /** 软删标记（1=已放回待排）：仅 includeDeleted 查询返回的行带值 */
  deleted?: number;
  courseName?: string;
  courseCode?: string;
  /** 上课班级（后端取 schedule.target_class，是冗余字符串，非 join 班级表） */
  clazzName?: string;
  teacherId?: number;
  teacherName?: string;
  classroomId?: number;
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
  /** 后端取 schedule.remark */
  note?: string;
}

/** 周课表查询入参。★ startDate / endDate **必填**，缺则 code=422 */
export interface ScheduleQuery {
  startDate: string;
  endDate: string;
  termId?: string | number;
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
  courseId: number;
  teacherId: number;
  classroomId?: number;
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
  scheduleId?: number | null;
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
  classroomId?: number;
  remark?: string;
  /** 上课班级（schedule.target_class）：null/缺省=不改，空串=清空 */
  targetClass?: string;
}

/**
 * PUT /api/v1/schedules/swap 入参（C-20 互换课次 · 表内拖动落到**已占用格**）。
 * ★ 只对调两节课的「时间坐标」（class_time / duration_min / weekday / period_no），
 *   课程 / 教师 / 教室**跟着课次本身走**、不随格子移动。
 */
export interface ScheduleSwapBo {
  /** 被拖动的课次（源） */
  fromScheduleId: number;
  /** 被落在其上的课次（目标，格子里原有的那节） */
  toScheduleId: number;
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

/** 成绩趋势点（近 8 周） */
export interface AnalyticsTrendPoint {
  week: string;
  avgScore: number;
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
  student: string;
  course: string;
  dept: string;
  type: string;
  score: number;
  level: string;
}

/** 全校学情聚合 VO */
export interface SchoolAnalyticsVo {
  summary: AnalyticsSummary;
  categories: AnalyticsCategory[];
  distribution: AnalyticsBucket[];
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
