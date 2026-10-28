import { request } from '@/api/request';
import type { SystemStatusVo } from '@/views/admin/monitor/types';

/**
 * 系统状态聚合（#9）。
 * -----------------------------------------------------------------------------
 * 契约出处：`AdminMonitorController.java:11-19`（出参形状注释）+ `SystemStatusServiceImpl.java:48`（取值实现）。
 * 返回体**只有五项**：`jvm` / `onlineUsers` / `serverTime` / `db` / `redis`。
 * CPU 使用率、磁盘、网络、连接池、可用率、运行时长、课堂列表、ERROR 日志 —— 后端一个都没有，
 * 那些一律由页面显示「—」并挂缺口说明。**不要在这个函数里补假字段**，
 * 一旦补了，页面上的「—」就变成了看起来像真数据的常量（答辩时会被追问数据来源）。
 *
 * 为什么 `request<T>` 之后不要再取 `.data`：`api/request.ts:57` 的 `request()` 已在第 61 行
 * `return body.data as T` 统一剥掉 `{code,message,data}` 外壳，这里拿到的直接就是内层对象。
 */
export function getSystemStatus() {
  return request<SystemStatusVo>({ url: '/api/v1/admin/system/status', method: 'get' });
}
