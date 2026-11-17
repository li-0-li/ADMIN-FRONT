import { rawRequest, request } from '@/api/request';
import type {
  CourseBrief,
  PageResult,
  ScheduleCell,
  ScheduleCreateBo,
  ScheduleCreateResult,
  ScheduleQuery,
  ScheduleSwapBo,
  ScheduleUpdateBo
} from '@/types/admin';

/**
 * ★ 端点路径：曾经两个版本并存（`/api/v1/schedules` 旧包 / `/api/v1/admin/schedules` 新源码），
 *   靠「首次调用探测 + 缓存」兜底。2026-11-16 已定版 admin 前缀，排课端点固定走常量 `SCHEDULE_BASE`；
 *   课程端点（`coursePath`）仍保留探测，因为它也挂在同一批旧 jar 上，收敛需随换包进行。
 */
const SUCCESS = new Set([0, 200]);

/**
 * 19 位雪花 id 出站一律原样透传，不许经 `Number()`：后端逐字段 `@JsonFormat(shape=STRING)`（实测响应体
 * `scheduleId`/`courseId`/`teacherId` 带引号 15 / 裸数字 0），入站是 `Long`，收带引号字符串。
 * ★ 契约里 `courseId/teacherId/classroomId` 仍声明 number（`src/types/admin.ts` 归综合线，编号 66 转 string），
 *   所以这里只在**接口层**加宽，避免共享工作区在类型翻转前先红。综合线落地后这段别名即可删除。
 */
type StringId = string | number;
export type ScheduleCreateBody = Omit<ScheduleCreateBo, 'courseId' | 'teacherId' | 'classroomId'> & {
  courseId: StringId;
  teacherId: StringId;
  classroomId?: StringId;
};
export type ScheduleUpdateBody = Omit<ScheduleUpdateBo, 'classroomId' | 'teacherId'> & {
  classroomId?: StringId;
  teacherId?: StringId;
};
export type ScheduleSwapBody = Omit<ScheduleSwapBo, 'fromScheduleId' | 'toScheduleId'> & {
  fromScheduleId: StringId;
  toScheduleId: StringId;
};

/** 探测某路径在后端是否存在（含业务报错 422/403 也算存在；只有「无此资源/静态资源」判不存在） */
async function exists(base: string, probeParams: Record<string, unknown>): Promise<boolean> {
  try {
    // 用 rawRequest：request 遇到非成功 code 会弹红条，探测不该弹。
    const body = await rawRequest<unknown>({ url: base, method: 'get', params: probeParams });
    const code = body.code;
    if (code === undefined || SUCCESS.has(code)) return true;
    const msg = String(body.message ?? body.msg ?? '');
    // 若依把「找不到静态资源 / 无此端点」包成 code=500 + 这句文案
    return !msg.includes('No static resource');
  } catch {
    // 网络层异常（HTTP 非 2xx）视为不可用，继续试下一个候选
    return false;
  }
}

/** 生成一个"懒解析 + 缓存"的路径解析器 */
function pathResolver(candidates: readonly string[], probeParams: Record<string, unknown>) {
  let cached: string | null = null;
  return async (): Promise<string> => {
    if (cached) return cached;
    for (const c of candidates) {
      if (await exists(c, probeParams)) {
        cached = c;
        return c;
      }
    }
    cached = candidates[candidates.length - 1];
    return cached;
  };
}

const coursePath = pathResolver(['/api/v1/admin/courses', '/api/v1/courses'], { page: 1, pageSize: 1 });

/**
 * 排课端点定版为 admin 前缀（2026-11-16 · 报告 P2-3）。
 * ★ 原来这里挂的是「一次性探测并缓存」的双候选（`/api/v1/admin/schedules` 与 `/api/v1/schedules`），
 *   探测会把真正的 0 行 / 500 一起吞掉：旧路径恒返回 0 行时，页面看着像「本周没课」而不是「调错了端点」。
 *   现已确认真实端点为 `/api/v1/admin/schedules`（`AdminScheduleController` 类级 @RequestMapping），
 *   候选列表整个删掉，调用失败就直接暴露。
 */
const SCHEDULE_BASE = '/api/v1/admin/schedules';

/** C-16 周课表查询。★ startDate / endDate 必填，缺则后端 code=422 */
export async function listSchedules(query: ScheduleQuery) {
  return request<PageResult<ScheduleCell>>({ url: SCHEDULE_BASE, method: 'get', params: query });
}

/** C-17 新建课次（带冲突检查）。★ 命中冲突时后端**不落库**，返回 conflict=true */
export async function createSchedule(body: ScheduleCreateBody) {
  return request<ScheduleCreateResult>({ url: SCHEDULE_BASE, method: 'post', data: body });
}

/**
 * C-19 移动课次（表内拖动换到**空白格**）。
 * ★ 教师/课程由后端从原记录继承；`classroomId` 不传则沿用原教室。
 * ★ 命中冲突时后端**不落库**，返回 conflict=true + conflictMsg。
 */
