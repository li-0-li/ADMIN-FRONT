import { rawRequest, request } from '@/api/request';
import type { PageResult } from '@/types/admin';

/**
 * 课堂巡查（G4 / T1）—— 2026-11-11 实测 8080 现役包，只有「会话层」两个端点：
 *
 * | 端点 | 权限 | 出参 |
 * |---|---|---|
 * | GET /api/v1/admin/sessions?status=&page=&pageSize= | admin:patrol:list（菜单 3275） | PageResult<PatrolSessionVO> |
 * | GET /api/v1/sessions/{sessionId}/step-logs | admin:patrol:steplogs（菜单 3276） | **裸数组** SessionStepLogVO[] |
 *
 * ★ 与启动包的两处偏差（以实测为准）：
 *  1. 步骤明细**不是"随会话"鉴权**，后端另有独立权限点 `admin:patrol:steplogs`（sys_menu 3276）。
 *     少授这个点的人能看列表、但点开步骤会 403 ⇒ 页面对"查看步骤"做权限门禁，不做点了报错的按钮。
 *  2. `pageSize>100` 服务端兜底 20（**不含** total 计算，所以统计卡取 total 仍准）。
 *
 * ★ 计划层（`/api/v1/admin/patrol/plans`，5 端点）当前包 **0 个**（api-docs 453 条路径里没有），
 *   sys_menu 3357~3364 也是 0 行 ⇒ 页面只做能力探测 + 缺口提示，不写无法实测的 CRUD。
 *   探测用 `probePatrolPlans()`，三态：absent / forbidden / ready。
 *
 * ★ 会话层**没有**巡查结论的写端点（无 PATCH/PUT）⇒ 「保存巡查记录」按钮是禁用态 + 说明，
 *   不做一个点了没反应的按钮（验收会当 bug）。
 */

/** 会话状态（后端 status 列 varchar(16)，取值见 AdminPatrolController 注释） */
export type SessionStatus = 'waiting' | 'late_absent' | 'ongoing' | 'ended';

/** 巡查结论（classroom_session.patrol_status） */
export type PatrolStatus = 'normal' | 'warning' | 'problem';

/** 步骤执行状态（后端 SQL 按时间戳推导，见 SessionStepLogVo 注释） */
export type StepStatus = 'done' | 'doing' | 'todo';

/** 课堂巡查行（PatrolSessionVo）—— 字段名严格照 OpenAPI，不自行改名 */
export interface PatrolSessionVO {
  /** ★ 后端 @JsonFormat(shape=STRING)：19 位雪花 id 收的是**字符串**，不许经 Number() */
  sessionId: string | number;
  courseName?: string | null;
  teacherName?: string | null;
  status?: string | null;
  /** 已完成的步骤序号（0 起还是 1 起由后端定，页面只原样显示「第 N 步」） */
  currentStep?: number | null;
  actualStartTime?: string | null;
  patrolStatus?: string | null;
  patrolNote?: string | null;
  patrolBy?: string | number | null;
  patrolAt?: string | null;
  deptName?: string | null;
  room?: string | null;
  /** 如「1-2 节」（schedule.period_no + weekday 拼出） */
  slot?: string | null;
}

/** 步骤执行明细行（SessionStepLogVo） */
export interface SessionStepLogVO {
  stepName?: string | null;
  planMin?: number | null;
  actualMin?: number | null;
  /** done / doing / todo（未开始也可能给 null） */
  status?: string | null;
  /** sign / talk / teach / quiz / homework 等 */
  stepType?: string | null;
}

export interface PatrolSessionQuery {
  /** 空串/undefined = 不筛选；后端只认 waiting / late_absent / ongoing / ended，别的值 422 */
  status?: string;
  page?: number;
  pageSize?: number;
}

/** `silent` 透传给请求层：统计卡 / 抽屉这类「有兜底展示」的调用不该弹红条 */
interface CallOpts {
  silent?: boolean;
}

/** #12 课堂巡查分页查询 */
export function listPatrolSessions(query: PatrolSessionQuery = {}, opts: CallOpts = {}) {
  const params: Record<string, unknown> = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20
  };
  // status 空值时**不传**该参数：传空串后端按"不筛选"处理，但少传一个参数更干净
  if (query.status) params.status = query.status;
  return request<PageResult<PatrolSessionVO>>({
    url: '/api/v1/admin/sessions',
    method: 'get',
    params,
    silent: opts.silent === true
  });
}

/** A1 步骤执行明细。★ data 是裸数组，没有 list/total 包装 */
export async function listSessionStepLogs(sessionId: string | number, opts: CallOpts = {}) {
  const data = await request<SessionStepLogVO[]>({
    url: `/api/v1/sessions/${String(sessionId)}/step-logs`,
    method: 'get',
    silent: opts.silent === true
  });
  return Array.isArray(data) ? data : [];
}

/* ------------------------------------------------------------------ *
 * 计划层能力探测
 * ------------------------------------------------------------------ */

export type PatrolPlanProbe = 'absent' | 'forbidden' | 'ready';

const PATROL_PLANS = '/api/v1/admin/patrol/plans';

/**
 * 探测巡查计划端点是否可用。三态含义：
 *  - `absent`    当前后端包没有这套端点 ⇒ 页面显示「能力未上线」缺口提示；
 *  - `forbidden` 端点在线但本账号缺 `admin:patrol:planList` ⇒ 提示"缺授权"（准确指向 sys_menu 3357~3364 没授），
 *                **不算接口故障**，所以也不该弹红条；
 *  - `ready`     探测真的拿到 code=0，端点与授权都通。
 *
 * 判据与 schedules.ts 的 exists() 一致：若依把"端点不存在"包成 code=500 + `No static resource`，
 * 只有这句话判不存在；403 反而证明端点存在。用 rawRequest + silent 是为了让探测失败**不弹 toast**。
 */
export async function probePatrolPlans(): Promise<PatrolPlanProbe> {
  try {
    const body = await rawRequest<unknown>({
      url: PATROL_PLANS,
      method: 'get',
      params: { page: 1, pageSize: 1 },
      silent: true
    });
    const code = body.code;
    if (code === undefined || code === 0 || code === 200) return 'ready';
    if (code === 401 || code === 403) return 'forbidden';
    const msg = String(body.message ?? body.msg ?? '');
    if (msg.includes('No static resource')) return 'absent';
    // 其余（422 参数错 / 500 内部错）说明端点存在但当前不可用，按"未上线"处理更保守，
    // 避免渲染出点了就报错的管理区
    return 'absent';
  } catch {
    // 网络层异常（含 401 跳登录）一律按未上线处理，页面降级成缺口提示
    return 'absent';
  }
}
