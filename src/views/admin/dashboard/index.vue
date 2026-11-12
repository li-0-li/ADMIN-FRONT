<script setup lang="ts">
/**
 * 后台管理（首页）/admin/dashboard
 * -----------------------------------------------------------------------------
 * ★ 2026-11-12 优化（业主「优化一下后台管理页面」）：
 *  1. **删掉两列假数据**：「教师」「学生数」在 `/admin/courses` 响应里**根本不存在**
 *     （真实字段只有 major/courseType/offeringCount/scheduleCount/credit/hours），
 *     原来渲染出的「—」与「0」不是"没数据"，而是字段不存在——`0` 尤其危险，看着像真值。
 *     ⇒ 换成后端真有的四列：专业 / 类型 / 开课 / 排课。
 *  2. 统计卡补图标（`STATS[].icon` 早就定义了，模板一直没渲染，属半成品）+ 落地链接 + 骨架态。
 *  3. 快捷入口 7 个竖排按钮 → 2 列图标网格，右栏高度砍半。
 *  4. 新增系统状态迷你条（复用 `/api/v1/admin/system/status`），让首页反映真实运行态。
 *     ⚠ 权限 `admin:monitor:status` 缺失时**完全不发请求、整条不渲染**（非超管看不到监控数据，
 *       而不是看到一条 403 报错）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { getDashboardSummary, listCourses } from '@/api/admin/dashboard';
import { getSystemStatus } from '@/api/admin/monitor';
import type { DashboardSummary } from '@/types/admin';
import type { SystemStatusVo } from '@/views/admin/monitor/types';
import { ADMIN_MENUS } from '@/config/menu';
import { useUserStore } from '@/store/user';

const router = useRouter();
const userStore = useUserStore();

const summary = ref<DashboardSummary | null>(null);
const courses = ref<Record<string, unknown>[]>([]);
const loading = ref(true);

/* ---------------- 系统状态迷你条 ---------------- */

const sys = ref<SystemStatusVo | null>(null);
const sysLoaded = ref(false);
/** 权限到位才请求：非超管没有 admin:monitor:status，发了也是 403，白白在控制台留一条红 */
const canSeeSys = computed(() => userStore.hasPermi('admin:monitor:status'));

/** CPU：旧包没这个字段（undefined）→「—」；新包首采是 null →「采样中」；两者语义不同不能合并 */
const cpuText = computed(() => {
  const v = sys.value?.cpu;
  if (v === undefined) return '—';
  if (v === null) return '采样中';
  return `${v.toFixed(1)}%`;
});

/** 在线用户：`-1` 是「Redis 取不到」，不是 0 人在线 */
const onlineText = computed(() => {
  const n = sys.value?.onlineUsers;
  if (n === undefined || n === null) return '—';
  if (n < 0) return '不可达';
  return String(n);
});

/** 磁盘使用率：后端只给 totalMB/freeMB，百分比是展示层换算 */
const diskText = computed(() => {
  const d = sys.value?.disk;
  if (!d || !d.totalMB) return '—';
  const usedPct = Math.round(((d.totalMB - (d.freeMB ?? 0)) / d.totalMB) * 100);
  const freeGB = (d.freeMB ?? 0) / 1024;
  return `${usedPct}%（剩 ${freeGB.toFixed(0)}G）`;
});

function fmtUptime(ms?: number) {
  if (!ms || ms <= 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

const sysCells = computed(() => [
  { key: 'online', icon: 'users', label: '在线用户', value: onlineText.value },
  { key: 'cpu', icon: 'activity', label: 'CPU', value: cpuText.value },
  { key: 'disk', icon: 'database', label: '磁盘', value: diskText.value },
  { key: 'uptime', icon: 'clock', label: '运行时长', value: fmtUptime(sys.value?.uptimeMs) }
]);

/* ---------------- 统计卡 ---------------- */

/**
 * 快捷入口：取菜单里的 7 项。
 * ★ 2026-11-09 会议 #22 摘掉 AI 工作台后由 9 → 8 项
 * ★ 2026-11-10 P-3 摘掉「课程审核」页（并入课程总览抽屉）后 8 → 7 项
 */
const SHORTCUT_PATHS = [
  '/admin/accounts',
  '/admin/analytics',
  '/admin/patrol',
  '/admin/basicdata',
  '/admin/monitor',
  '/admin/logs',
  '/admin/config'
];
const shortcuts = ADMIN_MENUS.filter(m => SHORTCUT_PATHS.includes(m.path));

/** 每张卡都落到一个真实页面——点了有反应，比写一句猜来的「环比 +12%」诚实 */
const STATS = [
  { key: 'totalCourses', label: '总课程', icon: 'database', to: '/admin/courses', hint: '课程总览' },
  { key: 'activeStudents', label: '在教学生', icon: 'users', to: '/admin/students', hint: '学生管理' },
  { key: 'teacherCount', label: '教师数', icon: 'presentation', to: '/admin/teachers', hint: '教师管理' },
  { key: 'pendingHomework', label: '待批改作业', icon: 'list-checks', to: '/admin/analytics', hint: '全校学情' }
] as const;

function statValue(key: string) {
  const v = summary.value?.[key as keyof DashboardSummary];
  if (v === undefined || v === null) return '—';
  return typeof v === 'number' ? v.toLocaleString('zh-CN') : String(v);
}

/** 课程状态枚举 → 中文（实测后端取值：active / archived / certifying） */
const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'badge-info' },
  certifying: { label: '认证中', cls: 'badge-warning' },
  archived: { label: '已归档', cls: 'badge-neutral' },
  pending: { label: '待发布', cls: 'badge-neutral' },
  closed: { label: '已结课', cls: 'badge-neutral' },
  draft: { label: '草稿', cls: 'badge-neutral' }
};

