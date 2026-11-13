import { rawRequest, request, requestBlob } from '@/api/request';
import type { PageResult } from '@/types/admin';

/**
 * 课堂巡查（G4）—— 2026-11-13 实测 8080 包（api-docs 551 路径），两层都齐了：
 *
 * **会话层（教师端自动产生、管理端补结论）**
 * | 端点 | 权限 | 出参 |
 * |---|---|---|
 * | GET /api/v1/admin/sessions?status=&page=&pageSize= | admin:patrol:list（3275） | PageResult<PatrolSessionVO> |
 * | GET /api/v1/sessions/{sessionId}/step-logs | admin:patrol:steplogs（3276） | **裸数组** SessionStepLogVO[] |
 * | POST /api/v1/admin/patrol/sessions/export | admin:patrol:export（★ 菜单**未落库**） | Excel 流 |
 *
 * **计划层（管理端自建巡查安排 + 听课记录）**
 * | 端点 | 权限 | 出参 |
 * |---|---|---|
 * | GET /api/v1/admin/patrol/plans | admin:patrol:planList（3357） | PageResult<PatrolPlanVO>（行内 records[]） |
 * | POST /api/v1/admin/patrol/plans | admin:patrol:planAdd（3358） | planId |
 * | PUT /api/v1/admin/patrol/plans/{planId} | admin:patrol:planEdit（3359） | boolean |
 * | DELETE /api/v1/admin/patrol/plans/{planId} | admin:patrol:planRemove（3360） | boolean |
 * | POST /api/v1/admin/patrol/records?planId=&content= | admin:patrol:recordAdd（3361） | {recordId, fileUrl} |
 *
 * ★ 与 2026-11-11 首版的差异（当时只有会话层两个端点，计划层写成"缺口提示"）：
 *   源码 T-05 提交 `1bfe3e69` 已合入远端 be-admin，建表脚本 `patrol-plan-1110.sql` 与菜单
 *   3357~3361 也已在本地库执行 ⇒ 计划层**可以做成真界面**，页面横幅已撤。
 *
 * ★ 三个仍要留意的后端事实（实测，别再重复排查）：
 *  1. 步骤明细**不是"随会话"鉴权**，是独立权限点 `admin:patrol:steplogs`（3276）。
 *  2. `pageSize>100` 服务端兜底 20（计划层同口径），**不影响 total**，统计卡取 total 仍准。
 *  3. 导出权限点 `admin:patrol:export` 在 sys_menu 里**一行都没有**（3357~3361 只有计划层 5 个）
 *     ⇒ 非超管账号调导出必 403。按钮按权限门禁，并在页面写明"需补菜单"，不假装能导。
 *
 * ★ 会话层**没有**巡查结论写端点（无 PATCH/PUT）⇒「保存巡查记录」仍是禁用态 + 说明。
 *   结论只能由教师端/别的入口写入，管理端目前只读。
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

/* ------------------------------------------------------------------ *
 * 计划层（真实端点，2026-11-13 起）
 * ------------------------------------------------------------------ */

/** 计划状态（后端 STATUSES 白名单，新增恒 pending，只能编辑流转） */
export type PlanStatus = 'pending' | 'ongoing' | 'done' | 'cancelled';

/** 听课记录（PatrolRecordVo）。★ fileUrl 是**预签名地址**（`/oss/...`），对象名不外泄 */
export interface PatrolRecordVO {
  recordId: string | number;
  planId: string | number;
  recorderId?: string | number | null;
  recorderName?: string | null;
  content?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileUrl?: string | null;
  createTime?: string | null;
}

/** 巡查计划行（AdminPatrolPlanVo）。records 由后端按当页 planId 一次性回填，非 N+1 */
export interface PatrolPlanVO {
  planId: string | number;
  planName?: string | null;
  offeringId?: string | number | null;
  courseId?: string | number | null;
  courseName?: string | null;
  teacherId?: string | number | null;
  teacherName?: string | null;
  classroom?: string | null;
  /** yyyy-MM-dd（后端用 LocalDate.parse 校验，传别的时间格式会 500 + "格式非法"） */
  patrolDate?: string | null;
  periodNo?: number | null;
  status?: string | null;
  remark?: string | null;
  createTime?: string | null;
  records?: PatrolRecordVO[] | null;
}