export async function moveSchedule(scheduleId: string | number, body: ScheduleUpdateBody) {
  return request<ScheduleCreateResult>({
    url: `${SCHEDULE_BASE}/${scheduleId}`,
    method: 'put',
    data: body
  });
}

/**
 * C-20 互换课次（表内拖动落到**已占用格** —— 与该格的课交换位置）。
 * ★ 只对调两节课的时间坐标；课程/教师/教室跟着各自课次走。
 * ★ 任一方在新位置与第三节课冲突则后端**整体不写**，返回 conflict=true。
 */
export async function swapSchedules(body: ScheduleSwapBody) {
  return request<ScheduleCreateResult>({
    url: `${SCHEDULE_BASE}/swap`,
    method: 'put',
    data: body
  });
}

/** C-22 放回待排：软删课次，课程随「本周未出现」口径自动回到待排池 */
export async function deleteSchedule(scheduleId: string | number) {
  return request<{ removed: boolean }>({
    url: `${SCHEDULE_BASE}/${scheduleId}`,
    method: 'delete'
  });
}

/**
 * C-24 发布课表（整学期口径）：全部未发布（draft）课次一次性置为 published。
 * ★ 发布后学生/教师端才可见新排课次；已发布课次再改动保持已发布。
 */
export async function publishSchedules() {
  return request<{ published: number }>({ url: `${SCHEDULE_BASE}/publish`, method: 'post' });
}

/**
 * B-7 自动排课（auto-arrange v1，后端 2026-11-09 a9c6a6e；批次2 2026-11-12 扩参）：
 * 为某条开课记录（offeringId）或整门课全部教学班（courseId，二选一）按学期锚点铺满课次。
 * 批次2 新参：weekParity（all/odd/even，判定基准=教学周绝对周号）、
 * targetClass（指定班级，覆盖 offering 首选班级）、preferredClassroomId（教室锁定）。
 * ★ 供建课向导 step2「一键重排」与排课页「自动排课」统一调用（批次2：前端本地 runAuto 已下线，
 *   自动排课只走这一个端点，消除两套算法打架）。
 * ★ 幂等：已有课次的周自动跳过，重复调用零副作用；教师资格闸门在后端。
 */
export interface AutoArrangeBody {
  offeringId?: string | number;
  courseId?: string | number;
  weekdays?: number[];
  periodNos?: string[];
  weekParity?: 'all' | 'odd' | 'even';
  targetClass?: string;
  preferredClassroomId?: string | number;
  /** 只排该学期的开课（2026-11-13）：不传则后端排除已结束学期，避免排进历史学期 */
  termId?: string | number;
  /**
   * 周窗口覆盖（2026-11-16「排到本周」）：与开课配置的周范围**取交集**，不是替换。
   * weekFrom + weekCount（缺省 1）＝ 只在这一段周内找空位。
   */
  weekFrom?: number;
  /** 与 weekFrom 配用；缺省 1 */
  weekCount?: number;
}
export async function autoArrange(body: AutoArrangeBody) {
  return request<
    Array<{ offeringId: string; courseId: string; courseName?: string; totalWeeks?: number; arranged?: number; weeksPlaced?: number[]; skipped?: Array<{ week?: number; weekNo?: number; reason?: string }> }>
  >({
    url: `${SCHEDULE_BASE}/auto-arrange`,
    method: 'post',
    data: {
      ...(body.offeringId !== undefined ? { offeringId: String(body.offeringId) } : {}),
      ...(body.courseId !== undefined ? { courseId: String(body.courseId) } : {}),
      weekdays: body.weekdays,
      periodNos: body.periodNos,
      weekParity: body.weekParity ?? 'all',
      ...(body.targetClass ? { targetClass: body.targetClass } : {}),
      ...(body.termId !== undefined && body.termId !== '' ? { termId: String(body.termId) } : {}),
      ...(body.weekFrom !== undefined ? { weekFrom: body.weekFrom } : {}),
      ...(body.weekCount !== undefined ? { weekCount: body.weekCount } : {}),
      ...(body.preferredClassroomId !== undefined && body.preferredClassroomId !== ''
        ? { preferredClassroomId: String(body.preferredClassroomId) }
        : {})
    }
  });
}

/** 课程池数据源（拖动排课的「未排课程」来源） */
export async function listCoursePool(schoolId?: string | number) {
  return request<PageResult<CourseBrief>>({
    url: await coursePath(),
    method: 'get',
    params: { page: 1, pageSize: 200, schoolId: schoolId || undefined }
  });
}

/**
 * 开课记录行（`AdminOfferingVo`，`GET /admin/courses/{courseId}/offerings`）。
 *
 * ★ T-01 起「教师」只在开课记录上：`AdminCourseVo` 类注释明写
 *   `courseCode / teacherId / teacherName / semester / studentCount / targetClasses` 六列
 *   **是开课属性、从课程行上移除**（见 `AdminCourseVo`）。所以课程列表返回 `teacherId=null`
 *   **不是缺陷**，前端要教师就得走这条接口 —— 别再当 bug 派给后端（2026-11-12 已核实）。
 */
