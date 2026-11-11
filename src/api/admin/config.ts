import { rawRequest, request } from '@/api/request';

/**
 * 系统配置（C-7/C-8）+ 敏感词库（C-9/C-10），对齐 AdminSystemConfigController。
 * 实测（2026-11-02，现役包）：25 个配置键、6 个分组（ai/quota/cert/class/security/system），
 * valueType ∈ boolean/number/string/json；items 行键 configId/configGroup/configKey/
 * configValue/valueType/editable/remark/schoolId/updateTime 全为字符串化出参。
 */

export interface ConfigItem {
  configId: string;
  schoolId: string;
  configGroup: string;
  configKey: string;
  configValue: string;
  valueType?: 'boolean' | 'number' | 'string' | 'json';
  editable?: number;
  remark?: string;
  updateTime?: string;
}

export function listConfigs() {
  return request<{ configs: Record<string, string>; items: ConfigItem[] }>({ url: '/api/v1/admin/configs', method: 'get' });
}

/** 批量写。只发改动过的键，减少无意义审计记录；单键也走这里（configKey/configValue 与批量同端点等价） */
export function updateConfigs(patch: Record<string, string>) {
  return request<boolean>({ url: '/api/v1/admin/configs', method: 'put', data: { configs: patch } });
}

export interface SensitiveWordVo {
  wordId: string;
  word: string;
  category: 'politics' | 'abuse' | 'ad' | 'custom' | string;
  wordLevel: 'high' | 'mid' | 'low' | string;
  handleAction: 'block' | 'replace' | 'audit' | string;
  replaceWord?: string;
  status: number;
}

export function listWords(query: { page?: number; pageSize?: number; keyword?: string; status?: number }) {
  return request<{ list: SensitiveWordVo[]; total: number; page: number; pageSize: number }>({
    url: '/api/v1/admin/sensitive-words',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}

export interface SensitiveWordSaveBody {
  wordId?: string;
  word: string;
  category: string;
  wordLevel: string;
  handleAction: string;
  replaceWord?: string;
  status?: number;
  /** true = 删除该词（后端 SensitiveWordBo.delete 标志位，POST 同端点承担删除） */
  delete?: boolean;
}

/** 新增（无 wordId）/ 更新（带 wordId）/ 删除（wordId + delete:true）三合一 */
export function saveWord(body: SensitiveWordSaveBody) {
  return request<{ wordId?: string; deleted?: boolean }>({ url: '/api/v1/admin/sensitive-words', method: 'post', data: body });
}

/* ------------------------------------------------------------------ *
 * 教学周全局设置（G8 / R-2 · 录音 A1「教学周要能在后台设置」）
 * ------------------------------------------------------------------ */

/**
 * 契约来自后端源码（`AdminSystemConfigController` T05-6/T05-7）：
 *  - GET  `/api/v1/admin/config/teaching-week` → `{ weekFrom, weekCount, isDefault, overrides[] }`
 *    全局默认存 `biz_config` 两键 `teaching.week.from` / `teaching.week.count`，缺省 1 / 16；
 *  - PUT  同路径，body `{ weekFrom?, weekCount? }`（均可空 = 只改其一，1~25 / 1~30）。
 * 权限点：`admin:config:teachingWeekQuery`(菜单 3362) / `admin:config:teachingWeekEdit`(3363)。
 *
 * ★ 2026-11-11 实测 8080 现役包：该端点**尚未上线**（返回 `No static resource`）
 *   ⇒ 页面走三态探测，不把它当故障，也不假装能存。
 */

/** 单课覆盖：开课记录自己设过周窗口的行（offering.week_from / week_count 非空） */
export interface TeachingWeekOverride {
  offeringId?: string;
  courseId?: string;
  courseName?: string;
  termCode?: string;
  weekFrom?: number | null;
  weekCount?: number | null;
}

export interface TeachingWeekVo {
  weekFrom: number;
  weekCount: number;
  /** true = biz_config 里两个键都还没有，页面展示的是后端缺省值（1 / 16） */
  isDefault?: boolean;
  overrides?: TeachingWeekOverride[];
}

export type TeachingWeekProbe = 'absent' | 'forbidden' | 'ready';

const TEACHING_WEEK = '/api/v1/admin/config/teaching-week';

/**
 * 三态探测（判据与 `probePatrolPlans` 一致）：
 *  - `absent`    现役包没有这个端点 ⇒ 显示缺口提示（当前就是这一态）
 *  - `forbidden` 端点在线但缺 `admin:config:teachingWeekQuery`（sys_menu 3362 未登记/未授权）
 *  - `ready`     拿到 code=0，可渲染表单
 * 用 rawRequest + silent：探测失败不该弹 toast 打扰用户。
 */
export async function probeTeachingWeek(): Promise<TeachingWeekProbe> {
  try {
    const body = await rawRequest<TeachingWeekVo>({ url: TEACHING_WEEK, method: 'get', silent: true });
    const code = body.code;
    if (code === undefined || code === 0 || code === 200) return 'ready';
    if (code === 401 || code === 403) return 'forbidden';
    const msg = String(body.message ?? body.msg ?? '');
    if (msg.includes('No static resource')) return 'absent';
    return 'absent';
  } catch {
    return 'absent';
  }
}

/** 读（探测已确认 ready 后再调，失败照常抛给调用方提示） */
export function getTeachingWeek() {
  return request<TeachingWeekVo>({ url: TEACHING_WEEK, method: 'get' });
}

/** 写：至少给一个字段 */
export function saveTeachingWeek(body: { weekFrom?: number; weekCount?: number }) {
  return request<boolean>({ url: TEACHING_WEEK, method: 'put', data: body });
}
