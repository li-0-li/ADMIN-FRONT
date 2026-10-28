<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { getSchoolAnalytics, handleAlert } from '@/api/admin/analytics';
import { listMajors, listTerms } from '@/api/admin/basicdata';
import { listCourses } from '@/api/admin/dashboard';
import type { AnalyticsAlert, AnalyticsPrepDetail, SchoolAnalyticsVo } from '@/types/admin';

/**
 * 全校学情统计看板（原型 ui-prototype/pc/admin-analytics.html）。
 * 数据 = 后端一次聚合 GET /api/v1/admin/analytics/school（termId / major / courseId / deptId / alertStatus 过滤）。
 * 筛选 = 学期/院系/专业/课程四维（termId 后端翻译成学期编码真正参与过滤）；
 * 迭代 2026-10-20：教师教学排行 / 课程及格率倒数 TOP / 分数段分布 / 学期环比 / 预警闭环。
 * 导出生成前端 CSV：后端 /export/report 只认 semester 参数，用它导出会与屏上院系/专业/课程筛选口径不一致。
 */
const loading = ref(true);
const data = ref<SchoolAnalyticsVo | null>(null);
/** 本页聚合数据的拉取时刻；后端没有推送，界面不能再写「实时」 */
const loadedAt = ref('');

/* ---------- 筛选：学期 / 院系 / 专业 / 课程（院系 = 任课教师所属部门，后端 deptId 过滤） ---------- */
// 三个下拉的 id 一律归一成 string：10-27 实测后端已逐字段 @JsonFormat(shape=STRING)，
// 而 src/types/admin.ts 的契约还写着 number ⇒ 不照抄契约、也不用 as number 假声明（Number() 会把 19 位雪花 ID 静默打错）
const terms = ref<{ termId: string; name: string }[]>([]);
const depts = ref<{ deptId: string; name: string }[]>([]);
const majors = ref<string[]>([]);
const courses = ref<{ courseId: string; name: string }[]>([]);
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
      .map(t => ({ termId: String(t.termId), name: t.name || String(t.termId) }));
    // 专业选项 = 专业主表（course.major 是文本列，按名匹配）；
    // ⚠️ 远端库 major 表曾为空导致下拉无选项，10-20 已按 course.major 去重补种
    majors.value = (mRes?.list ?? []).map(m => m.name || '').filter(Boolean);
    // 课程下拉只列启用中的课程：过滤掉教师端测试遗留的 creating 草稿（111/jljl 之类）
    courses.value = (cRes?.list ?? [])
      .filter(c => c.courseId !== undefined && c.status === 'active')
      .map(c => ({ courseId: String(c.courseId), name: (c.courseName as string) || String(c.courseId) }));
    // 学期默认选中「当前学期」，没有标记就取第一个
    if (!filters.termId) {
      const cur = tRes?.list?.find(t => t.isCurrent === 1) ?? tRes?.list?.[0];
      if (cur?.termId !== undefined) filters.termId = String(cur.termId);
    }
  } catch {
    /* 已在请求层提示；筛选下拉留空不影响主数据展示 */
  }
}

/** 聚合接口一次拉全页数据 ⇒ 并发响应必须只认最后一次，否则慢的那次会覆盖新筛选结果 */
let reqSeq = 0;
let mergeTimer: number | undefined;
/**
 * 失败原因（存文案不存布尔：2026-10-28 交付前复查发现原来失败与"后端返回空"共用一句
 * 「加载失败或暂无数据」，用户看不出是网络问题还是真的没数据，也看不到后端说了什么）。
 * 与账号页 P1-1 同一处理方式，保持两条线一致。
 */
const loadError = ref('');
/**
 * 上次「成功拿到数据」时对应的筛选维度快照。
 * 用途只有一个：挡住导出的口径错配 —— dimBadge 是实时的（改筛选立刻变），data 是滞后的
 * （要等接口回来）。两者不同步时导出，CSV 首行写的是新维度、数据是旧全量，等于交出一份
 * 自己都对不上的报表。2026-10-28 实测可复现（选专业后立刻导出：维度写"计算机科学与技术"、
 * 课程数仍是 13 门）。
 * ⚠️ 必须把 alertStatus 一起纳入快照：dimBadge 只含学期/院系/专业/课程，**不含预警页签**，
 * 而 CSV 里的预警名单是按页签取的（待处理 / 已处理）。只比 dimBadge 的话，切页签后立刻导出
 * 会漏过门禁，导出「已处理」的标题配「待处理」的名单。
 */
const loadedDim = ref('');
/** 口径快照 = 可见筛选维度 + 预警页签（两者都决定 CSV 某一节的内容） */
const dimSnapshot = () => `${dimBadge.value}|${alertStatus.value}`;