export interface OfferingBrief {
  offeringId: string;
  /** 授课教师（该开课记录的教师，不是课程的） */
  teacherId?: string | null;
  teacherName?: string | null;
  termId?: string | null;
  termCode?: string | null;
  /** 教学班标识（如 `CS2026-1`） */
  classKey?: string | null;
  /** 面向班级名（数组；无班级时后端返回 `[]` 而非 null） */
  targetClasses?: string[] | null;
  studentCount?: number | null;
  status?: string | null;
  weekCount?: number | null;
  /** 起始周（`course_offering.week_from`，缺省 1；2026-11-17 课程配置弹窗回填节奏用） */
  weekFrom?: number | null;
  /** 一周几节（`course_offering.lessons_per_week`，缺省 1；待排池按它封顶每周签数） */
  lessonsPerWeek?: number | null;
  /** 一共多少课时（节次口径；null = 按周数×每周节次自然铺满；2026-11-17 配置弹窗回填用） */
  totalLessons?: number | null;
  /**
   * 这条开课记录是否已保存排课设置（`course_offering.schedule_configured`，1=已配）。
   * ★ 2026-11-16 新增：待排池要判「已配置课程」，光看课程行的 `offeringUnconfigured`
   *   只知道**几条**没配，不知道缺的是节奏、教师还是班级；逐条明细才判得准。
   * ★ 可选：旧包不下发 ⇒ 缺省按「已配」处理（不许因此把课全打成未配置）。
   */
  scheduleConfigured?: number | boolean | null;
}

/**
 * 某门课的全部开课记录。
 * ★ `data` 是**裸数组**（实测 `{"code":0,...,"data":[...]}`），没有 list/total 信封。
 * ★ 旧包/无权限时可能失败 ⇒ 调用方一律 catch 后按「教师未知」降级，不许阻断课程池渲染。
 */
export async function listCourseOfferings(courseId: string | number) {
  // 复用课程池的前缀探测（`/api/v1/admin/courses` vs `/api/v1/courses`），旧包也能拼对
  const data = await request<OfferingBrief[]>({
    url: `${await coursePath()}/${String(courseId)}/offerings`,
    method: 'get'
  });
  return Array.isArray(data) ? data : [];
}

/* ---------------- B-9 按班成池（批次5，后端 f3118e42，2026-11-13） ----------------
 * 录音口径（11-11）：「必修课按行政班直接分进去，不让学生选；只有选修课才开放选课」。
 * 选一个行政班 → 拉本学期面向该班的必修开课清单（offering.target_classes json_contains 精确匹配），
 * 排课动作仍复用 autoArrange（逐门下发），本接口只负责按班成池。
 * scheduledCount = 该开课已排课次数（deleted=0），满周前端提示「已排完」，避免重复自动排课全被幂等跳过。
 */
export interface ClazzPoolItem {
  offeringId: string;
  courseId: string;
  courseName: string;
  teacherId?: string | null;
  teacherName?: string | null;
  weekFrom?: number | null;
  weekCount?: number | null;
  termId?: string | null;
  termCode?: string | null;
  /** 排课节奏是否已配置（0=未配置，自动排课会跳过；1=已配置） */
  scheduleConfigured?: number | null;
  scheduledCount?: number | null;
}
export async function fetchClazzPool(clazzId: string | number, termId?: string | number) {
  const data = await request<ClazzPoolItem[]>({
    url: '/api/v1/admin/schedules/clazz-pool',
    method: 'get',
    params: { clazzId: String(clazzId), ...(termId ? { termId: String(termId) } : {}) }
  });
  return Array.isArray(data) ? data : [];
}


/* ---------------- B-10 课次调整（批次6，后端 1a3682b5，2026-11-13） ----------------
 * 录音缺口：调课/停课不再只靠 remark 文字。停课 canceled（课表保留并标注、冲突检测让位）、
 * 补课 makeup、恢复正常 normal（恢复时后端清空代课与原因）；可带代课教师与调整原因。
 * 权限 admin:schedules:lessonStatus（menu 3369）。
 */
export interface LessonStatusBody {
  lessonStatus: 'normal' | 'canceled' | 'makeup';
  substituteTeacherId?: string | number | null;
  adjustReason?: string | null;
}
export async function updateLessonStatus(scheduleId: string | number, body: LessonStatusBody) {
  return request<number>({
    url: `${SCHEDULE_BASE}/${String(scheduleId)}/lesson-status`,
    method: 'put',
    data: {
      lessonStatus: body.lessonStatus,
      ...(body.substituteTeacherId ? { substituteTeacherId: String(body.substituteTeacherId) } : {}),
      ...(body.adjustReason ? { adjustReason: body.adjustReason } : {})
    }
  });
}