/**
 * 新建/编辑入参（PatrolPlanSaveBo）。
 * ★ 后端必填只有 planName + patrolDate（`validate()` 里逐条判，其余可为空）；
 *   periodNo 传了就必须在 1~30，否则 "节次非法（1~30）"。
 * ★ 编辑时空对象会被 `isEmptyUpdate()` 拒绝（"缺少要更新的字段"）⇒ 前端一律整份提交。
 */
export interface PatrolPlanSaveBody {
  planId?: string | number;
  planName: string;
  offeringId?: string | number | null;
  courseId?: string | number | null;
  teacherId?: string | number | null;
  classroom?: string | null;
  patrolDate: string;
  periodNo?: number | null;
  status?: string | null;
  remark?: string | null;
}

export interface PatrolPlanQuery {
  status?: string;
  /** yyyy-MM-dd 精确匹配（后端按天筛，不是区间） */
  patrolDate?: string;
  page?: number;
  pageSize?: number;
}

/** 计划分页列表。records[] 内嵌听课记录，附件已预签名 */
export function listPatrolPlans(query: PatrolPlanQuery = {}, opts: CallOpts = {}) {
  const params: Record<string, unknown> = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20
  };
  if (query.status) params.status = query.status;
  if (query.patrolDate) params.patrolDate = query.patrolDate;
  return request<PageResult<PatrolPlanVO>>({
    url: PATROL_PLANS,
    method: 'get',
    params,
    silent: opts.silent === true
  });
}

/** 新建计划（后端恒置 pending，忽略入参 status） */
export function createPatrolPlan(body: PatrolPlanSaveBody) {
  return request<string | number>({ url: PATROL_PLANS, method: 'post', data: body });
}

/**
 * 编辑计划（含状态流转 pending/ongoing/done/cancelled）。
 * ★ 入参是 Partial：后端 `updatePlan()` **不调用** `validate()`，只判
 *   「存在 + status 白名单 + 非空更新」⇒ 只传 `{status:'ongoing'}` 完全合法（实测通过）。
 *   但**不能传空对象**（isEmptyUpdate 会拒绝 "缺少要更新的字段"）。
 */
export function updatePatrolPlan(planId: string | number, body: Partial<PatrolPlanSaveBody>) {
  return request<boolean>({ url: `${PATROL_PLANS}/${String(planId)}`, method: 'put', data: body });
}

/** 软删计划（听课记录保留，后端软删） */
export function removePatrolPlan(planId: string | number) {
  return request<boolean>({ url: `${PATROL_PLANS}/${String(planId)}`, method: 'delete' });
}

/**
 * 上传听课记录（multipart）。
 * ★ 参数位置是后端的硬约定：planId / content 走 **query**，file 走 **multipart body**
 *   （`@RequestParam` + `MultipartFile`，不是 @RequestPart 对象）。
 * ★ content 与 file **至少其一非空**，都空后端直接 "听课纪要与附件至少其一非空"。
 * ★ 附件 50MB 上限，超了后端报 "附件超过 50MB 上限"。
 * ★ 附件落存储（MinIO / 本地磁盘降级）—— 存储不可用时后端返回 "附件上传失败，请稍后重试"，
 *   这是**环境问题不是前端问题**，页面要按这个语义提示。
 */
export function uploadPatrolRecord(planId: string | number, content: string, file?: File | null) {
  const params: Record<string, unknown> = { planId };
  if (content && content.trim()) params.content = content.trim();
  const form = new FormData();
  // 只有真的带文件才 append：append('file', null) 会变成字符串 "null" 传给后端
  if (file) form.append('file', file);
  return request<{ recordId?: string | number; fileUrl?: string }>({
    url: '/api/v1/admin/patrol/records',
    method: 'post',
    params,
    data: form
  });
}

/**
 * 导出巡查记录（会话层，筛选条件与 #12 列表同口径）。
 * ★ 走 POST + body（与 C-12b `/courses/export` 同构），GET 会得到
 *   "Request method 'POST' is not supported"。后端直接回 Excel 流 ⇒ requestBlob。
 * ★ body 允许为空（`@RequestBody(required=false)`），传 `{}` 也安全。
 */
export function exportPatrolSessions(status?: string) {
  return requestBlob({
    url: '/api/v1/admin/patrol/sessions/export',
    method: 'post',
    data: { status: status || undefined }
  });
}
