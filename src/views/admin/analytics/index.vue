<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { exportReport, getSchoolAnalytics, handleAlert } from '@/api/admin/analytics';
import { listMajors, listTerms } from '@/api/admin/basicdata';
import { listCourses } from '@/api/admin/dashboard';
import type {
  AnalyticsPrepDetail,
  ReportFileVo,
  SchoolAnalyticsVo
} from '@/types/admin';

/**
 * 全校学情统计看板（原型 ui-prototype/pc/admin-analytics.html）。
 * 数据 = 后端一次聚合 GET /api/v1/admin/analytics/school（termId / major / courseId / deptId / alertStatus 过滤）。
 * 筛选 = 学期/院系/专业/课程四维（termId 后端翻译成学期编码真正参与过滤）；
 * 迭代 2026-10-20：教师教学排行 / 课程及格率倒数 TOP / 分数段分布 / 学期环比 / 预警闭环。
 */
const loading = ref(true);
const exporting = ref(false);
const data = ref<SchoolAnalyticsVo | null>(null);

/* ---------- 筛选：学期 / 院系 / 专业 / 课程（院系 = 任课教师所属部门，后端 deptId 过滤） ---------- */
const terms = ref<{ termId: number; name: string }[]>([]);
const depts = ref<{ deptId: number; name: string }[]>([]);
const majors = ref<string[]>([]);
const courses = ref<{ courseId: number; name: string }[]>([]);
const filters = reactive({ termId: '', deptId: '', major: '', courseId: '' });
/** 预警名单状态：open 待处理 / closed 已处理（闭环切换） */
const alertStatus = ref<'open' | 'closed'>('open');

const dimBadge = computed(() => {
  const t = terms.value.find(o => String(o.termId) === filters.termId)?.name ?? '全部学期';
  const d = depts.value.find(o => String(o.deptId) === filters.deptId)?.name ?? '全部院系';
  const m = majors.value.find(x => x === filters.major) ?? '全部专业';
  const c = courses.value.find(o => String(o.courseId) === filters.courseId)?.name ?? '全部课程';
  return `${t} · ${d} · ${m} · ${c}`;
});

async function loadPickers() {
  try {
    const [tRes, mRes, cRes] = await Promise.all([
      listTerms({ page: 1, pageSize: 50 }),
      listMajors({ page: 1, pageSize: 100 }),
      listCourses({ page: 1, pageSize: 200 })
    ]);
    terms.value = (tRes?.list ?? [])
      .filter(t => t.termId !== undefined)
      .map(t => ({ termId: t.termId as number, name: t.name || String(t.termId) }));
    // 专业选项 = 专业主表（course.major 是文本列，按名匹配）；
    // ⚠️ 远端库 major 表曾为空导致下拉无选项，10-20 已按 course.major 去重补种
    majors.value = (mRes?.list ?? []).map(m => m.name || '').filter(Boolean);
    // 课程下拉只列启用中的课程：过滤掉教师端测试遗留的 creating 草稿（111/jljl 之类）
    courses.value = (cRes?.list ?? [])
      .filter(c => c.courseId !== undefined && c.status === 'active')
      .map(c => ({ courseId: c.courseId as number, name: (c.courseName as string) || String(c.courseId) }));
    // 学期默认选中「当前学期」，没有标记就取第一个
    if (!filters.termId) {
      const cur = tRes?.list?.find(t => t.isCurrent === 1) ?? tRes?.list?.[0];
      if (cur?.termId !== undefined) filters.termId = String(cur.termId);
    }
  } catch {
    /* 已在请求层提示；筛选下拉留空不影响主数据展示 */
  }
}

