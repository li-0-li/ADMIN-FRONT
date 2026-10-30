<script setup lang="ts">
/**
 * 系统状态监控（/admin/monitor）
 * -----------------------------------------------------------------------------
 * 原型：`UI/ui-prototype/pc/admin-monitor.html`（结构 / 信息层级 / 字段顺序逐块照抄）
 * 端点：`GET /api/v1/admin/system/status`（权限 `admin:monitor:status`）
 * 验收目标（业主给）：「指标卡 + 一张趋势图」，三态齐备，缺数据处显式标注。
 *
 * 本页最容易做错的一件事：原型里 8 项指标是模拟出来（`Math.random`）的，后端一个都没有。
 * 照抄原型的数字就会变成**假数据**——所以凡是后端没有的，一律渲染「—」并在页顶挂缺口说明，
 * 这一条不是保守，是启动包 §五.3 的硬要求（「不做假数据、不假装成功」）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ZkIcon from '@/components/ZkIcon.vue';
import { getErrorLogs, getSystemStatus } from '@/api/admin/monitor';
import type { ErrorLogsVo, HealthState, ProbeInfo, SystemStatusVo } from './types';

/* ---------------- 状态 ---------------- */

/** 首次加载 / 手动刷新时给整页遮罩；5 秒自动刷新**不**给，否则每 5 秒闪一次白，见下方 startAuto */
const loading = ref(false);
const failed = ref(false);
const failMsg = ref('');
/** 后端快照。失败时**故意保留**上一次成功的那份，见 catch 注释 */
const status = ref<SystemStatusVo | null>(null);
/** 最近一次成功取数的本地时刻，用来让「数据是旧的」这件事可见 */
const fetchedAt = ref('');

/**
 * 「新包探测」：status 响应里有没有 10-30 新增的字段（cpu / pool / uptimeMs）。
 * 旧包没有 ⇒ 相关区块回落「后端未提供」的原缺口显示；新包在 ⇒ 显示真数据。
 * 用 `'cpu' in status` 而不是 `status.cpu != null`：**新包首次轮询 cpu 就是 null**，
 * 那是「首次采样中」，不是「没有这个指标」——两种 null 必须显示成不同文案。
 */
const hasNewFields = computed(() => {
  if (!status.value) return false;
  return 'cpu' in status.value || 'pool' in status.value || 'uptimeMs' in status.value;
});

/**
 * 日志级别筛选（本地过滤，不发请求）：'ERROR' 只显示 ERROR 行（本区块的主题），
 * 'ALL' 显示文件尾部的全部行（排查时看上下文用）。旧包下这个控件 disabled 是摆设，
 * 端点可用后激活为真功能——过滤是纯前端行为，不需要后端参数。
 */
const logLevel = ref<'ERROR' | 'ALL'>('ERROR');

/** 按筛选级别过滤后的行。ERROR 行判定复用行高亮的 isErrLine，两处口径永不脱节 */
const errLinesShown = computed(() => {
  const lines = errLogs.value?.lines ?? [];
  return logLevel.value === 'ERROR' ? lines.filter(l => isErrLine(l)) : lines;
});

/** 自动刷新间隔，与原型「实时 · 5s 刷新」一致 */
const AUTO_MS = 5000;
/** ERROR 日志慢节奏：30 秒一拉。日志文本重复率极高，捆进 5s 轮询纯属浪费带宽 */
const ERR_MS = 30000;

let timer: number | undefined;
/** 防重入：5s 定时器和人手点「立即刷新」会撞车，撞上就复用正在飞的那次请求 */
let inFlight = false;

/** 距下次自动刷新的秒数（1 秒心跳递减、成功取数即重置）——「实时」要让人看见节奏，不是一句静态文案 */
const refreshIn = ref(AUTO_MS / 1000);
let tickTimer: number | undefined;

/* ---- ERROR 日志（新端点 /error-logs，30 秒一拉）---- */

const errLogs = ref<ErrorLogsVo | null>(null);
/**
 * 端点能力：null = 还没探测过；true = 有端点（渲染日志行）；false = 探测过不存在（旧包）
 * ⇒ 区块回落「未接入」的缺口显示。探测失败后**不再重试**：换包是发布线的动作，
 * 前端轮询打不出新端点，每 30 秒白打一次没意义。
 */
const errSupported = ref<boolean | null>(null);
let errTimer: number | undefined;
let errInFlight = false;

/* ---- 趋势图本地采样 ---- */

/** 环形缓冲长度：30 点 × 5 秒 = 近 150 秒，与原型「近 30 个采样点」一致 */
const TREND_MAX = 30;
interface TrendPoint {
  t: string;
  cpu: number | null;
  mem: number;
}
/** 只在组件存活期间累积，进页清零重新采——历史序列在后端不存在，这是前端本地采样，不是假历史 */
const trendPoints = ref<TrendPoint[]>([]);

/* ---------------- 取数 ---------------- */

/**
 * 拉一次系统状态。
 * @param silent true = 自动刷新，不显示 loading 遮罩、不清旧值
 * 副作用：改 status / failed / failMsg / fetchedAt；不抛错（错误已转成页面状态）
 */