async function load() {
  const seq = ++reqSeq;
  const dimAtReq = dimSnapshot();
  loading.value = true;
  try {
    const res = await getSchoolAnalytics({
      termId: filters.termId || undefined,
      deptId: filters.deptId || undefined,
      major: filters.major || undefined,
      courseId: filters.courseId || undefined,
      alertStatus: alertStatus.value
    });
    if (seq !== reqSeq) return;
    data.value = res;
    loadedDim.value = dimAtReq;
    loadError.value = '';
    loadedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 院系选项随每次聚合返回 ⇒ 只增不减地合并进本地列表。
    // 后端 deptOptions 会跟着课程筛选一起缩小，直接整表替换会让已选中的院系从下拉里消失：
    // 下拉回显成裸 id「201」，dimBadge 找不到名字回落成「全部院系」，连导出文件名与 CSV 首行的口径都是错的。
    if (res?.deptOptions?.length) {
      const byId = new Map(depts.value.map(d => [String(d.deptId), d]));
      for (const d of res.deptOptions) {
        if (d?.deptId !== undefined && d?.deptName) byId.set(String(d.deptId), { deptId: String(d.deptId), name: d.deptName });
      }
      depts.value = [...byId.values()];
    }
  } catch (e) {
    if (seq !== reqSeq) return;
    data.value = null;
    // request.ts 已经 toast 过一次，这里再落一条常驻文案：toast 几秒就没了，
    // 而「这页为什么是空的」需要留在屏上，且要能区分失败与真的没数据
    const msg = String((e as { message?: string })?.message ?? '').trim();
    loadError.value = msg || '学情数据读取失败（网络或登录状态异常）';
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

/** 五个筛选都打同一个聚合接口 ⇒ 连改合并成一次请求 */
function reloadSoon() {
  if (mergeTimer) window.clearTimeout(mergeTimer);
  mergeTimer = window.setTimeout(load, 150);
}

watch(
  [() => filters.termId, () => filters.deptId, () => filters.major, () => filters.courseId, alertStatus],
  () => reloadSoon()
);

/* ---------- 统计卡 ---------- */
interface StatCard {
  key: 'avg' | 'pass' | 'live' | 'alert';
  label: string;
  icon: string;
}
const STAT_CARDS: StatCard[] = [
  { key: 'avg', label: '全校平均分', icon: 'activity' },
  { key: 'pass', label: '及格率', icon: 'badge-check' },
  { key: 'live', label: '当前上课课堂', icon: 'graduation-cap' },
  { key: 'alert', label: '预警学生', icon: 'alert-triangle' }
];
const num = (v: number | undefined | null, suffix = '') =>
  v === undefined || v === null ? '—' : `${Math.round(v * 10) / 10}${suffix}`;
/** 变化量带方向符号：▲+2.1 / ▼0.8 / ±0 —— 颜色之外还要能读出涨跌 */
const deltaText = (d: number | undefined | null, suffix = '') =>
  d === undefined || d === null
    ? ''
    : `${d > 0 ? '▲+' : d < 0 ? '▼' : '±'}${Math.round(Math.abs(d) * 10) / 10}${suffix}`;
/**
 * 预警涨跌的配色方向。
 * 本仓 theme.css 的 `.stat .up{color:var(--success-strong)}` / `.stat .down{color:var(--error-strong)}`
 * 是「up=绿、down=红」，即颜色本身只表示好坏，不表示数值正负。
 * 平均分/及格率：涨是好事 ⇒ d≥0 用 up(绿)，与数值方向一致。
 * 预警：减少才是好事 ⇒ d≤0 用 up(绿)，与数值方向相反。
 * ⚠️ 此处注释曾写成「颜色反向（down 绿 / up 红）」，与 theme.css 实际相反，
 *    照那句实现会让「预警下降 6 条」显示成红色（读成坏事），已更正。
 */
function alertTrendCls(d: number): string {
  return d <= 0 ? 'up' : 'down';
}
function trendOf(card: StatCard): { text: string; cls: string } | null {
  const s = data.value?.summary;
  if (!s) return null;
  // 无样本时不显示「本月较上月 ±0分」——分母都不存在，涨跌是假的
  if (noScoreSample.value && (card.key === 'avg' || card.key === 'pass')) return null;
  if (card.key === 'avg') {
    const tc = data.value?.termCompare;
    // 分母来自编号 54 的 curCount/prevCount（两学期各自的去重学生数）；prevCount=0 时上期侧无可比样本，不能再写「较上学期」
    const cnt = tc?.curCount !== undefined && tc?.curCount !== null && tc?.prevCount ? `（${tc.curCount} 人/上期 ${tc.prevCount} 人）` : '';
    if (tc && tc.curAvg !== undefined && tc.curAvg !== null && tc.prevAvg !== undefined && tc.prevAvg !== null && tc.prevCount) {
      const d = Math.round((tc.curAvg - tc.prevAvg) * 10) / 10;
      return { text: `较上学期 ${deltaText(d, '分')}${cnt}`, cls: d >= 0 ? 'up' : 'down' };
    }
    // 回落到自然月环比：后端 avgScoreDelta/passRateDelta 恒为「本自然月 − 上一自然月」
    // （AdminStatsServiceImpl.java:153-158 的 firstOfMonth 起算）。这里若写「较上期」，
    // 在上一学期无数据（prevCount=0）时会与「较上学期」混淆 ⇒ 明确写成「本月较上月」。
    return { text: `本月较上月 ${deltaText(s.avgScoreDelta, '分')}`, cls: (s.avgScoreDelta ?? 0) >= 0 ? 'up' : 'down' };
  }
  if (card.key === 'pass') {
    // 选中学期且有上一学期数据 ⇒ 显示学期环比（④）；否则回落到自然月环比
    const tc = data.value?.termCompare;
    const cnt = tc?.curCount !== undefined && tc?.curCount !== null && tc?.prevCount ? `（${tc.curCount} 人/上期 ${tc.prevCount} 人）` : '';
    if (tc && tc.prevPass !== undefined && tc.prevPass !== null && tc.curPass !== undefined && tc.curPass !== null && tc.prevCount) {
      const d = Math.round((tc.curPass - tc.prevPass) * 10) / 10;
      return { text: `较上学期 ${deltaText(d, '%')}${cnt}`, cls: d >= 0 ? 'up' : 'down' };
    }
    return { text: `本月较上月 ${deltaText(s.passRateDelta, '%')}`, cls: s.passRateDelta >= 0 ? 'up' : 'down' };
  }
  if (card.key === 'live') return { text: loadedAt.value ? `${loadedAt.value} 拉取` : '当次拉取', cls: 'up' };
  /* 预警涨跌：单位已定论为「条」，不再是「条数差 or 人数差都说得通」的悬案。
     依据①后端源码 AdminStatsServiceImpl.java:176-181：alertDelta = cur_new − prev_new；
          AdminStatsMapper.xml:306-313：cur_new/prev_new 都是 sum(case ... then 1 else 0) ⇒ 数的是行数（条）。
     依据②库内实测：2026-10 新增 3 条、2026-09 新增 9 条 ⇒ 3−9 = −6，与接口返回的 alertDelta=−6 一致；
          若按人数差则是 3−4 = −1，对不上 ⇒ 排除人数解释。
     文案主体必须写「本月新增」：本卡数字是「4 名待处理学生」，直接挂「−6」会被读成「少了 6 人」。
     时间窗是自然月（后端 firstOfMonth 起算），与上方「较上学期」不是同一维度，故写明「本月」。 */
  if (card.key === 'alert') {
    const d = s.alertDelta;
    if (d === undefined || d === null) return null;
    return { text: `本月新增较上月 ${deltaText(d, ' 条')}`, cls: alertTrendCls(d) };
  }
  return null;
}
/** 卡区脚注：百分比要有分母，否则 82.4% 说不出是「多少门课、多少学生」里的 82.4% */
const coverage = computed(() => {
  const s = data.value?.summary;
  if (!s) return '';
  const cnt = (v: number | undefined) => (v === undefined || v === null ? '—' : v);
  return `当前筛选维度覆盖 ${cnt(s.courseCount)} 门课程 · ${cnt(s.teacherCount)} 名教师 · ${cnt(s.studentCount)} 名学生 · 已批改成绩 ${distTotal.value} 份`;
});

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
/** 没有一份已批改成绩时，平均分/及格率不能写成「0 分 / 0%」——那是把「没数据」显示成「考了 0 分」 */
const noScoreSample = computed(() => distTotal.value === 0);
/** 10-26 后端已把 deptId/major/courseId 下推到成绩类聚合（实测 deptId=203 时平均分/及格率/两张排行/预警全变）
 *  ⇒ 原「成绩类各块仍是全学期口径」的临时判定与标题后缀一并撤掉（编号 29） */
/** 分类统计在空集下仍会返回 4 个分类名（值全 0）⇒ 按合计判空，不要摆 4 行 0 出来 */
const categoriesTotal = computed(() => (data.value?.categories ?? []).reduce((s, c) => s + (c.courseCount ?? 0), 0));
/** 只判空态行不够：数据行也得收掉，否则屏上是「4 行 0 + 一行空态」 */
const catRows = computed(() => (categoriesTotal.value ? data.value?.categories ?? [] : []));
const dpW = (rate: number) => Math.min(100, Math.max(rate > 0 ? 3 : 0, rate));
/** 份数不足 10 的及格率不稳（5 份里挂 1 份就是 80%），条眼降透明并在口径行里说明 */
const SMALL_N = 10;
const thinSample = (n: number | undefined) => n !== undefined && n !== null && n < SMALL_N;

/* ---------- 分数段分布（③）：柱高按最大档定标 ---------- */
const bandMax = computed(() => Math.max(1, ...(data.value?.distribution ?? []).map(b => b.count)));
const bandH = (c: number) => Math.round((c / bandMax.value) * 100);
/**
 * 档色按分数语义而非数组下标（后端档位是 <60 / 60-70 / 70-80 / 80-90 / 90-100，
 * 按下标取色一旦后端改档序或并档，及格线以下就会穿成绿）。
 */
function bandLower(range: string): number | null {
  const s = String(range ?? '');
  const m = s.match(/\d+/);
  if (!m) return null;
  return /[<≤]/.test(s) ? 0 : Number(m[0]);
}
/** 及格线以下的档（红色） */
const failBand = (range: string) => {
  const lo = bandLower(range);
  return lo !== null && lo < 60;
};
function bandCls(range: string): string {
  const lo = bandLower(range);
  if (lo === null) return 'band-na';
  if (lo < 60) return 'band-low';
  if (lo < 70) return 'band-mid';
  if (lo < 80) return 'band-mid2';
  if (lo < 90) return 'band-good';
  return 'band-best';
}
/** 口径行：把「哪个档算不及格」写在图下面，而不是让人猜颜色 */
const failBandText = computed(() => {
  const failing = (data.value?.distribution ?? []).filter(b => failBand(b.range));
  return failing.length ? `${failing.map(b => b.range).join(' / ')} 为 60 分及格线以下` : '分数段按及格线上下分色';
});

/* ---------- 教师教学排行（①）与课程及格率倒数 TOP（②）---------- */
const teacherRanks = computed(() => data.value?.teacherRankings ?? []);
const courseRanks = computed(() => data.value?.courseRankings ?? []);

/* ---------- 预警闭环（⑤）：标记已处理 + 填写处理备注 ---------- */
const handling = ref(false);
async function onHandleAlert(a: { alertId?: string | number; student?: string; course?: string }) {
  if (handling.value || !a.alertId) return;
  let note = '';
  try {
    const r = await ElMessageBox.prompt(
      `把「${a.student || '该学生'} · ${a.course || ''}」的预警标记为已处理，并写下处理方式（可留空）。`,
      '预警闭环',
      {
        confirmButtonText: '标记已处理',
        cancelButtonText: '取消',
        inputPlaceholder: '如：已联系学生本人，约定本周内补交',
        // 后端 handle_note 列宽 500，留一倍余量；超长的备注会让表格撑破行
        inputValidator: (v: string) => (v ?? '').trim().length <= 200 || '处理备注请控制在 200 字以内'
      }
    );
    note = String(r.value ?? '').trim();
  } catch {
    return; // 用户取消
  }
  handling.value = true;
  try {
    await handleAlert(a.alertId, note || undefined);
    ElMessage.success(note ? '已标记为处理完成，处理备注已记录' : '已标记为处理完成');
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
  // 滞后在前：教务开这块是为了找异常行，不是先看正常的
  return [...map.values()].sort(
    (a, b) => pct(a.prepDone, a.prepTotal) - pct(b.prepDone, b.prepTotal) || a.key.localeCompare(b.key, 'zh-CN')
  );
});
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
function prepStatus(p: number): { label: string; cls: string } {
  if (p >= 80) return { label: '正常', cls: 'badge-success' };
  if (p >= 50) return { label: '偏慢', cls: 'badge-warning' };
  return { label: '滞后', cls: 'badge-error' };
}
/** 该院系下备课进度 <50% 的课程数 —— 「滞后课程」列。
 *  同一课程可能有多位教师的行，必须先按课程合计再判，只取「首次出现的那一行」会让后端行序决定屏上数字 */
function lagCoursesOf(g: PrepAgg): number {
  if (prepDim.value !== 'dept') return 0;
  const byCourse = new Map<string, { done: number; total: number }>();
  for (const d of data.value?.prepDetails ?? []) {
    if (d.dept !== g.key) continue;
    const c = byCourse.get(d.course) || { done: 0, total: 0 };
    c.done += d.prepDone ?? 0;
    c.total += d.prepTotal ?? 0;
    byCourse.set(d.course, c);
  }
  let lag = 0;
  for (const c of byCourse.values()) if (pct(c.done, c.total) < 50) lag++;
  return lag;
}
function drillRows(g: PrepAgg): AnalyticsPrepDetail[] {
  return (data.value?.prepDetails ?? []).filter(d => (prepDim.value === 'dept' ? d.dept : d.course) === g.key);
}
function switchPrep(dim: 'dept' | 'course') {
  prepDim.value = dim;
  Object.keys(prepOpen).forEach(k => delete prepOpen[k]);
}
/** 下钻开关：行点击与键盘（展开按钮）共用一个入口 */
function togglePrep(key: string) {
  prepOpen[key] = !prepOpen[key];
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
  // y = 160 - (v-min)/span*120 ⇒ v = min + (160-y)/120*span
  const tickV = (gy: number) => Math.round((min + ((160 - gy) / 120) * span) * 10) / 10;
  return {
    line: pts.map((p, i) => `${x(i)},${y(p.avgScore)}`).join(' '),
    dots: pts.map((p, i) => ({ cx: x(i), cy: y(p.avgScore), week: p.week })),
    // 原来三条网格线没有读数，折线高低看不出是 78 与 82 还是 60 与 95 的差
    grid: [122, 84, 46].map(gy => ({ y: gy, v: tickV(gy) }))
  };
});

/* ---------- 实验完成率环形 ---------- */
const RING_C = 314;
const ringOffset = computed(() => RING_C * (1 - Math.min(100, Math.max(0, data.value?.experimentRate ?? 0)) / 100));

/* ---------- 预警等级 → badge ---------- */
/**
 * 库里等级码不统一：实测同一列同时出现 high / mid / low（不是 medium），
 * 只认 medium 的话 4 条中危会原样显示英文码、排序还掉到「低」后面。
 */
function levelCode(level: string): '高' | '中' | '低' | '' {
  const v = String(level ?? '').trim().toLowerCase();
  if (v === '高' || v === 'high') return '高';
  if (v === '中' || v === 'mid' || v === 'middle' || v === 'medium') return '中';
  if (v === '低' || v === 'low') return '低';
  return '';
}
const LEVEL_BADGE: Record<'高' | '中' | '低', string> = { 高: 'badge-error', 中: 'badge-warning', 低: 'badge-info' };
function levelOf(level: string): { label: string; cls: string } {
  const c = levelCode(level);
  return c ? { label: c, cls: LEVEL_BADGE[c] } : { label: String(level ?? '') || '—', cls: 'badge-neutral' };
}
const LEVEL_RANK: Record<'高' | '中' | '低', number> = { 高: 3, 中: 2, 低: 1 };
function levelRank(level: string): number {
  const c = levelCode(level);
  return c ? LEVEL_RANK[c] : 0;
}
/**
 * 名单默认按后端数组序 = 高年级低分和低年级高分混排，得自己扫。
 * 待处理按等级降序、同级按当前分升序（最该找的先找到）；已处理按处理时间倒序。
 */
const sortedAlerts = computed<AnalyticsAlert[]>(() => {
  const rows = data.value?.alerts ?? [];
  if (alertStatus.value === 'closed') {
    return [...rows].sort((a, b) => String(b.handledAt ?? '').localeCompare(String(a.handledAt ?? '')));
  }
  return [...rows].sort((a, b) => levelRank(b.level) - levelRank(a.level) || (a.score ?? 999) - (b.score ?? 999));
});
/** 名单当前页签里按姓名去重的学生数（用于在同一页签内把「行 / 人」说清） */
const alertRowStudents = computed(() => new Set(sortedAlerts.value.map(a => String(a.student ?? ''))).size);
/** 实测：summary.alertStudents / alertCount / alertDelta 恒为「待处理」口径，切到「已处理」页签时不随表变
 *  （`count(distinct student_id where status='open')`）⇒ 文案必须按页签分开写，否则会把两个集合当成同一集合对照 */
const alertCardTitle = computed(() => alertStatus.value === 'open'
  ? '待处理口径的去重学生数（后端 summary.alertStudents）：同一学生命中多条预警只计 1 人，所以它小于名单行数'
  : '这张卡始终是「待处理」口径的学生数，不随「已处理」页签变化；下方名单是已处理记录，两个集合不同，不能相减比对');
const alertCaliberNote = computed(() => alertStatus.value === 'open'
  ? `本表一行 = 一条待处理预警（现 ${sortedAlerts.value.length} 行，涉及 ${alertRowStudents.value} 名学生）；上方卡片按学生去重，两者不等不是数据错。名单不受 page/pageSize 影响，后端上限 200 条、超出静默截断且无 total。`
  : `本表一行 = 一条已处理预警（现 ${sortedAlerts.value.length} 行，涉及 ${alertRowStudents.value} 名学生）；上方「预警学生」仍是待处理口径（${data.value?.summary?.alertStudents ?? '—'} 人），与本页签不是同一集合。名单不受 page/pageSize 影响，后端上限 200 条、超出静默截断且无 total。`);
const alertSortHint = computed(() =>
  alertStatus.value === 'closed' ? '按处理时间最新在前' : '按等级高→低、同级按当前分低→高'
);

/* ---------- 导出报表：按当前筛选维度在前端生成 CSV ---------- */
/**
 * 后端 GET /api/v1/admin/export/report 只接 reportType/format/semester，不吃 deptId/major/courseId
 * ⇒ 用它导出的是整个学期口径，和屏上筛选后的数字对不上。
 * 改为导出页内已聚合的接口出参（同一份数据，不做二次加工）。
 */
const csvCell = (v: unknown): string => {
  let s = v === undefined || v === null ? '' : String(v);
  // 课程名/学生名/备注是库里的文本，写成 =1+1 或 -2+3 会被 Excel 当公式执行 ⇒ 前置单引号阻断
  // 2026-10-28 补：原正则只有 [=+@]，漏了 - 与制表/回车 —— 这三个同样是 Excel/Sheets 的公式起始符
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const csvRow = (cells: unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;

function buildCsv(): string {
  const d = data.value;
  const s = d?.summary;
  const closed = alertStatus.value === 'closed';
  const out: string[] = [];
  out.push(csvRow(['全校学情统计报表']));
  out.push(csvRow(['统计维度', dimBadge.value]));
  out.push(csvRow(['数据拉取时刻', loadedAt.value || '—']));
  out.push(csvRow([]));
  out.push(csvRow(['总览']));
  out.push(csvRow(['平均分', noScoreSample.value ? '—' : num(s?.avgScore), '及格率', noScoreSample.value ? '—' : num(s?.passRate, '%'), '当前上课课堂', s?.liveClassCount, '预警学生', s?.alertStudents]));
  out.push(csvRow(['课程数', s?.courseCount, '教师数', s?.teacherCount, '学生数', s?.studentCount, '已批改成绩', distTotal.value]));
  out.push(csvRow([]));
  out.push(csvRow(['课程分类统计']));
  out.push(csvRow(['类别', '课程数', '学生数', '平均分', '及格率']));
  for (const c of catRows.value) out.push(csvRow([catText(c.category), c.courseCount, c.studentCount, num(c.avgScore), num(c.passRate, '%')]));
  out.push(csvRow([]));
  out.push(csvRow(['分数段分布']));
  out.push(csvRow(['分数段', '份数']));
  for (const b of d?.distribution ?? []) out.push(csvRow([b.range, b.count]));
  out.push(csvRow([]));
  out.push(csvRow(['院系及格率对比']));
  out.push(csvRow(['院系', '及格率', '成绩份数', '样本偏少']));
  for (const x of d?.deptPassRates ?? []) out.push(csvRow([x.deptName, num(x.passRate, '%'), x.scoreCount, thinSample(x.scoreCount) ? '是' : '']));
  out.push(csvRow([]));
  out.push(csvRow(['课程及格率倒数 TOP']));
  out.push(csvRow(['课程', '院系', '平均分', '及格率', '成绩份数', '样本偏少']));
  for (const x of d?.courseRankings ?? []) out.push(csvRow([x.course, x.dept ?? '—', num(x.avgScore), num(x.passRate, '%'), x.scoreCount, thinSample(x.scoreCount) ? '是' : '']));
  out.push(csvRow([]));
  out.push(csvRow(['教师教学排行']));
  out.push(csvRow(['教师', '院系', '课程数', '批改份数', '平均分', '及格率']));
  for (const x of d?.teacherRankings ?? []) out.push(csvRow([x.teacher, x.dept ?? '—', x.courseCount, x.scoreCount, num(x.avgScore), num(x.passRate, '%')]));
  out.push(csvRow([]));
  out.push(csvRow(['备课与实验进度（教师明细）']));
  out.push(csvRow(['院系', '课程', '教师', '备课完成周', '备课总周', '实验完成次', '实验总次', '备课进度']));
  for (const x of d?.prepDetails ?? []) out.push(csvRow([x.dept, x.course, x.teacher, x.prepDone, x.prepTotal, x.expDone, x.expTotal, `${pct(x.prepDone, x.prepTotal)}%`]));
  out.push(csvRow([]));
  out.push(csvRow(['当前上课课堂']));
  out.push(csvRow(['课程', '教师', '教室', '节次', '在线学生']));
  for (const x of d?.liveClasses ?? []) out.push(csvRow([x.course, x.teacher, x.room, x.slot, x.online]));
  out.push(csvRow([]));
  out.push(csvRow([`预警名单（${closed ? '已处理' : '待处理'}）`]));
  out.push(csvRow(['学生', '课程', '院系', '类型', '当前分', '等级', closed ? '处理时间' : '状态', closed ? '处理备注' : '']));
  for (const x of sortedAlerts.value) out.push(csvRow([x.student, x.course, x.dept, x.type, x.score, levelOf(x.level).label, closed ? x.handledAt ?? '—' : x.status ?? 'open', closed ? x.handleNote ?? '' : '']));
  return out.join('');
}
/** 文件名带筛选维度，避免导出后分不清是哪一份口径 */
function csvFileName(): string {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const dim = dimBadge.value.replace(/[\s·]+/g, '_').replace(/[\\/:*?"<>|]/g, '');
  return `全校学情_${dim}_${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.csv`;
}
function onExport() {
  if (!data.value) {
    ElMessage.warning('当前没有可导出的数据，请先重新加载');
    return;
  }
  /* 口径一致性门禁：筛选一变 dimBadge 立刻变，但 data 要等接口回来。
     这两个不同步时导出，CSV 首行写新维度、数据是旧全量 —— 2026-10-28 实测复现过。
     loading 单独挡不住 150ms 防抖窗口（reloadSoon 还没把 loading 置 true），所以以维度快照为准。 */
  if (loading.value || loadedDim.value !== dimSnapshot()) {
    ElMessage.warning('筛选已变更但数据还没刷新完，请等加载完成后再导出');
    return;
  }
  // BOM 不能省：没有它 Excel 直接双击打开中文 CSV 会乱码
  const blob = new Blob(['\ufeff', buildCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName();
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('报表已按当前筛选维度生成');
}

onMounted(async () => {
  await Promise.all([load(), loadPickers()]);
});
</script>

<template>
  <div class="page-head">
    <h1>全校学情统计看板</h1>
    <div class="actions">
      <button class="btn btn-outline" title="按上方筛选维度导出本页全部表格数据（CSV）" @click="onExport">
        <ZkIcon name="download" :size="16" style="margin-right: 4px" />导出当前筛选报表
      </button>
    </div>
  </div>

  <div v-loading="loading" class="analytics-body">
    <!-- 筛选条：学期 / 院系 / 专业 / 课程（需求三维=学期/院系/课程 + 追加专业，10-20 拍板都留；
         院系 = 任课教师所属部门（sys_dept），后端 deptId 过滤；school 表只有一所大学，学校维度无筛选价值已隐藏 -->
    <div class="card card-pad filter-bar">
      <span class="small muted">统计维度</span>
      <el-select v-model="filters.termId" class="f-sel" placeholder="学期" filterable>
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="String(t.termId)" />
      </el-select>
      <el-select v-model="filters.deptId" class="f-sel" placeholder="全部院系" clearable filterable title="按任课教师所属院系筛选（sys_dept），不是学生院系；口径 10-26 已与后端确认">
        <el-option v-for="d in depts" :key="d.deptId" :label="d.name" :value="String(d.deptId)" />
      </el-select>
      <!-- 专业：与智能排课页同维度；course.major 是文本列，按专业名过滤
           10-28 更正：原 title 写「演示库当前没有课程-专业关联数据，选中后各块为空」已失实
           （10-20 补种 major 后 course.major 已有值：全部学期下「计算机科学与技术」命中 7 门课 / 64 份已批改成绩）。
           这里只写机制、不写具体门数与份数 —— 数字会随补种与学期筛选漂移，写死一次就等着下次失实。 -->
      <el-select v-model="filters.major" class="f-sel" placeholder="全部专业" clearable filterable title="按课程的专业（course.major 文本列）过滤；演示库已有课程关联到专业，选中后各块正常出数">
        <el-option v-for="m in majors" :key="m" :label="m" :value="m" />
      </el-select>
      <!-- 课程：需求文档（三级功能清单+原型）的第三维；按 course.course_id 过滤 -->
      <el-select v-model="filters.courseId" class="f-sel" placeholder="全部课程" clearable filterable>
        <el-option v-for="c in courses" :key="c.courseId" :label="c.name" :value="String(c.courseId)" />
      </el-select>
      <span class="badge badge-info dim-badge">{{ dimBadge }}</span>
    </div>

    <template v-if="data">
      <!-- 统计卡：平均分 / 及格率 / 当前上课课堂 / 预警学生 -->
      <div class="grid g4 mt16 cards">
        <div v-for="c in STAT_CARDS" :key="c.key" class="card stat">
          <div class="label">
            <ZkIcon :name="c.icon" :size="13" style="vertical-align: -2px; margin-right: 4px" />{{ c.label }}
          </div>
          <div
            class="num"
            :style="c.key === 'live' ? 'color:var(--brand-600)' : ''"
            :title="c.key === 'alert' ? alertCardTitle : ''"
          >
            {{
              c.key === 'avg'
                ? (noScoreSample ? '—' : num(data.summary?.avgScore))
                : c.key === 'pass'
                  ? (noScoreSample ? '—' : num(data.summary?.passRate, '%'))
                  : c.key === 'live'
                    ? (data.summary?.liveClassCount ?? '—')
                    : (data.summary?.alertStudents ?? '—')
            }}
          </div>
          <div v-if="trendOf(c)" class="trend" :class="trendOf(c)!.cls">{{ trendOf(c)!.text }}</div>
        </div>
      </div>
      <div v-if="coverage" class="cov-line small muted">{{ coverage }}</div>
      <!-- 后端 10-26 已确认并落地：院系 = 任课教师所属院系，且 deptId/major/courseId 已下推到成绩类聚合 ⇒ 这行从「临时口径声明」转为常驻定义 -->
      <div class="scope-note small">
        本页的「院系」按<b>任课教师所属院系</b>计（后端 course → teacher_id → sys_user.dept_id → sys_dept，10-26 确认），<b>不是学生院系</b>；筛选中的院系/专业/课程会同时下推到平均分、及格率、分数段、两张排行与预警名单，各块同口径。
      </div>

      <!-- 课程分类统计 + 成绩分布 -->
      <div class="grid g2 mt16 pair">
        <div class="card">
          <div class="card-pad"><div class="card-title">课程分类统计（按课程类别）</div></div>
          <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr><th>#</th><th>类别</th><th>课程数</th><th>学生数</th><th>平均分</th><th>及格率</th></tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in catRows" :key="c.category">
                <td class="muted">{{ i + 1 }}</td>
                <td><span class="badge" :class="catCls(i)">{{ catText(c.category) }}</span></td>
                <td>{{ c.courseCount }}</td>
                <td>{{ c.studentCount }}</td>
                <td>{{ num(c.avgScore) }}</td>
                <td>{{ num(c.passRate, '%' ) }}</td>
              </tr>
              <tr v-if="!catRows.length">
                <td colspan="6" class="center muted" style="padding: 24px">当前筛选范围内没有课程</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-title">院系及格率对比</div>
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
              <div v-for="d in data.deptPassRates ?? []" :key="d.deptId" class="dp-row" :class="{ thin: thinSample(d.scoreCount) }">
                <span class="dp-name" :title="d.deptName">{{ d.deptName }}</span>
                <div class="dp-track"><i :style="{ width: dpW(d.passRate) + '%' }" :class="{ low: d.passRate < 60 }"></i></div>
                <span class="dp-num" :class="{ low: d.passRate < 60 }">{{ num(d.passRate, '%') }}</span>
                <span class="dp-cnt" :class="{ warn: thinSample(d.scoreCount) }" :title="thinSample(d.scoreCount) ? `仅 ${d.scoreCount} 份成绩，及格率不稳` : ''">{{ d.scoreCount }} 份</span>
              </div>
            </template>
          </div>
          <div v-if="data.deptPassRates?.length" class="caliber small muted">院系列 = 任课教师所属院系（非学生院系）；条长 = 及格率；份数 &lt;{{ SMALL_N }} 的行标<span class="cnt-warn">橙色的份数</span>并降条不透明度。</div>
        </div>
      </div>

      <!-- 分数段分布 + 课程及格率倒数 TOP（对标主流教务大屏的薄弱课定位） -->
      <div class="grid g2 mt16 pair">
        <div class="card card-pad">
          <div class="between" style="margin-bottom: 6px">
            <div class="card-title">分数段分布</div>
            <span class="small muted">共 {{ distTotal }} 份已批改成绩</span>
          </div>
          <div v-if="distTotal > 0" class="score-bands">
            <div v-for="b in data.distribution ?? []" :key="b.range" class="band-col">
              <span class="band-num">{{ b.count }}</span>
              <div class="band-track">
                <i :class="bandCls(b.range)" :style="{ height: bandH(b.count) + '%' }"></i>
              </div>
              <span class="band-label" :class="{ fail: failBand(b.range) }">{{ b.range }}</span>
            </div>
          </div>
          <div v-if="distTotal > 0" class="caliber small muted">{{ failBandText }}。</div>
          <div v-else class="empty" style="padding: 22px 10px">
            <span class="empty-icon"><ZkIcon name="bar-chart-3" :size="22" /></span>
            <p class="empty-main">暂无已批改成绩</p>
            <p class="empty-sub">教师批改作业后，这里会按 &lt;60 / 60-70 / … / 90-100 五档展示分布</p>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-title">课程及格率倒数 TOP5（薄弱课程）</div>
          <div v-if="courseRanks.length" class="dept-pass" style="padding-top: 10px">
            <div v-for="c in courseRanks" :key="c.courseId" class="dp-row" :class="{ thin: thinSample(c.scoreCount) }">
              <span class="dp-name" :title="c.course">{{ c.course }}</span>
              <div class="dp-track"><i class="low" :style="{ width: dpW(c.passRate) + '%' }"></i></div>
              <span class="dp-num low">{{ num(c.passRate, '%') }}</span>
              <span class="dp-cnt" :class="{ warn: thinSample(c.scoreCount) }" :title="thinSample(c.scoreCount) ? `仅 ${c.scoreCount} 份成绩，及格率不稳` : ''">{{ c.scoreCount }} 份</span>
            </div>
          </div>
          <div v-if="courseRanks.length" class="caliber small muted">倒数 TOP 按及格率升序；份数 &lt;{{ SMALL_N }} 的课程橙色标记，先确认是不是刚开课。</div>
          <div v-else class="empty" style="padding: 22px 10px">
            <span class="empty-icon ok"><ZkIcon name="shield-check" :size="22" /></span>
            <p class="empty-main">暂无薄弱课程数据</p>
            <p class="empty-sub">有已批改成绩后，及格率最低的课程会排在这里</p>
          </div>
        </div>
      </div>

      <!-- 教师教学排行（批改份数降序）：教务处看工作量与教学效果 -->
      <div class="card mt16">
        <div class="card-pad between">
          <div class="card-title">教师教学排行（按批改份数）</div>
          <span class="small muted">口径：已批改作业成绩；及格率 = 及格份数 ÷ 批改份数</span>
        </div>
        <div v-if="teacherRanks.length" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th>#</th><th>教师</th><th title="任课教师所属院系（非学生院系）">院系</th><th>课程数</th><th>批改份数</th><th>平均分</th><th>及格率</th></tr>
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
        </div>
        <div v-else class="empty" style="padding: 22px 10px">
          <span class="empty-icon"><ZkIcon name="users" :size="22" /></span>
          <p class="empty-main">暂无教师批改数据</p>
          <p class="empty-sub">教师批改作业后，这里会按批改份数展示教学排行</p>
        </div>
      </div>

      <!-- 备课与实验进度监控（按院系 / 按课程，点击行下钻教师明细） -->
      <div class="card mt16">
        <div class="card-pad between">
          <div class="card-title">备课与实验进度监控（{{ prepDim === 'dept' ? '按院系' : '按课程' }}）</div>
          <span class="row" style="gap: 10px">
            <span class="pilltabs">
              <span class="pill" role="button" tabindex="0" :class="{ active: prepDim === 'dept' }" :aria-pressed="prepDim === 'dept'" @click="switchPrep('dept')" @keydown.enter.prevent="switchPrep('dept')" @keydown.space.prevent="switchPrep('dept')">按院系</span>
              <span class="pill" role="button" tabindex="0" :class="{ active: prepDim === 'course' }" :aria-pressed="prepDim === 'course'" @click="switchPrep('course')" @keydown.enter.prevent="switchPrep('course')" @keydown.space.prevent="switchPrep('course')">按课程</span>
            </span>
            <span class="small muted">点击行可下钻查看教师明细</span>
          </span>
        </div>
        <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr v-if="prepDim === 'dept'">
              <th>#</th><th title="任课教师所属院系（非学生院系）">院系</th><th>课程数</th><th>教师数</th><th>备课进度</th><th>实验进度</th><th>滞后课程</th><th>状态</th>
            </tr>
            <tr v-else>
              <th>#</th><th>课程</th><th title="任课教师所属院系（非学生院系）">院系</th><th>任课教师</th><th>备课进度</th><th>实验进度</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(g, gi) in prepAggs" :key="g.key">
              <tr class="prep-main" @click="togglePrep(g.key)">
                <td class="muted">{{ gi + 1 }}</td>
                <td>
                  <div class="row" style="gap: 6px">
                    <!-- ZkIcon 没有登记 chevron-down（画出来是空框），改用一个图标 + 旋转变体。
                         行本身不可聚焦（tr 没有键盘语义），展开做成真按钮：Tab 能走到、Enter/Space 能开合 -->
                    <button class="chev" type="button" :class="{ open: prepOpen[g.key] }" :aria-expanded="!!prepOpen[g.key]"
                      :aria-label="(prepOpen[g.key] ? '收起' : '展开') + g.key + '的教师明细'" @click.stop="togglePrep(g.key)"><ZkIcon name="chevron-right" :size="14" /></button>
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
                <td :colspan="prepDim === 'dept' ? 8 : 7" style="background: var(--bg-subtle); padding: 0">
                  <div style="padding: 12px 18px">
                    <div class="small muted" style="margin-bottom: 8px">教师明细（{{ drillRows(g).length }} 条）</div>
                    <table class="tbl drill-tbl">
                      <thead>
                        <tr><th>#</th><th>教师</th><th>课程</th><th>备课进度</th><th>实验进度</th><th>状态</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(d, di) in drillRows(g)" :key="d.teacher + d.course">
                          <td class="muted">{{ di + 1 }}</td>
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
              <td :colspan="prepDim === 'dept' ? 8 : 7" class="center muted" style="padding: 24px">当前筛选条件下无数据</td>
            </tr>
          </tbody>
        </table>
        </div>
        <div class="between" style="padding: 12px 16px">
          <span class="small muted">共 {{ prepAggs.length }} 个{{ prepDim === 'dept' ? '院系' : '课程' }}（点击行下钻教师明细）</span>
          <span class="small muted">按备课完成率升序排列（滞后在前）· 数据随本页聚合拉取{{ loadedAt ? `，${loadedAt}` : '' }}</span>
        </div>
      </div>

      <!-- 当前上课课堂 + 成绩趋势 / 实验完成率 -->
      <div class="grid mt16 live-grid">
        <div class="card">
          <div class="card-pad between">
            <div class="card-title">当前上课课堂（{{ loadedAt ? `${loadedAt} 拉取` : '当次拉取' }} · {{ data.liveClasses?.length ?? 0 }} 个）</div>
            <span class="row" style="gap: 8px">
              <span class="badge badge-neutral" title="数据来自一次聚合请求，没有推送、不会自己变；要更新请点右侧刷新">非实时</span>
              <button class="btn btn-outline btn-sm" :disabled="loading" @click="load">
                <ZkIcon name="refresh-cw" :size="12" style="vertical-align: -2px; margin-right: 2px" />刷新
              </button>
            </span>
          </div>
          <div v-if="data.liveClasses?.length" class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr><th>#</th><th>课程</th><th>教师</th><th>教室</th><th>节次</th><th>在线学生</th></tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in data.liveClasses ?? []" :key="i">
                <td class="muted">{{ i + 1 }}</td>
                <td>{{ l.course || '—' }}</td>
                <td>{{ l.teacher || '—' }}</td>
                <td>{{ l.room || '—' }}</td>
                <td>{{ l.slot || '—' }}</td>
                <td>{{ l.online || '—' }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          <!-- 空态：说明"功能在、只是此刻没课"，避免空表格显得破 -->
          <div v-else class="empty">
            <span class="empty-icon"><ZkIcon name="calendar-days" :size="22" /></span>
            <p class="empty-main">当前没有正在进行的课堂</p>
            <p class="small muted">只在有课堂处于上课状态时显示列表，可切换学期或院系查看其他时段</p>
          </div>
        </div>
        <div class="card card-pad">
          <div class="between" style="align-items: baseline; margin-bottom: 4px">
            <!-- 原标题写「近 {{ trend.length }} 周」是错的：后端统计窗口固定近 8 周（TREND_WEEKS=8），
                 但 group by weekofyear 只返回「有提交的周」⇒ length 是采样点数，不是时间窗长度。
                 2026-10-28 实测：窗口 8 周，标题写「近 6 周」，用户会以为只统计了 6 周。
                 改成直说采样周数；无数据时不写「近 0 周」那种自相矛盾的话。 -->
            <div class="card-title">成绩趋势（{{ data.trend?.length ? `${data.trend.length} 个有数据的周` : '暂无数据' }}）</div>
            <span class="small muted">纵轴：周平均分</span>
          </div>
          <svg v-if="trendPts" viewBox="0 0 400 200" style="width: 100%; height: auto">
            <line x1="30" y1="10" x2="30" y2="160" stroke="#e3eaec" />
            <line x1="30" y1="160" x2="390" y2="160" stroke="#e3eaec" />
            <g stroke="#f1f5f6">
              <line v-for="g in trendPts.grid" :key="g.y" x1="30" :y1="g.y" x2="390" :y2="g.y" />
            </g>
            <!-- viewBox 400 宽 + width:100% ⇒ 字号是随卡片缩放的用户单位。原来写 9/10，实测渲染只有 7~8px 且 fill 用 ink-400（2.56:1），
                 轴标签既看不清也读不出值 ⇒ 提到 13 单位（渲染约 10.5px）+ ink-500（4.76:1） -->
            <g font-size="13" fill="#64748b" text-anchor="end">
              <text v-for="g in trendPts.grid" :key="'v' + g.y" x="27" :y="g.y + 4">{{ g.v }}</text>
            </g>
            <polyline :points="trendPts.line" fill="none" stroke="#0d9488" stroke-width="2.5" stroke-linecap="round" />
            <g fill="#0d9488">
              <circle v-for="d in trendPts.dots" :key="d.week" :cx="d.cx" :cy="d.cy" r="3.5" />
            </g>
            <g font-size="13" fill="#64748b">
              <text v-for="d in trendPts.dots" :key="'t' + d.week" :x="d.cx - 9" y="178">{{ d.week }}</text>
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
          <!-- 后端 experimentRate = published<=0 ? 0 : done/published*100（AdminStatsServiceImpl.java:211-216），
               且出参不带 published 数 ⇒ 前端分不出「没有已发布实验任务」与「有任务但无人提交」，
               两者都渲染成 0%。不补假数据，改成把这条限制写在环下面。 -->
          <p v-if="!data.experimentRate" class="small muted" style="text-align: center; margin-top: 4px">
            0% 无法区分「本学期没有已发布实验任务」与「有任务但无人提交」
          </p>
        </div>
      </div>

      <!-- 预警名单（闭环：待处理可标记已处理，已处理留痕） -->
      <div class="card mt16">
        <div class="card-pad between">
          <div class="card-title">预警名单（低分 / 退步 / 未提交）</div>
          <span class="row" style="gap: 10px">
            <span class="small muted">{{ alertSortHint }}</span>
            <span class="pilltabs">
              <span class="pill" role="button" tabindex="0" :class="{ active: alertStatus === 'open' }" :aria-pressed="alertStatus === 'open'" @click="alertStatus = 'open'" @keydown.enter.prevent="alertStatus = 'open'" @keydown.space.prevent="alertStatus = 'open'">待处理</span>
              <span class="pill" role="button" tabindex="0" :class="{ active: alertStatus === 'closed' }" :aria-pressed="alertStatus === 'closed'" @click="alertStatus = 'closed'" @keydown.enter.prevent="alertStatus = 'closed'" @keydown.space.prevent="alertStatus = 'closed'">已处理</span>
            </span>
          </span>
        </div>
        <div v-if="sortedAlerts.length" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>#</th><th>学生</th><th>课程</th><th title="任课教师所属院系（非学生院系）">院系</th><th>类型</th><th>当前分</th><th>等级</th>
              <th>{{ alertStatus === 'open' ? '操作' : '处理时间' }}</th>
              <th v-if="alertStatus === 'closed'">处理备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(a, ai) in sortedAlerts" :key="a.alertId ?? (a.student + a.course)">
              <td class="muted">{{ ai + 1 }}</td>
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
              <td v-if="alertStatus === 'closed'" class="small muted note-cell" :title="a.handleNote || ''">{{ a.handleNote || '—' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
        <!-- 空态：待处理无预警是好事（正向文案）；已处理为空是普通无数据 -->
        <div v-else class="empty">
          <span class="empty-icon" :class="{ ok: alertStatus === 'open' }"><ZkIcon :name="alertStatus === 'open' ? 'shield-check' : 'badge-check'" :size="22" /></span>
          <p class="empty-main">{{ alertStatus === 'open' ? '当前筛选范围内没有触发预警的学生' : '还没有已处理的预警记录' }}</p>
          <p class="small muted">{{ alertStatus === 'open' ? '低分、成绩退步、连续未提交的学生会自动出现在这里' : '在「待处理」里点击「标记已处理」后，记录会留痕在这里' }}</p>
        </div>
        <!-- 编号 51/15 的屏上交代：卡片是「人」，名单是「条」；名单不分页、有 200 条静默截断上限。放在表格之后，与本页其它 .caliber 同位（放表头与表之间会把 card-head 间距顶成 26px） -->
        <div v-if="sortedAlerts.length" class="caliber small muted">{{ alertCaliberNote }}</div>
      </div>
    </template>

    <!-- 接口失败 / 无数据：页内缺口提示（不裸报红）。
         2026-10-28 交付前复查：原来两种情况共用一句「学情数据加载失败或暂无数据」，
         用户看不出是网络/登录问题还是真的没数据，也看不到后端返回了什么 ⇒ 按 loadError 分流。 -->
    <div v-else-if="!loading" class="card card-pad center" style="padding: 48px">
      <template v-if="loadError">
        <p class="empty-main">学情数据读取失败</p>
        <p class="small muted" style="margin-top: 6px">{{ loadError }}</p>
        <p class="small muted" style="margin-top: 6px">若反复失败，先确认登录未过期、后端 8080 与数据库隧道都在。</p>
      </template>
      <template v-else>
        <p class="empty-main">当前筛选范围内没有可比对的数据</p>
        <p class="small muted" style="margin-top: 6px">试试放宽筛选（清空院系 / 专业 / 课程），或换一个学期。</p>
      </template>
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
  /* ink-500 压在 --bg-50 灰底上实测 4.44:1，差 0.06 不到 AA ⇒ 提到 ink-700（7.07:1） */
  color: var(--ink-700, #475569);
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
  flex: 0 0 clamp(72px, 11vw, 118px);
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
  /* 「51 份」是份数分母，不是装饰：原 11px + ink-400 在白底实测 2.56:1，读不清 ⇒ 12px + ink-500（4.76:1，AA） */
  font-size: 12px;
  color: var(--ink-500, #64748b);
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
/* 筛选下拉：定宽改弹性，窄屏不溢出（原先是四个内联 px 宽） */
.f-sel {
  width: clamp(150px, 17vw, 200px);
}
/* 「全部院系/全部专业/全部课程」是未筛选时的口径文案，不是输入提示 ⇒ EP 默认 2.56:1 读不清，提到与 .muted 同一档 */
.filter-bar :deep(.el-select__placeholder.is-transparent) {
  color: var(--ink-500, #64748b);
}
/* 卡区口径脚注：给百分比一个分母 */
.cov-line {
  margin-top: 8px;
  padding-left: 2px;
}
/* 口径提示：写在屏上而不是等别人来问「为什么筛了院系数字没变」。文字用 ink-700 压浅琥珀底，实测对比度 >7:1 */
.scope-note {
  margin-top: 10px;
  padding: 9px 12px;
  color: var(--ink-700, #475569);
  background: rgba(180, 83, 9, 0.07);
  border-left: 3px solid #b45309;
  border-radius: 6px;
  line-height: 1.65;
}
/* 口径行：条长/颜色/排序的读法写在图下面，不靠读者猜 */
.caliber {
  margin-top: 8px;
  line-height: 1.6;
}
.cnt-warn {
  display: inline-block;
  padding: 0 4px;
  margin: 0 3px;
  border-radius: 4px;
  /* 橙色小 chips 压在 10% 琥珀底上，原 #d97706 只有 2.86:1 ⇒ 同族加深到 amber-700（4.52:1） */
  color: #b45309;
  background: rgba(217, 119, 6, 0.1);
}
/* ZkIcon 未登记 chevron-down（会渲染成空框），下钻箭头用一个图标 + 旋转 */
.chev {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-400);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.chev.open {
  transform: rotate(90deg);
}
/* 全局样式没有任何 :focus-visible 规则 ⇒ 自定义控件的焦点环得本页自己给，否则键盘用户看不见自己在哪 */
.chev:focus-visible,
.pill:focus-visible {
  outline: 2px solid var(--brand-600, #2563eb);
  outline-offset: 2px;
}
.pill:focus-visible {
  border-radius: var(--r-full, 999px);
}
.dp-row.thin .dp-track i {
  opacity: 0.45;
}
.dp-cnt.warn {
  /* #d97706 在白底只有 3.19:1 ⇒ 加深到 amber-700（5.02:1） */
  color: #b45309;
  font-weight: 600;
}
.band-label.fail {
  color: #dc2626;
  font-weight: 600;
}
/* 分数段档位解析不出数字时的兜底灰（后端换档名也不至于是白柱） */
.band-na {
  background: var(--ink-400, #94a3b8);
}
/* 处理备注列：折行显示，长备注不再顶开整行 */
.note-cell {
  max-width: 240px;
  white-space: normal;
  word-break: break-word;
  line-height: 1.5;
}
/* 表格宽度由列内容决定，窄屏不会自己缩 ⇒ 每张表套一层横滚容器，溢出留在卡内、不顶穿页面 */
.tbl-wrap {
  overflow-x: auto;
}
/* 窄屏回落：全局只把 .g4 兜到 1100px 两列，.g2 没有兜底 ⇒ 本页自己收 */
@media (max-width: 1000px) {
  .pair {
    grid-template-columns: 1fr;
  }
}
/* 表卡页眉 = .card > .card-pad（图表卡是 .card.card-pad 整体内缩，不匹配这条）。
   全局 .card-title 自带 margin-bottom:12px，与页眉 padding-bottom:18px 叠加后 5 张表卡的「标题→表格」实测 30/26/18/20/18 不一 ⇒ 归零，留白只由 padding 决定 */
.card > .card-pad > .card-title {
  margin-bottom: 0;
}
/* 网格子项默认 min-width:auto ⇒ 轨道被卡片内容的 min-content 顶宽（400px 视口下实测 .pair 轨道 290px、.card-title 画到 x=523 出视口）。
   放开最小宽度后轨道能缩回容器，宽表退回 .tbl-wrap 里横滚 */
.cards > *,
.pair > *,
.live-grid > * {
  min-width: 0;
}
@media (max-width: 620px) {
  .cards {
    grid-template-columns: 1fr;
  }
  .filter-bar .dim-badge {
    margin-left: 0;
  }
}
@media (max-width: 560px) {
  .score-bands {
    gap: 6px;
  }
  .band-track {
    max-width: 34px;
  }
}
</style>
