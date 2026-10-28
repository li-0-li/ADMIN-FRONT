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
import { getSystemStatus } from '@/api/admin/monitor';
import type { HealthState, ProbeInfo, SystemStatusVo } from './types';

/* ---------------- 状态 ---------------- */

/** 首次加载 / 手动刷新时给整页遮罩；5 秒自动刷新**不**给，否则每 5 秒闪一次白，见下方 startAuto */
const loading = ref(false);
const failed = ref(false);
const failMsg = ref('');
/** 后端快照。失败时**故意保留**上一次成功的那份，见 catch 注释 */
const status = ref<SystemStatusVo | null>(null);
/** 最近一次成功取数的本地时刻，用来让「数据是旧的」这件事可见 */
const fetchedAt = ref('');

/** 异常日志级别筛选。后端无日志端点，筛选结果恒为空，但控件保留原型形态 */
const logLevel = ref<'ERROR' | 'ALL'>('ERROR');

/** 自动刷新间隔，与原型「实时 · 5s 刷新」一致 */
const AUTO_MS = 5000;

let timer: number | undefined;
/** 防重入：5s 定时器和人手点「立即刷新」会撞车，撞上就复用正在飞的那次请求 */
let inFlight = false;

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

function manualRefresh() {
  fetchStatus();
}

/** 起自动刷新。切页时必须停掉，否则组件已卸载、定时器还在往后台发请求 */
function startAuto() {
  stopAuto();
  timer = window.setInterval(() => {
    // 标签页在后台时跳过：监控页挂在后台还每 5 秒打一次 SELECT 1 + Redis 探针，纯属白烧
    if (document.hidden) return;
    fetchStatus(true);
  }, AUTO_MS);
}

function stopAuto() {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

onMounted(() => {
  fetchStatus();
  startAuto();
});

onBeforeUnmount(() => {
  stopAuto();
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
 * 服务器负载 5 行。原型这 5 行全是模拟值；这里只有「内存」能从 jvm 算出来，
 * 其余 4 行后端无端点 ⇒ pct=null（不画进度）+ 文字写清为什么没有。
 */
const loadRows = computed<LoadRow[]>(() => [
  { key: 'cpu', name: 'CPU', pct: null, text: '— · 后端未提供' },
  {
    key: 'mem',
    name: '内存',
    pct: memPct.value,
    text: memPct.value == null ? '— · JVM 数据缺失' : `${memPct.value}% · ${memText.value}`
  },
  { key: 'disk', name: '磁盘', pct: null, text: '— · 后端未提供' },
  { key: 'net', name: '网络出口', pct: null, text: '— · 后端未提供' },
  { key: 'db', name: '数据库连接', pct: null, text: '— · 无连接池指标' }
]);

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
 * 服务健康度 6 卡，**卡位与原型逐一对齐**（API 网关 / AI 服务 / MySQL / 文件存储 / 消息队列 / 直播投屏）。
 * 其中 3 项后端无探活端点 ⇒ unknown（灰点 + 「无监控端点」），不拿「正常」兜底。
 */
const healthCards = computed<HealthCard[]>(() => {
  const db = status.value?.db;
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
    { key: 'oss', name: '文件存储', state: 'unknown', sub: '无监控端点' },
    { key: 'mq', name: '消息队列', state: 'unknown', sub: '无监控端点' },
    { key: 'live', name: '直播/投屏', state: 'unknown', sub: '无监控端点' }
  ];
});

/** 趋势图没有第二个采样点，图里那句说明就要带上当前值，否则人以为整页都挂了 */
const trendHint = computed(() =>
  memPct.value == null ? '暂无历史采样数据' : `暂无历史采样数据（当前堆内存 ${memPct.value}%）`
);
</script>

<template>
  <div v-loading="loading" class="monitor-page">
    <!-- 页头：标题 + 实时徽标 + 立即刷新（照原型 .page-head / .actions） -->
    <div class="page-head">
      <h1>系统状态监控</h1>
      <div class="actions">
        <span class="badge badge-success">
          <ZkIcon name="activity" :size="11" style="margin-right: 4px" />实时 · 5s 刷新
        </span>
        <el-button @click="manualRefresh">
          <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />立即刷新
        </el-button>
      </div>
    </div>

    <!-- 数据源缺口：常驻，不是错误态。这块是本页「不假装成功」的证据 -->
    <div class="card card-pad gap-note">
      <div class="row gap-10">
        <div class="icon-box"><ZkIcon name="info" :size="16" /></div>
        <div>
          <div class="card-title gap-title">数据源缺口（本页不编数据）</div>
          <div class="small muted">
            唯一数据源 <code>GET /api/v1/admin/system/status</code> 只返回 JVM 内存、在线账号数、服务器时间、
            MySQL 探活、Redis 探活五项。以下项目<b>后端没有任何端点</b>，页面上显示「—」而不是编一个数：
            CPU 使用率 / 磁盘 / 网络出口 / 连接池占用 / 服务可用率 / 运行时长 / 当前课堂列表 / ERROR 日志。
          </div>
          <div class="small muted mt8">
            Redis 探活其实有值，但原型的 6 个服务卡里没有 Redis 卡位，为不偏离设计稿，这里不额外插卡。
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
          <div class="num muted-num">—</div>
          <div class="trend">
            {{ coreCount == null ? '后端未提供 CPU 指标' : `${coreCount} 核 · 使用率后端未提供` }}
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
            后端只返回「当前一次」采样，没有历史序列，画不出折线。
            按启动包 §五.11：数据为空也要画轴 + 一句说明，不能留一片空白（空白看着像页面挂了）。
          -->
          <svg viewBox="0 0 480 170" class="trend-svg" role="img" :aria-label="trendHint">
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
            <text class="svg-empty" x="253" y="74" text-anchor="middle">{{ trendHint }}</text>
            <text class="svg-empty-sub" x="253" y="92" text-anchor="middle">
              后端只返回当前一次采样，无历史序列接口
            </text>
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
            <div class="pf-row last"><span class="k">运行时长</span><b class="small">—</b></div>
            <div class="small muted mt8">这两项后端无端点，未编造。</div>
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
            <el-select v-model="logLevel" size="small" style="width: 140px" disabled>
              <el-option label="ERROR" value="ERROR" />
              <el-option label="ERROR + WARN" value="ALL" />
            </el-select>
            <el-button size="small" @click="manualRefresh">
              <ZkIcon name="refresh-cw" :size="13" style="margin-right: 4px" />刷新
            </el-button>
          </span>
        </div>
        <div class="log-wrap">
          <div class="err-log">
            <div>
              <span class="ts">--:--:--</span>
              <span class="lv">[GAP]</span>
              <b>monitor</b>
              — 后端未提供 ERROR 级别日志查询端点，本区块无数据。操作/登录日志在「系统日志」页
              （<code>GET /api/v1/admin/logs</code>），但那不是 ERROR 级别日志，不在此处冒充。
            </div>
          </div>
          <div class="small muted mt8">
            共 0 条 {{ logLevel }} 级别日志 · 未接入；服务器时间 {{ fmtServerTime(status.serverTime) }}
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