async function fetchStatus(silent = false) {
  if (inFlight) return;
  inFlight = true;
  if (!silent) loading.value = true;
  try {
    const r = await getSystemStatus();
    status.value = r && typeof r === 'object' ? r : null;
    failed.value = false;
    failMsg.value = '';
    fetchedAt.value = clock(new Date());
    refreshIn.value = AUTO_MS / 1000;
    // 每次成功取数都喂一个点给趋势缓冲：cpu 首次为 null 也喂（mem 有值），
    // 图上 CPU 线就从第一次非 null 的点开始画——不编造「回到 0%」
    pushTrendPoint();
  } catch (e) {
    // 失败时**不清 status**：监控页把「刚才还好好的」整屏清空，比继续显示旧值更误导。
    // 正确做法是留着旧值 + 明确标出「数据停在几点」，让人知道看到的是旧数据。
    failed.value = true;
    failMsg.value = (e as Error)?.message ?? '请求失败';
  } finally {
    inFlight = false;
    if (!silent) loading.value = false;
  }
}

/** 往趋势缓冲压一个采样点；超长从头丢（环形缓冲，shift 掉最旧的） */
function pushTrendPoint() {
  const s = status.value;
  if (!s) return;
  const mem = memPct.value;
  if (mem == null) return; // 连 JVM 内存都没有就没必要压点，图维持空态说明
  trendPoints.value.push({ t: clock(new Date()), cpu: num(s.cpu), mem });
  if (trendPoints.value.length > TREND_MAX) trendPoints.value.shift();
}

/**
 * 拉一次 ERROR 日志尾部。silent 探测：旧包没有端点时 catch 住，仅首次失败时置 false。
 */
async function fetchErrorLogs() {
  if (errInFlight) return;
  errInFlight = true;
  try {
    const r = await getErrorLogs(50);
    errLogs.value = r && typeof r === 'object' ? r : null;
    errSupported.value = true;
  } catch {
    if (errSupported.value === null) errSupported.value = false;
  } finally {
    errInFlight = false;
  }
}

function manualRefresh() {
  fetchStatus();
  // 已探测过端点不存在（旧包）就不白打；null/true 都打（探测或正常拉取）
  if (errSupported.value !== false) fetchErrorLogs();
}

/** 起自动刷新。切页时必须停掉，否则组件已卸载、定时器还在往后台发请求 */
function startAuto() {
  stopAuto();
  timer = window.setInterval(() => {
    // 标签页在后台时跳过：监控页挂在后台还每 5 秒打一次 SELECT 1 + Redis 探针，纯属白烧
    if (document.hidden) return;
    fetchStatus(true);
  }, AUTO_MS);
  // 1 秒心跳只做倒计时减法，不发请求——倒计时是展示层的事，别和取数节奏耦合
  tickTimer = window.setInterval(() => {
    if (refreshIn.value > 0) refreshIn.value -= 1;
  }, 1000);
  // ERROR 日志用独立的慢定时器：探测过端点不存在（旧包）就不再起，省掉无意义的轮询
  if (errSupported.value !== false) {
    fetchErrorLogs();
    errTimer = window.setInterval(() => {
      if (document.hidden || errSupported.value === false) return;
      fetchErrorLogs();
    }, ERR_MS);
  }
}

function stopAuto() {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
  if (tickTimer !== undefined) {
    window.clearInterval(tickTimer);
    tickTimer = undefined;
  }
  if (errTimer !== undefined) {
    window.clearInterval(errTimer);
    errTimer = undefined;
  }
}

onMounted(() => {
  fetchStatus();
  startAuto();
});

onBeforeUnmount(() => {
  stopAuto();
});

/** 日志行是否 ERROR 级别（logback pattern: `HH:mm:ss.SSS [thread] LEVEL`）——真 ERROR 行加亮显示 */
function isErrLine(line: string): boolean {
  return /\b(ERROR)\b/.test(line);
}

/** 日志块底部统计：按筛选态给口径——筛选后要同时报「显示/全部」，否则行数对不上会像丢了数据 */
const errFootText = computed(() => {
  if (errSupported.value === false) return 'ERROR 日志端点未接入（旧包）';
  const total = errLogs.value?.lines?.length ?? 0;
  const shown = errLinesShown.value.length;
  const size = errLogs.value?.fileSizeKB;
  const sizeText = size == null ? '' : ` · 文件 ${size} KB`;
  const scope = logLevel.value === 'ERROR' ? '仅 ERROR' : '全部级别';
  return `显示 ${shown}/${total} 行（${scope}，尾部 50 行）${sizeText}`;
});

/* ---------------- 工具 ---------------- */

const p2 = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

/** 只认数字，其余（null / undefined / 空串 / 字符串数字）一律归一成 number | null */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** MB → GB，一位小数。后端给的是整数 MB，这里只做展示精度，不参与计算 */
const mb2gb = (mb: number | null) => (mb == null ? '—' : (mb / 1024).toFixed(1));

/**
 * 后端 LocalDateTime 的两种序列化形态都要认：
 * 字符串 `'2026-10-28T15:40:01'`，或数组 `[2026,10,28,15,40,1]`（Jackson 关掉 ISO 时）。
 * 只认一种的话，另一种会在页面上变成 `2026,10,28,15,40,1` 这种看着像坏数据的字符串。
 */
function fmtServerTime(v: SystemStatusVo['serverTime']): string {
  if (v == null) return '—';
  if (Array.isArray(v)) {
    const [y, mo, d, h, mi, s] = v;
    return `${y}-${p2(Number(mo))}-${p2(Number(d))} ${p2(Number(h))}:${p2(Number(mi))}:${p2(Number(s ?? 0))}`;
  }
  // 后端实测返回 '2026-10-28T15:46:51.3273552'（带 7 位小数秒），页面上只到秒就够了
  return String(v).replace('T', ' ').replace(/\.\d+$/, '');
}

/* ---------------- 派生指标 ---------------- */

const jvm = computed(() => status.value?.jvm ?? {});

