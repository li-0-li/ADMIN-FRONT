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
 * ⚠️ 契约出处（后端源码逐字读出，非猜测）：
 *   · `AdminMonitorController.java`（/status + /error-logs 两个端点）
 *   · `SystemStatusServiceImpl.java`（取值实现）
 *
 * 2026-10-30 起新增 `cpu` / `disk` / `pool` / `uptimeMs` 四项（补丁单
 * `工作汇报/20261030-监控页-后端补丁单.md`）。**旧包没有这四个字段**——所以全部按
 * 「可能不存在」建模，页面做能力探测：字段在就显示真数据，不在就维持「—」，
 * 新旧两个包都能跑（与日志页 browser/os/roleName 同一手法）。
 *
 * 仍然没有的（继续「—」+ 缺口说明）：网络出口、服务可用率（近 7 天）、当前课堂列表。
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

  /**
   * 全机 CPU 使用率（%，1 位小数）。**首次轮询是 null**（没有上一次 ticks 可做差），
   * 页面必须把 null 显示成「首次采样中」，不能显示成 0%。
   */
  cpu?: number | null;
  /** JVM 工作目录所在盘（MB 口径，与 jvm 一致；totalMB/freeMB 由前端换算展示） */
  disk?: DiskInfo | null;
  /**
   * Druid 连接池水位。后端按实际类型捞，捞不到（换 Hikari / 单测 mock）时是 null ⇒ 页面显示「无连接池指标」。
   * `waitCount > 0` = 有请求在排队等连接，是池不够用的第一信号，页面要醒目提示。
   */
  pool?: PoolInfo | null;
  /** JVM 运行时长（毫秒）。格式化（几天几小时）是展示逻辑，归前端 */
  uptimeMs?: number;
}

/** 磁盘三项（`disk()` 返回）。MB 整数，前端复用 mb2gb 换算展示 */
export interface DiskInfo {
  totalMB?: number;
  freeMB?: number;
  /** 工作目录绝对路径，排障线索（哪个盘一目了然），页面上可显示为小字 */
  path?: string;
}

/** Druid 连接池四项（`pool()` 返回） */
export interface PoolInfo {
  active?: number;
  idle?: number;
  max?: number;
  waitCount?: number;
}

/**
 * ERROR 日志尾部（`GET /api/v1/admin/system/error-logs`）。
 * `lines` 时间正序（最旧在前、最新在最底部，与主流控制台阅读方向一致）。
 * 读文件失败时**不抛 500**，而是 `error` 带中文原因——页面必须把这个错误当「这一块的说明」渲染，
 * 不能当成整页失败。
 */
export interface ErrorLogsVo {
  /** 定位到的 sys-error.log 路径；null = logback 里没有 FileAppender 匹配 */
  file?: string | null;
  fileSizeKB?: number;
  error?: string;
  lines?: string[];
}

/** 服务健康度卡片的四态：未知要单独一档，不能拿「正常」兜底 */
export type HealthState = 'ok' | 'warn' | 'err' | 'unknown';
