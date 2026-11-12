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
 * ★ 后端接口路径有两个版本并存（实测踩到，不是猜的）：
 *   · `/api/v1/schedules` —— 当前本机运行的 jar（旧产物）只认这个；
 *   · `/api/v1/admin/schedules` —— 团队仓源码里 `AdminScheduleController` 已改成带 admin 前缀
 *     （类注释：「与学生端 ScheduleController 同仓共存需错开」），但还没重新打包。
 *   `/api/v1/courses` 同理（dashboard.ts 的注释早就记过同一现象）。
 *
 *   ⇒ 不做「赌哪一版」，改为**首次调用一次性探测并缓存**：按候选顺序试，命中「无此资源」再回退。
 *     后端以后重打包成哪一版，前端都不用改。
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

const schedulePath = pathResolver(['/api/v1/admin/schedules', '/api/v1/schedules'], {
  startDate: '1970-01-01',
  endDate: '1970-01-01',
  page: 1,
  pageSize: 1
});

const coursePath = pathResolver(['/api/v1/admin/courses', '/api/v1/courses'], { page: 1, pageSize: 1 });

/** C-16 周课表查询。★ startDate / endDate 必填，缺则后端 code=422 */
export async function listSchedules(query: ScheduleQuery) {
  return request<PageResult<ScheduleCell>>({ url: await schedulePath(), method: 'get', params: query });
}

/** C-17 新建课次（带冲突检查）。★ 命中冲突时后端**不落库**，返回 conflict=true */
export async function createSchedule(body: ScheduleCreateBody) {
  return request<ScheduleCreateResult>({ url: await schedulePath(), method: 'post', data: body });
}

/**
 * C-19 移动课次（表内拖动换到**空白格**）。
 * ★ 教师/课程由后端从原记录继承；`classroomId` 不传则沿用原教室。
 * ★ 命中冲突时后端**不落库**，返回 conflict=true + conflictMsg。
 */
export async function moveSchedule(scheduleId: string | number, body: ScheduleUpdateBody) {
  return request<ScheduleCreateResult>({
    url: `${await schedulePath()}/${scheduleId}`,
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
    url: `${await schedulePath()}/swap`,
    method: 'put',
    data: body
  });
}

/** C-22 放回待排：软删课次，课程随「本周未出现」口径自动回到待排池 */
export async function deleteSchedule(scheduleId: string | number) {
  return request<{ removed: boolean }>({
    url: `${await schedulePath()}/${scheduleId}`,
    method: 'delete'
  });
}

/**
 * C-24 发布课表（整学期口径）：全部未发布（draft）课次一次性置为 published。
 * ★ 发布后学生/教师端才可见新排课次；已发布课次再改动保持已发布。
 */
export async function publishSchedules() {
  return request<{ published: number }>({ url: `${await schedulePath()}/publish`, method: 'post' });
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
}
export async function autoArrange(body: AutoArrangeBody) {
  return request<
    Array<{ offeringId: string; courseId: string; courseName?: string; totalWeeks?: number; arranged?: number; weeksPlaced?: number[]; skipped?: Array<{ week?: number; weekNo?: number; reason?: string }> }>
  >({
    url: `${await schedulePath()}/auto-arrange`,
    method: 'post',
    data: {
      ...(body.offeringId !== undefined ? { offeringId: String(body.offeringId) } : {}),
      ...(body.courseId !== undefined ? { courseId: String(body.courseId) } : {}),
      weekdays: body.weekdays,
      periodNos: body.periodNos,
      weekParity: body.weekParity ?? 'all',
      ...(body.targetClass ? { targetClass: body.targetClass } : {}),
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