async function load() {
  loading.value = true;
  try {
    data.value = await getSchoolAnalytics({
      termId: filters.termId ? Number(filters.termId) : undefined,
      deptId: filters.deptId ? Number(filters.deptId) : undefined,
      major: filters.major || undefined,
      courseId: filters.courseId ? Number(filters.courseId) : undefined,
      alertStatus: alertStatus.value
    });
    // 院系选项随每次聚合返回（不被 deptId 自身过滤）；旧包无该字段时保留上次结果
    if (data.value?.deptOptions?.length) {
      depts.value = data.value.deptOptions.map(d => ({ deptId: d.deptId, name: d.deptName }));
    }
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [filters.termId, filters.deptId, filters.major, filters.courseId],
  () => load()
);
watch(alertStatus, () => load());

/* ---------- 统计卡 ---------- */
interface StatCard {
  key: 'avg' | 'pass' | 'live' | 'alert';
  label: string;
  icon: string;
}
const STAT_CARDS: StatCard[] = [
  { key: 'pass', label: '及格率', icon: 'badge-check' },
  { key: 'live', label: '当前上课课堂', icon: 'graduation-cap' },
  { key: 'alert', label: '预警学生', icon: 'alert-triangle' }
];
const num = (v: number | undefined | null, suffix = '') =>
  v === undefined || v === null ? '—' : `${Math.round(v * 10) / 10}${suffix}`;
/** 变化量：+2.1 / -0.8；0 显示 ±0 */
const deltaText = (d: number | undefined, suffix = '') =>
  d === undefined || d === null ? '' : `${d > 0 ? '+' : d < 0 ? '' : '±'}${Math.round(d * 10) / 10}${suffix}`;
/** 预警数减少是好事 ⇒ 颜色反向（down 绿 / up 红） */
function trendOf(card: StatCard): { text: string; cls: string } | null {
  const s = data.value?.summary;
  if (!s) return null;
  if (card.key === 'pass') {
    // 选中学期且有上一学期数据 ⇒ 显示学期环比（④）；否则回落到自然月环比
    const tc = data.value?.termCompare;
    if (tc && tc.prevPass !== undefined && tc.prevPass !== null && tc.curPass !== undefined && tc.curPass !== null) {
      const d = Math.round((tc.curPass - tc.prevPass) * 10) / 10;
      return { text: `较上学期 ${deltaText(d, '%')}`, cls: d >= 0 ? 'up' : 'down' };
    }
    return { text: `较上期 ${deltaText(s.passRateDelta, '%')}`, cls: s.passRateDelta >= 0 ? 'up' : 'down' };
  }
  if (card.key === 'live') return { text: '实时', cls: 'up' };
  return { text: `较上期 ${deltaText(s.alertDelta)}`, cls: s.alertDelta <= 0 ? 'up' : 'down' };
}

/* ---------- 课程分类统计：badge 色按行轮换（原型同款） ---------- */
const CAT_CLS = ['badge-info', 'badge-success', 'badge-warning', 'badge-neutral'];
const catCls = (i: number) => CAT_CLS[i % CAT_CLS.length];
/** 库里存的是分类码 → 中文展示（未知码兜底原样） */
const CAT_TEXT: Record<string, string> = {
  general: '公共基础课',
  core: '专业核心课',
  lab: '实验实践课',
  elective: '通识选修课'
};
const catText = (v: string) => CAT_TEXT[String(v)] ?? v;

/* ---------- 院系及格率对比：汇总行取已批改总数，横条按 100% 定标 ---------- */
const distTotal = computed(() => (data.value?.distribution ?? []).reduce((s, b) => s + b.count, 0));
const dpW = (rate: number) => Math.min(100, Math.max(rate > 0 ? 3 : 0, rate));

/* ---------- 分数段分布（③）：柱高按最大档定标，档位颜色随区间加深 ---------- */
const bandMax = computed(() => Math.max(1, ...(data.value?.distribution ?? []).map(b => b.count)));
const bandH = (c: number) => Math.round((c / bandMax.value) * 100);
const BAND_CLS = ['band-low', 'band-mid', 'band-mid2', 'band-good', 'band-best'];
const bandCls = (i: number) => BAND_CLS[i % BAND_CLS.length];

/* ---------- 教师教学排行（①）与课程及格率倒数 TOP（②）---------- */
const teacherRanks = computed(() => data.value?.teacherRankings ?? []);
const courseRanks = computed(() => data.value?.courseRankings ?? []);

/* ---------- 预警闭环（⑤）：标记已处理 ---------- */
const handling = ref(false);
async function onHandleAlert(a: { alertId?: number; student?: string; course?: string }) {
  if (handling.value || !a.alertId) return;
  try {
    await ElMessageBox.confirm(
      `确认把「${a.student || '该学生'} · ${a.course || ''}」的预警标记为已处理？`,
      '预警闭环',
      { confirmButtonText: '标记已处理', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return; // 用户取消
  }
  handling.value = true;
  try {
    await handleAlert(a.alertId);
    ElMessage.success('已标记为处理完成');
    await load();
  } catch {
    /* 已在请求层提示 */
  } finally {
    handling.value = false;
  }
}

/* ---------- 备课与实验进度监控：按院系 / 按课程聚合 + 行下钻 ---------- */
const prepDim = ref<'dept' | 'course'>('dept');
const prepOpen = reactive<Record<string, boolean>>({});
interface PrepAgg {
  key: string;
  dept: string;
  courses: Record<string, true>;
  teachers: Record<string, true>;
  prepDone: number;
  prepTotal: number;
  expDone: number;
  expTotal: number;
}
const prepAggs = computed<PrepAgg[]>(() => {
  const map = new Map<string, PrepAgg>();
  for (const d of data.value?.prepDetails ?? []) {
    const k = prepDim.value === 'dept' ? d.dept : d.course;
    if (!map.has(k)) {
      map.set(k, { key: k, dept: prepDim.value === 'dept' ? k : d.dept, courses: {}, teachers: {}, prepDone: 0, prepTotal: 0, expDone: 0, expTotal: 0 });
    }
    const g = map.get(k)!;
    if (d.course) g.courses[d.course] = true;
    if (d.teacher) g.teachers[d.teacher] = true;
    g.prepDone += d.prepDone ?? 0;
    g.prepTotal += d.prepTotal ?? 0;
    g.expDone += d.expDone ?? 0;
    g.expTotal += d.expTotal ?? 0;
  }
  return [...map.values()];
});
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
function prepStatus(p: number): { label: string; cls: string } {
  if (p >= 80) return { label: '正常', cls: 'badge-success' };
  if (p >= 50) return { label: '偏慢', cls: 'badge-warning' };
  return { label: '滞后', cls: 'badge-error' };
}
/** 该院系（或课程）下备课进度 <50% 的课程数 —— 「滞后课程」列 */
function lagCoursesOf(g: PrepAgg): number {
  if (prepDim.value !== 'dept') return 0;
  const seen = new Set<string>();
  let lag = 0;
  for (const d of data.value?.prepDetails ?? []) {
    if (d.dept !== g.key || seen.has(d.course)) continue;
    seen.add(d.course);
    if (pct(d.prepDone, d.prepTotal) < 50) lag++;
  }
  return lag;
}
function drillRows(g: PrepAgg): AnalyticsPrepDetail[] {
  return (data.value?.prepDetails ?? []).filter(d => (prepDim.value === 'dept' ? d.dept : d.course) === g.key);
}
function switchPrep(dim: 'dept' | 'course') {
  prepDim.value = dim;
  Object.keys(prepOpen).forEach(k => delete prepOpen[k]);
}

/* ---------- 成绩趋势折线（近 8 周，SVG 手绘） ---------- */
const trendPts = computed(() => {
  const pts = data.value?.trend ?? [];
  if (pts.length < 2) return null;
  const vs = pts.map(p => p.avgScore);
  const min = Math.min(...vs) - 2;
  const max = Math.max(...vs) + 2;
  const span = Math.max(1, max - min);
  const x = (i: number) => 40 + Math.round((i * 340) / (pts.length - 1));
  const y = (v: number) => 160 - Math.round(((v - min) / span) * 120);
  return {
    line: pts.map((p, i) => `${x(i)},${y(p.avgScore)}`).join(' '),
    dots: pts.map((p, i) => ({ cx: x(i), cy: y(p.avgScore), week: p.week })),
    grid: [122, 84, 46]
  };
});

/* ---------- 实验完成率环形 ---------- */
const RING_C = 314;
const ringOffset = computed(() => RING_C * (1 - Math.min(100, Math.max(0, data.value?.experimentRate ?? 0)) / 100));

/* ---------- 预警等级 → badge ---------- */
function levelOf(level: string): { label: string; cls: string } {
  const v = String(level ?? '');
  if (v === '高' || v === 'high') return { label: '高', cls: 'badge-error' };
  if (v === '中' || v === 'medium') return { label: '中', cls: 'badge-warning' };
  if (v === '低' || v === 'low') return { label: '低', cls: 'badge-info' };
  return { label: v || '—', cls: 'badge-neutral' };
}

/* ---------- 导出报表：后端生成文件并返回下载地址 ---------- */
async function onExport() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const semester = terms.value.find(o => String(o.termId) === filters.termId)?.name;
    const file = await exportReport({ reportType: 'school-analytics', format: 'csv', semester });
    downloadReport(file);
    ElMessage.success(`报表已生成：${file?.fileName || '全校学情报表'}`);
  } catch {
    ElMessage.warning('报表生成失败，请稍后重试');
  } finally {
    exporting.value = false;
  }
}
function downloadReport(file: ReportFileVo | undefined) {
  if (!file?.fileUrl) return;
  const a = document.createElement('a');
  a.href = file.fileUrl;
  a.download = file.fileName || '';
  a.click();
}

onMounted(async () => {
  await Promise.all([load(), loadPickers()]);
});
</script>

<template>
  <div class="page-head">
    <h1>全校学情统计看板</h1>
    <div class="actions">
      <button class="btn btn-outline" :disabled="exporting" @click="onExport">
        <ZkIcon name="download" :size="16" style="margin-right: 4px" />{{ exporting ? '生成中…' : '导出报表' }}
      </button>
    </div>
  </div>

  <div v-loading="loading" class="analytics-body">
    <!-- 筛选条：学期 / 院系 / 专业 / 课程（需求三维=学期/院系/课程 + 追加专业，10-20 拍板都留；
         院系 = 任课教师所属部门（sys_dept），后端 deptId 过滤；school 表只有一所大学，学校维度无筛选价值已隐藏 -->
    <div class="card card-pad filter-bar">
      <span class="small muted">统计维度</span>
      <el-select v-model="filters.termId" class="f-sel" placeholder="学期" filterable style="width: 200px">
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="String(t.termId)" />
      </el-select>
      <el-select v-model="filters.deptId" class="f-sel" placeholder="全部院系" clearable filterable style="width: 190px">
        <el-option v-for="d in depts" :key="d.deptId" :label="d.name" :value="String(d.deptId)" />
      </el-select>
      <!-- 专业：与智能排课页同维度；course.major 是文本列，按专业名过滤 -->
      <el-select v-model="filters.major" class="f-sel" placeholder="全部专业" clearable filterable style="width: 190px">
        <el-option v-for="m in majors" :key="m" :label="m" :value="m" />
      </el-select>
      <!-- 课程：需求文档（三级功能清单+原型）的第三维；按 course.course_id 过滤 -->
      <el-select v-model="filters.courseId" class="f-sel" placeholder="全部课程" clearable filterable style="width: 190px">
        <el-option v-for="c in courses" :key="c.courseId" :label="c.name" :value="String(c.courseId)" />
      </el-select>
      <span class="badge badge-info dim-badge">{{ dimBadge }}</span>
    </div>

    <template v-if="data">
      <!-- 四张统计卡 -->
      <div class="grid g4 mt16">
        <div v-for="c in STAT_CARDS" :key="c.key" class="card stat">
          <div class="label">
            <ZkIcon :name="c.icon" :size="13" style="vertical-align: -2px; margin-right: 4px" />{{ c.label }}
          </div>
          <div class="num" :style="c.key === 'live' ? 'color:var(--brand-600)' : ''">
            {{
              c.key === 'pass'
                ? num(data.summary?.passRate, '%')
                : c.key === 'live'
                  ? (data.summary?.liveClassCount ?? '—')
                  : (data.summary?.alertCount ?? '—')
            }}
          </div>
          <div v-if="trendOf(c)" class="trend" :class="trendOf(c)!.cls">
            <template v-if="c.key === 'live'"><span class="badge badge-success">实时</span> 进行中</template>
            <template v-else>{{ trendOf(c)!.text }}</template>
          </div>
        </div>
      </div>

      <!-- 课程分类统计 + 成绩分布 -->
      <div class="grid g2 mt16">
        <div class="card">
          <div class="card-pad" style="padding-bottom: 0"><div class="card-title">课程分类统计（按课程类别）</div></div>
          <table class="tbl">
            <thead>
              <tr><th>类别</th><th>课程数</th><th>学生数</th><th>平均分</th><th>及格率</th></tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in data.categories ?? []" :key="c.category">
                <td><span class="badge" :class="catCls(i)">{{ catText(c.category) }}</span></td>
                <td>{{ c.courseCount }}</td>
                <td>{{ c.studentCount }}</td>
                <td>{{ num(c.avgScore) }}</td>
                <td>{{ num(c.passRate, '%' ) }}</td>
              </tr>
              <tr v-if="!data.categories?.length">
                <td colspan="5" class="center muted" style="padding: 24px">暂无分类数据</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card card-pad">
          <div class="card-title">院系及格率对比（当前筛选维度）</div>
          <!-- 汇总指标：同一筛选维度下的成绩总览，填充卡片上部并给出读数锚点 -->
          <div v-if="data.distribution?.length" class="dist-meta">
            <div class="dm-item">
              <span class="dm-num">{{ distTotal }}</span>
              <span class="dm-label">已批改成绩</span>
            </div>
            <div class="dm-item">
              <span class="dm-num">{{ num(data.summary?.passRate, '%') }}</span>
              <span class="dm-label">及格率</span>
            </div>
          </div>
          <!-- 院系横条对比：管理端视角，按任课教师所属院系聚合，及格率降序 -->
          <div class="dept-pass">
            <div v-if="!data.deptPassRates?.length" class="empty">
              <span class="empty-icon"><ZkIcon name="bar-chart-3" :size="22" /></span>
              <p class="empty-main">暂无院系成绩数据</p>
              <p class="empty-sub">有已批改的作业成绩后，这里会展示各院系及格率对比</p>
            </div>
            <template v-else>
              <div v-for="d in data.deptPassRates ?? []" :key="d.deptId" class="dp-row">
                <span class="dp-name" :title="d.deptName">{{ d.deptName }}</span>
                <div class="dp-track"><i :style="{ width: dpW(d.passRate) + '%' }" :class="{ low: d.passRate < 60 }"></i></div>
                <span class="dp-num" :class="{ low: d.passRate < 60 }">{{ num(d.passRate, '%') }}</span>
                <span class="dp-cnt">{{ d.scoreCount }} 份</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 分数段分布 + 课程及格率倒数 TOP（对标主流教务大屏的薄弱课定位） -->
      <div class="grid g2 mt16">
        <div class="card card-pad">
          <div class="between" style="margin-bottom: 6px">
            <div class="card-title">分数段分布（当前筛选维度）</div>
            <span class="small muted">共 {{ distTotal }} 份已批改成绩</span>
          </div>
          <div v-if="distTotal > 0" class="score-bands">
            <div v-for="(b, i) in data.distribution ?? []" :key="b.range" class="band-col">
              <span class="band-num">{{ b.count }}</span>
              <div class="band-track">
                <i :class="bandCls(i)" :style="{ height: bandH(b.count) + '%' }"></i>
              </div>
              <span class="band-label">{{ b.range }}</span>
            </div>
          </div>
          <div v-else class="empty" style="padding: 22px 10px">
            <span class="empty-icon"><ZkIcon name="bar-chart-3" :size="22" /></span>
            <p class="empty-main">暂无已批改成绩</p>
            <p class="empty-sub">教师批改作业后，这里会按 &lt;60 / 60-70 / … / 90-100 五档展示分布</p>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-title">课程及格率倒数 TOP5（薄弱课程）</div>
          <div v-if="courseRanks.length" class="dept-pass" style="padding-top: 10px">
            <div v-for="c in courseRanks" :key="c.courseId" class="dp-row">
              <span class="dp-name" :title="c.course">{{ c.course }}</span>
              <div class="dp-track"><i class="low" :style="{ width: dpW(c.passRate) + '%' }"></i></div>
              <span class="dp-num low">{{ num(c.passRate, '%') }}</span>
              <span class="dp-cnt">{{ c.scoreCount }} 份</span>
            </div>
          </div>
          <div v-else class="empty" style="padding: 22px 10px">
            <span class="empty-icon ok"><ZkIcon name="shield-check" :size="22" /></span>
            <p class="empty-main">暂无薄弱课程数据</p>
            <p class="empty-sub">有已批改成绩后，及格率最低的课程会排在这里</p>
          </div>
        </div>
      </div>

      <!-- 教师教学排行（批改份数降序）：教务处看工作量与教学效果 -->
      <div class="card mt16">
        <div class="card-pad between" style="padding-bottom: 0">
          <div class="card-title">教师教学排行（按批改份数）</div>
          <span class="small muted">口径：已批改作业成绩；及格率 = 及格份数 ÷ 批改份数</span>
        </div>
        <table v-if="teacherRanks.length" class="tbl">
          <thead>
            <tr><th>#</th><th>教师</th><th>院系</th><th>课程数</th><th>批改份数</th><th>平均分</th><th>及格率</th></tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in teacherRanks" :key="t.teacherId">
              <td class="muted">{{ i + 1 }}</td>
              <td><div class="row" style="gap: 8px"><span class="avatar sm">{{ (t.teacher || '?')[0] }}</span>{{ t.teacher || '—' }}</div></td>
              <td class="small muted">{{ t.dept || '—' }}</td>
              <td>{{ t.courseCount }}</td>
              <td>{{ t.scoreCount }}</td>
              <td>{{ num(t.avgScore) }}</td>
              <td><span class="badge" :class="t.passRate >= 60 ? 'badge-success' : 'badge-error'">{{ num(t.passRate, '%') }}</span></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty" style="padding: 22px 10px">
          <span class="empty-icon"><ZkIcon name="users" :size="22" /></span>
          <p class="empty-main">暂无教师批改数据</p>
          <p class="empty-sub">教师批改作业后，这里会按批改份数展示教学排行</p>
        </div>
      </div>

      <!-- 备课与实验进度监控（按院系 / 按课程，点击行下钻教师明细） -->
      <div class="card mt16">
        <div class="card-pad between" style="padding-bottom: 0">
          <div class="card-title">备课与实验进度监控（{{ prepDim === 'dept' ? '按院系' : '按课程' }}）</div>
          <span class="row" style="gap: 10px">
            <span class="pilltabs">
              <span class="pill" :class="{ active: prepDim === 'dept' }" @click="switchPrep('dept')">按院系</span>
              <span class="pill" :class="{ active: prepDim === 'course' }" @click="switchPrep('course')">按课程</span>
            </span>
            <span class="small muted">点击行可下钻查看教师明细</span>
          </span>
        </div>
        <table class="tbl">
          <thead>
            <tr v-if="prepDim === 'dept'">
              <th>院系</th><th>课程数</th><th>教师数</th><th>备课进度</th><th>实验进度</th><th>滞后课程</th><th>状态</th>
            </tr>
            <tr v-else>
              <th>课程</th><th>院系</th><th>任课教师</th><th>备课进度</th><th>实验进度</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="g in prepAggs" :key="g.key">
              <tr class="prep-main" @click="prepOpen[g.key] = !prepOpen[g.key]">
                <td>
                  <div class="row" style="gap: 6px">
                    <ZkIcon :name="prepOpen[g.key] ? 'chevron-down' : 'chevron-right'" :size="14" style="color: var(--ink-400)" />
                    <b style="color: var(--ink-900)">{{ g.key }}</b>
                  </div>
                </td>
                <template v-if="prepDim === 'dept'">
                  <td>{{ Object.keys(g.courses).length }}</td>
                  <td>{{ Object.keys(g.teachers).length }}</td>
                </template>
                <template v-else>
                  <td class="small muted">{{ g.dept }}</td>
                  <td>{{ Object.keys(g.teachers).length }} 人</td>
                </template>
                <td>
                  <div class="row" style="gap: 8px">
                    <div class="progress" style="width: 110px"><i :style="{ width: pct(g.prepDone, g.prepTotal) + '%' }"></i></div>
                    <span class="small">{{ g.prepDone }}/{{ g.prepTotal }} 周</span>
                  </div>
                </td>
                <td>
                  <div class="row" style="gap: 8px">
                    <div class="progress" style="width: 110px"><i :style="{ width: pct(g.expDone, g.expTotal) + '%' }"></i></div>
                    <span class="small">{{ g.expDone }}/{{ g.expTotal }} 次</span>
                  </div>
                </td>
                <td v-if="prepDim === 'dept'">{{ lagCoursesOf(g) }}</td>
                <td><span class="badge" :class="prepStatus(pct(g.prepDone, g.prepTotal)).cls">{{ prepStatus(pct(g.prepDone, g.prepTotal)).label }}</span></td>
              </tr>
              <!-- 下钻：教师明细 -->
              <tr v-if="prepOpen[g.key]" class="prep-drill">
                <td :colspan="prepDim === 'dept' ? 7 : 6" style="background: var(--bg-subtle); padding: 0">
                  <div style="padding: 12px 18px">
                    <div class="small muted" style="margin-bottom: 8px">教师明细（{{ drillRows(g).length }} 条）</div>
                    <table class="tbl drill-tbl">
                      <thead>
                        <tr><th>教师</th><th>课程</th><th>备课进度</th><th>实验进度</th><th>状态</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="d in drillRows(g)" :key="d.teacher + d.course">
                          <td><div class="row" style="gap: 8px"><span class="avatar sm">{{ (d.teacher || '?')[0] }}</span>{{ d.teacher }}</div></td>
                          <td>{{ d.course }}</td>
                          <td>
                            <div class="row" style="gap: 8px">
                              <div class="progress" style="width: 110px"><i :style="{ width: pct(d.prepDone, d.prepTotal) + '%' }"></i></div>
                              <span class="small">{{ d.prepDone }}/{{ d.prepTotal }} 周</span>
                            </div>
                          </td>
                          <td>
                            <div class="row" style="gap: 8px">
                              <div class="progress" style="width: 110px"><i :style="{ width: pct(d.expDone, d.expTotal) + '%' }"></i></div>
                              <span class="small">{{ d.expDone }}/{{ d.expTotal }} 次</span>
                            </div>
                          </td>
                          <td><span class="badge" :class="prepStatus(pct(d.prepDone, d.prepTotal)).cls">{{ prepStatus(pct(d.prepDone, d.prepTotal)).label }}</span></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!prepAggs.length">
              <td :colspan="prepDim === 'dept' ? 7 : 6" class="center muted" style="padding: 24px">当前筛选条件下无数据</td>
            </tr>
          </tbody>
        </table>
        <div class="between" style="padding: 12px 16px">
          <span class="small muted">共 {{ prepAggs.length }} 个{{ prepDim === 'dept' ? '院系' : '课程' }}（点击行下钻教师明细）</span>
          <span class="small muted">进度数据实时汇总自各教师备课记录与实验任务</span>
        </div>
      </div>

      <!-- 当前上课课堂 + 成绩趋势 / 实验完成率 -->
      <div class="grid mt16 live-grid">
        <div class="card">
          <div class="card-pad between" style="padding-bottom: 0">
            <div class="card-title">当前上课课堂（实时 · {{ data.liveClasses?.length ?? 0 }} 个）</div>
            <span v-if="data.liveClasses?.length" class="badge badge-success">
              <ZkIcon name="refresh-cw" :size="12" style="vertical-align: -2px; margin-right: 2px" /> 直播中
            </span>
          </div>
          <table v-if="data.liveClasses?.length" class="tbl">
            <thead>
              <tr><th>课程</th><th>教师</th><th>教室</th><th>节次</th><th>在线学生</th></tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in data.liveClasses ?? []" :key="i">
                <td>{{ l.course || '—' }}</td>
                <td>{{ l.teacher || '—' }}</td>
                <td>{{ l.room || '—' }}</td>
                <td>{{ l.slot || '—' }}</td>
                <td>{{ l.online || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <!-- 空态：说明"功能在、只是此刻没课"，避免空表格显得破 -->
          <div v-else class="empty">
            <span class="empty-icon"><ZkIcon name="calendar-days" :size="22" /></span>
            <p class="empty-main">当前没有正在进行的课堂</p>
            <p class="small muted">只在有课堂处于上课状态时显示列表，可切换学期或院系查看其他时段</p>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-title">成绩趋势（近 {{ data.trend?.length ?? 0 }} 周）</div>
          <svg v-if="trendPts" viewBox="0 0 400 200" style="width: 100%; height: auto">
            <line x1="30" y1="10" x2="30" y2="160" stroke="#e3eaec" />
            <line x1="30" y1="160" x2="390" y2="160" stroke="#e3eaec" />
            <g stroke="#f1f5f6">
              <line v-for="gy in trendPts.grid" :key="gy" x1="30" :y1="gy" x2="390" :y2="gy" />
            </g>
            <polyline :points="trendPts.line" fill="none" stroke="#0d9488" stroke-width="2.5" stroke-linecap="round" />
            <g fill="#0d9488">
              <circle v-for="d in trendPts.dots" :key="d.week" :cx="d.cx" :cy="d.cy" r="3.5" />
            </g>
            <g font-size="10" fill="#94a3b8">
              <text v-for="d in trendPts.dots" :key="'t' + d.week" :x="d.cx - 8" y="176">{{ d.week }}</text>
            </g>
          </svg>
          <p v-else class="muted small" style="padding: 16px 0">暂无趋势数据</p>
          <div class="divider" style="margin: 14px 0"></div>
          <div class="card-title">实验完成率</div>
          <div class="center">
            <svg viewBox="0 0 120 120" style="width: 120px">
              <circle cx="60" cy="60" r="50" fill="none" stroke="#f1f5f6" stroke-width="12" />
              <circle
                cx="60" cy="60" r="50" fill="none" stroke="#0d9488" stroke-width="12" stroke-linecap="round"
                :stroke-dasharray="RING_C" :stroke-dashoffset="ringOffset" transform="rotate(-90 60 60)"
              />
              <text x="60" y="66" text-anchor="middle" font-size="20" font-weight="800" fill="#0f172a">
                {{ data.experimentRate ?? 0 }}%
              </text>
            </svg>
          </div>
        </div>
      </div>

      <!-- 预警名单（闭环：待处理可标记已处理，已处理留痕） -->
      <div class="card mt16">
        <div class="card-pad between" style="padding-bottom: 0">
          <div class="card-title">预警名单（低分 / 退步 / 未提交）</div>
          <span class="pilltabs">
            <span class="pill" :class="{ active: alertStatus === 'open' }" @click="alertStatus = 'open'">待处理</span>
            <span class="pill" :class="{ active: alertStatus === 'closed' }" @click="alertStatus = 'closed'">已处理</span>
          </span>
        </div>
        <table v-if="data.alerts?.length" class="tbl">
          <thead>
            <tr>
              <th>学生</th><th>课程</th><th>院系</th><th>类型</th><th>当前分</th><th>等级</th>
              <th>{{ alertStatus === 'open' ? '操作' : '处理时间' }}</th>
              <th v-if="alertStatus === 'closed'">处理备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in data.alerts ?? []" :key="a.alertId ?? (a.student + a.course)">
              <td>{{ a.student || '—' }}</td>
              <td>{{ a.course || '—' }}</td>
              <td>{{ a.dept || '—' }}</td>
              <td>{{ a.type || '—' }}</td>
              <td>{{ a.score ?? '—' }}</td>
              <td><span class="badge" :class="levelOf(a.level).cls">{{ levelOf(a.level).label }}</span></td>
              <td>
                <button
                  v-if="alertStatus === 'open'"
                  class="btn btn-outline btn-sm" :disabled="handling" @click="onHandleAlert(a)"
                >标记已处理</button>
                <span v-else class="small muted">{{ a.handledAt || '—' }}</span>
              </td>
              <td v-if="alertStatus === 'closed'" class="small muted">{{ a.handleNote || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <!-- 空态：待处理无预警是好事（正向文案）；已处理为空是普通无数据 -->
        <div v-else class="empty">
          <span class="empty-icon" :class="{ ok: alertStatus === 'open' }"><ZkIcon :name="alertStatus === 'open' ? 'shield-check' : 'badge-check'" :size="22" /></span>
          <p class="empty-main">{{ alertStatus === 'open' ? '当前筛选范围内没有触发预警的学生' : '还没有已处理的预警记录' }}</p>
          <p class="small muted">{{ alertStatus === 'open' ? '低分、成绩退步、连续未提交的学生会自动出现在这里' : '在「待处理」里点击「标记已处理」后，记录会留痕在这里' }}</p>
        </div>
      </div>
    </template>

    <!-- 接口失败 / 无数据：页内缺口提示（不裸报红） -->
    <div v-else-if="!loading" class="card card-pad center" style="padding: 48px">
      <p class="muted">学情数据加载失败或暂无数据。</p>
      <button class="btn btn-outline" style="margin-top: 12px" @click="load">
        <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />重新加载
      </button>
    </div>
  </div>
</template>

<style scoped>
.analytics-body {
  min-height: 240px;
}
/* 筛选条：徽章靠右 */
.filter-bar {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  padding: 14px 18px;
}
.filter-bar .dim-badge {
  margin-left: auto;
}
/* 成绩分布：纯 CSS 柱状图 */
/* 汇总指标行：同一维度的成绩总览三格 */
.dist-meta {
  display: flex;
  gap: 10px;
  margin: 10px 0 2px;
}
.dm-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 0 8px;
  background: var(--bg-50, #f6f7f9);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.dm-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--ink-900, #1c2333);
  line-height: 1.2;
}
.dm-label {
  font-size: 12px;
  color: var(--ink-500);
}
/* 院系及格率横条对比：名称 / 轨道 / 数值 / 份数四列 */
.dept-pass {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 2px 6px;
  min-height: 210px;
}
.dp-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dp-name {
  flex: 0 0 96px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-700, #475569);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-track {
  flex: 1;
  height: 14px;
  background: var(--bg-50, #f1f5f9);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.dp-track i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--brand-400, #7c9df2), var(--brand-600, #4a6fd6));
  border-radius: 999px;
  transition: width 0.25s ease;
}
/* 及格率告警（<60%）：红色条，与中国市场涨跌用色惯例一致 */
.dp-track i.low {
  background: linear-gradient(90deg, #f87171, #dc2626);
}
.dp-num {
  flex: 0 0 52px;
  text-align: right;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-900, #1c2333);
  font-variant-numeric: tabular-nums;
}
.dp-num.low {
  color: #dc2626;
}
.dp-cnt {
  flex: 0 0 52px;
  text-align: right;
  font-size: 11px;
  color: var(--ink-400, #94a3b8);
}
/* 分数段分布：五档柱状（<60 红渐深 → 90-100 绿），柱高按最大档定标 */
.score-bands {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 18px 6px 4px;
  min-height: 190px;
}
.band-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.band-num {
  font-size: 14px;
  font-weight: 700;
  color: var(--ink-900, #1c2333);
  font-variant-numeric: tabular-nums;
}
.band-track {
  width: 100%;
  max-width: 56px;
  height: 110px;
  display: flex;
  align-items: flex-end;
  background: var(--bg-50, #f6f7f9);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.band-track i {
  display: block;
  width: 100%;
  min-height: 2px;
  border-radius: 8px 8px 0 0;
  transition: height 0.25s ease;
}
.band-low { background: linear-gradient(180deg, #f87171, #dc2626); }
.band-mid { background: linear-gradient(180deg, #fbbf24, #d97706); }
.band-mid2 { background: linear-gradient(180deg, #93c5fd, #3b82f6); }
.band-good { background: linear-gradient(180deg, #6ee7b7, #10b981); }
.band-best { background: linear-gradient(180deg, #34d399, #0d9488); }
.band-label {
  font-size: 12px;
  color: var(--ink-500);
  white-space: nowrap;
}
/* 空态：图标圆底 + 主副文案，居中，传达"功能在、暂无数据" */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 34px 16px 30px;
  text-align: center;
}
.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: var(--bg-50, #f6f7f9);
  border: 1px solid var(--border);
  color: var(--ink-400, #94a3b8);
}
/* 正向空态（如"无预警"）：绿色图标底 */
.empty-icon.ok {
  color: #0d9488;
  background: rgba(13, 148, 136, 0.08);
  border-color: rgba(13, 148, 136, 0.25);
}
.empty-main {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #475569);
}
.empty-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ink-400, #94a3b8);
}
.empty .small {
  max-width: 360px;
  line-height: 1.6;
}
/* 下钻明细表嵌在浅灰行里：白底 + 边框，圆角裁切 */
.drill-tbl {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.prep-main {
  cursor: pointer;
}
.prep-main:hover td {
  background: var(--bg-soft);
}
/* 实时课堂 + 趋势：2fr 1fr，窄屏回落单列 */
.live-grid {
  grid-template-columns: 2fr 1fr;
}
@media (max-width: 1100px) {
  .live-grid {
    grid-template-columns: 1fr;
  }
}
.divider {
  height: 1px;
  background: var(--border);
}
</style>
