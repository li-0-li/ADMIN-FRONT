/**
 * 系统监控页的契约类型。
 * -----------------------------------------------------------------------------
 * 来源不是猜测，是后端源码逐字读出来的：
 *   · 出参形状：`admin/src/main/java/com/ruoyi/admin/controller/AdminMonitorController.java:11-19`
 *   · 字段实际取值：`.../service/impl/SystemStatusServiceImpl.java:48-150`
 *
 * 为什么这些类型写在本页目录而**不往 `src/types/admin.ts` 追加**：
 * 那是全站共享板，三条前端线同时写会互相覆盖（启动包 §五.2）。本页契约只有本页用，
 * 放自己目录里既不会撞，也让「删掉这页」是一次干净删除。
 */

/** JVM 内存三项 + 核数。单位 MB，由后端 `/1024/1024` 取整而来，**只能当整数展示，不要拿去算精确 GB** */
export interface JvmInfo {
  freeMemoryMB?: number;
  totalMemoryMB?: number;
  maxMemoryMB?: number;
  availableProcessors?: number;
}

/**
 * 探活结果（db / redis 共用）。
 * `status` 只有 `'up'` / `'down'` 两个值；`down` 时才带 `message`。
 * `url` 只有 db 有（JDBC URL），redis 没有——所以它对页面是无用字段，仅作排障线索。
 */
export interface ProbeInfo {
  status?: string;
  costMs?: number;
  url?: string;
  message?: string;
}

/**
 * 系统状态聚合出参。
 *
 * ⚠️ 契约边界（后端注释原文「其余…后端未提供，前端按缺省值显示破折号」）：
 * CPU 使用率、磁盘、网络、连接池占用、服务可用率、运行时长、当前课堂列表、ERROR 日志
 * **这 8 项没有任何端点**。页面一律显示「—」+ 缺口说明，禁止在这里加假字段把页面填满。
 */
export interface SystemStatusVo {
  /**
   * 后端 LocalDateTime。
   * 序列化成两种形态都可能：JSON 里配了 JavaTimeModule 且关了时间戳 ⇒ `'2026-10-28T15:40:01'`；
   * 否则退化成数组 `[2026,10,28,15,40,1]`。两种都要认，否则页面上会显示成 `[object Object]` 之类。
   */
  serverTime?: string | number[];
  /**
   * 在线账号数 = Redis 里 `login_tokens:*` 的 key 数量。
   * ⚠️ **`-1` 表示取不到（Redis 不可达），不是 0 人在线**——两个语义在页面上必须显示成不同的文案，
   * 合成一个「0」会把「监控自己瞎了」误报成「系统很闲」。
   */
  onlineUsers?: number;
  jvm?: JvmInfo;
  db?: ProbeInfo;
  redis?: ProbeInfo;
}

/** 服务健康度卡片的四态：未知要单独一档，不能拿「正常」兜底 */
export type HealthState = 'ok' | 'warn' | 'err' | 'unknown';
