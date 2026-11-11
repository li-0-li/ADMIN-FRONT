import { request } from '@/api/request';
import type { ErrorLogsVo, SystemStatusVo } from '@/views/admin/monitor/types';

/**
 * 系统状态聚合（#9）。
 * -----------------------------------------------------------------------------
 * 契约出处：`AdminMonitorController.java`（出参形状注释）+ `SystemStatusServiceImpl.java`（取值实现）。
 * 2026-10-30 起返回体在原五项（`jvm / onlineUsers / serverTime / db / redis`）之外
 * 新增 `cpu / disk / pool / uptimeMs`（补丁单 `工作汇报/20261030-监控页-后端补丁单.md`）。
 * **旧包没有这四个字段**——页面按能力探测消费，本函数不做任何字段补默认值：
 * 一旦补了 `cpu ?? 0` 之类的默认值，旧包下页面上的「—」就变成了看起来像真数据的 0（答辩会被追问数据来源）。
 *
 * 为什么 `request<T>` 之后不要再取 `.data`：`api/request.ts` 的 `request()` 已统一剥掉
 * `{code,message,data}` 外壳，这里拿到的直接就是内层对象。
 */
export function getSystemStatus() {
  return request<SystemStatusVo>({
    url: '/api/v1/admin/system/status',
    method: 'get',
    // 页面自带失败横幅 + 旧快照保留。不带 silent 的话，后端一挂每 5 秒弹一次报错
    // toast（实测确认过的缺陷），横幅与 toast 同文案重复轰炸——提示职责全在横幅
    silent: true
  });
}

/**
 * ERROR 级别日志尾部（logback `sys-error.log` 最后 limit 行，时间正序）。
 *
 * 为什么不捆进 `getSystemStatus`：监控页 5 秒轮询一次 status，日志几十行捆进去
 * 99% 的轮询都在重复传同一段文本——单独端点，调用方按自己的慢节奏（约 30 秒）拉。
 * 读文件失败时后端**不抛 500**，`error` 字段带中文原因，调用方按文案渲染即可。
 *
 * ★ 2026-11-11 实测：`limit` 后端**硬顶 200**（传 500 仍只返 200 行），默认值必须取 200 不能取 50——
 * 日志尾部一条异常的 stack trace 就要 150~200 行，取 50 必然切在堆栈中间，窗口里连一条 ERROR 头都
 * 看不到（实测 50 行含 ERROR=0，200 行含 ERROR=1），默认「只看 ERROR」视图因此恒为空。
 */
export function getErrorLogs(limit = 200) {
  return request<ErrorLogsVo>({
    url: '/api/v1/admin/system/error-logs',
    method: 'get',
    params: { limit },
    // 能力探测必带：旧包没有这个端点（返回 code=500「No static resource」），
    // 不带 silent 会弹一条英文技术报错 toast 污染界面——页面 catch 后自己降级显示「未接入」
    silent: true
  });
}