/** 已用堆 = total − free（后端没给 used，只能这么算；不是「物理内存占用」） */
const memUsedMB = computed(() => {
  const total = num(jvm.value.totalMemoryMB);
  const free = num(jvm.value.freeMemoryMB);
  return total == null || free == null ? null : Math.max(0, total - free);
});

/**
 * 堆占用率，口径 = used / total（**不是** used / max）。
 * 用 max 做分母的话，JVM 当前只申请了 4 GB 而 max 是 16 GB 时会显示 25% 以下，
 * 看起来「内存很闲」，实际堆已经快满了 —— 这是监控页最容易误导人的一个口径。
 */
const memPct = computed(() => {
  const used = memUsedMB.value;
  const total = num(jvm.value.totalMemoryMB);
  if (used == null || !total) return null;
  return Math.round((used / total) * 100);
});

/**
 * 堆内存的展示文案。总量 <1 GB 时必须用 MB：
 * 实测这台后端 total=398MB，按 GB 保留一位小数会变成「0.4 / 0.4 GB」——
 * 已用与总量显示成同一个数，等于什么都没显示。
 */
const memText = computed(() => {
  const used = memUsedMB.value;
  const total = num(jvm.value.totalMemoryMB);
  if (used == null || total == null) return 'JVM 数据缺失';
  return total >= 1024 ? `${mb2gb(used)} / ${mb2gb(total)} GB` : `${used} / ${total} MB`;
});

const onlineText = computed(() => {
  const n = num(status.value?.onlineUsers);
  if (n == null) return '在线账号数 —';
  // 后端约定 -1 = 取不到（Redis 不可达）。显示成「0 人」会把监控自己瞎掉说成系统很闲
  if (n < 0) return '在线账号数取不到（Redis 不可达）';
  return `全站在线账号 ${n} 人`;
});

const coreCount = computed(() => num(jvm.value.availableProcessors));

/** 进度条颜色阈值：≥80 红、≥60 黄、其余品牌色。与原型 colorOf 一致 */
function barColor(pct: number | null) {
  if (pct == null) return 'transparent';
  if (pct >= 80) return 'var(--error)';
  if (pct >= 60) return 'var(--warning)';
  return 'var(--brand-600)';
}

interface LoadRow {
  key: string;
  name: string;
  pct: number | null;
  text: string;
}

/**
 * 服务器负载 5 行。原型这 5 行全是模拟值。
 * 10-30 起内存 / CPU / 磁盘 / 数据库连接四行有真数据（新包字段 + 能力探测），网络出口仍无端点。
 * 「新包但值为 null」与「旧包没字段」必须显示成不同文案（前者是采样中/缺失，后者是真没有）。
 */
const loadRows = computed<LoadRow[]>(() => {
  // 显式提取为局部标量：比 `x && num(x.y)!` 的断言链可读，也避开 TS 在对象链上的收窄盲区
  const diskInfo = status.value?.disk ?? null;
  const diskTotal = num(diskInfo?.totalMB);
  const diskFree = num(diskInfo?.freeMB);
  const diskPct =
    diskTotal != null && diskFree != null && diskTotal > 0
      ? Math.round(((diskTotal - diskFree) / diskTotal) * 100)
      : null;
  const poolInfo = status.value?.pool ?? null;
  const poolActive = num(poolInfo?.active);
  const poolMax = num(poolInfo?.max);
  const poolWait = num(poolInfo?.waitCount);
  const poolPct =
    poolActive != null && poolMax != null && poolMax > 0
      ? Math.round((poolActive / poolMax) * 100)
      : null;
  const cpu = num(status.value?.cpu);
  return [
    {
      key: 'cpu',
      name: 'CPU',
      pct: cpu,
      text:
        cpu != null
          ? `${cpu}% · 全机口径`
          : hasNewFields.value
            ? '首次采样中…'
            : '— · 后端未提供'
    },
    {
      key: 'mem',
      name: '内存',
      pct: memPct.value,
      text: memPct.value == null ? '— · JVM 数据缺失' : `${memPct.value}% · ${memText.value}`
    },
    {
      key: 'disk',
      name: '磁盘',
      pct: diskPct,
      text:
        diskPct == null
          ? hasNewFields.value
            ? '— · 磁盘数据缺失'
            : '— · 后端未提供'
          : `${diskPct}% · 可用 ${fmtMb(diskFree)} / 共 ${fmtMb(diskTotal)}`
    },
    { key: 'net', name: '网络出口', pct: null, text: '— · 后端未提供（实训环境无此指标）' },
    {
      key: 'db',
      name: '数据库连接',
      pct: poolPct,
      text:
        poolPct == null
          ? '— · 无连接池指标'
          : `${poolActive} 活跃 / ${poolMax} 最大${poolWait != null && poolWait > 0 ? ` · ⚠ ${poolWait} 个请求排队等连接` : ''}`
    }
  ];
});