function statusOf(row: Record<string, unknown>) {
  const key = String(row.status ?? '');
  return STATUS_TEXT[key] ?? { label: key || '—', cls: 'badge-neutral' };
}

/** 课程类型（实测：required / elective），未登记的原样透出，不猜 */
const TYPE_TEXT: Record<string, string> = {
  required: '必修',
  elective: '选修',
  public: '公共',
  optional: '任选'
};
function typeOf(row: Record<string, unknown>) {
  const k = String(row.courseType ?? '');
  return TYPE_TEXT[k] ?? (k || '—');
}

/** 排课节数：0 要显式写「未排课」，不能显示成「0 节」——后者像排过但为空 */
function scheduleOf(row: Record<string, unknown>) {
  const n = Number(row.scheduleCount ?? 0);
  return n > 0 ? `${n} 节` : '未排课';
}

onMounted(async () => {
  // ★ 三个请求**各自兜底**，绝不用 Promise.all 绑死 —— 此前 courses 打死路径把 summary
  //   连坐成整个 Promise.all reject ⇒ 四张统计卡全「—」+ 每次登录控制台报错。
  try {
    summary.value = await getDashboardSummary();
  } catch {
    /* 已在请求层提示，卡片保持「—」 */
  }
  try {
    const c = await listCourses({ page: 1, pageSize: 5 });
    courses.value = c?.list ?? [];
  } catch {
    courses.value = [];
  }
  loading.value = false;

  // 状态条单独走，失败就当没有（首页不该因为监控挂了而报错）
  if (canSeeSys.value) {
    try {
      const s = await getSystemStatus();
      sys.value = s && typeof s === 'object' && Object.keys(s).length > 0 ? s : null;
    } catch {
      sys.value = null;
    }
    sysLoaded.value = true;
  }
});
</script>

