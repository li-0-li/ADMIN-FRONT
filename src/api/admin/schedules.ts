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
export async function createSchedule(body: ScheduleCreateBo) {
  return request<ScheduleCreateResult>({ url: await schedulePath(), method: 'post', data: body });
}

/**
 * C-19 移动课次（表内拖动换到**空白格**）。
 * ★ 教师/课程由后端从原记录继承；`classroomId` 不传则沿用原教室。
 * ★ 命中冲突时后端**不落库**，返回 conflict=true + conflictMsg。
 */
export async function moveSchedule(scheduleId: number, body: ScheduleUpdateBo) {
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
export async function swapSchedules(body: ScheduleSwapBo) {
  return request<ScheduleCreateResult>({
    url: `${await schedulePath()}/swap`,
    method: 'put',
    data: body
  });
}

/** C-22 放回待排：软删课次，课程随「本周未出现」口径自动回到待排池 */
export async function deleteSchedule(scheduleId: number) {
  return request<{ removed: boolean }>({
    url: `${await schedulePath()}/${scheduleId}`,
    method: 'delete'
  });
}

/** 课程池数据源（拖动排课的「未排课程」来源） */
export async function listCoursePool() {
  return request<PageResult<CourseBrief>>({
    url: await coursePath(),
    method: 'get',
    params: { page: 1, pageSize: 200 }
  });
}