/** MB 展示：<1GB 用 MB（JVM 堆才几百 MB 的教训），≥1GB 用 GB 一位小数 */
function fmtMb(mb: number | null | undefined): string {
  const n = num(mb);
  if (n == null) return '—';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

/** 运行时长：毫秒 → 「X 天 X 小时 X 分」；不足一天只显示时分。旧包无此字段 ⇒ null */
const uptimeText = computed<string | null>(() => {
  const ms = num(status.value?.uptimeMs);
  if (ms == null) return null;
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
});

/* ---------------- 综合判定条（风险前置） ----------------
 * 行业惯例（运维监控页设计共识）：打开页面先读「有没有事」这一条，而不是扫 8 张卡找红点。
 * 判据与负载行的进度条颜色同一套阈值（≥80 预警），探针 down 属故障级、阈值越限属预警级，
 * 两级分开展示——把「Redis 挂了」和「CPU 偏高」混成一档会误导处置优先级。
 */

interface Verdict {
  level: 'ok' | 'warn' | 'err';
  text: string;
  items: string[];
}

const verdict = computed<Verdict>(() => {
  if (failed.value) {
    return { level: 'err', text: '状态接口读取失败', items: [failMsg.value || '网络或服务异常'] };
  }
  if (!status.value) {
    return { level: 'ok', text: '正在获取系统状态…', items: [] };
  }
  const errs: string[] = [];
  const warns: string[] = [];
  if (status.value.db?.status === 'down') errs.push('MySQL 不可达');
  if (status.value.redis?.status === 'down') errs.push('Redis 不可达');
  const cpu = num(status.value.cpu);
  if (cpu != null && cpu >= 80) warns.push(`CPU ${cpu}%（阈值 80%）`);
  if (memPct.value != null && memPct.value >= 80) warns.push(`堆内存 ${memPct.value}%（阈值 80%）`);
  const dt = num(status.value.disk?.totalMB);
  const df = num(status.value.disk?.freeMB);
  if (dt != null && df != null && dt > 0 && (df / dt) * 100 < 10) {
    warns.push(`磁盘剩余不足 10%（可用 ${fmtMb(df)}）`);
  }
  const wc = num(status.value.pool?.waitCount);
  if (wc != null && wc > 0) warns.push(`连接池 ${wc} 个请求排队等连接`);
  if (errs.length) return { level: 'err', text: `${errs.length} 项探针异常`, items: errs.concat(warns) };
  if (warns.length) return { level: 'warn', text: `${warns.length} 项越过预警阈值`, items: warns };
  const okBits: string[] = [];
  if (cpu != null) okBits.push(`CPU ${cpu}%`);
  if (memPct.value != null) okBits.push(`内存 ${memPct.value}%`);
  const online = num(status.value.onlineUsers);
  if (online != null && online >= 0) okBits.push(`在线 ${online}`);
  return { level: 'ok', text: okBits.length ? `各探针正常 · ${okBits.join(' · ')}` : '各探针正常', items: [] };
});

interface HealthCard {
  key: string;
  name: string;
  state: HealthState;
  sub: string;
}

function probeState(p: ProbeInfo | undefined): HealthState {
  if (!p) return 'unknown';
  if (p.status === 'up') return 'ok';
  if (p.status === 'down') return 'err';
  return 'unknown';
}

function probeSub(p: ProbeInfo | undefined, upSuffix = ''): string {
  if (!p) return '无探活数据';
  if (p.status === 'up') {
    const c = num(p.costMs);
    return c == null ? `正常${upSuffix}` : `${c} ms${upSuffix}`;
  }
  if (p.status === 'down') return '不可达';
  return '状态未知';
}

/**
 * 服务健康度卡。
 * 卡位来源：原型 6 卡（API 网关 / AI 服务 / MySQL / 文件存储 / 消息队列 / 直播投屏）
 * + 2026-10-30 业主批准新增的 **Redis** 卡（探活数据一直有——`status.redis` 与 db 同构，
 * 只因原型没画这卡位才一直显示不了；插在 MySQL 之后，同为「有真探活」的基础设施）。
 * 其中 AI 服务 / 文件存储 / 消息队列 / 直播投屏 4 项后端无探活端点 ⇒ unknown（灰点），
 * 不拿「正常」兜底。
 */
const healthCards = computed<HealthCard[]>(() => {
  const db = status.value?.db;
  const redis = status.value?.redis;
  return [
    {
      key: 'api',
      name: 'API 网关',
      // 「能把这个响应送到浏览器」本身就是 API 存活的正证，不需要额外端点
      state: status.value ? 'ok' : 'unknown',
      sub: status.value ? '本次请求成功' : '未取到'
    },
    { key: 'ai', name: 'AI 服务', state: 'unknown', sub: '无监控端点' },
    { key: 'db', name: 'MySQL', state: probeState(db), sub: probeSub(db) },
    {
      key: 'redis',
      name: 'Redis',
      state: probeState(redis),
      sub: probeSub(redis, ' · 读写探针')
    },
    { key: 'oss', name: '文件存储', state: 'unknown', sub: '无监控端点' },
    { key: 'mq', name: '消息队列', state: 'unknown', sub: '无监控端点' },
    { key: 'live', name: '直播/投屏', state: 'unknown', sub: '无监控端点' }
  ];
});

/**
 * 趋势图：后端没有历史序列接口，改用**前端本地采样**（每次 5s 轮询成功后压一个点，
 * 最多 30 个 = 近 150 秒）。这是「本页进入以来的真采样」，不是假历史——
 * 图上会标明采样口径，不会让人误以为是后端长期数据。
 */
const TREND_LEFT = 36;
const TREND_RIGHT = 470;
const TREND_BOTTOM = 130;
const TREND_TOP = 10;

/** pct(0~100) → SVG y 坐标 */
function trendY(pct: number): number {
  return TREND_BOTTOM - (Math.min(100, Math.max(0, pct)) / 100) * (TREND_BOTTOM - TREND_TOP);
}

/** 点 → SVG 坐标。不足 30 点时**右对齐**：最新点永远贴右缘，线从右侧向左生长 */
function toPolyline(key: 'cpu' | 'mem'): string | null {
  const pts = trendPoints.value.filter(p => p[key] != null) as TrendPoint[];
  if (pts.length < 2) return null;
  const offset = TREND_MAX - trendPoints.value.length;
  return pts
    .map(p => {
      const idx = offset + trendPoints.value.indexOf(p);
      const x = TREND_LEFT + (idx / (TREND_MAX - 1)) * (TREND_RIGHT - TREND_LEFT);
      return `${x.toFixed(1)},${trendY(p[key] as number).toFixed(1)}`;
    })
    .join(' ');
}

const cpuLine = computed(() => toPolyline('cpu'));
const memLine = computed(() => toPolyline('mem'));
const trendSampled = computed(() => trendPoints.value.length);

/* ---- 悬停读数：鼠标贴哪个采样点，就亮那条竖线并出数值框 ---- */

const hoverIdx = ref(-1);

/** 鼠标 → viewBox 坐标 → 缓冲区索引。viewBox 480 宽 ≠ 渲染宽度，必须按 rect 比例换算 */
function onTrendMove(e: MouseEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  const svgX = ((e.clientX - rect.left) / rect.width) * 480;
  const offset = TREND_MAX - trendPoints.value.length;
  const idx = Math.round(((svgX - TREND_LEFT) / (TREND_RIGHT - TREND_LEFT)) * (TREND_MAX - 1)) - offset;
  hoverIdx.value = idx >= 0 && idx < trendPoints.value.length ? idx : -1;
}

const hoverPoint = computed<TrendPoint | null>(() =>
  hoverIdx.value >= 0 ? trendPoints.value[hoverIdx.value] ?? null : null
);

/** 悬停点的 x 坐标（与折线同一套右对齐映射，竖线必须正好穿过点） */
const hoverX = computed(() => {
  if (hoverIdx.value < 0) return TREND_LEFT;
  const offset = TREND_MAX - trendPoints.value.length;
  return TREND_LEFT + ((offset + hoverIdx.value) / (TREND_MAX - 1)) * (TREND_RIGHT - TREND_LEFT);
});

/** 空轴说明：有采样了就报「采到几个点」，别再让人以为整页挂了 */
const trendHint = computed(() => {
  if (trendSampled.value === 0) return '暂无采样数据';
  return `本地采样中 · 已采 ${trendSampled.value}/${TREND_MAX} 点（每 5 秒 1 点，进页起算）`;
});
</script>

<template>
  <div v-loading="loading" class="monitor-page">
    <!-- 页头：标题 + 实时徽标 + 立即刷新（照原型 .page-head / .actions） -->
    <div class="page-head">
      <h1>系统状态监控</h1>
      <div class="actions">
        <span class="badge badge-success" title="自动刷新间隔 5 秒，后台标签页时暂停">
          <ZkIcon name="activity" :size="11" style="margin-right: 4px" />实时 · {{ refreshIn }}s 后刷新
        </span>
        <el-button @click="manualRefresh">
          <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />立即刷新
        </el-button>
      </div>
    </div>

    <!-- 综合判定条（风险前置）：打开页面先读这一条，不用扫全页找红点 -->
    <div class="card card-pad verdict mt16" :class="`verdict-${verdict.level}`">
      <div class="row gap-10">
        <span class="verdict-dot"></span>
        <div>
          <b class="small">{{ verdict.text }}</b>
          <div v-if="verdict.items.length" class="small muted mt4">{{ verdict.items.join('；') }}</div>
        </div>
      </div>
    </div>

    <!-- 数据源缺口：常驻，不是错误态。这块是本页「不假装成功」的证据 -->
    <div class="card card-pad gap-note">
      <div class="row gap-10">
        <div class="icon-box"><ZkIcon name="info" :size="16" /></div>
        <div>
          <div class="card-title gap-title">数据源缺口（本页不编数据）</div>
          <div class="small muted">
            数据源 <code>GET /api/v1/admin/system/status</code> 现返回九项：JVM 内存、核数、在线账号数、
            服务器时间、MySQL 探活、Redis 探活、<b>CPU 使用率、磁盘、连接池水位</b>，
            外加独立端点 <code>GET /api/v1/admin/system/error-logs</code>（ERROR 日志尾部）与
            运行时长（<code>uptimeMs</code>）。
            若当前看到「—」，说明后端还在跑 10-30 之前的旧包，换包后本页自动点亮，无需改前端。
          </div>
          <div class="small muted mt8">
            仍无数据源的三项，显示「—」而不是编一个数：<b>网络出口</b>（实训环境无此指标）、
            <b>服务可用率（近 7 天）</b>（需历史采样存储）、<b>当前课堂列表</b>（课堂数据在「课堂巡查」页，
            本页不重复接）。趋势图为<b>前端本地采样</b>（进页起每 5 秒 1 点），不是后端历史序列。
          </div>
        </div>
      </div>
    </div>

    <!-- 失败态：整页唯一数据源挂了，除了提示还要给重试入口 -->
    <div v-if="failed" class="card card-pad mt16">
      <div class="center">
        <div class="icon-box lg gap-icon"><ZkIcon name="alert-triangle" :size="26" /></div>
        <div class="card-title gap-title2">系统状态读取失败</div>
        <div class="small muted">{{ failMsg }}</div>
        <div v-if="status" class="small muted mt8">
          下方仍显示 {{ fetchedAt }} 取到的旧快照，请勿当成当前状态。
        </div>
        <el-button type="primary" class="mt12" @click="manualRefresh">重试</el-button>
      </div>
    </div>

    <!-- 空态：请求成功但没拿到任何字段（后端返回空对象 / null） -->
    <div v-else-if="!status" class="card card-pad mt16">
      <div class="center">
        <div class="icon-box lg gap-icon"><ZkIcon name="database" :size="26" /></div>
        <div class="card-title gap-title2">后端返回了空状态</div>
        <div class="small muted">响应里没有 jvm / db / redis 任何一个字段。</div>
        <div class="small muted mt8">可能是接口版本与页面契约不一致，可点「立即刷新」重试。</div>
      </div>
    </div>

    <template v-else>
      <!-- 核心指标 4 卡（.grid.g4 / .card.stat 均来自 theme.css） -->
      <div class="grid g4">
        <div class="card stat">
          <div class="label">当前上课课堂</div>
          <div class="num muted-num">—</div>
          <div class="trend">
            <span class="badge badge-neutral">无端点</span>
            <span>{{ onlineText }}</span>
          </div>
        </div>
        <div class="card stat">
          <div class="label">CPU 负载</div>
          <div class="num" :class="{ 'muted-num': num(status?.cpu) == null }">
            {{ num(status?.cpu) == null ? '—' : `${num(status?.cpu)}%` }}
          </div>
          <div class="trend">
            {{
              num(status?.cpu) != null
                ? `${coreCount == null ? '' : `${coreCount} 核 · `}全机口径，与上次轮询做差`
                : hasNewFields
                  ? '首次采样中…（5 秒后出值）'
                  : '后端未提供 CPU 指标'
            }}
          </div>
        </div>
        <div class="card stat">
          <div class="label">内存占用</div>
          <div class="num">{{ memPct == null ? '—' : `${memPct}%` }}</div>
          <div class="trend">
            {{ memPct == null ? 'JVM 数据缺失' : `${memText} · JVM 堆` }}
          </div>
        </div>
        <div class="card stat">
          <div class="label">今日异常</div>
          <div class="num muted-num">—</div>
          <div class="trend">后端未提供异常计数</div>
        </div>
      </div>

      <div class="grid mt16 split">
        <!-- 左：服务器负载 5 行 + 趋势图 -->
        <div class="card card-pad">
          <div class="between">
            <div class="card-title gap-title">服务器负载</div>
            <span class="small muted">采样间隔 5 秒</span>
          </div>

          <div class="mt12">
            <div v-for="r in loadRows" :key="r.key" class="load-row">
              <span class="nm">{{ r.name }}</span>
              <span class="bar">
                <!-- pct 为 null 时不画填充色：画一条 0% 的条会被读成「使用率为 0」 -->
                <i
                  v-if="r.pct !== null"
                  :style="{ width: `${r.pct}%`, background: barColor(r.pct) }"
                ></i>
              </span>
              <span class="pv">{{ r.text }}</span>
            </div>
          </div>

          <div class="card-title mt16 trend-title">CPU / 内存 负载趋势（近 30 个采样点）</div>
          <!--
            后端没有历史序列接口：趋势线来自前端本地采样（每次 5s 轮询成功压 1 点，
            进页起算，最多 30 点 ≈ 150 秒）。点数 <2 时画不出线，回落空轴 + 说明
            （空白看着像页面挂了）。
          -->
          <svg
            viewBox="0 0 480 170"
            class="trend-svg"
            role="img"
            :aria-label="trendHint"
            @mousemove="onTrendMove"
            @mouseleave="hoverIdx = -1"
          >
            <line x1="36" y1="10" x2="36" y2="130" stroke="#e3eaec" />
            <line x1="36" y1="130" x2="470" y2="130" stroke="#e3eaec" />
            <g stroke="#f1f5f6">
              <line x1="36" y1="100" x2="470" y2="100" />
              <line x1="36" y1="70" x2="470" y2="70" />
              <line x1="36" y1="40" x2="470" y2="40" />
            </g>
            <g class="svg-ax">
              <text x="8" y="34">75%</text>
              <text x="8" y="64">50%</text>
              <text x="8" y="94">25%</text>
              <text x="8" y="134">0</text>
            </g>
            <g class="svg-ax">
              <text x="36" y="146">-150s</text>
              <text x="230" y="146">-75s</text>
              <text x="440" y="146">现在</text>
            </g>
            <!-- 最新点永远贴右缘（toPolyline 右对齐），线随采样从右向左生长 -->
            <polyline v-if="cpuLine" :points="cpuLine" class="trend-line-cpu" fill="none" />
            <polyline v-if="memLine" :points="memLine" class="trend-line-mem" fill="none" />
            <!-- 悬停读数：竖线穿过采样点，数值框贴点右侧（靠右半区时翻到左侧防出画布） -->
            <template v-if="hoverPoint">
              <line :x1="hoverX" y1="10" :x2="hoverX" y2="130" class="tt-guide" />
              <circle :cx="hoverX" :cy="trendY(hoverPoint.mem)" r="3" class="tt-dot" />
              <g :transform="`translate(${hoverX > 330 ? hoverX - 128 : hoverX + 10}, 18)`">
                <rect width="118" height="48" rx="4" class="tt-box" />
                <text class="tt-t" x="8" y="15">{{ hoverPoint.t }}</text>
                <text class="tt-v" x="8" y="30">
                  CPU {{ hoverPoint.cpu == null ? '采样中' : `${hoverPoint.cpu}%` }}
                </text>
                <text class="tt-v" x="8" y="42">内存 {{ hoverPoint.mem }}%</text>
              </g>
            </template>
            <template v-if="!cpuLine && !memLine">
              <text class="svg-empty" x="253" y="74" text-anchor="middle">{{ trendHint }}</text>
              <text class="svg-empty-sub" x="253" y="92" text-anchor="middle">
                前端本地采样，进页后每 5 秒累积 1 点
              </text>
            </template>
          </svg>
          <div class="row small muted legend">
            <span class="row gap-6"><i class="lg-cpu"></i>CPU</span>
            <span class="row gap-6"><i class="lg-mem"></i>内存</span>
          </div>
        </div>

        <!-- 右：服务健康度 + 当前课堂 -->
        <div class="stack">
          <div class="card card-pad">
            <div class="card-title">服务健康度</div>
            <div class="grid g2 health-grid">
              <div v-for="c in healthCards" :key="c.key" class="svc" :class="c.state">
                <span class="dot"></span>
                <div class="svc-body">
                  <b class="small">{{ c.name }}</b>
                  <div class="small muted">{{ c.sub }}</div>
                </div>
              </div>
            </div>
            <div class="hair"></div>
            <div class="pf-row"><span class="k">服务可用率（近 7 天）</span><b class="small">—</b></div>
            <div class="pf-row last">
              <span class="k">运行时长</span>
              <b class="small">
                {{ uptimeText ?? (hasNewFields ? '数据缺失' : '—') }}
              </b>
            </div>
            <div class="small muted mt8">
              可用率后端无端点，未编造；运行时长来自 <code>uptimeMs</code>（JVM 自启动起）。
            </div>
          </div>

          <div class="card">
            <div class="card-pad between head-tight">
              <div class="card-title">当前上课课堂（实时）</div>
              <span class="badge badge-neutral">无端点</span>
            </div>
            <!-- 不用 el-empty：本仓从没引入过它的默认插图，实测渲染成一个灰块 -->
            <div class="center empty-box">
              <div class="icon-box lg gap-icon"><ZkIcon name="list-checks" :size="24" /></div>
              <div class="small muted">
                <code>GET /api/v1/admin/system/status</code> 不含课堂列表，本区块无数据源。
              </div>
              <div class="small muted mt8">
                课堂数据在「课堂巡查」页（<code>/api/v1/admin/sessions</code>），本页不重复接。
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 异常日志：控件保留原型形态，但筛选结果恒为空并写明原因 -->
      <div class="card mt16">
        <div class="card-pad between head-tight">
          <div class="card-title">异常日志查看（ERROR 级别）</div>
          <span class="row gap-8">
            <el-select v-model="logLevel" size="small" style="width: 150px">
              <el-option label="只看 ERROR" value="ERROR" />
              <el-option label="全部级别" value="ALL" />
            </el-select>
            <el-button size="small" @click="manualRefresh">
              <ZkIcon name="refresh-cw" :size="13" style="margin-right: 4px" />刷新
            </el-button>
          </span>
        </div>
        <div class="log-wrap">
          <!-- 旧包探测：端点不存在 ⇒ 保留原缺口说明（与换包前完全一致） -->
          <div v-if="errSupported === false" class="err-log">
            <div>
              <span class="ts">--:--:--</span>
              <span class="lv">[GAP]</span>
              <b>monitor</b>
              — 当前运行的后端包未包含 ERROR 日志端点（10-30 补丁），本区块无数据。操作/登录日志在
              「系统日志」页（<code>GET /api/v1/admin/logs</code>），但那不是 ERROR 级别日志，不在此处冒充。
            </div>
          </div>
          <!-- 端点存在但后端读文件失败：把后端给的中文原因原样亮出来 -->
          <div v-else-if="errLogs?.error" class="err-log">
            <div>
              <span class="ts">{{ clock(new Date()) }}</span>
              <span class="lv">[GAP]</span>
              <b>monitor</b>
              — 端点可达但读日志失败：{{ errLogs.error }}
            </div>
          </div>
          <!-- 正常态：逐行渲染（默认只看 ERROR，可切「全部级别」看上下文） -->
          <div v-else-if="errLinesShown.length" class="err-log">
            <div v-for="(line, i) in errLinesShown" :key="i" :class="{ 'err-line-hot': isErrLine(line) }">
              {{ line }}
            </div>
          </div>
          <!-- 端点存在但当前筛选下没有行：说清是「筛后为空」还是「文件里本来就没有」，不留歧义 -->
          <div v-else class="err-log">
            <div>
              <span class="ts">{{ clock(new Date()) }}</span>
              <span class="lv lv-ok">[OK]</span>
              <b>monitor</b>
              — {{ errSupported === null
                ? '正在探测 ERROR 日志端点…'
                : logLevel === 'ERROR'
                  ? `尾部 ${errLogs?.lines?.length ?? 0} 行中没有 ERROR 行（可切「全部级别」查看）`
                  : '日志文件近 256KB 内没有内容' }}
            </div>
          </div>
          <div class="small muted mt8">
            {{ errFootText }}；服务器时间 {{ fmtServerTime(status.serverTime) }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * 原型 admin-monitor.html 第 8-25 行有一段**页内**样式（.gauge / .load-row / .svc / .err-log），
 * 它们不在 theme.css 里（已实测：theme.css 中 load-row / svc / err-log / divider 命中数为 0），
 * 所以必须搬进本页 scoped style，否则这几个块会失去全部外观。
 * 颜色一律走 theme.css 的变量（--brand-600 / --success / --warning / --error / --border / --bg-soft /
 * --success-soft / --warning-soft / --error-soft / --ink-300 / --ink-400），不写字面色——
 * 写死的话，以后改主题色这页会变成唯一不跟着变的一页。
 */
.monitor-page {
  padding-bottom: 8px;
}

.row {
  display: flex;
  align-items: center;
}
.gap-10 {
  gap: 10px;
}
.gap-8 {
  gap: 8px;
}
.gap-6 {
  gap: 6px;
}

/* 缺口说明条：左侧一根提示色竖条，避免和右侧真数据卡片混淆 */
.gap-note {
  border-left: 3px solid var(--warning);
}
.gap-title {
  margin: 0 0 4px;
}
.gap-title2 {
  margin-bottom: 6px;
}
.gap-icon {
  margin: 0 auto 12px;
}
.gap-note code,
.empty-box code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--brand-50);
  padding: 1px 4px;
  border-radius: 3px;
}
/* 深色日志块里的 code 不能沿用上面那套浅底：父级文字是 #e2e8f0，浅底浅字等于看不见 */
.err-log code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: rgba(255, 255, 255, 0.12);
  color: #e2e8f0;
  padding: 1px 4px;
  border-radius: 3px;
}