<template>
  <div class="page-head">
    <h1>后台管理</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="router.push('/admin/schedule')">
        <ZkIcon name="calendar-days" :size="16" />智能排课
      </a>
    </div>
  </div>

  <!-- 系统状态迷你条：权限不足 / 取数失败都不渲染，不留半截空壳 -->
  <div v-if="sysLoaded && sys" class="card sysbar">
    <div v-for="c in sysCells" :key="c.key" class="sys-cell">
      <span class="sys-ico"><ZkIcon :name="c.icon" :size="14" /></span>
      <span class="k">{{ c.label }}</span>
      <span class="v">{{ c.value }}</span>
    </div>
    <a class="tbl-link sys-more" href="javascript:void(0)" @click="router.push('/admin/monitor')">
      查看监控<ZkIcon name="chevron-right" :size="13" />
    </a>
  </div>

  <div class="grid g4">
    <div
      v-for="s in STATS"
      :key="s.key"
      class="card stat stat-card"
      role="link"
      tabindex="0"
      @click="router.push(s.to)"
      @keydown.enter="router.push(s.to)"
    >
      <span class="stat-icon"><ZkIcon :name="s.icon" :size="17" /></span>
      <div class="label">{{ s.label }}</div>
      <div class="num">
        <span v-if="loading" class="sk" />
        <span v-else>{{ statValue(s.key) }}</span>
      </div>
      <div class="hint">进入{{ s.hint }}<ZkIcon name="chevron-right" :size="12" /></div>
    </div>
  </div>

  <div class="grid mt16 dash-main">
    <div class="card">
      <div class="card-pad between" style="padding-bottom: 0">
        <div class="card-title">最近课程</div>
        <a class="tbl-link" href="javascript:void(0)" @click="router.push('/admin/courses')">全部课程</a>
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>课程</th>
            <th>专业</th>
            <th>类型</th>
            <th>开课</th>
            <th>排课</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="7" class="muted">加载中…</td></tr>
          <tr v-else-if="courses.length === 0">
            <td colspan="7" class="muted">没有课程数据</td>
          </tr>
          <template v-else>
            <tr v-for="c in courses" :key="String(c.courseId)">
              <td class="cell-name" :title="String(c.courseName ?? '')">{{ c.courseName ?? '—' }}</td>
              <td class="muted">{{ c.major ?? '—' }}</td>
              <td>{{ typeOf(c) }}</td>
              <td>{{ c.offeringCount ?? 0 }}</td>
              <td :class="{ muted: Number(c.scheduleCount ?? 0) === 0 }">{{ scheduleOf(c) }}</td>
              <td><span class="badge" :class="statusOf(c).cls">{{ statusOf(c).label }}</span></td>
              <td>
                <span class="link" @click="router.push('/admin/courses')">查看</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="card card-pad">
      <div class="card-title">快捷入口</div>
      <div class="sc-grid">
        <a
          v-for="m in shortcuts"
          :key="m.path"
          class="sc-item"
          href="javascript:void(0)"
          @click="router.push(m.path)"
        >
          <span class="sc-ico"><ZkIcon :name="m.icon" :size="17" /></span>
          <span class="sc-text">{{ m.title }}</span>
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 主区两栏：宽屏 2.4:1；窄于 1280 收成单栏（IDE 预览面板 / 分屏下表格不再被挤扁） */
.dash-main {
  grid-template-columns: 2.4fr 1fr;
}
@media (max-width: 1280px) {
  .dash-main {
    grid-template-columns: 1fr;
  }
}

/* 统计卡：图标徽标 + 可点 + hover 反馈（背景/文字色全部用主题变量，跟随主题不写死） */
.stat-card {
  position: relative;
  cursor: pointer;
  transition: border-color 0.16s, box-shadow 0.16s, transform 0.16s;
}
.stat-card:hover,
.stat-card:focus-visible {
  border-color: var(--brand-400);
  box-shadow: var(--sh-2);
  outline: none;
}
.stat-icon {
  position: absolute;
  top: 15px;
  right: 15px;
  width: 34px;
  height: 34px;
  border-radius: var(--r-md);
  display: grid;
  place-items: center;
  background: var(--brand-50);
  color: var(--brand-600);
}
.stat-card .hint {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--ink-400);
}
.stat-card:hover .hint {
  color: var(--brand-600);
}

/* 数字骨架：加载时占位，避免「…」让卡片高度跳动 */
.sk {
  display: inline-block;
  width: 64px;
  height: 26px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-subtle), var(--border), var(--bg-subtle));
  background-size: 200% 100%;
  animation: sk 1.1s ease-in-out infinite;
}
@keyframes sk {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* 系统状态条（与下方 g4 网格的 gap 18px 对齐，项目里没有 mb* 工具类） */
.sysbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  padding: 10px 18px;
  margin-bottom: 18px;
}
.sys-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 20px;
  margin-right: 20px;
  border-right: 1px solid var(--border);
}
.sys-cell .k {
  font-size: 12px;
  color: var(--ink-500);
}
.sys-cell .v {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-900);
}
.sys-ico {
  display: grid;
  place-items: center;
  color: var(--brand-600);
}
.sys-more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

/* 表格内操作链接（.tbl .link 是全局样式，页头标题旁那个链接用同一套观感） */
.tbl-link {
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.tbl-link:hover {
  color: var(--primary-hover);
}
.cell-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 快捷入口：2 列图标网格，比 7 个通栏按钮省一半高度 */
.sc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}
.sc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--ink-700);
  font-size: 13px;
  transition: border-color 0.16s, background 0.16s, color 0.16s;
}
.sc-item:hover {
  border-color: var(--brand-400);
  background: var(--brand-50);
  color: var(--brand-700);
}
/* 7 个入口在 2 列网格里会剩一格空位 —— 让奇数末项横跨两列补平，避免右侧豁口 */
.sc-grid > .sc-item:last-child:nth-child(odd) {
  grid-column: span 2;
}
.sc-ico {
  display: grid;
  place-items: center;
  color: var(--brand-600);
  flex: none;
}
.sc-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
