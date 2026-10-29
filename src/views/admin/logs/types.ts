/**
 * 系统日志页类型（#8）。
 * -----------------------------------------------------------------------------
 * 契约出处：`AdminLogRowVo.java:22-54`（字段注释写明「字段名是契约的一部分，不得改名」）
 * + `AdminAuditLogMapper.xml:20-87`（两个分支 SQL）。
 *
 * 两个页签（操作日志 / 登录日志）**出参同形**：后端在 SQL 侧把 `sys_logininfor`
 * 的列别名成了 `sys_oper_log` 那一套名字，所以前端只写一套适配。
 *
 * ⚠️ 两处必须知道的事实（决定页面上哪些列不能画）：
 *   1. **没有「操作内容」文本**。原型的「修改账号状态：张同学 → 停用」这种描述后端不存，
 *      能拿到的只有 `title`（模块名）+ `businessType`（操作类型）+ `requestMethod` + `operUrl`。
 *      所以「操作内容」列由这三项拼出来，不是凭空写的。
 *   2. **登录日志没有角色、没有设备/客户端**。VO 里 `businessType` 恒为 0、
 *      `requestMethod` / `operUrl` 恒为空串（`AdminAuditLogMapper.xml:61-63` 写死），
 *      原型那两列（角色、设备）后端没有任何来源 ⇒ 页面不画，不做假列。
 */

/** 后端出参：两个页签共用的行形状 */
export interface LogRowVo {
  /** 主键：操作日志 ← oper_id；登录日志 ← info_id。实测下发为字符串（雪花/自增均按字符串） */
  operId: string;
  /** 模块名。登录日志固定为「登录日志」（SQL 写死） */
  title: string;
  /** 操作类型：若依 business_type。0 其它 / 1 新增 / 2 修改 / 3 删除 / 5 导出 / 6 导入 … */
  businessType: number | null;
  /** 请求方式。登录日志恒为空串 */
  requestMethod: string;
  /** 请求地址。登录日志恒为空串 */
  operUrl: string;
  /** 操作人（登录日志里是登录账号） */
  operName: string;
  operIp: string;
  /** 操作地点。实测有「内网IP」「XX XX」（后者是 IP 解析失败的脏值）与空串 */
  operLocation: string;
  /** ⚠️ 0 = 正常，非 0 = 异常。判成败只看这个字段，不要看 HTTP 状态 */
  status: number | null;
  /** 后端已格式化成 `yyyy-MM-dd HH:mm:ss` 字符串，前端不要再解析成时间戳 */
  operTime: string;
  /** 耗时（毫秒）。登录日志恒为 0 */
  costTime: number | null;
}

/** 页签标识：与后端 `AdminLogServiceImpl.java:27` 的 LOG_TYPE_LOGIN 对齐，其余一律走操作日志 */
export type LogTab = 'operation' | 'login';

/** 查询入参。两个页签能用到的字段不同，由页面按页签择一传，见 api/admin/logs.ts 顶部说明 */
export interface LogQuery {
  tab: LogTab;
  /** 操作日志：操作人（映射到 operName）；登录日志：账号或 IP（映射到 keyword） */
  keyword: string;
  /** 仅操作日志：模块名，映射到 title（后端 `title || keyword` 二选一，所以不能借 keyword 传模块） */
  module: string;
  /** 仅操作日志：businessType */
  businessType: number | null;
  /** 两个页签通用：0 正常 / 非 0 异常 */
  status: number | null;
  /** yyyy-MM-dd，两个页签通用 */
  startTime: string;
  endTime: string;
  page: number;
  pageSize: number;
}