.center {
  text-align: center;
  padding: 26px 0;
}
/* 无数据源区块：给足上下留白，避免它在卡片里像「加载失败」 */
.empty-box {
  padding: 26px 20px 22px;
}

/* 「—」占位数字不要和真数字一样重，否则第一眼读成 0 以外的实数 */
.muted-num {
  color: var(--ink-500);
}

.split {
  grid-template-columns: 1.25fr 1fr;
}

/* ---- 服务器负载行（原型 .load-row）---- */
.load-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px dashed var(--border);
}
.load-row:last-child {
  border-bottom: 0;
}
.load-row .nm {
  width: 96px;
  flex: none;
  font-size: 13px;
  font-weight: 600;
}
.load-row .bar {
  flex: 1;
  height: 10px;
  border-radius: 5px;
  background: var(--bg-soft);
  overflow: hidden;
}
.load-row .bar i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s;
}
.load-row .pv {
  width: 168px;
  flex: none;
  text-align: right;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

/* ---- 趋势图 ---- */
.trend-title {
  margin-bottom: 6px;
}
.trend-svg {
  width: 100%;
  height: auto;
}
/* 坑 #7：UnoCSS 的 presetAttributify 会把 font-size="10" 当工具类并生成 2.5rem，
   所以 SVG 里的字号一律用 class 控制，不写 font-size 属性 */
.svg-ax {
  font-size: 10px;
  fill: var(--ink-400);
}
.svg-empty {
  font-size: 12px;
  fill: var(--ink-500);
}
.svg-empty-sub {
  font-size: 10px;
  fill: var(--ink-400);
}
.legend {
  gap: 16px;
  margin-top: 4px;
}
.legend i {
  width: 14px;
  height: 3px;
  display: inline-block;
}
.lg-cpu {
  background: var(--brand-600);
}
.lg-mem {
  background: var(--warning);
}
/* 折线颜色与图例一一对应——图例换了色这线不同步就是误导 */
.trend-line-cpu {
  stroke: var(--brand-600);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.trend-line-mem {
  stroke: var(--warning);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* ---- 综合判定条：左竖条 + 圆点用同一色，绿/黄/红三档 ---- */
.verdict {
  border-left: 3px solid var(--success);
}
.verdict-warn {
  border-left-color: var(--warning);
}
.verdict-err {
  border-left-color: var(--error);
}
.verdict-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.verdict-warn .verdict-dot {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-soft);
}
.verdict-err .verdict-dot {
  background: var(--error);
  box-shadow: 0 0 0 3px var(--error-soft);
}

/* ---- 趋势图悬停读数 ---- */
.tt-guide {
  stroke: var(--ink-300);
  stroke-dasharray: 3 3;
}
.tt-dot {
  fill: var(--brand-600);
  stroke: #fff;
  stroke-width: 1.5;
}
.tt-box {
  fill: var(--ink-900);
  fill-opacity: 0.92;
}
.tt-t {
  font-size: 10px;
  fill: #94a3b8;
}
.tt-v {
  font-size: 11px;
  fill: #e2e8f0;
  font-variant-numeric: tabular-nums;
}

/* ---- 服务健康度卡（原型 .svc）---- */
.health-grid {
  gap: 10px;
}
.svc {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
}
.svc-body {
  flex: 1;
  min-width: 0;
}
.svc .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
.svc.ok .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.svc.warn .dot {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-soft);
}
.svc.err .dot {
  background: var(--error);
  box-shadow: 0 0 0 3px var(--error-soft);
}
/* 新增第四态：无监控端点。原型只有 ok/warn/err 三态，没有「不知道」这一档，
   缺了它就只能把未知画成「正常」，那正好是本页最不能犯的错 */
.svc.unknown .dot {
  background: var(--ink-300);
  box-shadow: 0 0 0 3px var(--bg-soft);
}

/* theme.css 里没有 .divider，用一条发丝线替代 */
.hair {
  height: 1px;
  background: var(--border);
  margin: 12px 0;
}
.pf-row.last {
  border-bottom: 0;
}

.head-tight {
  padding-bottom: 0;
}

/* ---- 异常日志（原型 .err-log）---- */
.log-wrap {
  padding: 12px 18px 18px;
}
.err-log {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  background: var(--ink-900);
  color: #e2e8f0;
  border-radius: 10px;
  padding: 14px 16px;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
}
.err-log .lv {
  color: #f87171;
  font-weight: 700;
}
/* 探测中 / 无 ERROR 行时的绿色徽标——深色底上的「没有错误」用绿，不用和 GAP 同色的红 */
.err-log .lv-ok {
  color: #4ade80;
}
/* 真 ERROR 行整行加亮：扫一眼能定位到最近一次出错的位置 */
.err-line-hot {
  color: #fca5a5;
}
.err-log .ts {
  color: #94a3b8;
}

/* 窄视口（≤1280）下两栏并排会把负载条压到文字折行，改单列 */
@media (max-width: 1280px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
