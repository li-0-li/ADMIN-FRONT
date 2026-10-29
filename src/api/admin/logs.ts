import { request } from '@/api/request';
import type { PageResult } from '@/types/admin';
import type { LogQuery, LogRowVo } from '@/views/admin/logs/types';

/**
 * 系统日志分页查询（#8）。
 * -----------------------------------------------------------------------------
 * 契约出处：`AdminLogController.java:45-62`（入参）+ `AdminLogServiceImpl.java:37-58`（分支）
 * + `AdminAuditLogMapper.xml:20-87`（两条 SQL）。
 *
 * ⚠️ **两个页签吃的参数不同，传错了不会报错、只会静默筛不出来**（这是本函数存在的主要理由，
 * 别在页面里直接拼 params）：
 *   - 操作日志分支：`moduleKey = title || keyword` —— 也就是说 **`title` 和 `keyword` 抢同一个位置**，
 *     两者都传时只有 `title` 生效。而 `keyword` 在这个分支里被当作**模块名**去 like，
 *     不是操作人。所以「按操作人搜」只能走 `operName`，绝不能借 `keyword`。
 *   - 登录日志分支：只认 `keyword`（同时 like `user_name` 和 `ipaddr`）、`status`、时间窗；
 *     `title` / `operName` / `businessType` 传了也被忽略（`AdminLogServiceImpl.java:47-50`）。
 *     这里显式不传，避免下一个人以为它们生效了。
 *
 * 为什么 `request<T>` 之后不再取 `.data`：`api/request.ts` 已在剥壳处 `return body.data as T`，
 * 拿到的直接是内层 `{list,total,page,pageSize}`。
 */
export function listLogs(q: LogQuery) {
  const params: Record<string, unknown> = {
    logType: q.tab,
    status: q.status ?? undefined,
    startTime: q.startTime || undefined,
    endTime: q.endTime || undefined,
    page: q.page,
    pageSize: q.pageSize
  };

  if (q.tab === 'login') {
    params.keyword = q.keyword || undefined;
  } else {
    if (q.keyword) params.operName = q.keyword;
    if (q.module) params.title = q.module;
    if (q.businessType !== null) params.businessType = q.businessType;
  }

  return request<PageResult<LogRowVo>>({ url: '/api/v1/admin/logs', method: 'get', params });
}

/**
 * 导出用：按同一套筛选条件一次拉一大页（后端 `pageSize` 无上限校验，实测 2000 可一次返回）。
 * 之所以不做「循环翻页拉全量」：773/1093 条按 10 条一页要打 78/110 次请求，
 * 既慢又会在导出途中混入别人新产生的日志，得到一个内部不一致的文件。
 */
export const EXPORT_PAGE_SIZE = 2000;

export function listLogsForExport(q: LogQuery) {
  return listLogs({ ...q, page: 1, pageSize: EXPORT_PAGE_SIZE });
}
