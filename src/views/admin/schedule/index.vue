<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { createSchedule, deleteSchedule, listCoursePool, listSchedules, moveSchedule, publishSchedules, swapSchedules } from '@/api/admin/schedules';
import type { ScheduleCreateBody, ScheduleSwapBody, ScheduleUpdateBody } from '@/api/admin/schedules';
import { deleteCourse } from '@/api/admin/courses';
import { listClasses, listClassrooms, listMajors, listSchools, listTerms, updateClassroom } from '@/api/admin/basicdata';
import { listUsers } from '@/api/admin/users';
import { listPeriods } from '@/api/admin/periods';
import type { Classroom, CourseBrief, ScheduleCell } from '@/types/admin';

/**
 * 节次表（★ 已不是常量——主数据源是 GET /api/v1/admin/periods，见 loadPeriods）。
 * 下面这份是**兜底初值**：接口不可用时（10-26 运行包无此端点、或后端故障）页面照常渲染，
 * 数据与库内现值一致（10-28 后端线 D1 已把库对齐到 110 分钟口径）；接口可用后兜底永不触发。
 * 换成 reactive 而不是 ref：本文件 22 处使用点（grid 的 PERIODS.map、节次上下导航的
 * findIndex/find、文案拼接）全部按普通数组写法消费，reactive 数组不必改任何一行；
 * 整体替换必须用 splice（reactive 代理不能重新赋值，赋了就丢响应）。
 * 旧注释留档：时间由业务方给出每段 110 分钟；库里原值 08:30/95 分钟曾与这里不一致，
 * 10-28 起两边都是 110 口径，且以接口为准后此注释只剩历史意义。
 */
const PERIODS = reactive([
  { seq: 1, label: '1-2 节', start: '08:00', end: '09:50', duration: 110, evening: false },
  { seq: 2, label: '3-4 节', start: '10:10', end: '12:00', duration: 110, evening: false },
  { seq: 3, label: '5-6 节', start: '14:30', end: '16:20', duration: 110, evening: false },
  { seq: 4, label: '7-8 节', start: '16:40', end: '18:30', duration: 110, evening: false },
  { seq: 5, label: '9-10 节', start: '19:00', end: '20:50', duration: 110, evening: true }
]);

/* ---------------- 节次配置加载（接口主源 + 兜底回落，施工项 #3）----------------
 * 为什么要回落而不是报错：/api/v1/admin/periods 是后端 10-28 新增端点，8080 的运行包
 * （10-26）里还没有 ⇒ 换包前这个请求**必然**拿到 "No static resource"。排课页是演示
 * 重点页，节次行结构（grid）直接由 PERIODS 驱动，报错方案会让页面在换包前一直不可用；
 * 兜底值与库内现值一致（后端线 D1 已对齐 110 口径），回落期间演示无感。
 * 接口可用后回落分支永不触发；届时若库内再调节次时间，前端零改动。
 *
 * ★ 映射键是 seq：课次数据的 periodNo（数字）对应接口的 seq；
 *   接口的 periodNo 是 "1-2" 展示串，不是键——按字面用它映射会全部 miss（实测样本可查）。
 *
 * ★ 失效条件（2026-10-29 复核补充）：接口只返回 status=1 的启用行（PeriodVo 刻意不返回 status，
 *   理由见后端 AdminPeriod 注释）。若某行节次被停用：接口返 4 行 ⇒ 网格 4 行，但该 seq 名下的
 *   历史课次仍在 cellMap 里收集（按课次 weekday+periodNo 建键，与 PERIODS 无关），
 *   于是这批课次在网格上**没有对应的行可画** —— 表现为「课次不显示」，不是数据被删。
 *   当前库 class_period 5 行全启用（10-29 实测），不触发；真要停用某节次，须先清理该 seq 的课次。
 */
const periodsFallback = ref(true);
const PERIODS_FALLBACK_TIP = '节次时段为本地默认值（节次接口暂不可用），如与教务实际作息不符请以后者为准';

/** "HH:mm" 差值分钟数；跨午夜的节次按 0 处理并留给调用方兜底（当前业务不存在跨午夜段） */
function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff > 0 ? diff : 0;
}

async function loadPeriods() {
  try {
    const res = await listPeriods({ page: 1, pageSize: 10 });
    const rows = (res?.list ?? [])
      .filter(p => p && p.seq != null && p.startTime && p.endTime)
      .map(p => {
        const startHour = Number(String(p.startTime).slice(0, 2));
        return {
          seq: Number(p.seq),
          label: p.periodName,
          start: p.startTime,
          end: p.endTime,
          // 接口没有 duration 字段 ⇒ 由起止时间实算（拖动冲突检查的 durationMin 消费）
          duration: minutesBetween(p.startTime, p.endTime),
          // 接口没有 evening 字段 ⇒ 推导：晚课段命名带"晚"（现库口径），或开始时间在 19 点后。
          // 失效条件：业务把晚课挪到 19 点前开始且改名 ⇒ 需后端补 evening 字段，别再猜。
          evening: p.periodName.includes('晚') || startHour >= 19
        };
      })
      .sort((a, b) => a.seq - b.seq); // 节次上下导航（findIndex ± 1）依赖数组有序，不能信后端返回序
    if (!rows.length) throw new Error('节次列表为空');
    PERIODS.splice(0, PERIODS.length, ...rows);
    periodsFallback.value = false;
  } catch {
    /* 保持兜底初值不动；静默降级 + 顶部提示条说明，不弹 toast（页面照常可用的降级不值得打断） */
    periodsFallback.value = true;
  }
}
const WEEKDAYS = [
  { v: 1, label: '周一' },
  { v: 2, label: '周二' },
  { v: 3, label: '周三' },
  { v: 4, label: '周四' },
  { v: 5, label: '周五' }
];
const CN = '一二三四五六日';
const timeRange = (p: { start: string; end: string }) => `${p.start}–${p.end}`;
/** 一周课次一般几十条；给足 pageSize，避免被后端默认 50 截断 */
const PAGE_SIZE = 200;

const pad = (n: number) => `${n}`.padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function mondayOf(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

const weekStart = ref(mondayOf(new Date()));
const weekStartStr = computed(() => fmt(weekStart.value));
/** 当前显示周的日期范围文案（周一 ~ 周日）：跨年时两端都带年份 */
const weekRangeLabel = computed(() => {
  const s = weekStart.value;
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  if (s.getFullYear() !== e.getFullYear()) {
    return `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getFullYear()}年${e.getMonth() + 1}月${e.getDate()}日`;
  }
  return `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`;
});
const weekEndStr = computed(() => {
  const e = new Date(weekStart.value);
  e.setDate(e.getDate() + 6);
  return fmt(e);
});

const allCells = ref<ScheduleCell[]>([]);
const loading = ref(false);
/**
 * ★ 为什么和 loading 分开：落库后的**回读**要用「可见但不阻挡」的遮罩。
 * 用户反馈"有时候按住拖动不了"，实测根因是刷新时 Element Plus 的 `.el-loading-mask`
 * （rgba(255,255,255,.9)、z-index 2000、**pointer-events: auto**、覆盖整块课表）
 * 把 mousedown 全部吃掉 ⇒ dragstart 根本不会触发（CDP 实测：顶点=el-loading-mask、只有 mousedown）。
 * 用户最容易撞上的时刻，恰恰是"刚拖完一节、马上拖下一节"——那时正在回读。
 * 而首次加载 / 切周是**整体替换**，保留阻挡：否则会被人把旧周的课拖到新周日期的格子上。
 */
const refreshing = ref(false);
/** 读取失败标记：区分「接口挂了导致的空表」与「真的没课」。
 *  旧写法 catch 里只清数据，两种空在界面上长得一样，用户只能猜（2026-10-22 复盘缺陷 2）。 */
const loadError = ref(false);
const filters = reactive({ courseId: '', teacherId: '', clazzName: '', classroomId: '', major: '', termId: '', schoolId: '' });
/** 任一维度处于筛选中 ⇒ 工具栏出现「清空筛选」总入口 */
const anyFilter = computed(() => Object.values(filters).some(v => v !== ''));
function clearFilters() {
  filters.courseId = '';
  filters.teacherId = '';
  filters.clazzName = '';
  filters.classroomId = '';
  filters.major = '';
  filters.termId = '';
  filters.schoolId = '';
  // 学期清空会经 watcher 再 load 一次；非空时这次 load 就是把服务端过滤撤掉的那一次
  void load();
}
// termId/schoolId 用 string：基础数据主键 10-28 起后端字符串化（@JsonFormat STRING），19 位雪花 id 用 number 会截断
/** 学期下拉（后端 ScheduleQueryBo 支持 termId 过滤 ⇒ 服务端筛，变化即重查）；
 *  startDate/endDate 用于「学期第 N 周」标注（2026-10-21） */
const terms = ref<{ termId: string; name: string; startDate?: string; endDate?: string }[]>([]);
/** 学校列表（基础数据 school 表，学校级）：≥2 个才显示学校筛选，单校无筛选意义 */
const schools = ref<{ schoolId: string; name: string }[]>([]);
/** 班级名 → 专业名 映射（schedule.target_class 是冗余字符串、无 clazzId 外键，
 *  专业信息只能借基础数据的班级列表接口按名称映射） */
const clazzMajorMap = ref<Record<string, string>>({});

/**
 * 拉取本周课次。
 * @param soft 落库后的回读（同周同筛选，只是重读一遍）⇒ 遮罩不阻挡；否则整体替换 ⇒ 遮罩阻挡。
 */
/** 请求序号：翻周 / 换筛选会并发多个 load，只让最后一次的结果落盘（旧响应后到会盖掉新周的数据） */
let loadSeq = 0;
async function load(soft = false) {
  const my = ++loadSeq;
  if (soft) refreshing.value = true;
  else {
    loading.value = true;
    // 周或口径变了就先清掉上一批：不清的话摘要条会继续挂着上一周的人数，看起来像"数据没变"
    allCells.value = [];
    returnedCells.value = [];
  }
  loadError.value = false;
  try {
    const res = await listSchedules({
      startDate: weekStartStr.value,
      endDate: weekEndStr.value,
      termId: filters.termId || undefined,
      schoolId: filters.schoolId || undefined,
      page: 1,
      pageSize: PAGE_SIZE,
      includeDeleted: true
    });
    if (my !== loadSeq) return;
    const rows = res?.list ?? [];
    allCells.value = rows.filter(c => !c.deleted);
    // 软删行 = 本周被放回待排的课次：每条 = 待排池里的一张签（1 节课 1 签，可拖 1 次）
    returnedCells.value = rows.filter(c => !!c.deleted);
  } catch {
    if (my !== loadSeq) return;
    allCells.value = [];
    returnedCells.value = [];
    loadError.value = true;
  } finally {
    if (my !== loadSeq) return;
    // 卡片整批重渲染后原触发元素已离开 DOM，悬浮层不收会浮在原地成为孤儿
    hideCardTip();
    if (soft) refreshing.value = false;
    else loading.value = false;
  }
}

function gotoThisWeek() {
  weekStart.value = mondayOf(new Date());
  load();
}

/** 日历面板选日期：跳到所选日期所在的一周（周一为起点） */
function onDatePick(v: string | Date | null) {
  if (!v) return;
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return;
  const m = mondayOf(d);
  if (fmt(m) === weekStartStr.value) return;
  weekStart.value = m;
  load();
}

/** 翻周：±7 天对齐到相邻一周的周一 */
function shiftWeek(delta: number) {
  const m = mondayOf(weekStart.value);
  m.setDate(m.getDate() + delta);
  weekStart.value = m;
  load();
}

/* ---------- 下拉选项：课程/教师/专业/班级 = 主表全量 ∪ 本周课次推导（见各 computed） ---------- */
/** 课程选项 = **课程主表全量**（courseList，listCoursePool 拉取）∪ 本周课次出现的课程。
 *  ⛔ 只从课次推导的旧口径：本周没排到的课程在下拉里"消失"——新增的课程尤其如此。
 *  主表全量保证「全部课程」始终完整；选专业后的收窄只作用于课次推导部分（主表课程无专业关联）。 */
const courseOptions = computed(() => {
  const m = new Map<string, string>();
  const put = (v?: string | number, l?: string) => {
    if (v === undefined || v === null || v === '') return;
    const k = String(v);
    if (!m.has(k)) m.set(k, l || k);
  };
  for (const o of courseList.value) put(o.value, o.label);
  const rows = filters.major
    ? allCells.value.filter(r => majorOf(r.clazzName) === filters.major)
    : allCells.value;
  for (const r of rows) put(r.courseId, r.courseName);
  return Array.from(m, ([value, label]) => ({ value, label }));
});
/** 教师选项 = **教师主表全量**（teacherList，账号接口按 teacher 角色拉取）∪ 本周课次的教师 */
const teacherOptions = computed(() => {
  const m = new Map<string, string>();
  for (const o of teacherList.value) m.set(o.value, o.label);
  for (const r of allCells.value) {
    const k = r.teacherId === undefined || r.teacherId === null ? '' : String(r.teacherId);
    if (!k || k === '0') continue;
    if (!m.has(k)) m.set(k, r.teacherName || k);
  }
  return Array.from(m, ([value, label]) => ({ value, label }));
});

/**
 * 教室下拉 = **真数据源**（C-21 `GET /api/v1/admin/classrooms`，随 loadPickers 拉全量）。
 * 此前从本周课次里去重推导（接口缺位的替代做法），本周没课/没教室时下拉为空。
 * 兜底：课次里引用了但教室列表里已不存在的 id（如刚被删的教室）补一项，避免 el-select 显示成裸 id。
 */
const classroomsAll = ref<Classroom[]>([]);
const classroomList = ref<{ value: string; label: string }[]>([]);
const roomOptions = computed(() => {
  const opts = [...classroomList.value];
  const known = new Set(opts.map(o => o.value));
  for (const c of allCells.value) {
    const id = c.classroomId === undefined || c.classroomId === null ? '' : String(c.classroomId);
    if (id && !known.has(id)) {
      opts.push({ value: id, label: c.roomName || id });
      known.add(id);
    }
  }
  return opts;
});

/* ---------- 「全部教室」弹窗：C-21 教室列表只读查看，弹窗内可再按关键字过滤 ---------- */
const roomsVisible = ref(false);
const roomKeyword = ref('');
/** 教室类型 / 状态与基础数据页同一套口径 */
const ROOM_TYPE_TEXT: Record<string, string> = { physical: '物理教室', virtual: '虚拟教室' };
const STATUS_TEXT: Record<string, string> = { active: '启用', inactive: '停用', '0': '启用', '1': '停用' };
const STATUS_CLS: Record<string, string> = { active: 'badge-success', inactive: 'badge-neutral', '0': 'badge-success', '1': 'badge-neutral' };
const roomsFiltered = computed(() => {
  const kw = roomKeyword.value.trim().toLowerCase();
  if (!kw) return classroomsAll.value;
  return classroomsAll.value.filter(r =>
    [r.name, r.code, r.location, r.device, r.capacity]
      .some(v => v !== undefined && v !== null && String(v).toLowerCase().includes(kw))
  );
});
function openRooms() {
  roomKeyword.value = '';
  roomsVisible.value = true;
}

/* ---------- 教室编辑（C-21 PUT）：在「所有教室」弹窗内按行编辑 ---------- */
const roomEditVisible = ref(false);
const roomEditSaving = ref(false);
const roomEditForm = reactive<Classroom>({
  classroomId: undefined,
  name: '',
  code: '',
  roomType: 'physical',
  capacity: undefined,
  location: '',
  device: '',
  status: 'active',
  remark: ''
});
function openRoomEdit(row: Classroom) {
  Object.assign(roomEditForm, {
    classroomId: row.classroomId,
    name: row.name ?? '',
    code: row.code ?? '',
    roomType: row.roomType ?? 'physical',
    capacity: row.capacity,
    location: row.location ?? '',
    device: row.device ?? '',
    status: row.status ?? 'active',
    remark: row.remark ?? ''
  });
  roomEditVisible.value = true;
}
async function saveRoomEdit() {
  if (!roomEditForm.classroomId || roomEditSaving.value) return;
  if (!roomEditForm.name?.trim()) {
    ElMessage.warning('教室名称不能为空');
    return;
  }
  roomEditSaving.value = true;
  try {
    await updateClassroom({ ...roomEditForm, name: roomEditForm.name.trim() });
    ElMessage.success(`教室「${roomEditForm.name.trim()}」已更新`);
    roomEditVisible.value = false;
    // 教室下拉缓存失效：清空强制 loadPickers 重拉
    classroomsAll.value = [];
    classroomList.value = [];
    await loadPickers();
  } catch {
    /* 请求层已提示 */
  } finally {
    roomEditSaving.value = false;
  }
}

/** 班级筛选：**班级主表全量**（listClasses → clazzNameList）∪ 本周课次出现过的班级名。
 *  旧口径只从课次推导，课次没登记班级时下拉为空；主表兜底保证「全部班级」始终有完整选项。
 *  空字符串仍不生成选项（空白项没有筛选意义）。 */
const clazzOptions = computed(() => {
  const m = new Map<string, string>();
  const put = (n?: string) => {
    if (!n || m.has(n)) return;
    if (filters.major && majorOf(n) !== filters.major) return;
    m.set(n, n);
  };
  for (const n of clazzNameList.value) put(n);
  for (const r of allCells.value) put(r.clazzName);
  return Array.from(m, ([value, label]) => ({ value, label }));
});
/** 切换专业时，已选的班级/课程若不在新专业范围内则自动清空，避免筛出空集 */
watch(
  () => filters.major,
  () => {
    if (filters.clazzName && !clazzOptions.value.some(o => o.value === filters.clazzName)) {
      filters.clazzName = '';
    }
    if (filters.courseId && !courseOptions.value.some(o => o.value === filters.courseId)) {
      filters.courseId = '';
    }
  }
);
/** 班级名 → 专业名：先查班级主表映射（clazz.majorName，数据规范时的正名），
 *  映射不到再按班级名前缀兜底——取首个数字前的部分（计科2301→计科、软件2201→软件、计科2026-1班→计科），
 *  并把前缀展开为**完整专业名**（先查常见缩写对照，再跟专业主表名称做前缀匹配，兜底原样返回）。
 *  背景：schedule.target_class 是冗余字符串（无 clazzId 外键），演示课次的班级大多未登记进班级主表。 */
/** 常见专业缩写 → 完整专业名（班级名前缀是缩写时的正名对照） */
const MAJOR_ABBR: Record<string, string> = {
  计科: '计算机科学与技术',
  软件: '软件工程',
  网工: '网络工程',
  物联: '物联网工程',
  信安: '信息安全',
  大数据: '数据科学与大数据技术',
  数媒: '数字媒体技术',
  通信: '通信工程',
  电信: '电子信息工程',
  自动化: '自动化'
};
/** 专业主表的完整名称列表（loadPickers 拉取），用于前缀→正名的数据驱动匹配 */
const majorNames = ref<string[]>([]);
function majorOf(clazzName?: string): string | undefined {
  if (!clazzName) return undefined;
  const mapped = clazzMajorMap.value[clazzName];
  if (mapped) return mapped;
  const prefix = clazzName.match(/^(.+?)\d/)?.[1];
  if (!prefix) return undefined;
  return MAJOR_ABBR[prefix] || majorNames.value.find(n => n.startsWith(prefix)) || prefix;
}
/** 专业选项 = **专业主表全量**（listMajors）∪ 本周课次班级推导出的专业。
 *  ⛔ 只从课次推导的旧口径有致命缺陷：本周课次没登记班级（target_class 空）时下拉直接空——
 *  「全部专业」本就该列出所有可选专业，与本周有没有对应课无关。 */
const majorOptions = computed(() => {
  const m = new Map<string, string>();
  for (const n of majorNames.value) {
    if (n) m.set(n, n);
  }
  for (const r of allCells.value) {
    const major = majorOf(r.clazzName);
    if (major && !m.has(major)) m.set(major, major);
  }
  return Array.from(m, ([value, label]) => ({ value, label }));
});

/* ---------- 筛选在前端做：一周课次量小，立刻生效且选项不会被自身筛空 ---------- */
const filtered = computed(() =>
  allCells.value.filter(
    c =>
      (!filters.courseId || String(c.courseId) === filters.courseId) &&
      (!filters.teacherId || String(c.teacherId) === filters.teacherId) &&
      (!filters.clazzName || (c.clazzName ?? '') === filters.clazzName) &&
      (!filters.major || majorOf(c.clazzName) === filters.major) &&
      (!filters.classroomId || String(c.classroomId) === filters.classroomId)
  )
);

/* ---------- 冲突本地推导（2026-10-20）：后端 conflict 列从不回填（恒空）⇒ 前端按同款规则推导 ----------
 * 规则与后端编号 60 的三维同查一致：同一节次「同教师 / 同教室 / 同班级」= 冲突（三者都不同的并行合法）。
 * ⚠️ 现役 8080 包（10-26 11:39 构建）仍是二维，同班级这维要等 10-28 换包后两边才对得上；
 *    换包前页面会多标出「同班级」这一类红，属预期，不是页面缺陷。
 * 推导只用于可视化标红与计数；落库拦截仍以真实接口返回为准。 */
const conflictInfo = computed(() => {
  const reasons = new Map<string, string[]>();
  const add = (id: string, why: string) => {
    const list = reasons.get(id);
    if (list) {
      if (!list.includes(why)) list.push(why);
    } else reasons.set(id, [why]);
  };
  const scan = (keyOfCell: (c: ScheduleCell) => string | null, whyOf: (first: ScheduleCell) => string) => {
    const groups = new Map<string, ScheduleCell[]>();
    for (const c of filtered.value) {
      if (!c.weekday || !c.periodNo) continue;
      const k = keyOfCell(c);
      if (!k) continue;
      const gk = `${c.weekday}-${c.periodNo}-${k}`;
      const list = groups.get(gk);
      if (list) list.push(c);
      else groups.set(gk, [c]);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (const c of list) add(String(c.scheduleId), whyOf(list[0]));
    }
  };
  scan(
    c =>
      c.teacherId !== undefined && c.teacherId !== null
        ? `t${c.teacherId}`
        : c.teacherName && c.teacherName.trim()
          ? `n${c.teacherName.trim()}`
          : null,
    first => `与「${first.courseName ?? '另一节课'}」同教师`
  );
  scan(
    c => (c.classroomId !== undefined && c.classroomId !== null ? `r${c.classroomId}` : null),
    first => `与「${first.courseName ?? '另一节课'}」同教室`
  );
  scan(
    c => {
      const own = (c.clazzName ?? '').trim();
      return own ? `c${own}` : null;
    },
    first => `与「${first.courseName ?? '另一节课'}」同班级`
  );
  return reasons;
});
/** 该课次命中的冲突原因列表（空 = 无冲突） */
function conflictOf(s: ScheduleCell): string[] {
  return conflictInfo.value.get(String(s.scheduleId)) ?? [];
}
/** 冲突课次总数（工具栏徽标） */
const conflictCount = computed(() => conflictInfo.value.size);

/* ================= 2026-10-21 丙：只看冲突 / 逐个跳转 / 视角概览 / 视图状态进 URL ================= */

/* ---------- 「只看冲突」 ----------
 * ★ 冲突判定仍基于**筛选后的全量课次**（conflictInfo ← filtered），只在渲染时收窄。
 *   若把过滤塞进 filtered，会出现"只剩冲突 pair 中的一节 ⇒ 冲突自己消失"的漏判。 */
const onlyConflicts = ref(false);
/** 视角概览点中的那一行（key = 前缀 + 显示名：t1001 / n未指定教师 / r9002 / x未指定教室 / c计算机2301）
 *  ★ 不写进 filters，只在渲染层收窄：① 点一行看它时概览其余行仍在，能直接点下一行；
 *    ② 未登记 ID 的行按名字也能聚焦（2026-10-22 实测本周 3 节里 2 节 classroomId=null，
 *       旧版按 ID 筛选对这些行只能禁用，等于"点不动"）。 */
const rosterFocus = ref('');
function focusMatch(c: ScheduleCell) {
  const k = rosterFocus.value;
  if (!k) return true;
  const head = k[0];
  const name = k.slice(1);
  if (viewMode.value === 'teacher')
    return head === 't' ? String(c.teacherId ?? '') === name : ((c.teacherName ?? '').trim() || '未指定教师') === name;
  if (viewMode.value === 'room')
    return head === 'r' ? String(c.classroomId ?? '') === name : ((c.roomName ?? '').trim() || '未指定教室') === name;
  if (viewMode.value === 'class') return ((c.clazzName ?? '').trim() || '未填班级') === name;
  return true;
}
const shownCells = computed(() =>
  filtered.value.filter(c => (!onlyConflicts.value || conflictInfo.value.has(String(c.scheduleId))) && focusMatch(c))
);
/** 冲突课次按「节次 → 星期」的阅读顺序排队，上一处/下一处按此序走 */
const conflictQueue = computed(() =>
  filtered.value
    .filter(c => conflictInfo.value.has(String(c.scheduleId)) && c.weekday && c.periodNo)
    .sort((a, b) => (a.periodNo ?? 0) - (b.periodNo ?? 0) || (a.weekday ?? 0) - (b.weekday ?? 0))
);
const jumpIdx = ref(-1);
/** 描边只在当前这一跳亮 1.6 秒；★ 与 jumpIdx 分开——跳完亮完，计数仍停在「2 / 5」，
 *  否则徽标回落到「— / 5」，用户不知道自己在第几处（首版踩过，探针实测到）。 */
const jumpFlashId = ref<string | number>(0);
const jumpTargetId = computed(() => jumpFlashId.value);
let jumpResetTimer: ReturnType<typeof setTimeout> | undefined;
/** 跳上一处/下一处冲突：自动开启「只看冲突」，展开叠牌格，滚动到可视区并描边 1.6 秒 */
async function jumpConflict(step: 1 | -1) {
  const n = conflictQueue.value.length;
  if (!n) {
    jumpIdx.value = -1;
    ElMessage.info('本周当前筛选下没有冲突课次');
    return;
  }
  onlyConflicts.value = true;
  jumpIdx.value = jumpIdx.value < 0 ? (step > 0 ? 0 : n - 1) : (jumpIdx.value + step + n) % n;
  const t = conflictQueue.value[jumpIdx.value];
  // 目标课次不在"只看它"的范围里 ⇒ 先放开聚焦，否则跳过去了屏幕上什么也没有
  if (rosterFocus.value && !focusMatch(t)) rosterFocus.value = '';
  await nextTick();
  if (t.weekday && t.periodNo) expandCell(t.weekday, t.periodNo);
  await nextTick();
  document.querySelector(`[data-sid="${t.scheduleId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  jumpFlashId.value = t.scheduleId;
  if (jumpResetTimer) clearTimeout(jumpResetTimer);
  jumpResetTimer = setTimeout(() => (jumpFlashId.value = 0), 1600);
}
/** 队列变了（换周 / 改筛选 / 关掉过滤）⇒ 位置失效，回到「未开始」而不是指着越界的一项 */
watch(conflictQueue, (q) => {
  if (jumpIdx.value >= q.length) jumpIdx.value = -1;
  if (!q.length) jumpFlashId.value = 0;
});

/* ---------- 视角概览（班级 / 教师 / 教室） ----------
 * 与筛选的差别：筛选是单值收敛，一次只能看一位教师，**无法横向比较**"谁本周占了几节、
 * 谁的课撞了"。概览条把当前周按维度聚合出来，点一行 = 课表只看它（rosterFocus，只收渲染层），
 * 再点同一行取消 ⇒ 网格与拖拽逻辑一行不动（避免动叠牌与落点判定）。 */
type ViewMode = '' | 'class' | 'teacher' | 'room';
const viewMode = ref<ViewMode>('');
const VIEW_OPTIONS: { m: ViewMode; t: string }[] = [
  { m: 'class', t: '班级' },
  { m: 'teacher', t: '教师' },
  { m: 'room', t: '教室' }
];
const roster = computed(() => {
  if (!viewMode.value) return [];
  const rows = new Map<string, { key: string; label: string; lessons: number; conflicts: number }>();
  for (const c of filtered.value) {
    let label: string;
    if (viewMode.value === 'teacher') label = (c.teacherName ?? '').trim() || '未指定教师';
    else if (viewMode.value === 'room') label = (c.roomName ?? '').trim() || '未指定教室';
    else label = (c.clazzName ?? '').trim() || '未填班级';
    /* key 前缀必须区分"按 ID 聚合"与"按名字聚合"：focusMatch 靠首字符决定比 ID 还是比名字，
       两类共用前缀会让名字行（如 t未指定教师）去和 teacherId 比 ⇒ 点它反而变空表（首版踩过） */
    const id = viewMode.value === 'teacher' ? c.teacherId : viewMode.value === 'room' ? c.classroomId : undefined;
    const groupKey =
      id !== undefined && id !== null
        ? (viewMode.value === 'teacher' ? 't' : 'r') + String(id)
        : (viewMode.value === 'teacher' ? 'n' : viewMode.value === 'room' ? 'x' : 'c') + label;
    const r = rows.get(groupKey) ?? { key: groupKey, label, lessons: 0, conflicts: 0 };
    r.lessons += 1;
    if (conflictInfo.value.has(String(c.scheduleId))) r.conflicts += 1;
    rows.set(groupKey, r);
  }
  return [...rows.values()]
    .map(r => ({ key: r.key, label: r.label, lessons: r.lessons, conflicts: r.conflicts }))
    .sort((a, b) => b.lessons - a.lessons || a.label.localeCompare(b.label, 'zh-CN'));
});
/** 点概览行 = 课表只看它；再点同一个 = 取消 */
function pickRoster(row: { key: string }) {
  rosterFocus.value = rosterFocus.value === row.key ? '' : row.key;
}
function setViewMode(m: ViewMode) {
  viewMode.value = viewMode.value === m ? '' : m;
  // 聚焦 key 的维度前缀跟着视角走，换视角必须作废，否则「教师 t1001」会被当成教室行
  rosterFocus.value = '';
}
/** 概览条标题：正在"只看它"时把对象名回显出来，避免用户忘了网格被收窄 */
const rosterHead = computed(() => {
  const dim = viewMode.value === 'teacher' ? '教师' : viewMode.value === 'room' ? '教室' : '班级';
  const picked = roster.value.find(r => r.key === rosterFocus.value);
  return picked
    ? `${dim}视角 · 课表当前只看「${picked.label}」（共 ${roster.value.length} 个${dim}，点别的行直接切；再点它或退出视角恢复整周）`
    : `${dim}视角 · 本周 ${roster.value.length} 个${dim} · 点一行只看它`;
});

/* ---------- 视图状态写进 URL query ----------
 * 现状：刷新后一律回到「本周 + 无筛选」，也没法把"第 9 周只看计算机学院"链接发给同事。
 * 做法：setup 内**同步**读一次 query（早于 :1857 那个学期/学校 watcher 注册 ⇒ 不会触发重复请求），
 * 变更时 router.replace 换 query。**只读现成路由**，不动禁改的 src/router/index.ts。 */
const route = useRoute();
const router = useRouter();
const qv = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '');
function applyQueryState() {
  const w = qv(route.query.week);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w) && !Number.isNaN(Date.parse(w))) weekStart.value = mondayOf(new Date(`${w}T00:00:00`));
  filters.termId = qv(route.query.term);
  filters.schoolId = qv(route.query.school);
  filters.major = qv(route.query.major);
  filters.courseId = qv(route.query.course);
  filters.clazzName = qv(route.query.clazz);
  filters.teacherId = qv(route.query.teacher);
  filters.classroomId = qv(route.query.room);
  onlyConflicts.value = qv(route.query.conflict) === '1';
  const vm = qv(route.query.view);
  viewMode.value = vm === 'teacher' || vm === 'room' || vm === 'class' ? vm : '';
  rosterFocus.value = qv(route.query.focus);
}
function syncQueryState() {
  const next: Record<string, string> = {};
  if (weekStartStr.value !== fmt(mondayOf(new Date()))) next.week = weekStartStr.value;
  if (filters.termId) next.term = filters.termId;
  if (filters.schoolId) next.school = filters.schoolId;
  if (filters.major) next.major = filters.major;
  if (filters.courseId) next.course = filters.courseId;
  if (filters.clazzName) next.clazz = filters.clazzName;
  if (filters.teacherId) next.teacher = filters.teacherId;
  if (filters.classroomId) next.room = filters.classroomId;
  if (onlyConflicts.value) next.conflict = '1';
  if (viewMode.value) next.view = viewMode.value;
  if (rosterFocus.value) next.focus = rosterFocus.value;
  void router.replace({ query: next });
}
applyQueryState();
watch([weekStart, filters, onlyConflicts, viewMode, rosterFocus], syncQueryState, { deep: true });

/* ---------- 教室容量校验（2026-10-20）：行业标配「人数→容量匹配」，数据都有、此前没用 ---------- */
/** 新增课次：所选教室容量 < 所选课程选课人数 ⇒ 提示（不硬拦，教室紧张时管理员自行取舍） */
const createCapacityWarn = computed(() => {
  const room = classroomsAll.value.find(r => String(r.classroomId) === form.classroomId);
  const course = poolCourses.value.find(c => String(c.courseId) === form.courseId);
  if (!room || course?.studentCount === undefined || course.studentCount === null) return '';
  return (course.studentCount ?? 0) > (room.capacity ?? Number.MAX_SAFE_INTEGER)
    ? `该教室容量 ${room.capacity} 人，小于「${course.courseName ?? '该课程'}」的 ${course.studentCount} 名学生`
    : '';
});
/** 课次详情：同口径 */
const detailCapacityWarn = computed(() => {
  const c = detailCell.value;
  if (!c) return '';
  const room = classroomsAll.value.find(r => String(r.classroomId) === editForm.classroomId);
  const course = poolCourses.value.find(x => String(x.courseId) === String(c.courseId));
  if (!room || course?.studentCount === undefined || course.studentCount === null) return '';
  return (course.studentCount ?? 0) > (room.capacity ?? Number.MAX_SAFE_INTEGER)
    ? `该教室容量 ${room.capacity} 人，小于选课人数 ${course.studentCount}`
    : '';
});

const keyOf = (weekday: number, periodNo: number) => `${weekday}-${periodNo}`;

/**
 * 节次格 → 该格内的**全部**课次。
 * ★ 一个节次格可以容纳多节课：同一时间不同教师、不同教室并行上课是合法的
 *   （后端只把「同教师」或「同教室」判为冲突，见 countConflict）。
 *   所以这里必须是数组，不能像原来那样一格只留最后一节课（会把并行的课吞掉）。
 */
const cellMap = computed(() => {
  const m: Record<string, ScheduleCell[]> = {};
  for (const c of shownCells.value) {
    if (!c.weekday || !c.periodNo) continue;
    const k = keyOf(c.weekday, c.periodNo);
    (m[k] ??= []).push(c);
  }
  return m;
});
/** 行 × 列 二维结构，模板里可直接拿到「该格课次列表」，避免在模板中重复调用取值函数 */
const grid = computed(() =>
  PERIODS.map(period => ({
    period,
    cells: WEEKDAYS.map(d => ({ weekday: d.v, list: cellMap.value[keyOf(d.v, period.seq)] ?? [] }))
  }))
);

/* ================= 拖动排课 =================
 * 拖动落点与对应操作（都真实落库）：
 *   ① 课程池卡片     → 任意节次格           ⇒ C-17 新建（POST /api/v1/schedules）
 *   ② 课表内已有课次 → 空格子               ⇒ C-19 改到该时间（PUT /api/v1/schedules/{scheduleId}）
 *   ③ 课表内已有课次 → **别的教师**的课次卡 ⇒ 弹选择：C-19「并入这一节」/ C-20「互换上课时间」
 *   ④ 课表内已有课次 → **同一教师**的课次卡 ⇒ 只能 C-20 互换上课时间
 *   ⑤ 课表内已有课次 → 自己那张卡           ⇒ 拦下并说明原因
 * 后端原本只有 GET/POST、无移动接口；C-19/C-20 由管理端模块补两条 PUT
 *   （C-19 冲突检查**排除自己**、C-20 排除**双方**；两次都只动时间/星期/节次，
 *    课程与授课教师从原记录继承、教室不传则沿用）。
 * ★ 互换的语义是「两节课对调上课时间」：课程 / 教师 / 教室跟着课次本身走，不随格子移动。
 * ★★ **一个节次格可以容纳多节课**，但能否并存取决于教师：
 *   不同教师并存合法、同一教师并存必冲突（后端 countConflict 只把「同教师」或「同教室」判为冲突；
 *   已实测：不同教师+不同教室 → conflict=false 放行；同教师 / 同教室 → 拦）。
 *   ⇒ 规则据此分成「可选并入/互换」与「只能互换」两种，见 ③④。
 * ★ 互换会把对方也挪走（破坏性大于"并入"），所以两种都可行时必须由用户显式选择，
 *   不做默认自动决定 —— 避免"我只是想把他俩放一起，怎么把另一节挪走了"。
 * ⛔ 仍不接后端端点：`/schedules/auto`（自动排课走页内本地实现，见下方 runAuto）
 *   ✔ 已实现并真发请求：`publishSchedules()`（发布课表，`:2215`）、`deleteSchedule()`（删除课次，`:1294` / `:1300` / `:1475`）
 */
const poolCourses = ref<CourseBrief[]>([]);

/* ---------- 三重认证门槛（2026-10-29 需求）：只有通过三重认证的课才能排课 ----------
 * 口径：course.status === 'active'。课程审核（C-15）三项材料全过后，后端把 course.status
 * 置为 active（见 api/admin/certifications.ts 注释与 schema_v9 的 creating/certifying/active/archived）。
 * 作用面：待排池（含自动排课，二者同源）、新增课次的课程下拉、网格内存量课次（标灰 + 角标 + 禁拖）。
 */
/** courseId -> 课程池记录：认证判定与教师回显共用一张表 */
const courseById = computed(() => {
  const m = new Map<string, CourseBrief>();
  for (const c of poolCourses.value) m.set(String(c.courseId), c);
  return m;
});
/** 该课程是否已通过三重认证。课程池里查不到的课次（历史/脏数据）按未认证处理——宁可多拦，不放未认证的进来。 */
function certPassed(courseId: string | number | undefined | null): boolean {
  if (courseId === undefined || courseId === null) return false;
  return courseById.value.get(String(courseId))?.status === 'active';
}

/** 本周被「放回待排」的课次（软删行全集）：每条 = 待排池里的一张签 */
const returnedCells = ref<ScheduleCell[]>([]);

/** 当前学期 id（loadPickers 拉学期列表时记录）：未选学期（=全部学期）时池子按它判定「已排」 */
const currentTermId = ref('');

/* ---------- 学期周次标注：2026-10-29 需求整体移除（页头胶囊、摘要内联、两处弹窗警告、weekNo 计算） ---------- */

/** 待排池条目：1 条 = 1 节课（放回课次逐条成签）或 1 门本周未排的课程 */
interface PoolEntry extends CourseBrief {
  /** 唯一键：lesson-{scheduleId} / course-{courseId} */
  key: string;
  /**
   * 该课程在本学期已有活跃课次 ⇒ 这张签是**重复排课入口**（2026-10-30 P0-A）。
   * 成因：放回=软删课次行，而软删行会一直留在池里成签（后端列表仍返回 deleted 行）；
   * 这门课其余节次还好端端在课表上，于是每点一次自动排课就把它重排一遍
   * （10-29 实测一次多出 126 条 = 7 张残留签 × 18 周）。
   * 自动排课默认跳过这类签（见 autoEntries）；要重排整门课，先把该课全部放回。
   */
  inSchedule: boolean;
}

/**
 * 待排池（2026-10-18 改版：1 节课 1 张签，每张可拖 1 次）。
 * ★ 口径一（学期）：「已排」判定锁定学期（选中学期；全部学期按当前学期），否则全部学期视图池恒空。
 * ★ 口径二（放回即回池，10-16 拍板）：本周每条软删课次 = 1 张签，拖一次后端消费一条
 *   （防重复排课堆积），签随刷新逐张消失；本周完全未排的课程仍按课程出 1 张签。
 */
const poolEntries = computed<PoolEntry[]>(() => {
  const scope = filters.termId || currentTermId.value;
  // termId 为 NULL 的课次（演示数据课程未关联学期）按「在范围内」处理，否则选中学期后池子误判全未排
  const inScope = scope
    ? allCells.value.filter(
        c => c.termId === undefined || c.termId === null || String(c.termId) === String(scope)
      )
    : allCells.value;
  const used = new Set(inScope.map(c => String(c.courseId)));
  // courseId -> 本周放回的课次列表
  const returned = new Map<string, ScheduleCell[]>();
  for (const r of returnedCells.value) {
    const rk = String(r.courseId);
    const list = returned.get(rk);
    if (list) list.push(r);
    else returned.set(rk, [r]);
  }
  const out: PoolEntry[] = [];
  for (const c of poolCourses.value) {
    const rows = returned.get(String(c.courseId));
    if (rows?.length) {
      // 放回即回池：每条放回课次 1 张签（拖一次排回一节）
      for (const r of rows) {
        out.push({ ...c, key: `lesson-${r.scheduleId}`, inSchedule: used.has(String(r.courseId)) });
      }
    } else if (!used.has(String(c.courseId))) {
      out.push({ ...c, key: `course-${c.courseId}`, inSchedule: false });
    }
  }
  return out.filter(c => {
    // 三重认证门槛（2026-10-29）：未过认证的课程连签都不出——放回的课次签同拦，防止绕道重排
    if (!certPassed(c.courseId)) return false;
    if (filters.courseId && String(c.courseId) !== filters.courseId) return false;
    if (filters.teacherId && String(c.teacherId) !== filters.teacherId) return false;
    return true;
  });
});

/* ---------- 待排课程展开浮层（非模态可拖动；内含搜索与教师筛选） ---------- */
const poolPanelVisible = ref(false);
const panelKeyword = ref('');
const panelTeacherId = ref('');
/** 面板课程列表 = 当前待排池 + 面板内筛选（关键字匹配课程名；教师下拉筛选） */
const panelEntries = computed(() =>
  poolEntries.value.filter(c => {
    if (panelKeyword.value && !(c.courseName ?? '').toLowerCase().includes(panelKeyword.value.trim().toLowerCase())) return false;
    if (panelTeacherId.value && String(c.teacherId ?? '') !== panelTeacherId.value) return false;
    return true;
  })
);
async function openPoolPanel() {
  panelKeyword.value = '';
  panelTeacherId.value = '';
  poolPanelVisible.value = true;
  // 待排池/教师/班级强制刷新：别处刚新增的课程、教师、班级立即可见（loadPickers 内部有缓存判定，清空才重拉）
  courseList.value = [];
  poolCourses.value = [];
  teacherList.value = [];
  clazzNameList.value = [];
  clazzMajorMap.value = {};
  majorNames.value = [];
  await loadPickers();
}

const draggingCourse = ref<CourseBrief | null>(null);
/** 正在拖动的**已有课次**（表内移动 C-19 / 互换 C-20） */
const draggingCell = ref<ScheduleCell | null>(null);
const dragOverKey = ref('');
/** 写请求进行中（移动/互换）——**只覆盖写请求本身**，回读不算，否则"保存中"窗口会翻倍 */
const busy = ref(false);

/* ---------- 多课格子的展开/折叠 ----------
 * 并入后一个节次格里有多节课。默认**压缩叠加**：全部课程都显示，
 * 但像一叠牌一样压在一起（只露每张的课程名行）+ 底部显眼的「同段共 N 节 · 点击展开」条；
 * 点击（卡片或条）完全展开平铺，再点收起。
 * key = weekday-periodNo；数据刷新后残留的 key 无副作用（压缩态只在 >1 节时生效）。 */
const expandedCells = ref(new Set<string>());
const cellKey = (weekday: number, periodNo: number) => `${weekday}-${periodNo}`;
function isCellExpanded(weekday: number, periodNo: number) {
  return expandedCells.value.has(cellKey(weekday, periodNo));
}
function toggleCellExpand(weekday: number, periodNo: number) {
  const k = cellKey(weekday, periodNo);
  const next = new Set(expandedCells.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  expandedCells.value = next;
}
/** 该格当前是否处于压缩叠加态 */
function isCollapsedCell(weekday: number, periodNo: number, count: number) {
  return count > 1 && !isCellExpanded(weekday, periodNo);
}
/** 折叠叠牌几何：浅灰格 td.cell 97px（border-box）− 上下 padding 5×2 = 内容区 87px。
 * 顶卡最多 84px（n≤2 时全高不压缩，即「之前的样子」）；节数多时顶卡按 87 − 3×(n−1) 压矮，
 * 压到 48px 下限为止，保证整叠永远不出格子。 */
const CELL_CONTENT_H = 87;
const CARD_MAX_H = 84;
const REVEAL_PX = 3;
function deckGeom(n: number) {
  const cardH = Math.max(48, Math.min(CARD_MAX_H, CELL_CONTENT_H - (n - 1) * REVEAL_PX));
  return { cardH, deckH: cardH + (n - 1) * REVEAL_PX };
}
/** 压缩态点击卡片＝展开该格；展开态点击卡片＝打开详情 */
function onCardClick(s: ScheduleCell, weekday: number, periodNo: number, count: number) {
  hideCardTip();
  if (isCollapsedCell(weekday, periodNo, count)) toggleCellExpand(weekday, periodNo);
  else openDetail(s);
}
/** 并入/新建落到某格成功后自动展开，让"多节并存"立刻可见 */
function expandCell(weekday: number, periodNo: number) {
  if (!expandedCells.value.has(cellKey(weekday, periodNo))) {
    expandedCells.value = new Set(expandedCells.value).add(cellKey(weekday, periodNo));
  }
}

/* ---------- 课表网格键盘可达（2026-10-22 落地第一档）----------
 * roving tabindex：整张网格在 Tab 序列里只占一个停靠点（当前锚点格里的那张卡，
 * 空格子则是空格本身），进网之后用方向键在格子间走，Enter/Space 激活。
 * 这样 Tab 键不会被几百张卡片淹没，键盘路径和鼠标路径指向同一批动作。
 * 第二档（键盘完成"移动/互换"这类拖拽语义）改动量约 150 行，另批做。 */
const gridFocus = reactive<{ wd: number; pn: number; sid: string | number | null }>({
  wd: WEEKDAYS[0].v,
  pn: PERIODS[0].seq,
  sid: null
});
function cellListAt(weekday: number, periodSeq: number): ScheduleCell[] {
  return cellMap.value[keyOf(weekday, periodSeq)] ?? [];
}
/** 锚点格里的停靠课次：该课次已被撤回/删除时退化成本格第一节，空格子退化为 null */
const tabStopSid = computed<string | number | null>(() => {
  const list = cellListAt(gridFocus.wd, gridFocus.pn);
  if (!list.length) return null;
  return list.some(s => String(s.scheduleId) === String(gridFocus.sid)) ? gridFocus.sid : list[0].scheduleId;
});
/** 卡片是否为本轮 Tab 停靠点（true → tabindex=0，其余 -1） */
function isTabStop(weekday: number, periodSeq: number, sid: string | number | null): boolean {
  if (weekday !== gridFocus.wd || periodSeq !== gridFocus.pn) return false;
  // 空格的停靠点用 null 表示；null 与任何 id 都不相等，故先同判 null 再比字符串
  if (sid === null || tabStopSid.value === null) return sid === tabStopSid.value;
  return String(sid) === String(tabStopSid.value);
}
function cardTabindex(weekday: number, periodSeq: number, sid: string | number): string {
  return isTabStop(weekday, periodSeq, sid) ? '0' : '-1';
}
function emptyTabindex(weekday: number, periodSeq: number): string {
  return isTabStop(weekday, periodSeq, null) ? '0' : '-1';
}
/** 卡片拿到焦点时把锚点挪过来（鼠标点选后再按 Tab 会回到刚操作的那格） */
function onCardFocus(s: ScheduleCell, weekday: number, periodSeq: number, e: FocusEvent) {
  gridFocus.wd = weekday;
  gridFocus.pn = periodSeq;
  gridFocus.sid = s.scheduleId;
  showCardTip(e.target as HTMLElement | undefined, s, weekday, periodSeq);
}
/** 空格子拿到焦点时也把锚点挪过来：弹窗关闭时浏览器会把焦点还给「打开弹窗前那个元素」，
 * 走不到 onCardFocus，停靠点就会留在原处（Tab 出去再回来落回别的格子） */
function onEmptyFocus(weekday: number, periodSeq: number) {
  gridFocus.wd = weekday;
  gridFocus.pn = periodSeq;
  gridFocus.sid = null;
}
async function focusGridCell(weekday: number, periodSeq: number) {
  const list = cellListAt(weekday, periodSeq);
  gridFocus.wd = weekday;
  gridFocus.pn = periodSeq;
  gridFocus.sid = list.length ? list[0].scheduleId : null;
  await nextTick();
  const td = document.querySelector(`.sched td.cell[data-wd="${weekday}"][data-pn="${periodSeq}"]`);
  const target = (list.length
    ? td?.querySelector(`.cblock[data-sid="${gridFocus.sid}"]`)
    : td?.querySelector('.c-empty')) as HTMLElement | null;
  target?.focus();
}
const GRID_ARROW_STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};
function onGridKey(e: KeyboardEvent, weekday: number, periodSeq: number, s: ScheduleCell | null) {
  const count = cellListAt(weekday, periodSeq).length;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (s) onCardClick(s, weekday, periodSeq, count);
    else openCreate(weekday, periodSeq);
    return;
  }
  if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    const d = e.key === 'Home' ? WEEKDAYS[0] : WEEKDAYS[WEEKDAYS.length - 1];
    void focusGridCell(d.v, periodSeq);
    return;
  }
  const step = GRID_ARROW_STEPS[e.key];
  if (!step) return;
  e.preventDefault();
  const wi = WEEKDAYS.findIndex(x => x.v === weekday);
  const pi = PERIODS.findIndex(x => x.seq === periodSeq);
  if (wi < 0 || pi < 0) return;
  const nw = WEEKDAYS[Math.min(Math.max(wi + step[0], 0), WEEKDAYS.length - 1)].v;
  const np = PERIODS[Math.min(Math.max(pi + step[1], 0), PERIODS.length - 1)].seq;
  void focusGridCell(nw, np);
}

/** 本周 weekday 对应的日期（1=周一） */
function dateOf(weekday: number) {
  const d = new Date(weekStart.value);
  d.setDate(d.getDate() + (weekday - 1));
  return fmt(d);
}

/* ---------- 调整课次 · 每周节数核对（2026-10-20，只读提示，补齐靠手动拖）----------
 * 单个课次没有"每周几节"属性（schedule 一行 = 一个日期），所以这里反过来做：
 * 拉该课程未来 25 周的真实课次，按周计数并压缩成区间（如「第1~16周 2节；第17~18周 1节」），
 * 让"哪些周缺节"一眼可见；补齐方式 = 把待排池签拖到缺节那周的空格。 */
const weeklyCheck = ref<{ loading: boolean; text: string; uneven: boolean } | null>(null);
async function loadWeeklyCheck(courseId: string | number) {
  weeklyCheck.value = { loading: true, text: '', uneven: false };
  try {
    // 统计窗口 = 重复排课同款锚定：当前显示周为第 1 周，向后 25 周
    const end = new Date(weekStart.value);
    end.setDate(end.getDate() + 25 * 7 - 1);
    const res = await listSchedules({
      startDate: fmt(weekStart.value),
      endDate: fmt(end),
      page: 1,
      pageSize: 500,
      includeDeleted: true
    });
    if (!weeklyCheck.value?.loading) return; // 弹窗已关或换了课次，丢弃过期结果
    // ★ 适配层：契约 ScheduleCell 无 classTime，但后端实际返回该字段（实测确认）——
    //   页内扩展类型读取，不动 types.ts；字段缺失时降级为"无法按周统计"。
    type RowWithDate = ScheduleCell & { classTime?: string };
    const rows = ((res?.list ?? []) as RowWithDate[]).filter(c => String(c.courseId) === String(courseId) && !c.deleted);
    const byWeek = new Map<number, number>();
    let sawDate = false;
    for (const c of rows) {
      const d = new Date(String(c.classTime ?? '').slice(0, 10).replace(/-/g, '/'));
      if (Number.isNaN(d.getTime())) continue;
      sawDate = true;
      const w = Math.floor((d.getTime() - weekStart.value.getTime()) / (7 * 86400000)) + 1;
      if (w >= 1 && w <= 25) byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
    }
    if (!sawDate) {
      weeklyCheck.value = { loading: false, text: '接口未返回课次日期，无法按周统计（可翻周肉眼核对）', uneven: false };
      return;
    }
    if (!byWeek.size) {
      weeklyCheck.value = { loading: false, text: '未来 25 周内没有该课程的课次', uneven: false };
      return;
    }
    const maxWeek = Math.max(...byWeek.keys());
    const runs: Array<{ from: number; to: number; n: number }> = [];
    for (let w = 1; w <= maxWeek; w++) {
      const n = byWeek.get(w) ?? 0;
      const last = runs[runs.length - 1];
      if (last && last.n === n) last.to = w;
      else runs.push({ from: w, to: w, n });
    }
    weeklyCheck.value = {
      loading: false,
      text: runs.map(r => (r.from === r.to ? `第${r.from}周 ${r.n} 节` : `第${r.from}~${r.to}周 ${r.n} 节`)).join('；'),
      uneven: runs.length > 1
    };
  } catch {
    if (weeklyCheck.value?.loading) weeklyCheck.value = { loading: false, text: '统计失败（接口异常），可稍后重开弹窗重试', uneven: false };
  }
}

/* ---------- 2026-10-20 UI 惯例对标（Google Calendar / WebUntis / UniTime）----------
 * ① 今天列高亮 ② 课程卡一门课一色 ③ hover 同课程联动 + 完整信息 tooltip ④ 本周摘要条 */

/** 今天是显示周的周几（1=周一…7=周日；0=不在本周）——weekStart 恒为周一，按天数差直接算 */
const todayWeekday = computed(() => {
  const n = new Date();
  const diff = (new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - weekStart.value.getTime()) / 86400000;
  return diff >= 0 && diff < 7 ? diff + 1 : 0;
});

/** 课程配色：10 色低饱和调色板，按 courseId 取模 ⇒ 同一课程跨格、跨周稳定同色。
 *  冲突红优先级更高（冲突卡走 c-conf，不叠加课程色）；未发布灰是角标，不抢底色。 */
const COURSE_TONES = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'] as const;
/** 大整数 id 取模：19 位雪花 id 若先转成 JS 数值再取模会丢精度，取模结果就不是真值 ⇒ 按十进制字符串逐位取模。
 *  已暴力核过等价性：0~99999 × 模 10/3/7/12 共 400,000 例与「先转数值再取模」全等，另取 4 个 19~20 位大 id
 *  对 BigInt 取模全等（合计 400,016 例、0 处不符）⇒ 2^53 以内恒等，超过 2^53 时本函数才是对的那个。 */
function idMod(id: string | number, m: number): number {
  const s = String(id);
  let r = 0;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) continue;
    r = (r * 10 + d) % m;
  }
  return r;
}
function courseTone(courseId?: string | number | null): string {
  const k = courseId === undefined || courseId === null ? '' : String(courseId);
  if (!k || k === '0') return 't1';
  return COURSE_TONES[idMod(k, COURSE_TONES.length)];
}

/** 卡片 hover 联动：悬停时高亮同课程的其他课次（WebUntis 惯例——一眼看出一门课一周占哪几格） */
const hoverCourseId = ref<string | number | null>(null);

/** 配色第二通道：形状与 10 色互质 ⇒ 30 种「色 + 形」组合不重复，
 *  色弱用户与黑白打印下仍能区分课程（原配色只有色相一个通道，是无障碍缺口）。 */
const COURSE_MARKS = ['●', '▲', '■'] as const;
function courseMark(courseId?: string | number | null): string {
  const k = courseId === undefined || courseId === null ? '0' : String(courseId);
  return COURSE_MARKS[idMod(k, COURSE_MARKS.length)];
}

/** 卡片明细行：tooltip 逐行渲染（原生 title 只能靠 \n，行距与断行不可控） */
function cardLines(s: ScheduleCell): string[] {
  const p = PERIODS.find(x => x.seq === s.periodNo);
  const name = s.courseName || '（未命名课程）';
  const lines = [
    s.courseCode ? `${name} · ${s.courseCode}` : name,
    `时间：周${CN[(s.weekday ?? 1) - 1]} ${p ? `${p.label}（${timeRange(p)}）` : ''} · ${dateOf(s.weekday ?? 1)}`,
    `教师：${s.teacherName || '—'} · 班级：${s.clazzName || '未填'}`,
    `教室：${s.roomName || '未指定教室'}`
  ];
  if (s.note) lines.push(`备注：${s.note}`);
  const why = conflictOf(s);
  if (why.length) lines.push(`冲突：${why.join('；')}`);
  return lines;
}

/** 读屏朗读文本：tooltip 是悬浮层，读屏用户拿不到，键盘可达必须靠 aria-label */
function cardAria(s: ScheduleCell, sameCellCount: number): string {
  const more = sameCellCount > 1 ? `，同节次共 ${sameCellCount} 节` : '';
  return `${cardLines(s).join('；')}${more}。按回车查看或调整这一节`;
}
function emptyCellAria(weekday: number, periodSeq: number): string {
  const p = PERIODS.find(x => x.seq === periodSeq);
  return `周${CN[weekday - 1]} ${p ? `${p.label}（${timeRange(p)}）` : ''}空闲。按回车在这里新增课次`;
}

/* ---------- 卡片明细悬浮层（2026-10-22 替换原生 title）----------
 * 整张网格共用一个 tooltip（虚拟触发 + manual），不是每张卡各挂一个实例：
 * 一张卡一个实例会往 body 里塞上百个 popper 节点，且 EP 的 OnlyChild 克隆触发元素
 * 会干扰叠牌的绝对定位与 `.cblock + .cblock` 相邻选择器。
 * 原生 title 的问题：换行靠 \n 不可控、无法样式化、悬停 1 秒才出、触屏与键盘拿不到。 */
const cardTipVisible = ref(false);
const cardTipEl = ref<HTMLElement | undefined>(undefined);
const cardTipLines = ref<string[]>([]);
const cardTipHint = ref('');
function showCardTip(el: HTMLElement | undefined, s: ScheduleCell, weekday: number, periodSeq: number) {
  if (!el) return;
  cardTipEl.value = el;
  cardTipLines.value = cardLines(s);
  const n = cellListAt(weekday, periodSeq).length;
  cardTipHint.value =
    `同节次共 ${n} 节 · 拖到空格=移动 · 拖到别的教师的课次=并入/互换 · 拖到同一教师的课次=互换`;
  cardTipVisible.value = true;
}
function hideCardTip() {
  cardTipVisible.value = false;
}
function onCardEnter(e: MouseEvent, s: ScheduleCell, weekday: number, periodSeq: number) {
  hoverCourseId.value = s.courseId ?? null;
  showCardTip(e.currentTarget as HTMLElement | undefined, s, weekday, periodSeq);
}
function onCardLeave() {
  hoverCourseId.value = null;
  hideCardTip();
}

/** 本周摘要条：当前筛选下课次数 / 教师数 / 教室数 / 冲突课次数 */
const weekStats = computed(() => {
  const teachers = new Set<string>();
  const rooms = new Set<string>();
  let conflicts = 0;
  for (const c of filtered.value) {
    if (c.teacherName) teachers.add(c.teacherName);
    if (c.roomName) rooms.add(c.roomName);
    if (conflictOf(c).length) conflicts++;
  }
  return { total: filtered.value.length, teachers: teachers.size, rooms: rooms.size, conflicts };
});

function onDragStart(c: CourseBrief, e: DragEvent) {
  draggingCell.value = null;
  draggingCourse.value = c;
  dragOverKey.value = '';
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', String(c.courseId));
  }
}
/**
 * 拖动课表内已有课次（表内移动 C-19 / 互换 C-20 的来源）。
 * ★ 这里**不再**因为"写请求进行中"就静默 `preventDefault()`——那样用户按下去毫无反应、
 *   也得不到任何解释（这本身就是"有时候按不住"的一个来源）。能不能落库改到 onCellDrop 判定，
 *   并由那里给出明确提示。
 */
function onCellBlockDragStart(cell: ScheduleCell, e: DragEvent) {
  // 三重认证门槛（2026-10-29）：未认证课次不许移动/互换——preventDefault 让拖拽根本起不来，
  // 同时弹说明，避免"按不住又不知道为什么"（与 busy 静默拦截的教训同源）。
  if (!certPassed(cell.courseId)) {
    e.preventDefault();
    ElMessage.info(`「${cell.courseName || '该课程'}」未通过三重认证，不能排课操作；请先在「课程审核」里通过认证`);
    return;
  }
  draggingCourse.value = null;
  draggingCell.value = cell;
  dragOverKey.value = '';
  hideCardTip();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `cell:${cell.scheduleId}`);
  }
}
function onDragEnd() {
  draggingCourse.value = null;
  draggingCell.value = null;
  dragOverKey.value = '';
  poolDragOver.value = false;
}
/* ---------- 拖回待排池（C-22 的拖拽入口）：把已有课次拖到「待排课程」卡片上松手 ---------- */
const poolDragOver = ref(false);
function onPoolDragOver(e: DragEvent) {
  if (!draggingCell.value) return; // 只接受「已有课次」拖回；从池里拖出来的课程不算
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  poolDragOver.value = true;
}
function onPoolDragLeave() {
  poolDragOver.value = false;
}
async function onPoolDrop(e: DragEvent) {
  e.preventDefault();
  poolDragOver.value = false;
  const cell = draggingCell.value;
  draggingCell.value = null; // 先清拖拽态，确认弹窗期间不留高亮
  if (!cell) return;
  await returnToPool(cell);
}
/**
 * 当前拖动源落到某格时的处置方式：
 *   ''         该格不是当前悬停目标
 *   'ok'       可放置 —— 落到**格子空白处**，或落到**别的教师的课次卡片**上：
 *                课程池卡片               ⇒ 该节次新建（C-17）
 *                已有课次 → 空格 / 别人的卡 ⇒ 改到该时间（C-19，与原课次并存）
 *                已有课次 → 不同教师的卡   ⇒ 放下后**由用户选择**「并入这一节」或「互换上课时间」
 *   'swaponly' 只能互换 —— 落到**同一教师**的另一节课卡片上。
 *              同一教师在同一个节次开两门课必然冲突（后端只按"同教师 / 同教室"判冲突），
 *              所以这里没有"并入"这个选项，落下去＝互换上课时间。
 *   'no'       不允许 —— ① 拖到自己所在的那张卡片上（原地放下没有意义）；
 *              ② 该班级在这一节次已另有课（后端编号 60 起「同班级同节次」也判冲突，
 *                 并入放不住、互换只是同班级对调，两种都不成立）
 * ★ 一个节次格可容纳多节课（同时间不同教师/教室并行）：**不同教师并存合法、同一教师并存必冲突**，
 *   规则据此分成「可选并入/互换」与「只能互换」两种。
 * ★ 互换会**把对方也挪走**（比"并入"破坏性大），所以两种都可行时必须让用户显式选，
 *   不做任何默认自动决定 —— 避免"我只是想把他俩放一起，怎么把另一节挪走了"。
 * ★ 真正的冲突仍由后端在落库时判定，前端只负责"这里哪几种操作可行"的引导。
 */
type DropMode = '' | 'ok' | 'swaponly' | 'no';
/** 悬停到的**卡片本体**所属课次 id（0＝不是卡片本体） */
const dragOverCardId = ref<string | number>(0);

/** 两节课是否同一教师：优先比 id，id 缺失时退回比姓名（都拿不准就当作"不同"） */
function isSameTeacher(a: ScheduleCell, b: ScheduleCell) {
  const ai = a.teacherId ?? null;
  const bi = b.teacherId ?? null;
  if (ai !== null && bi !== null) return String(ai) === String(bi);
  const an = (a.teacherName ?? '').trim();
  const bn = (b.teacherName ?? '').trim();
  return !!an && an === bn;
}

/**
 * 该班级在这一「周X 第N节」是否已另有课（排除被拖的那节自己）。
 * 后端编号 60 起把「同班级同节次」也判为冲突 ⇒ 前端提前拦下，省一次注定失败的写请求。
 */
function classBusyAt(cell: ScheduleCell, weekday: number, periodNo: number) {
  const own = (cell.clazzName ?? '').trim();
  if (!own) return false;
  return filtered.value.some(
    c =>
      c.scheduleId !== cell.scheduleId &&
      c.weekday === weekday &&
      c.periodNo === periodNo &&
      (c.clazzName ?? '').trim() === own
  );
}

function dropMode(weekday: number, periodNo: number): DropMode {
  if (!draggingCourse.value && !draggingCell.value) return '';
  if (dragOverKey.value !== keyOf(weekday, periodNo)) return '';
  if (draggingCell.value) {
    // 拖回自己那张卡片：原地放下没有意义
    if (String(dragOverCardId.value) === String(draggingCell.value.scheduleId)) return 'no';
    // 同一教师的另一节课 ⇒ 只能互换（同一教师不可能在同一节次上两门课）
    const hovered = filtered.value.find(x => String(x.scheduleId) === String(dragOverCardId.value));
    if (hovered && isSameTeacher(draggingCell.value, hovered)) return 'swaponly';
    // 该班级在此节次已另有课 ⇒ 并入和互换都放不进（互换是把同班级的两节对调，落点还是同一格）
    if (classBusyAt(draggingCell.value, weekday, periodNo)) return 'no';
  }
  return 'ok';
}
/** 悬停在某张**别的教师**的卡片上 ⇒ 放开后由用户选：并入 / 互换 */
function isChoiceHover(weekday: number, periodNo: number, s: ScheduleCell) {
  return String(dragOverCardId.value) === String(s.scheduleId) && dropMode(weekday, periodNo) === 'ok';
}
/** 悬停在**同一教师**的另一节课卡片上 ⇒ 只能互换 */
function isSwapOnlyHover(weekday: number, periodNo: number, s: ScheduleCell) {
  return String(dragOverCardId.value) === String(s.scheduleId) && dropMode(weekday, periodNo) === 'swaponly';
}

function applyDropEffect(mode: DropMode, e: DragEvent) {
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = draggingCell.value ? 'move' : 'copy';
  }
  // 只有「可放置 / 可互换」才 preventDefault，否则浏览器显示禁止光标且 drop 不触发；
  // 'no' 也放行 drop，好让落点时给出"不能放到原位"的明确解释（静默拦截是上一轮修过的坑）。
  if (mode !== '') e.preventDefault();
}

function onCellDragOver(weekday: number, periodNo: number, e: DragEvent) {
  if (!draggingCourse.value && !draggingCell.value) return;
  dragOverKey.value = keyOf(weekday, periodNo);
  dragOverCardId.value = 0;
  applyDropEffect(dropMode(weekday, periodNo), e);
}
/** 悬停到某张课次卡片上（卡片自己接管，不冒泡给 td）：分「可选并入/互换」与「只能互换」两种 */
function onBlockDragOver(weekday: number, periodNo: number, cell: ScheduleCell, e: DragEvent) {
  if (!draggingCourse.value && !draggingCell.value) return;
  dragOverKey.value = keyOf(weekday, periodNo);
  dragOverCardId.value = cell.scheduleId;
  applyDropEffect(dropMode(weekday, periodNo), e);
}
function onCellDragLeave(e: DragEvent) {
  const cur = e.currentTarget as HTMLElement | null;
  const to = e.relatedTarget as Node | null;
  if (cur && to && cur.contains(to)) return; // 在格子内部移动，不算离开
  dragOverKey.value = '';
  dragOverCardId.value = 0;
}
async function onCellDrop(weekday: number, periodNo: number, e: DragEvent) {
  e.preventDefault();
  await handleDrop(weekday, periodNo, 0);
}
async function onBlockDrop(weekday: number, periodNo: number, cell: ScheduleCell, e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  await handleDrop(weekday, periodNo, cell.scheduleId);
}

/* ---- 「并入 或 互换」二选一弹窗（不同教师两节课落到同一节次时） ---- */
const choiceVisible = ref(false);
const choiceFrom = ref<ScheduleCell | null>(null);
const choiceTo = ref<ScheduleCell | null>(null);
/** 把课次渲染成「周X 3-4 节」，用于弹窗里说明"谁去哪" */
function slotText(c: ScheduleCell | null) {
  if (!c) return '';
  const p = PERIODS.find(x => x.seq === c.periodNo);
  return `周${CN[(c.weekday ?? 1) - 1]} ${p?.label ?? ''}`;
}
function openChoice(from: ScheduleCell, to: ScheduleCell) {
  choiceFrom.value = from;
  choiceTo.value = to;
  choiceVisible.value = true;
}
async function applyChoice(kind: 'join' | 'swap') {
  const from = choiceFrom.value;
  const to = choiceTo.value;
  choiceVisible.value = false;
  choiceFrom.value = null;
  choiceTo.value = null;
  if (!from || !to) return;
  if (kind === 'join') {
    const wd = to.weekday ?? 1;
    const pn = to.periodNo ?? 0;
    await doMove(from, wd, pn);
    // 并入后该格变多课 ⇒ 自动展开（若冲突没并成，格内只有一节，展开条不会出现）
    expandCell(wd, pn);
  } else {
    await doSwap(from, to);
  }
}

/**
 * 落地统一处理。
 * @param targetCardId 落在哪张课次卡片上（0＝落在格子空白处）
 * ★ 规则由"同一节次能不能放下两节课"推导：
 *    空格                ⇒ 直接改到该时间（C-19，该节次原有课次不动）
 *    卡片 + **不同教师** ⇒ 弹出选择：**并入这一节**（C-19）/ **互换上课时间**（C-20）
 *    卡片 + **同一教师** ⇒ 只能互换（同一教师在同一节次开两门课必然冲突，并入放不住）
 *    卡片 + 自己         ⇒ 拦下并说明原因
 */
async function handleDrop(weekday: number, periodNo: number, targetCardId: string | number) {
  dragOverKey.value = '';
  dragOverCardId.value = 0;
  const movingCell = draggingCell.value;
  const newCourse = draggingCourse.value;
  draggingCell.value = null;
  draggingCourse.value = null;

  if (!movingCell && !newCourse) return;
  // ★ 写请求进行中：不静默丢弃，明确告诉用户这次为什么没生效
  //   （窗口已缩小到只剩写请求本身，回读不再算"保存中"）
  if (busy.value) {
    ElMessage.warning('上一次调整还在保存中，请稍候再拖一次');
    return;
  }

  // ① 课表内已有课次
  if (movingCell) {
    // 同班级同节次拦在本地：后端会拒绝，提前说明比让它报一次冲突更省
    if (classBusyAt(movingCell, weekday, periodNo)) {
      ElMessage.warning(
        `「${(movingCell.clazzName ?? '').trim()}」周${CN[weekday - 1]}这一节已有课，同班级不能同时上两门课，这次拖动没生效`
      );
      return;
    }
    if (targetCardId) {
      // ①-1 落回自己 → 原地放下没有意义
      if (String(targetCardId) === String(movingCell.scheduleId)) {
        ElMessage.warning('这就是它当前所在的格子');
        return;
      }
      const target = filtered.value.find(x => String(x.scheduleId) === String(targetCardId));
      if (!target) {
        // 理论上不会发生；兜底按"落到该时间"处理
        await doMove(movingCell, weekday, periodNo);
        return;
      }
      // ①-2 同一教师 ⇒ 只能互换
      if (isSameTeacher(movingCell, target)) {
        ElMessage.info('同一教师不能在同一个节次上两门课，已改为与它互换上课时间');
        await doSwap(movingCell, target);
        return;
      }
      // ①-3 不同教师 ⇒ 交给用户选：并入这一节 / 互换上课时间
      openChoice(movingCell, target);
      return;
    }
    // ①-4 落到格子空白处 ⇒ 直接改到该时间，该节次原有的课次留在原地
    await doMove(movingCell, weekday, periodNo);
    return;
  }
  // ② 课程池卡片 → 该节次新建（C-17）
  //    该格已有别的课也照常放行：同节次不同教师/不同教室是合法排课，
  //    是否冲突交给后端判定（冲突时会在提交后明确提示原因）。
  if (newCourse) {
    await openCreate(weekday, periodNo, { courseId: String(newCourse.courseId) });
  }
}

/* ---------- 撤回（2026-10-18）：每步写操作落库成功后记一条逆向动作，撤回按钮回退上一步 ---------- */
/** 撤回条目：move/edit 记原坐标与原教室班级；swap 对称（再换一次即还原）；
 *  putback 记完整新建参数（原时间原教师原班级）；create 记新建的课次 id（撤回=放回待排） */
type UndoAction =
  | { kind: 'move' | 'edit'; scheduleId: string | number; label: string; prev: ScheduleUpdateBody }
  | { kind: 'swap'; fromScheduleId: string | number; toScheduleId: string | number; label: string }
  | { kind: 'putback'; label: string; restore: ScheduleCreateBody }
  | { kind: 'create'; scheduleId: string | number; label: string }
  /** 周次重复排课（2026-10-20）：一次操作 = 多周课次，撤回 = 逐条放回待排 */
  | { kind: 'batchCreate'; scheduleIds: Array<string | number>; label: string };
const MAX_UNDO = 30;
const historyStack = ref<UndoAction[]>([]);
function pushUndo(a: UndoAction) {
  historyStack.value.push(a);
  if (historyStack.value.length > MAX_UNDO) historyStack.value.shift();
}
/** 撤回按钮 tooltip：显示将被撤回的那步是什么 */
const undoLabel = computed(() => historyStack.value[historyStack.value.length - 1]?.label ?? '');
/** 本次调整记录（最新在前）。depth = 撤回「这一步及其之后」所需的步数 */
const undoHistory = computed(() =>
  historyStack.value
    .map((h, i) => ({ no: i + 1, label: h.label, depth: historyStack.value.length - i }))
    .reverse()
);

/** 单条逆向动作的结果：ok=整步撤成；partial=批量里有条目失败（已撤的算数）；failed=整步没撤成 */
type UndoStep = { state: 'ok' | 'partial' | 'failed'; failed: number; total: number };
async function applyUndoEntry(entry: UndoAction): Promise<UndoStep> {
  try {
    if (entry.kind === 'move' || entry.kind === 'edit') await moveSchedule(entry.scheduleId, entry.prev);
    else if (entry.kind === 'swap') await swapSchedules({ fromScheduleId: entry.fromScheduleId, toScheduleId: entry.toScheduleId });
    else if (entry.kind === 'putback') await createSchedule(entry.restore);
    else if (entry.kind === 'batchCreate') {
      // 批量撤回：逐条放回待排；个别失败不中断（已撤的撤了，失败的提示后可重试或手动处理）
      let failed = 0;
      for (const id of entry.scheduleIds) {
        try {
          await deleteSchedule(id);
        } catch {
          failed++;
        }
      }
      if (failed) return { state: 'partial', failed, total: entry.scheduleIds.length };
    } else await deleteSchedule(entry.scheduleId);
    return { state: 'ok', failed: 0, total: 0 };
  } catch {
    /* 请求层已弹提示；撤回失败保留记录，可再点重试 */
    return { state: 'failed', failed: 1, total: 1 };
  }
}

async function undoLast() {
  const entry = historyStack.value[historyStack.value.length - 1];
  if (!entry || busy.value) return;
  busy.value = true;
  const r = await applyUndoEntry(entry);
  if (r.state === 'failed') {
    busy.value = false;
    return; // 视图未变，不用回读；记录留在栈里可重试
  }
  historyStack.value.pop();
  if (r.state === 'partial') ElMessage.warning(`撤回完成 ${r.total - r.failed}/${r.total} 条，失败的条目可稍后重试`);
  else ElMessage.success(`已撤回：${entry.label}`);
  busy.value = false;
  await load(true);
}

/** 回退到某一步之前（「本次调整记录」下拉点选）：从最新一条起连续撤 depth 步，撤不动就停在已完成处 */
async function undoToStep(depth: number) {
  if (busy.value) return;
  const target = Math.min(depth, historyStack.value.length);
  if (target <= 0) return;
  busy.value = true;
  let done = 0;
  let stopped = '';
  let partialNote = '';
  for (let i = 0; i < target; i++) {
    const entry = historyStack.value[historyStack.value.length - 1];
    if (!entry) break;
    const r = await applyUndoEntry(entry);
    if (r.state === 'failed') {
      stopped = `第 ${done + 1}/${target} 步「${entry.label}」没撤成`;
      break;
    }
    if (r.state === 'partial') partialNote = `批量步里有 ${r.failed}/${r.total} 条没删掉`;
    historyStack.value.pop();
    done++;
  }
  busy.value = false;
  if (stopped) ElMessage.warning(`已回退 ${done} 步后中断：${stopped}，已撤的不再重复`);
  else ElMessage.success(`已回退 ${done} 步${partialNote ? `（${partialNote}）` : ''}`);
  await load(true);
}

/**
 * 执行移动（C-19，落到空白格）。★ 不做乐观更新：先落库、成功后再刷新视图。
 * 冲突/失败时视图本就未变，避免「看着动了、其实没存」的假象。
 */
async function doMove(cell: ScheduleCell, weekday: number, periodNo: number) {
  const period = PERIODS.find(p => p.seq === periodNo);
  if (!period) return;
  const target = `周${CN[weekday - 1]} ${period.label}`;
  // 目标节次原有的课次（不含自己）：有的话，这次移动的效果就是"两节课排到同一节"
  const siblings = (cellMap.value[keyOf(weekday, periodNo)] ?? []).filter(
    s => s.scheduleId !== cell.scheduleId
  );
  // 撤回快照：原时间坐标（classTime 由 weekday/periodNo 精确重算）
  const prevPeriod = PERIODS.find(p => p.seq === cell.periodNo);
  const prev: ScheduleUpdateBody = {
    classTime: `${dateOf(cell.weekday ?? 1)} ${prevPeriod?.start ?? '08:00'}:00`,
    durationMin: prevPeriod?.duration ?? 110,
    weekday: cell.weekday ?? 1,
    periodNo: cell.periodNo ?? 1
  };
  busy.value = true;
  try {
    const res = await moveSchedule(cell.scheduleId, {
      classTime: `${dateOf(weekday)} ${period.start}:00`,
      durationMin: period.duration,
      weekday,
      periodNo
    });
    if (res?.conflict) {
      ElMessage.warning(
        `「${cell.courseName ?? '该课次'}」无法移到${target}：${res.conflictMsg || '该时段教师、教室或班级已被占用'}`
      );
      return;
    }
    pushUndo({
      kind: 'move',
      scheduleId: cell.scheduleId,
      label: `移动「${cell.courseName ?? '该课次'}」到${target}`,
      prev
    });
    ElMessage.success(
      siblings.length
        ? `已把「${cell.courseName ?? '该课次'}」也排到${target}，与该节原有 ${siblings.length} 节课次同时段`
        : `已把「${cell.courseName ?? '该课次'}」移到${target}`
    );
  } catch {
    /* 请求层已弹提示 */
  } finally {
    busy.value = false;
  }
  // ★ 回读放在 busy 之外，且用软遮罩：用户刚拖完一节就能马上拖下一节
  await load(true);
}

/**
 * 执行互换（C-20，落到已占用格）。
 * ★ 后端只对调两节课的时间坐标，课程/教师/教室跟着各自课次走 —— 所以这里
 *   直接按「谁的课去哪一格」来提示，不出现「把课程换过去」这种误导说法。
 * ★ 同样不做乐观更新：后端可能因第三方冲突整体不写，先落库再刷新。
 */
async function doSwap(from: ScheduleCell, to: ScheduleCell) {
  const fromLabel = from.courseName ?? '该课次';
  const toLabel = to.courseName ?? '该课次';
  const fromSlot = `周${CN[(from.weekday ?? 1) - 1]} ${PERIODS.find(p => p.seq === from.periodNo)?.label ?? ''}`;
  const toSlot = `周${CN[(to.weekday ?? 1) - 1]} ${PERIODS.find(p => p.seq === to.periodNo)?.label ?? ''}`;
  busy.value = true;
  try {
    const res = await swapSchedules({
      fromScheduleId: from.scheduleId,
      toScheduleId: to.scheduleId
    });
    if (res?.conflict) {
      ElMessage.warning(
        `「${fromLabel}」与「${toLabel}」无法互换：${res.conflictMsg || '互换后该时段教师、教室或班级已被占用'}`
      );
      return;
    }
    // 撤回：互换是对称操作，再换一次即还原
    pushUndo({
      kind: 'swap',
      fromScheduleId: from.scheduleId,
      toScheduleId: to.scheduleId,
      label: `互换「${fromLabel}」⇄「${toLabel}」`
    });
    ElMessage.success(`已把「${fromLabel}」与「${toLabel}」互换：${fromSlot} ⇄ ${toSlot}`);
  } catch {
    /* 请求层已弹提示 */
  } finally {
    busy.value = false;
  }
  await load(true);
}

/* ---------- 课次详情 ---------- */
/** C-22 放回待排：**两道确认** → 软删课次 → 课程自动回到待排池 */
const returning = ref(false);
async function returnToPool(cell: ScheduleCell) {
  if (!cell || returning.value) return;
  const name = cell.courseName || '该课次';
  const slot = `周${CN[(cell.weekday ?? 1) - 1]} ${PERIODS.find(p => p.seq === cell.periodNo)?.label ?? ''}`;
  // 该课程**学期口径内**还剩几节活跃课次（不含本节）：仅用于提示，不影响回池（放回即回池）
  const scope = filters.termId || currentTermId.value;
  // termId 为 NULL 的课次按「在范围内」处理（同 poolEntries 口径）
  const scopeCells = scope
    ? allCells.value.filter(
        c => c.termId === undefined || c.termId === null || String(c.termId) === String(scope)
      )
    : allCells.value;
  const remaining = scopeCells.filter(c => c.courseId === cell.courseId && c.scheduleId !== cell.scheduleId).length;
  const note = remaining > 0
    ? `该课程本周还有 ${remaining} 节课在课表，不受影响。`
    : '这节课将从课表移除，课程回到「待排课程」池。';
  try {
    // 单次确认即可（2026-10-16 按需求去掉二次确认）
    await ElMessageBox.confirm(
      `确定要把「${name}」（${slot}）放回待排课程吗？${note}`,
      '放回待排',
      { type: 'warning', confirmButtonText: '确认放回', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  returning.value = true;
  try {
    await deleteSchedule(cell.scheduleId);
    // 撤回快照：按原时间/教师/教室/班级新建一节（后端会消费本条软删槽位）
    const backPeriod = PERIODS.find(p => p.seq === cell.periodNo);
    pushUndo({
      kind: 'putback',
      label: `放回「${name}」（${slot}）`,
      restore: {
        courseId: cell.courseId,
        // 原课次必有授课教师；极端脏数据缺失时传 0，撤回会被后端拒绝并明确提示
        teacherId: cell.teacherId ?? 0,
        classroomId: cell.classroomId,
        classTime: `${dateOf(cell.weekday ?? 1)} ${backPeriod?.start ?? '08:00'}:00`,
        durationMin: backPeriod?.duration ?? 110,
        weekday: cell.weekday ?? 1,
        periodNo: cell.periodNo ?? 1,
        targetClass: cell.clazzName || undefined
      }
    });
    ElMessage.success(`「${name}」已回到待排课程池，可拖到新时间重新排课`);
    detailVisible.value = false;
    await load(true);
  } catch {
    /* 请求层已提示 */
  } finally {
    returning.value = false;
  }
}

/* ---------- C-23 删除课程（双重确认）：软删课程主记录 + 级联软删其全部课次 ---------- */
const deletingCourse = ref(false);
async function confirmCourseDelete(courseId: string | number, name: string) {
  if (deletingCourse.value) return;
  if (!courseId) {
    ElMessage.warning('该课次没有关联的课程ID，无法删除课程');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除课程「${name}」吗？该课程名下的课次也会一并从课表移除。`,
      '删除课程',
      { type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  try {
    await ElMessageBox.confirm(
      '删除后课程从课程列表消失，此操作不可撤销。确认删除？',
      '最终确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  deletingCourse.value = true;
  try {
    await deleteCourse(courseId);
    ElMessage.success(`课程「${name}」已删除`);
    detailVisible.value = false;
    createVisible.value = false;
    // 课程池与下拉缓存失效：清空强制 loadPickers 重拉
    courseList.value = [];
    poolCourses.value = [];
    await Promise.all([load(true), loadPickers()]);
  } catch {
    /* 请求层已提示 */
  } finally {
    deletingCourse.value = false;
  }
}
const detailVisible = ref(false);
const detailCell = ref<ScheduleCell | null>(null);
const detailPeriod = computed(() => PERIODS.find(p => p.seq === detailCell.value?.periodNo));
/** 详情弹窗里的可编辑项（C-19：只改教室与备注，上课时间不动） */
const editForm = reactive({ classroomId: '', remark: '', clazzName: '', teacherId: '', major: '' });
/** 全部班级名（基础数据班级列表）：详情弹窗「班级」下拉数据源 */
const clazzNameList = ref<string[]>([]);
/**
 * 班级下拉选项 = 班级主表名单 ∪ 课表里出现过的班级名。
 * ★ 主表登记不全（演示数据大多只存在于课表 target_class 冗余列），只用主表会让
 *   「可选班级」比实际在上课的班级少一大截——用户反馈「只能选一部分」就是这个原因。
 */
const classListOptions = computed(() => {
  const names = new Set<string>(clazzNameList.value);
  for (const o of clazzOptions.value) names.add(o.value);
  return [...names].sort();
});
const detailSaving = ref(false);

/** 详情弹窗教师（2026-10-29 锁只读，同新增弹门口径）：教师 = 课程的授课教师（提交三重认证的老师），弹窗内不可改。
 *  课程池查不到该课程时回退课次自带的教师信息，保证展示不空。
 *  失效条件：产品将来允许「代课 / 换教师」场景 ⇒ 这里恢复下拉，并同步放开下方 dirty 判定与保存 BO。 */
const detailTeacher = computed(() => {
  const c = detailCell.value;
  if (!c) return null;
  const fromCourse = courseById.value.get(String(c.courseId));
  const tid = fromCourse?.teacherId ?? (c.teacherId === undefined || c.teacherId === null ? '' : String(c.teacherId));
  const tname = fromCourse?.teacherName || c.teacherName || '';
  return { id: tid, name: tname || (tid ? `教师 #${tid}` : '未指定教师') };
});

/** 与原值比对，没改就不让点保存（避免无意义写库） */
const detailDirty = computed(() => {
  const c = detailCell.value;
  if (!c) return false;
  const cur = c.classroomId === undefined || c.classroomId === null ? '' : String(c.classroomId);
  return (
    editForm.classroomId !== cur ||
    editForm.remark !== (c.note ?? '') ||
    editForm.clazzName !== (c.clazzName ?? '')
  );
});

/** 详情弹窗班级选项：按选中专业过滤（专业来自班级主表映射或班级名前缀推断）；未选专业=全部 */
const filteredClassOptions = computed(() => {
  if (!editForm.major) return classListOptions.value;
  return classListOptions.value.filter(n => clazzMajorMap.value[n] === editForm.major || majorOf(n) === editForm.major);
});
/** 切换专业后，已选班级若不属于新专业则清空 */
watch(
  () => editForm.major,
  () => {
    if (editForm.clazzName && editForm.major && !filteredClassOptions.value.includes(editForm.clazzName)) {
      editForm.clazzName = '';
    }
  }
);

function openDetail(cell: ScheduleCell) {
  detailCell.value = cell;
  editForm.classroomId = cell.classroomId === undefined || cell.classroomId === null ? '' : String(cell.classroomId);
  editForm.remark = cell.note ?? '';
  editForm.clazzName = cell.clazzName ?? '';
  editForm.teacherId = cell.teacherId === undefined || cell.teacherId === null ? '' : String(cell.teacherId);
  // 联动初值：优先班级主表映射，映射不到按班级名前缀推断
  editForm.major = (cell.clazzName && clazzMajorMap.value[cell.clazzName]) || (cell.clazzName ? majorOf(cell.clazzName) : '') || '';
  detailVisible.value = true;
  // 每周节数核对（只读提示，补齐靠手动拖）：异步拉取，不阻塞弹窗打开
  if (cell.courseId) void loadWeeklyCheck(cell.courseId);
  else weeklyCheck.value = null;
  // 教师/班级/专业下拉强制刷新：别处（账号/基础数据）刚新增的立即可选（异步补拉，不阻塞弹窗打开）
  teacherList.value = [];
  clazzNameList.value = [];
  clazzMajorMap.value = {};
  majorNames.value = [];
  void loadPickers();
}

/**
 * 保存课次调整（复用 C-19）。
 * ★ 只改教室 / 备注：上课时间坐标按**原值**回传（后端必填），所以上课时间不变。
 * ★ 改教室可能撞车（同一时间该教室已被别的课占用）⇒ 后端不落库并回 conflict。
 */
async function saveDetail() {
  const c = detailCell.value;
  if (!c || !detailDirty.value) return;
  const period = PERIODS.find(p => p.seq === c.periodNo);
  if (!period) {
    ElMessage.warning('该课次节次异常，暂时无法调整');
    return;
  }
  const weekday = c.weekday ?? 1;
  // 撤回快照：保存前的教室/备注/班级/教师原值（detailCell 尚未被写回，c 就是原值）
  const prevBo: ScheduleUpdateBody = {
    classTime: `${dateOf(weekday)} ${period.start}:00`,
    durationMin: period.duration,
    weekday,
    periodNo: period.seq,
    classroomId: c.classroomId ?? undefined,
    remark: c.note ?? '',
    targetClass: c.clazzName ?? '',
    teacherId: c.teacherId ?? undefined
  };
  detailSaving.value = true;
  try {
    const res = await moveSchedule(c.scheduleId, {
      classTime: `${dateOf(weekday)} ${period.start}:00`,
      durationMin: period.duration,
      weekday,
      periodNo: period.seq,
      classroomId: editForm.classroomId || undefined,
      remark: editForm.remark,
      targetClass: editForm.clazzName.trim(),
      teacherId: editForm.teacherId || undefined
    });
    if (res?.conflict) {
      ElMessage.warning(`调整未保存：${res.conflictMsg || '该时段教师、教室或班级已被占用'}`);
      return;
    }
    pushUndo({
      kind: 'edit',
      scheduleId: c.scheduleId,
      label: `调整「${c.courseName ?? '该课次'}」的教室/班级/教师`,
      prev: prevBo
    });
    ElMessage.success('课次已调整');
    detailVisible.value = false;
  } catch {
    /* 请求层已弹提示 */
  } finally {
    detailSaving.value = false;
  }
  await load(true);
}

/* ---------- 新增课次（C-17 真接口） ---------- */
const createVisible = ref(false);
const saving = ref(false);
const form = reactive({ courseId: '', teacherId: '', classroomId: '', clazzName: '', weekday: 1, periodNo: 1 });
const createTitle = ref('新增课次');
/** 新增课次弹窗里的「上课班级」下拉，@opened 时把焦点直接放到这个必填项 */
const clazzSelRef = ref<{ focus?: () => void } | null>(null);
let focusClazzOnOpen = false;
const courseList = ref<{ value: string; label: string }[]>([]);
/** 新增课次弹窗「删除课程」按钮上显示的课程名（按当前选中项反查） */
const selectedCourseName = computed(
  () => courseList.value.find(o => o.value === form.courseId)?.label || '该课程'
);
const teacherList = ref<{ value: string; label: string }[]>([]);
/** 拖动/点击课程卡进来时，记录来源课程，用于自动预选授课教师 */
const presetCourseId = ref('');

/** 新增弹窗的课程选项：courseList 过滤出**已通过三重认证**的课（2026-10-29）。
 *  courseList 本体保持全量——顶部课程筛选框还要用它把存量未认证课次筛出来看。 */
const certifiedCourseOptions = computed(() => courseList.value.filter(o => certPassed(o.value)));

/** 授课教师只读化（2026-10-29）：教师固定 = 课程接口返回的 teacherId/teacherName
 *  （即提交三重认证的老师），不提供手选——选了课老师就定了，选不了课就留空拦提交。 */
watch(
  () => form.courseId,
  id => {
    const hit = id ? courseById.value.get(String(id)) : undefined;
    form.teacherId = hit?.teacherId ? String(hit.teacherId) : '';
  }
);

async function loadPickers() {
  if (!courseList.value.length) {
    try {
      const res = await listCoursePool(filters.schoolId || undefined);
      poolCourses.value = res?.list ?? [];
      courseList.value = poolCourses.value
        .map(c => ({ value: String(c.courseId), label: c.courseName || String(c.courseId) }))
        .filter(o => o.value);
    } catch {
      /* 已在请求层提示 */
    }
  }
  if (!teacherList.value.length) {
    try {
      const res = await listUsers({ roleKey: 'teacher', page: 1, pageSize: 100 });
      teacherList.value = (res?.list ?? []).map(u => ({
        value: String(u.userId),
        label: u.nickName || u.username
      }));
    } catch {
      /* 已在请求层提示 */
    }
  }
  if (!terms.value.length) {
    try {
      const res = await listTerms({ page: 1, pageSize: 50 });
      terms.value = (res?.list ?? [])
        .filter(t => t.termId !== undefined)
        .map(t => ({
          termId: t.termId as string,
          name: t.name || String(t.termId),
          startDate: t.startDate,
          endDate: t.endDate
        }));
      // ⛔ 不再默认选中「当前学期」（2026-10-20 实测）：演示数据的课次 term_id 为 NULL，
      // 后端按 termId 过滤会把它们**全部筛掉**（带任何 termId 查询都返回 0 行）⇒ 课表整页空白。
      // 默认「全部学期」，让用户显式选学期；selected 后若为空见模板里的空态提示。
      // 记录当前学期：池子「已排」判定在「全部学期」视图下按它收口
      const curTerm = res?.list?.find(t => t.isCurrent === 1) ?? res?.list?.[0];
      currentTermId.value = curTerm?.termId !== undefined ? String(curTerm.termId) : '';
    } catch {
      /* 已在请求层提示 */
    }
  }
  if (!schools.value.length) {
    try {
      const res = await listSchools({ page: 1, pageSize: 50 });
      schools.value = (res?.list ?? [])
        .filter(s => s.schoolId !== undefined)
        .map(s => ({ schoolId: s.schoolId as string, name: s.name || String(s.schoolId) }));
    } catch {
      /* 已在请求层提示 */
    }
  }
  if (!classroomList.value.length) {
    try {
      const res = await listClassrooms({ page: 1, pageSize: 200 });
      classroomsAll.value = res?.list ?? [];
      classroomList.value = classroomsAll.value.map(r => ({
        value: String(r.classroomId),
        label: r.name || String(r.classroomId)
      }));
    } catch {
      /* 已在请求层提示 */
    }
  }
  if (!Object.keys(clazzMajorMap.value).length || !majorNames.value.length) {
    try {
      const [clsRes, majRes] = await Promise.all([listClasses({ page: 1, pageSize: 200 }), listMajors({ page: 1, pageSize: 100 })]);
      const map: Record<string, string> = {};
      const names: string[] = [];
      for (const c of clsRes?.list ?? []) {
        if (c.clazzName) names.push(c.clazzName);
        if (c.clazzName && c.majorName) map[c.clazzName] = c.majorName;
      }
      clazzNameList.value = names;
      clazzMajorMap.value = map;
      majorNames.value = (majRes?.list ?? []).map(m => m.name || '').filter(Boolean);
    } catch {
      /* 已在请求层提示 */
    }
  }
}

/**
 * 打开新增课次弹窗。
 * @param weekday / periodNo 拖放或点空白格时有值（预填）；从课程卡点击进入时为 null（弹窗内自选）
 * @param preset  预选字段（拖动排课会带上 courseId）
 */
async function openCreate(
  weekday: number | null,
  periodNo: number | null,
  preset: { courseId?: string; classroomId?: string } = {}
) {
  // 课程/教师/班级下拉强制刷新：别处（基础数据/审核/账号）刚新增的无需刷新页面即可选到
  courseList.value = [];
  poolCourses.value = [];
  teacherList.value = [];
  clazzNameList.value = [];
  clazzMajorMap.value = {};
  majorNames.value = [];
  await loadPickers();
  form.classroomId = preset.classroomId ?? '';
  form.clazzName = '';
  form.weekday = weekday ?? 1;
  form.periodNo = periodNo ?? 1;
  // 每周多节：额外节位给个顺手默认（第 2 节默认排到下一工作日、同时段），并同步总节数满额
  for (const s of extraSlots) {
    s.weekday = form.weekday >= 5 ? 1 : form.weekday + 1;
    s.periodNo = form.periodNo;
  }
  syncRepeatTotal();
  presetCourseId.value = preset.courseId ?? '';
  form.courseId = preset.courseId ?? '';

  // 拖动排课：课程自带授课教师 → 自动预选（教师不在可选列表里则不预选，交由人工选）
  // 2026-10-29 起教师整体只读：watch(form.courseId) 统一从课程接口回填，这里不再单独处理
  form.teacherId = '';

  const period = PERIODS.find(x => x.seq === periodNo);
  createTitle.value =
    weekday && period ? `拖动排课 · 周${CN[weekday - 1]} ${period.label}` : '新增课次 · 手动选择时间';
  createVisible.value = true;
  // 班级是唯一推不出来的必填项（课程接口不带班级）⇒ 弹窗开完把焦点放上去，省一次"找框"的点击。
  // 焦点要等 @opened（EP 的开场动画结束）再设，nextTick 时输入框还没法接收焦点。
  focusClazzOnOpen = !form.clazzName;
}

function onCreateOpened() {
  if (!focusClazzOnOpen) return;
  focusClazzOnOpen = false;
  clazzSelRef.value?.focus?.();
}

async function submitCreate() {
  if (!form.courseId) {
    ElMessage.warning('请选择课程');
    return;
  }
  if (!form.teacherId) {
    ElMessage.warning(form.courseId ? '该课程没有登记授课教师，请先在课程管理补全' : '请先选择课程（教师随课程自动带出）');
    return;
  }
  if (!form.clazzName.trim()) {
    ElMessage.warning('请选择上课班级');
    return;
  }
  const period = PERIODS.find(x => x.seq === form.periodNo);
  if (!period) {
    ElMessage.warning('节次不合法');
    return;
  }
  // 每周多节：同周内两节选了相同「星期+节次」= 自己撞自己，直接拦
  const slots = buildRepeatSlots();
  const seenSlots = new Set<string>();
  for (const s of slots) {
    const k = `${s.weekday}-${s.periodNo}`;
    if (seenSlots.has(k)) {
      ElMessage.warning('每周有两节选了同一个「星期 + 节次」，请调整后再保存');
      return;
    }
    seenSlots.add(k);
  }
  // 重复口径下的回退定位：老 jar 可能不回传 scheduleId，靠 load 前后差集找出新建的课次
  const knownIds = new Set(allCells.value.map(c => c.scheduleId));
  saving.value = true;
  try {
    const { createdIds, failed, total } = await createBatch(
      {
        courseId: form.courseId,
        teacherId: form.teacherId,
        classroomId: form.classroomId || undefined,
        weekday: form.weekday,
        periodNo: form.periodNo,
        targetClass: form.clazzName.trim() || undefined
      },
      { slots, capTotal: repeatForm.total }
    );
    await load(true);
    const ids = createdIds.length
      ? createdIds
      : allCells.value
          .filter(
            x =>
              String(x.courseId) === String(form.courseId) &&
              x.weekday === form.weekday &&
              x.periodNo === form.periodNo &&
              !knownIds.has(x.scheduleId)
          )
          .map(x => x.scheduleId);
    const courseLabel = courseList.value.find(o => o.value === form.courseId)?.label ?? '课次';
    if (ids.length) {
      for (const s of slots) expandCell(s.weekday, s.periodNo);
      createVisible.value = false;
      const trimmed = repeatForm.total < repeatForm.weekly * effectiveRepeatTimes.value;
      pushUndo({
        kind: 'batchCreate',
        scheduleIds: ids,
        label: `新增「${courseLabel}」× ${ids.length} 节（${REPEAT_TEXT[repeatForm.mode]}${repeatForm.weekly > 1 ? ` · 每周 ${repeatForm.weekly} 节` : ''}${trimmed ? ' · 前满后少' : ''}）`
      });
      ElMessage.success(
        `已排入 ${ids.length} 节（${REPEAT_TEXT[repeatForm.mode]}${repeatForm.weekly > 1 ? ` · 每周 ${repeatForm.weekly} 节` : ''}，翻周即可查看）`
      );
      if (failed.length) {
        ElMessageBox.alert(`以下时段因冲突未排入：${failed.join('；')}`, '部分课次未排入', { type: 'warning' }).catch(() => {});
      }
    } else if (failed.length) {
      ElMessage.warning(`未保存：${failed[0]}`);
    } else {
      ElMessage.warning('未保存，请稍后重试');
    }
    void total;
  } catch {
    /* 已在请求层提示 */
  } finally {
    saving.value = false;
  }
}

/* ================= 周次重复（2026-10-20 需求）：排一次 = 整学期各周都有课 =================
 * 数据模型：schedule 一行 = 一个具体日期的课次（class_time 存日期、无 week_pattern 字段）。
 * ⇒ 「1-18 周、一周两节」= 第一周排好后，把同 weekday/periodNo 的课次按周逐条 POST
 *   （每行一个真实日期），第 2~18 周翻周即可见 —— 不依赖后端任何新字段。
 * 单双周 = 隔周重复：默认按学期起点锚定——学期第 1、3、5…周 = 单周（odd）、
 *   第 2、4、6…周 = 双周（even）；学期未配开始日期才回退「锚定当前浏览周」（有对调风险，弹窗有提示）。
 */
type RepeatMode = 'once' | 'all' | 'odd' | 'even';
const REPEAT_TEXT: Record<RepeatMode, string> = {
  once: '仅本周一次',
  all: '每周重复',
  odd: '单周（隔周上）',
  even: '双周（隔周上）'
};
/** 会话内记忆上次选择：连续排几门课不必每次重设。
 *  weekly = 每周节数（1~5，每节可分别定时间）；total = 总节数（可小于满额，前满后少）。 */
const repeatForm = reactive<{ mode: RepeatMode; times: number; weekly: number; total: number }>({
  mode: 'all',
  times: 18,
  weekly: 1,
  total: 18
});
/* ---------- 学期锚定（2026-10-29 重开单双周后配套） ----------
 * 隔周奇偶按学期日历算：学期第 1、3、5…周 = 单周，第 2、4、6…周 = 双周。
 * 学期起止来自基础数据-学期（terms 页面已加载）；起点未配置/日期非法时回退旧行为
 * （锚定当前浏览周，并在弹窗里给出橙色风险提示）。★ 日期解析容错：后端实返
 * "2026-08-24 00:00:00"，统一截前 10 位再拼 T，否则带时分秒原串拼 T 得 NaN。 */
function parseDateOnly(v?: string | null): Date | null {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10).replace(/\//g, '-')}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const currentTermInfo = computed(() => terms.value.find(t => String(t.termId) === String(currentTermId.value)) ?? null);
/** 学期第 1 周的周一（学期周中开课也算整第 1 周）；学期没配起点时 = null */
const termAnchorMonday = computed<Date | null>(() => {
  const s = parseDateOnly(currentTermInfo.value?.startDate);
  if (!s) return null;
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
});
const termStartDateLabel = computed(() => currentTermInfo.value?.startDate ? String(currentTermInfo.value.startDate).slice(0, 10) : '');
/** 实际重复次数（once=1，其余 clamp 1~25）——总节数满额 = weekly × 此值。
 *  ★ 学期锚定的隔周：实际次数 = 学期内的单/双周数（times 只是上限），
 *    否则默认 18 次会把满额显示成 18 节而实际学期内只有 9 个单周。 */
const effectiveRepeatTimes = computed(() => {
  if (repeatForm.mode === 'once') return 1;
  const t = Math.max(1, Math.min(25, Math.round(repeatForm.times || 1)));
  const anchor = termAnchorMonday.value;
  const end = parseDateOnly(currentTermInfo.value?.endDate);
  if (anchor && end && (repeatForm.mode === 'odd' || repeatForm.mode === 'even')) {
    const base = new Date(anchor);
    base.setDate(base.getDate() + (repeatForm.mode === 'even' ? 7 : 0));
    let n = 0;
    for (let i = 0; i < t; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + 14 * i);
      if (d > new Date(end.getTime() + 86399000)) break;
      n++;
    }
    return Math.max(1, n);
  }
  return t;
});
/** 每周第 2~5 节的时间（第 1 节 = 表单里的 星期/节次）；weekly 减小时多余项自动不渲染/不提交 */
const extraSlots = reactive(Array.from({ length: 4 }, () => ({ weekday: 1, periodNo: 1 })));
const extraSlotList = computed(() => extraSlots.slice(0, Math.max(0, repeatForm.weekly - 1)));
/** 每周节数 / 重复周数变化时，总节数回到满额（用户随后可手动改小） */
function syncRepeatTotal() {
  repeatForm.total = repeatForm.weekly * effectiveRepeatTimes.value;
}
/** 本次的全部「节位」：第 1 节 = 表单星期/节次，第 2~weekly 节 = extraSlots 前几项 */
function buildRepeatSlots(): Array<{ weekday: number; periodNo: number }> {
  const slots = [{ weekday: form.weekday, periodNo: form.periodNo }];
  for (let i = 0; i < repeatForm.weekly - 1 && i < extraSlots.length; i++) {
    slots.push({ weekday: extraSlots[i].weekday, periodNo: extraSlots[i].periodNo });
  }
  return slots;
}
/** 锚定前缀：每周=当前所在周起；隔周=学期起点（未配则回退当前周） */
const repeatAnchorLabel = computed(() => {
  if (repeatForm.mode !== 'all' && termAnchorMonday.value) return '按学期起点锚定';
  return '以当前所在周为第 1 周';
});
const repeatHint = computed(() => {
  if (repeatForm.mode === 'all') return `每周同一时间上课，共 ${repeatForm.times} 周（如第 1~18 周）`;
  if (repeatForm.mode === 'odd')
    return `学期第 1、3、5…周上课${termStartDateLabel.value ? `（学期始于 ${termStartDateLabel.value}）` : ''}，共 ${effectiveRepeatTimes.value} 次`;
  if (repeatForm.mode === 'even')
    return `学期第 2、4、6…周上课${termStartDateLabel.value ? `（学期始于 ${termStartDateLabel.value}）` : ''}，共 ${effectiveRepeatTimes.value} 次`;
  return '';
});
/** 重复计划展开成的上课日期串（YYYY-MM-DD）。once=1 条；odd/even 隔 14 天；all 隔 7 天。
 *  rp = 重复口径，缺省跟随弹窗表单；自动排课必须传固定口径，否则会被弹窗残留的单双周带偏（2026-10-29 修）。
 *  ★ 隔周锚定学期起点（2026-10-29）：单周=学期第 1、3、5…周、双周=第 2、4、6…周，
 *    从学期中间哪一周排都不错位，且补全整学期（含已过去的周，业主拍板）；
 *    学期没配起点才回退锚定当前浏览周。学期锚定时不出学期结束日。 */
function repeatDates(
  weekday: number,
  rp: { mode: RepeatMode; times: number } = repeatForm,
  /**
   * 自动排课传 true：**无视 mode 一律从学期起点铺到学期末**（2026-10-30 修）。
   * 为什么必须这样：原实现只有隔周（odd/even）才锚定学期，每周（all）是从
   *   `weekStart.value`（当前浏览的那一周）起算 ⇒ 实测 10-30 的库：学期 2026-08-24~2027-01-15，
   *   课次却分布成「8~9 月 0 条、10 月 29、11 月 118、12 月 128、次年 1~2 月 230」——
   *   既漏掉学期前 9 周，又排到学期结束日之后 6 周。自动排课语义就是「给整学期排课」，必须锚学期。
   */
  anchorToTerm = false
): string[] {
  const anchor = termAnchorMonday.value;
  const semEnd = parseDateOnly(currentTermInfo.value?.endDate);
  const semesterAnchored = !!anchor && (anchorToTerm || rp.mode === 'odd' || rp.mode === 'even');
  const base = new Date(semesterAnchored ? anchor! : weekStart.value);
  base.setDate(base.getDate() + (weekday - 1) + (rp.mode === 'even' ? 7 : 0));
  const step = rp.mode === 'odd' || rp.mode === 'even' ? 14 : 7;
  const count = rp.mode === 'once' ? 1 : Math.max(1, Math.min(25, Math.round(rp.times || 1)));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + step * i);
    if (semesterAnchored && semEnd && d > new Date(semEnd.getTime() + 86399000)) break;
    // ★ 每个日期只 push 一次。6329cab 曾误写成连 push 两次 ⇒ 每门课多出一倍「必自我冲突」的
    //   尝试：串行时表现为速度减半 + 报告里「跳过 18 周」；并发下相邻重复日期会同时通过
    //   冲突检查，真的写出重复课次（10-29 16:22 实测 5 门课全部双份）。
    out.push(fmt(d));
  }
  return out;
}

/**
 * 按当前重复口径批量创建课次（手动排课与自动排课共用）。
 * 每条一次真实 POST，6 路并发执行（2026-10-29 提速，见函数内注释）；某条冲突只跳过并记录，不打断其余。
 * slots = 本次的全部「节位」（手动排课每周节数>1 时传多组；自动排课省略 = 单节位）。
 * capTotal = 总节数截断（手动排课传 repeatForm.total）：全部节位按日期升序展开后
 *   只保留最早的 capTotal 条 —— 缺的节从最后一周往前扣（前满后少）。
 */
async function createBatch(
  base: {
    courseId: string | number;
    teacherId: string | number;
    classroomId?: string | number;
    weekday: number;
    periodNo: number;
    targetClass?: string;
  },
  opts?: {
    slots?: Array<{ weekday: number; periodNo: number }>;
    capTotal?: number;
    /** 重复口径覆盖：自动排课传「每周/隔周 × 学期真实周数」，不跟随弹窗残留的单双周选择（2026-10-29） */
    repeat?: { mode: RepeatMode; times: number };
    /** 铺日期时锚定学期起点（自动排课必传）：见 repeatDates 第三参说明（2026-10-30） */
    anchorToTerm?: boolean;
  },
  onProgress?: (done: number, total: number) => void
) {
  const slots = opts?.slots?.length ? opts.slots : [{ weekday: base.weekday, periodNo: base.periodNo }];
  type Plan = { date: string; weekday: number; periodNo: number };
  const plans: Plan[] = [];
  for (const s of slots) {
    for (const d of repeatDates(s.weekday, opts?.repeat, opts?.anchorToTerm)) plans.push({ date: d, weekday: s.weekday, periodNo: s.periodNo });
  }
  plans.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cap = opts?.capTotal;
  let final = cap !== undefined && plans.length > Math.max(1, cap) ? plans.slice(0, Math.max(1, cap)) : plans;
  // 并发防重保险：同一「日期×节位」只发一次。就算上游再产出重复日期，也不会因并发竞态
  // 双双通过冲突检查写出两行（10-29 实测教训：重复日期 + 6 路并发 = 真重复落库）。
  const seen = new Set<string>();
  final = final.filter(pl => {
    const k = `${pl.date}|${pl.periodNo}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  /* 并发写入（2026-10-29 提速）：原来一条一条 await，一门课 18 周 = 18 次串行往返，
   * 实测单条 1.0~1.6s ⇒ 一门课 20~30s、20 门课 10 分钟（业主实测就是这个数）。
   * 实测后端**不串行化**：6 条并发总耗时 721ms，反而比单条 1054ms 还短。
   * 取 6 的理由：同一门课的各周落在不同日期，冲突检查互不干扰；再高会挤占连接池
   * （页面上还有列表轮询在跑），6 是实测稳定值。结果按日期下标归集，报告顺序不变。 */
  const results = new Array<{ id?: string | number; fail?: string }>(final.length);
  let doneCount = 0;
  let cursor = 0;
  const runOne = async (i: number) => {
    const pl = final[i];
    const period = PERIODS.find(p => p.seq === pl.periodNo);
    if (!period) {
      results[i] = { fail: `${pl.date}：节次不合法` };
      onProgress?.(++doneCount, final.length);
      return;
    }
    try {
      const res = await createSchedule({
        ...base,
        weekday: pl.weekday,
        periodNo: pl.periodNo,
        classTime: `${pl.date} ${period.start}:00`,
        durationMin: period.duration
      });
      if (res?.conflict) {
        results[i] = {
          fail: `${pl.date.slice(5)}（周${CN[pl.weekday - 1]} ${period.label}）：${res.conflictMsg || '该时段教师、教室或班级已被占用'}`
        };
      } else if (res.scheduleId) {
        results[i] = { id: res.scheduleId };
      } else {
        results[i] = { fail: `${pl.date.slice(5)}（周${CN[pl.weekday - 1]} ${period.label}）：保存失败（响应无课次 id）` };
      }
    } catch {
      results[i] = { fail: `${pl.date.slice(5)}（周${CN[pl.weekday - 1]} ${period.label}）：保存失败` };
    }
    onProgress?.(++doneCount, final.length);
  };
  // 6 路工作池：cursor 是唯一分发点，Promise 串行取号、响应乱序但结果按下标归位
  const worker = async () => {
    while (cursor < final.length) {
      const i = cursor++;
      await runOne(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, final.length) }, worker));
  // 并发完成顺序不可依赖 ⇒ 按日期下标归集，createdIds / failed 顺序与旧版串行一致
  const createdIds: Array<string | number> = [];
  const failed: string[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.id !== undefined) createdIds.push(r.id);
    if (r.fail) failed.push(r.fail);
  }
  return { createdIds, failed, total: final.length };
}

/* ================= 自动排课（2026-10-20 本地实现；2026-10-22 丙修三处） =================
 * 规则（后端同款冲突判定 + 行业通行做法）：
 *   ① 只排「待排课程」池里的课，课表上已落座的一律不碰（= 行业的「手动排课锁定保护」）。
 *   ② 找位：在该教师空闲的格子里，对 5×5=25 个候选全部打分（见下方 AUTO_W）取最低分，不是取第一个空位。
 *   ③ 教室自动匹配：容量 ≥ 选课人数的空闲教室中取「余量最小」的；没有合适教室则不填（可手动补）。
 *   ④ 排不下/无教师的课跳过并进报告，不卡住其他课。
 * 重复口径固定「每周 × AUTO_WEEKS」，不跟随弹窗残留的单双周选择（2026-10-29 解耦，曾共用 repeatForm 有被带偏的隐患）。
 * ★ 10-29 调研重构（工作汇报/20261029-丙线-自动排课算法调研-对比与改进选项.md）：规划/写库两阶段——
 *   「生成排课方案」只在内存算（动态饱和度排序 + 腾挪回溯 + 随机重启择优），弹窗先给预览，
 *   用户点「确认写入课表」才逐门真实写库；失败课先在方案里救一轮，不再「排不进就直接放弃」。
 * ★ 10-22 修①「点了像没反应」：原代码在开跑那一行就把 autoReport 置成空对象 ⇒ 弹窗立刻切到
 *   「报告视图」，进度文案住在 v-if="!autoReport" 分支里全程不显示，用户从头看到的就是
 *   「排课结果：成功 0 门，跳过 0 门」+「知道了」（零写入探针实测：跑动中显示"成功 8 门"，
 *   而真实待排 12 门 × 18 周 = 187 次串行 POST、单次往返实测均值 327 ms ≈ 一分多钟）。
 *   ⇒ 跑动中只更新 autoProgress，结束后才写 autoReport。
 * ★ 10-22 修②「排出来的课没有班级」：同一探针捕获的 187 条 payload **全部不带 targetClass**，
 *   因为 /courses 出参实测只有 courseCode/courseId/courseName/semester/status/studentCount/teacherId/teacherName，
 *   没有班级字段 ⇒ 自动排的课次按班级筛选看不到、班级视角恒显示「未填班级」。
 *   ⇒ 放回签沿用原课次的班级（内存里就有）；整门新课由弹窗里选一次统一班级；都没选则如实留空并在报告里标明。
 * ★ 10-22 修③「排上了但没排开」：原②是「取第一个空位就 break」，而待排池按课程 id 升序进出、
 *   周一 1 节又常被现有课表占掉 ⇒ 实测 8 门课全落在周一 2~5 节 + 周二 1~5 节，周三门以后空的。
 *   ⇒ 改成对 25 个格子全打分择优，主目标「同班级不同天」，次目标「各天节数拉平」，再次「同教师连排」。 */
const autoVisible = ref(false);
const autoRunning = ref(false);
const autoProgress = ref('');
const autoReport = ref<{ ok: string[]; skip: string[] } | null>(null);
/** 本次自动排课统一写入的班级（放回签优先用各自原课次的班级） */
const autoClass = ref('');
/**
 * 是否连「课程已在课表」的签也重排（默认关，2026-10-30 P0-A）。
 * 关 = 护栏生效：inSchedule 的签是放回留下的软删行，课程其实还在课表上，
 * 让它参与排课就是重复排课（10-29 那次 126 条重复就是这么来的）。
 * 真实需求如果是「整门课换时间」，正确操作是把该课全部节次放回（used 里没它了 → inSchedule 自动变 false）。
 */
const autoIncludeScheduled = ref(false);
/** 本次自动排课实际参与的签 */
const autoEntries = computed(() =>
  poolEntries.value.filter(e => autoIncludeScheduled.value || !e.inSchedule)
);
/** 被护栏挡下的签数（设置视图上说明，不静默吞） */
const autoSkippedInSchedule = computed(() =>
  autoIncludeScheduled.value ? 0 : poolEntries.value.filter(e => e.inSchedule).length
);

function openAuto() {
  if (!poolEntries.value.length) {
    ElMessage.info('待排课程为空，没有可自动排课的课程');
    return;
  }
  // 安全默认：每次打开都回到「跳过已在课表的签」，避免上一次勾选遗留成隐性重复排课
  autoIncludeScheduled.value = false;
  if (!autoEntries.value.length) {
    ElMessage.warning('待排池里的签都对应「课程已在课表上」的放回记录，没有需要排的课；若要整门重排，先把该课全部节次放回');
    return;
  }
  autoReport.value = null;
  autoPlan.value = null;
  autoProgress.value = '';
  autoClass.value = '';
  autoVisible.value = true;
}

/** 这张签能沿用到的班级：放回签（lesson-{id}）= 原课次 clazzName；整门新课（course-{id}）= 弹窗所选 */
function entryClass(entry: PoolEntry) {
  if (entry.key.startsWith('lesson-')) {
    const src = returnedCells.value.find(r => String(r.scheduleId) === entry.key.slice(7));
    const own = (src?.clazzName ?? '').trim();
    if (own) return own;
  }
  return autoClass.value.trim();
}

/* ---------- 自动排课落位规则（2026-10-22：贪心取首个空位 → 全候选打分择优） ----------
 * 原规则：外层按「周一→周五」、内层按「1→5 节」取第一个空位就 break ⇒
 * 8 门课会全堆进周一 2~5 节 + 周二 1~5 节，看着"排上了但没排开"。
 * 现规则：把 5×5=25 个格子全部过一遍硬约束，再按下面的权重打分取最低分。
 * 权重集中在这里，日后按业务口径调参只动这张表，不动结构。 */
/**
 * 自动排课的**兜底**周数：只在学期没配开始/结束日期时使用（2026-10-29 起与弹窗表单解耦）。
 * ★ 2026-10-30 更正：原来把它当唯一口径（写死 18 周），而学期实际 2026-08-24~2027-01-15 = 21 周，
 *   于是自动排课每次都少排 3 周、且起点跟着「当前浏览周」跑。真实周数以 termWeekCount 为准，
 *   本常量退化为「学期没配日期时」的兜底值。
 */
const AUTO_WEEKS = 18;
/** 自动排课要铺的周数 = 学期真实周数（学期起点周一起算，含头尾）；学期没配日期回落 AUTO_WEEKS */
const termWeekCount = computed(() => {
  const anchor = termAnchorMonday.value;
  const end = parseDateOnly(currentTermInfo.value?.endDate);
  if (!anchor || !end) return AUTO_WEEKS;
  const days = Math.floor((end.getTime() - anchor.getTime()) / 86400000) + 1;
  // clamp 1~25 与手动排课 repeatForm.times 的上限一致，避免脏日期把写入量放大到不可控
  return Math.max(1, Math.min(25, Math.ceil(days / 7)));
});
/** 本次自动排课一条课要写的次数：每周=学期周数，隔周=学期内单/双周数 */
function autoRepeatTimes(parity: PoolParity): number {
  return parity === 'all' ? termWeekCount.value : Math.ceil(termWeekCount.value / 2);
}
/* ---------- 每门课的自动排课口径（2026-10-29）：每周 / 单周 / 双周 ----------
 * 会话级状态，key = PoolEntry.key（lesson-{scheduleId} / course-{courseId}，签刷新后仍在）。
 * 残留键不清理也无副作用（签没了就查不到）；隔周展开次数 = 学期周数的一半。 */
type PoolParity = 'all' | 'odd' | 'even';
const PARITY_TEXT: Record<PoolParity, string> = { all: '每周', odd: '单周', even: '双周' };
const poolParity = reactive<Record<string, PoolParity>>({});
function parityOf(e: PoolEntry): PoolParity {
  return poolParity[e.key] ?? 'all';
}
/** 点签上的口径胶囊循环切换：每周 → 单周 → 双周 → 每周 */
function cycleParity(e: PoolEntry) {
  const cur = parityOf(e);
  poolParity[e.key] = cur === 'all' ? 'odd' : cur === 'odd' ? 'even' : 'all';
}
/** 自动排课弹窗的隔周汇总与锚定说明（存在非每周口径的课才显示）；口径按**实际参与集**统计，不按全池 */
const poolParitySummary = computed(() => {
  const odd = autoEntries.value.filter(e => parityOf(e) === 'odd').length;
  const even = autoEntries.value.filter(e => parityOf(e) === 'even').length;
  if (!odd && !even) return '';
  const anchorNote = termAnchorMonday.value
    ? `隔周按学期起点锚定（学期始于 ${termStartDateLabel.value}，单周=第 1、3、5…周）`
    : '当前学期未配开始日期，隔周以当前浏览周为锚，开始前请先翻到学期第 1 周';
  return `单周 ${odd} 门 · 双周 ${even} 门——${anchorNote}`;
});
type AutoSlot = { weekday: number; periodNo: number; classroomId?: string; capacity?: number };
const AUTO_W = {
  /** 主目标：同一班级同一天已有几节课（每多一节 +100，等于把班级摊到不同天） */
  sameClassDay: 100,
  /** 次目标：该天（全校+本次已排）总节数，让周一~周五负载接近 */
  dayLoad: 6,
  /** 平摊之后让同一教师的课尽量连排，少留空等：与当天最近一节的节次距离 */
  teacherGap: 1,
  /** 该时段没有满足容量的教室 ⇒ 可以排但不推荐（轻罚，避免整门课直接放弃） */
  noRoom: 2,
  /** 教室容量余量：够用就好，别占大教室 */
  roomSlack: 0.2,
  /** 同分时靠早节次（0.05 ⇒ 只在以上全部打平时才起作用） */
  period: 0.05
};
function scoreAutoSlot(
  slot: AutoSlot,
  s: { sameClassDay: number; dayLoad: number; teacherGap: number; need: number }
): number {
  const slack = slot.classroomId ? Math.max((slot.capacity ?? 0) - s.need, 0) : 0;
  return (
    s.sameClassDay * AUTO_W.sameClassDay +
    s.dayLoad * AUTO_W.dayLoad +
    s.teacherGap * AUTO_W.teacherGap +
    (slot.classroomId ? 0 : AUTO_W.noRoom) +
    slack * AUTO_W.roomSlack +
    slot.periodNo * AUTO_W.period
  );
}

/* ---------- 规划引擎（2026-10-29 调研后重构）：先规划后写库 + 动态饱和度 + 腾挪回溯 + 随机重启 ----------
 * 业界对标（详见 工作汇报/20261029-丙线-自动排课算法调研-对比与改进选项.md）：
 *   P1 动态饱和度：每落位一门就重算剩余课的空位数、最紧的先排（Brelaz 1979；旧版只在开跑时排一次序，会错过紧张度反转）
 *   P2 规划/写库分离：方案在内存成型 → 弹窗预览 → 用户确认才逐门写库（旧版边找位边 POST，试错要付真实写库代价）
 *   P3 腾挪回溯：新课无位时挑一门「挪走后双方都有位」的已规划课让位（Nottingham IH2 驱逐重排的单层简化）
 *   P4 随机重启：同分随机破平跑 N 个方案取罚分最低（文献实证：贪心+随机重启≈弱化版元启发式）
 * 明确不做 GA/模拟退火/CP-SAT：分钟级耗时+服务端算力，本页十来门课×25 格的规模用不上。
 * 占用口径保持保守：单双周在占用表里按「整学期已占」处理（隔周共用同一格留待后续单独做）。 */

/** 规划期占用快照：buildAutoCtx 一次打底（课表现状），每次重启 cloneAutoCtx 一份，绝不写回真实课表 */
type AutoCtx = {
  teacherBusy: Set<string>;
  roomBusy: Set<string>;
  clazzBusy: Set<string>;
  sameClassDay: Record<string, number>;
  dayLoad: Record<number, number>;
  teacherPeriods: Record<string, number[]>;
};

/** 预览方案里的一门课：slot/clazz/parity 在规划时定死，提交时直接用（避免弹窗班级中途被改导致口径漂移） */
type PlannedItem = {
  entry: PoolEntry;
  clazz: string;
  parity: PoolParity;
  slot: AutoSlot;
  score: number;
  /** 本课曾为谁让位（自己被腾挪到次优格时记录对方课名，预览里如实展示） */
  movedFor: string | null;
  /** 本课排入时挤走了谁（对方已改排次优格） */
  ejected: string | null;
};

type AutoPlan = {
  items: PlannedItem[];
  failures: Array<{ label: string; reason: string }>;
  /** 全方案罚分 = 各格得分之和 + 每门失败课重罚；随机重启择优的依据 */
  penalty: number;
};

/** 重启次数：规划是纯内存计算（十来门课×25 格），8 次毫秒级完成；再多收益递减 */
const AUTO_RESTARTS = 8;
/** 失败重罚：让「少一门失败」的方案无条件胜过「格位打分更优」的方案 */
const AUTO_FAIL_PENALTY = 1e6;

function buildAutoCtx(): AutoCtx {
  const ctx: AutoCtx = {
    teacherBusy: new Set(),
    roomBusy: new Set(),
    clazzBusy: new Set(),
    sameClassDay: {},
    dayLoad: {},
    teacherPeriods: {}
  };
  for (const c of allCells.value) {
    if (!c.weekday || !c.periodNo) continue;
    if (c.teacherId !== undefined && c.teacherId !== null) {
      ctx.teacherBusy.add(`${c.weekday}-${c.periodNo}-${c.teacherId}`);
      (ctx.teacherPeriods[`${c.teacherId}|${c.weekday}`] ??= []).push(c.periodNo);
    }
    if (c.classroomId !== undefined && c.classroomId !== null) ctx.roomBusy.add(`${c.weekday}-${c.periodNo}-${c.classroomId}`);
    ctx.dayLoad[c.weekday] = (ctx.dayLoad[c.weekday] ?? 0) + 1;
    const own = (c.clazzName ?? '').trim();
    if (own) {
      ctx.clazzBusy.add(`${c.weekday}-${c.periodNo}-${own}`);
      ctx.sameClassDay[`${own}|${c.weekday}`] = (ctx.sameClassDay[`${own}|${c.weekday}`] ?? 0) + 1;
    }
  }
  return ctx;
}

function cloneAutoCtx(c: AutoCtx): AutoCtx {
  return {
    teacherBusy: new Set(c.teacherBusy),
    roomBusy: new Set(c.roomBusy),
    clazzBusy: new Set(c.clazzBusy),
    sameClassDay: { ...c.sameClassDay },
    dayLoad: { ...c.dayLoad },
    teacherPeriods: Object.fromEntries(Object.entries(c.teacherPeriods).map(([k, v]) => [k, [...v]]))
  };
}

/** 把一次落位写进占用/负载表（正常落位与腾挪回溯共用；下一门课打分必须看得见这一门） */
function ctxPlace(ctx: AutoCtx, teacherId: string | number, clazz: string, slot: AutoSlot) {
  ctx.teacherBusy.add(`${slot.weekday}-${slot.periodNo}-${teacherId}`);
  if (clazz) ctx.clazzBusy.add(`${slot.weekday}-${slot.periodNo}-${clazz}`);
  if (slot.classroomId) ctx.roomBusy.add(`${slot.weekday}-${slot.periodNo}-${slot.classroomId}`);
  ctx.dayLoad[slot.weekday] = (ctx.dayLoad[slot.weekday] ?? 0) + 1;
  (ctx.teacherPeriods[`${teacherId}|${slot.weekday}`] ??= []).push(slot.periodNo);
  if (clazz) ctx.sameClassDay[`${clazz}|${slot.weekday}`] = (ctx.sameClassDay[`${clazz}|${slot.weekday}`] ?? 0) + 1;
}

/** ctxPlace 的逆操作：腾挪回溯要临时摘掉一门已规划课再试位，试完放回 */
function ctxUnplace(ctx: AutoCtx, teacherId: string | number, clazz: string, slot: AutoSlot) {
  ctx.teacherBusy.delete(`${slot.weekday}-${slot.periodNo}-${teacherId}`);
  if (clazz) ctx.clazzBusy.delete(`${slot.weekday}-${slot.periodNo}-${clazz}`);
  if (slot.classroomId) ctx.roomBusy.delete(`${slot.weekday}-${slot.periodNo}-${slot.classroomId}`);
  ctx.dayLoad[slot.weekday] = Math.max(0, (ctx.dayLoad[slot.weekday] ?? 0) - 1);
  const arr = ctx.teacherPeriods[`${teacherId}|${slot.weekday}`];
  if (arr) {
    const i = arr.indexOf(slot.periodNo);
    if (i >= 0) arr.splice(i, 1);
  }
  if (clazz) {
    const k = `${clazz}|${slot.weekday}`;
    ctx.sameClassDay[k] = Math.max(0, (ctx.sameClassDay[k] ?? 0) - 1);
  }
}

/** 单格评估：过硬约束（教师/班级）→ 配容量最贴的空闲教室 → 按 AUTO_W 打分；违反硬约束返回 null */
function evalAutoSlot(
  ctx: AutoCtx,
  teacherId: string | number,
  clazz: string,
  need: number,
  wd: number,
  pn: number,
  roomCandidates: Classroom[]
): { slot: AutoSlot; score: number } | null {
  if (ctx.teacherBusy.has(`${wd}-${pn}-${teacherId}`)) return null;
  if (clazz && ctx.clazzBusy.has(`${wd}-${pn}-${clazz}`)) return null;
  let best: Classroom | undefined;
  for (const r of roomCandidates) {
    if (ctx.roomBusy.has(`${wd}-${pn}-${r.classroomId}`)) continue;
    if ((r.capacity ?? 0) < need) continue;
    if (!best || (r.capacity ?? 0) < (best.capacity ?? 0)) best = r;
  }
  const slot: AutoSlot = { weekday: wd, periodNo: pn, classroomId: best?.classroomId, capacity: best?.capacity };
  const used = ctx.teacherPeriods[`${teacherId}|${wd}`] ?? [];
  const score = scoreAutoSlot(slot, {
    sameClassDay: clazz ? ctx.sameClassDay[`${clazz}|${wd}`] ?? 0 : 0,
    dayLoad: ctx.dayLoad[wd] ?? 0,
    teacherGap: used.length ? Math.min(...used.map(p => Math.abs(p - pn))) : 0,
    need
  });
  return { slot, score };
}

/** 25 格全扫取最低分；rng 传入时对同分（±1e-9）格随机破平——这是随机重启的唯一随机源 */
function bestAutoSlot(
  ctx: AutoCtx,
  teacherId: string | number,
  clazz: string,
  need: number,
  roomCandidates: Classroom[],
  rng?: () => number,
  exclude?: string
): { slot: AutoSlot; score: number } | null {
  let bestScore = Number.POSITIVE_INFINITY;
  const ties: Array<{ slot: AutoSlot; score: number }> = [];
  for (const wd of [1, 2, 3, 4, 5]) {
    for (const pn of [1, 2, 3, 4, 5]) {
      if (exclude && `${wd}-${pn}` === exclude) continue;
      const r = evalAutoSlot(ctx, teacherId, clazz, need, wd, pn, roomCandidates);
      if (!r) continue;
      if (r.score < bestScore - 1e-9) {
        bestScore = r.score;
        ties.length = 0;
        ties.push(r);
      } else if (r.score <= bestScore + 1e-9) {
        ties.push(r);
      }
    }
  }
  if (!ties.length) return null;
  return rng && ties.length > 1 ? ties[Math.floor(rng() * ties.length)] : ties[0];
}

/** 一条签在给定占用下的自由度：教师还剩几格 / 班级还剩几格 / 两者同时空的格数（诊断与排序共用一套口径） */
function slotFreedom(ctx: AutoCtx, entry: PoolEntry) {
  const clz = entryClass(entry).trim();
  let freeTeacher = 0;
  let freeClazz = 0;
  let common = 0;
  for (const wd of [1, 2, 3, 4, 5]) {
    for (const pn of [1, 2, 3, 4, 5]) {
      const t = !entry.teacherId || !ctx.teacherBusy.has(`${wd}-${pn}-${entry.teacherId}`);
      const c = !clz || !ctx.clazzBusy.has(`${wd}-${pn}-${clz}`);
      if (t) freeTeacher++;
      if (c) freeClazz++;
      if (t && c) common++;
    }
  }
  return { freeTeacher, freeClazz, common };
}

/**
 * 排不进的**具体**原因（2026-10-30）。原来失败时统一写「该教师或该班级已被占满」，
 * 用户看不出到底谁满、还能不能救；实测 10-30 「张老师占满 25 格」时这条笼统文案几乎没信息量。
 * 三种无解情形分开报：教师满 / 班级满 / 各自有空但无交集。
 * 教室不参与判定：没有合适教室只按 AUTO_W.noRoom 轻罚，不会让一门课排不进。
 * 返回 null = 其实有空位（调用方不该走到失败分支）。
 */
function noSlotReason(ctx: AutoCtx, entry: PoolEntry): string | null {
  if (!entry.teacherId) return '课程未指定授课教师，自动排课要求先定教师';
  const f = slotFreedom(ctx, entry);
  if (f.common > 0) return null;
  const who = entry.teacherName || String(entry.teacherId);
  if (f.freeTeacher === 0) return `教师「${who}」本周 25 个格已排满，排不到任何时间`;
  const clz = entryClass(entry).trim();
  if (clz && f.freeClazz === 0) return `班级「${clz}」本周 25 个格已排满，换教师也排不进`;
  return `教师还剩 ${f.freeTeacher} 格、班级还剩 ${f.freeClazz} 格，但没有共同的空档（要错开其中一方才有位）`;
}

/** 饱和度（Brelaz 1979）：教师×班级当前还剩多少可并存格；缺教师的课返回 ∞ 不参与排序（反正要跳过） */
function freeAutoSlots(ctx: AutoCtx, entry: PoolEntry): number {
  if (!entry.teacherId) return Number.POSITIVE_INFINITY;
  // 与 noSlotReason 共用 slotFreedom 一处口径：排序与诊断必须看到同一组数字
  return slotFreedom(ctx, entry).common;
}

/** 构造一个完整方案（纯内存，不写库）：动态饱和度选课 → 打分选格 → 失败时单层腾挪 → 罚分汇总 */
function buildPlanOnce(ctxBase: AutoCtx, roomCandidates: Classroom[], rng: () => number): AutoPlan {
  const ctx = cloneAutoCtx(ctxBase);
  // ★ 只取 autoEntries（默认剔除 inSchedule 的签）：直接读全池会把放回留下的软删行
  //   当成「待排的新课」再铺满一学期 —— 10-29 那次 126 条重复排课就是这么产生的（P0-A 护栏）。
  const remaining = autoEntries.value.slice();
  const items: PlannedItem[] = [];
  const failures: AutoPlan['failures'] = [];
  let penalty = 0;
  while (remaining.length) {
    // P1：每次落位后重算剩余课的饱和度，最紧的先占位；同分随机破平（给 P4 提供多样性）
    let min = Number.POSITIVE_INFINITY;
    for (const e of remaining) {
      const f = freeAutoSlots(ctx, e);
      if (f < min) min = f;
    }
    const ties = remaining.filter(e => freeAutoSlots(ctx, e) === min);
    const entry = ties[Math.floor(rng() * ties.length)];
    remaining.splice(remaining.indexOf(entry), 1);
    const label = `「${entry.courseName}」`;
    if (!entry.teacherId) {
      failures.push({ label, reason: '课程未指定授课教师，自动排课要求先定教师' });
      continue;
    }
    const clazz = entryClass(entry).trim();
    const need = entry.studentCount ?? 0;
    const pick = bestAutoSlot(ctx, entry.teacherId, clazz, need, roomCandidates, rng);
    if (pick) {
      ctxPlace(ctx, entry.teacherId, clazz, pick.slot);
      items.push({ entry, clazz, parity: parityOf(entry), slot: pick.slot, score: pick.score, movedFor: null, ejected: null });
      penalty += pick.score;
      continue;
    }
    // P3 腾挪回溯（单层）：挑「挪走后本课有位、且自己也有次优格」的已规划课，让位代价最小者成交
    let deal: {
      q: PlannedItem;
      qOldScore: number;
      qNew: { slot: AutoSlot; score: number };
      ePick: { slot: AutoSlot; score: number };
      cost: number;
    } | null = null;
    for (const q of items) {
      ctxUnplace(ctx, q.entry.teacherId!, q.clazz, q.slot);
      const ePick = bestAutoSlot(ctx, entry.teacherId, clazz, need, roomCandidates);
      if (ePick) {
        // Q 自己的次优格不能还是原格（exclude），否则腾挪是空转
        const qNew = bestAutoSlot(ctx, q.entry.teacherId!, q.clazz, q.entry.studentCount ?? 0, roomCandidates, undefined, `${q.slot.weekday}-${q.slot.periodNo}`);
        if (qNew) {
          // 代价主看 Q 让位变差多少；E 的格位打分做次级参照（×1e-3 防止 E 挑了差格）
          const cost = qNew.score - q.score + ePick.score * 1e-3;
          if (!deal || cost < deal.cost) deal = { q, qOldScore: q.score, qNew, ePick, cost };
        }
      }
      ctxPlace(ctx, q.entry.teacherId!, q.clazz, q.slot);
    }
    if (deal) {
      ctxUnplace(ctx, deal.q.entry.teacherId!, deal.q.clazz, deal.q.slot);
      ctxPlace(ctx, deal.q.entry.teacherId!, deal.q.clazz, deal.qNew.slot);
      ctxPlace(ctx, entry.teacherId, clazz, deal.ePick.slot);
      deal.q.slot = deal.qNew.slot;
      deal.q.score = deal.qNew.score;
      deal.q.movedFor = entry.courseName;
      items.push({ entry, clazz, parity: parityOf(entry), slot: deal.ePick.slot, score: deal.ePick.score, movedFor: null, ejected: deal.q.entry.courseName });
      penalty += deal.qNew.score - deal.qOldScore + deal.ePick.score;
    } else {
      // 精确归因（2026-10-30）：走到这里 ctx 已是「全部落位 + 腾挪尝试完」的状态，诊断的就是真实占用
      const why = noSlotReason(ctx, entry) ?? '周一至周五 1~5 节无可用格（规划期未定位到具体原因）';
      failures.push({
        label: `${label}${clazz ? `（${clazz}）` : ''}`,
        reason: why
      });
    }
  }
  penalty += failures.length * AUTO_FAIL_PENALTY;
  return { items, failures, penalty };
}

const autoPlan = ref<AutoPlan | null>(null);

/**
 * 排课前的可行性预检（2026-10-30）：点「生成排课方案」之前就把「无论如何都排不进」的签指出来。
 * 用与规划完全相同的占用表（buildAutoCtx）与诊断函数（noSlotReason），所以预检结论与预览必然一致。
 * 只在弹窗打开时计算——buildAutoCtx 要遍历本周全部课次，页面其余时刻没必要跑。
 */
const autoFeasibility = computed(() => {
  if (!autoVisible.value) return null;
  const entries = autoEntries.value;
  if (!entries.length) return null;
  const ctx = buildAutoCtx();
  const blocked = entries
    .map(e => ({ e, reason: noSlotReason(ctx, e) }))
    .filter((x): x is { e: PoolEntry; reason: string } => !!x.reason);
  return { total: entries.length, blocked };
});

/** 本学期自动排课会写入的日期范围（设置视图明示，避免「排了但没覆盖整学期」这种事后才发现的问题） */
const autoTermRangeLabel = computed(() => {
  const anchor = termAnchorMonday.value;
  const end = parseDateOnly(currentTermInfo.value?.endDate);
  if (!anchor || !end) return `未配置学期起止日期，按兜底 ${AUTO_WEEKS} 周铺`;
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `学期第 1~${termWeekCount.value} 周（${fmt(anchor)} ~ ${fmt(end)}）`;
});

/** 隔周课在本学期实际要写的次数（设置视图明示用；与 autoRepeatTimes('odd'|'even') 同值） */
const autoOddEvenTimes = computed(() => Math.ceil(termWeekCount.value / 2));

/** 阶段一「生成排课方案」：纯内存规划（毫秒级），产出预览；一条数据都不写（P2） */
function runAuto() {
  if (autoRunning.value || !autoEntries.value.length) return;
  const ctxBase = buildAutoCtx();
  const roomCandidates = classroomsAll.value.filter(r => (r.status ?? 'active') !== 'inactive');
  // P4 随机重启：同分随机破平跑 N 个方案取罚分最低
  let best: AutoPlan | null = null;
  for (let i = 0; i < AUTO_RESTARTS; i++) {
    const p = buildPlanOnce(ctxBase, roomCandidates, Math.random);
    if (!best || p.penalty < best.penalty - 1e-9) best = p;
  }
  autoPlan.value = best;
}

/** 预览单行文案（与最终报告同口径，用户看到什么就写入什么） */
function planItemText(item: PlannedItem): string {
  const roomName = item.slot.classroomId ? classroomsAll.value.find(r => r.classroomId === item.slot.classroomId)?.name ?? '' : '';
  const where = `周${CN[item.slot.weekday - 1]} ${PERIODS.find(p => p.seq === item.slot.periodNo)?.label ?? ''}${roomName ? ' · ' + roomName : ''}${item.clazz ? ' · ' + item.clazz : ''}`;
  const n = autoRepeatTimes(item.parity);
  const times = item.parity === 'all' ? `${n} 周` : `${n} 次 · ${PARITY_TEXT[item.parity]}`;
  const moved = item.movedFor ? `（为「${item.movedFor}」让位，改排次优格）` : '';
  return `「${item.entry.courseName}」→ ${where}（${times}${item.clazz ? '' : '，未填班级'}）${moved}`;
}

/** 阶段二「确认写入课表」：按预览方案逐门真实写库；报告口径与旧版一致，写入失败如实进 skip */
async function commitAuto() {
  const plan = autoPlan.value;
  if (!plan || autoRunning.value) return;
  autoRunning.value = true;
  autoReport.value = null;
  const ok: string[] = [];
  const skip: string[] = [];
  try {
    for (const f of plan.failures) skip.push(`${f.label}：${f.reason}`);
    for (const [i, item] of plan.items.entries()) {
      autoProgress.value = `正在写入「${item.entry.courseName}」：第 ${i + 1}/${plan.items.length} 门（已写入 ${ok.length}）`;
      const { createdIds, failed, total } = await createBatch(
        {
          courseId: item.entry.courseId,
          teacherId: item.entry.teacherId!,
          classroomId: item.slot.classroomId,
          weekday: item.slot.weekday,
          periodNo: item.slot.periodNo,
          targetClass: item.clazz || undefined
        },
        { repeat: { mode: item.parity, times: autoRepeatTimes(item.parity) }, anchorToTerm: true },
        (done, t) => {
          autoProgress.value = `正在写入「${item.entry.courseName}」第 ${done}/${t} 周（第 ${i + 1}/${plan.items.length} 门）`;
        }
      );
      const roomName = item.slot.classroomId ? classroomsAll.value.find(r => r.classroomId === item.slot.classroomId)?.name ?? '' : '';
      const where = `周${CN[item.slot.weekday - 1]} ${PERIODS.find(p => p.seq === item.slot.periodNo)?.label ?? ''}${roomName ? ' · ' + roomName : ''}${item.clazz ? ' · ' + item.clazz : ''}`;
      const movedNote = item.movedFor ? `（为「${item.movedFor}」让位后改排）` : '';
      if (createdIds.length) {
        ok.push(
          `「${item.entry.courseName}」→ ${where}（${createdIds.length}/${total}${item.parity === 'all' ? ' 周' : ` 次 · ${PARITY_TEXT[item.parity]}`}${failed.length ? `，跳过 ${failed.length} 周` : ''}${item.clazz ? '' : '，未填班级'}）${movedNote}`
        );
        pushUndo({ kind: 'batchCreate', scheduleIds: createdIds, label: `自动排课「${item.entry.courseName}」` });
      } else {
        skip.push(`「${item.entry.courseName}」：预览方案写入失败（${failed[0] ?? '原因未知'}）`);
      }
    }
    autoReport.value = { ok, skip };
    autoPlan.value = null;
  } finally {
    autoRunning.value = false;
    autoProgress.value = '';
  }
  await load(true);
}

/* ---------- 发布课表（C-24）：draft→published，整学期口径 ----------
 * ★ 新建课次 = 未发布（学生/教师端不可见，卡片带「未发布」灰标）；
 *   点发布后其他端才可见。已发布课次再改动保持已发布（2026-10-19 拍板）。 */
async function onPublish() {
  try {
    await ElMessageBox.confirm(
      '将把全部未发布的课次设为已发布（整学期范围），学生端/教师端即可看到。已发布过的课次不受影响。确定发布？',
      '发布课表',
      { confirmButtonText: '发布', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return; // 用户取消
  }
  const res = await publishSchedules();
  ElMessage.success(res.published > 0 ? `已发布 ${res.published} 条课次` : '没有需要发布的课次');
  await load(true);
}

/* ---------- 导出：前端本地 CSV（2026-10-20 加维度：总表 / 按教师 / 按教室） ---------- */
function exportCsv(mode: 'week' | 'teacher' | 'classroom' = 'week') {
  const rows = (filtered.value.length ? filtered.value : allCells.value).slice();
  if (!rows.length) {
    ElMessage.info('当前没有可导出的课次');
    return;
  }
  rows.sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.periodNo ?? 0) - (b.periodNo ?? 0));
  const line = (cols: (string | number | undefined)[]) =>
    cols.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  const head = ['节次', '时间', '星期', '课程', '班级', '教师', '教室', '备注'];
  const rowLine = (r: ScheduleCell) => {
    const p = PERIODS.find(x => x.seq === r.periodNo);
    return line([
      p?.label ?? String(r.periodNo ?? ''),
      p ? timeRange(p) : '',
      `周${CN[(r.weekday ?? 1) - 1]}`,
      r.courseName ?? '',
      r.clazzName ?? '',
      r.teacherName ?? '',
      r.roomName ?? '',
      r.note ?? ''
    ]);
  };
  let csv = '';
  let nameSuffix = '';
  if (mode === 'week') {
    csv = [line(head), ...rows.map(rowLine)].join('\r\n');
  } else {
    // 分组导出：同一份数据换聚合视角（教师课表 / 教室课表），组间空行分隔
    const keyOfRow = mode === 'teacher' ? (r: ScheduleCell) => r.teacherName || '未指定教师' : (r: ScheduleCell) => r.roomName || '未指定教室';
    const groups = new Map<string, ScheduleCell[]>();
    for (const r of rows) {
      const k = keyOfRow(r);
      const list = groups.get(k);
      if (list) list.push(r);
      else groups.set(k, [r]);
    }
    const parts: string[] = [];
    for (const [k, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
      parts.push(line([`${mode === 'teacher' ? '教师' : '教室'}：${k}`]), ...list.map(rowLine), '');
    }
    csv = parts.join('\r\n');
    nameSuffix = mode === 'teacher' ? '_按教师' : '_按教室';
  }
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `课表${nameSuffix}_${weekStartStr.value}_${weekEndStr.value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(
    mode === 'week' ? '课表已导出（CSV，可用 Excel/WPS 打开）' : `已按${mode === 'teacher' ? '教师' : '教室'}分组导出`
  );
}

onMounted(async () => {
  // 节次配置不进 await 链：兜底初值已让表格行结构成立，接口晚到只晚一帧重渲染，
  // 没必要让它拖慢课表与下拉的首屏
  void loadPeriods();
  await Promise.all([load(), loadPickers()]);
});

/** 学期切换（服务端过滤）⇒ 重查本周课次 */
watch(
  () => [filters.termId, filters.schoolId],
  () => load()
);
</script>

<template>
  <!-- 节次降级提示（施工项 #3）：只在兜底生效时出现；用中性警示色而非红底——
       页面此时是完全可用的，红底"操作被拒"的既有语义会把人吓去查权限 -->
  <div v-if="periodsFallback" class="periods-fallback" role="status">
    <ZkIcon name="info" :size="15" style="flex: none" />
    <span>{{ PERIODS_FALLBACK_TIP }}</span>
  </div>
  <div class="page-head">
    <h1>智能排课</h1>
    <div class="actions">
      <!-- trigger 默认 hover：点一下不开菜单，键盘 / 触屏用户到不了导出 ⇒ 改点击触发 -->
      <el-dropdown trigger="click" @command="(m: 'week' | 'teacher' | 'classroom') => exportCsv(m)">
        <button class="btn btn-outline" type="button">
          <ZkIcon name="download" :size="16" style="margin-right: 4px" />导出课表<i class="icaret" aria-hidden="true"></i>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="week">本周总课表</el-dropdown-item>
            <el-dropdown-item command="teacher">按教师分组（教师课表）</el-dropdown-item>
            <el-dropdown-item command="classroom">按教室分组（教室课表）</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <button class="btn btn-primary" title="把待排课程自动找空闲时段排入课表" @click="openAuto">
        <ZkIcon name="zap" :size="16" style="margin-right: 4px" />自动排课
      </button>
    </div>
  </div>

  <div class="toolbar">
    <div class="right" style="gap: 8px; flex-wrap: wrap; width: 100%">
      <div class="week-nav">
        <el-date-picker
          :model-value="weekStart"
          type="date"
          placeholder="选择日期"
          style="width: 140px; height: 38px; --el-component-size: 38px"
          :clearable="false"
          :editable="false"
          @update:model-value="onDatePick"
        />
      </div>
      <!-- 学期：不带 clearable（有值时悬停显示叉叉会挤掉箭头、观感与其他框不一），但选项表头补一条
           「全部学期」⇒ 选完仍有回去的路，不用刷新页面 -->
      <el-select v-model="filters.termId" class="f-select" placeholder="全部学期">
        <el-option label="全部学期" value="" />
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="String(t.termId)" />
      </el-select>
      <!-- 学校：≥2 个学校才显示（单校筛选无意义），按课程的 school_id 过滤课表与待排池；
           school 表是「学校」级（贵州大学），不是院系 ⇒ 文案用学校 -->
      <el-select
        v-if="schools.length > 1"
        v-model="filters.schoolId"
        class="f-select"
        placeholder="全部学校"
        clearable
        filterable
      >
        <el-option v-for="s in schools" :key="s.schoolId" :label="s.name" :value="String(s.schoolId)" />
      </el-select>
      <!-- 筛选下拉：filterable = 输入关键字搜索选项；clearable = 一键清空该维度 -->
      <el-select v-model="filters.major" class="f-select" placeholder="全部专业" clearable filterable>
        <el-option v-for="o in majorOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filters.courseId" class="f-select" placeholder="全部课程" clearable filterable>
        <el-option v-for="o in courseOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filters.clazzName" class="f-select" placeholder="全部班级" clearable filterable>
        <el-option v-for="o in clazzOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filters.teacherId" class="f-select" placeholder="全部教师" clearable filterable>
        <el-option v-for="o in teacherOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <div class="room-filter">
        <el-select v-model="filters.classroomId" class="f-select" placeholder="全部教室" clearable filterable>
          <el-option v-for="o in roomOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <button class="btn btn-outline" title="查看所有教室" @click="openRooms">
          <ZkIcon name="list-checks" :size="14" style="margin-right: 4px" />打开
        </button>
      </div>
      <!-- 六个维度叠起来能叠到"课表一片空"，逐个清太累 ⇒ 有任一筛选时给一个总入口 -->
      <button
        v-if="anyFilter"
        class="btn btn-outline btn-sm"
        type="button"
        title="清空学期/专业/课程/班级/教师/教室全部筛选，回到整周课表"
        @click="clearFilters"
      >
        <ZkIcon name="refresh-cw" :size="13" style="margin-right: 4px" />清空筛选
      </button>
      <!-- 冲突计数徽标（本地推导，口径与后端一致：同节次同教师 / 同教室） -->
      <span v-if="conflictCount" class="badge badge-error">
        <ZkIcon name="alert-triangle" :size="12" style="margin-right: 4px" />{{ conflictCount }} 处冲突待调整
      </span>
      <!-- 冲突处置与视角概览已移到课表下方（2026-10-22 用户要求），工具栏只留上方这枚冲突计数徽标 -->
    </div>
  </div>

  <!-- 课程池：拖动排课的来源 -->
  <div
    class="card card-pad pool-card"
    :class="{ 'pool-drop-target': poolDragOver }"
    @dragover="onPoolDragOver"
    @dragleave="onPoolDragLeave"
    @drop="onPoolDrop"
  >
    <span v-if="poolDragOver" class="pool-drop-hint">
      <ZkIcon name="undo-2" :size="16" />松手放回待排课程
    </span>
    <div class="pool-head">
      <span class="card-title"><ZkIcon name="list-checks" :size="16" />待排课程</span>
      <span class="small muted">共 {{ poolEntries.length }} 条待排（1 条 = 1 节课）—— 拖到下方课表格子完成排课</span>
      <span class="spacer" style="flex: 1"></span>
      <button class="btn btn-outline btn-sm" title="展开全部待排课程（可搜索筛选、可拖动）" @click="openPoolPanel">
        <ZkIcon name="eye" :size="13" style="margin-right: 4px" />展开
      </button>
      <button class="btn btn-outline btn-sm" @click="openCreate(null, null)">
        <ZkIcon name="plus" :size="13" style="margin-right: 4px" />添加课程
      </button>
      <span v-if="draggingCourse" class="badge badge-info">
        <ZkIcon name="grip-vertical" :size="12" style="margin-right: 4px" />正在拖动：{{ draggingCourse.courseName }}
      </span>
      <span v-else-if="draggingCell" class="badge badge-info">
        <ZkIcon name="move" :size="12" style="margin-right: 4px" />正在拖动：{{ draggingCell.courseName }}
      </span>
    </div>
    <div v-if="poolEntries.length" class="pool-list">
      <div
        v-for="c in poolEntries"
        :key="c.key"
        class="pool-chip"
        draggable="true"
        :title="`拖动排课（${c.key.startsWith('lesson') ? '排回这 1 节' : '新建 1 节课次'}），或点击打开新增表单：${c.courseName}`"
        @dragstart="onDragStart(c, $event)"
        @dragend="onDragEnd"
        @click="openCreate(null, null, { courseId: String(c.courseId) })"
      >
        <ZkIcon name="grip-vertical" :size="13" class="grip" />
        <b>{{ c.courseName }}</b>
        <span class="small muted">{{ c.teacherName || '未指定教师' }} · {{ c.studentCount ?? 0 }} 人</span>
        <!-- 重复排课入口的可视化（2026-10-30 P0-A）：这门课还在课表上，这张签是放回留下的软删记录 -->
        <span
          v-if="c.inSchedule"
          class="badge badge-warning"
          title="该课程在课表上已有课次，这张签是「放回」留下的记录。自动排课默认跳过它（否则会把整门课重排一遍）；要整门重排请先把该课全部节次放回"
        >已在课表</span>
        <!-- 自动排课口径胶囊（2026-10-29）：每周/单周/双周循环切换，只影响自动排课；
             .stop 防止误触发签本体的「打开新增表单」点击与拖拽 -->
        <button
          type="button"
          class="chip-parity"
          :class="{ 'is-alt': parityOf(c) !== 'all' }"
          :title="`自动排课口径：${PARITY_TEXT[parityOf(c)]}${parityOf(c) === 'all' ? '' : termAnchorMonday ? '（按学期起点隔周）' : '（隔周上，锚定当前浏览周）'}，点击切换`"
          @mousedown.stop
          @click.stop="cycleParity(c)"
        >
          {{ PARITY_TEXT[parityOf(c)] }}
        </button>
      </div>
    </div>
    <div v-else class="pool-empty">
      <ZkIcon name="check" :size="14" />
      {{ poolCourses.length ? '本周课程已全部排入课表' : '课程池为空（后端课程列表未返回数据）' }}
    </div>
  </div>

  <div
    v-loading="loading || refreshing"
    :class="{ 'is-soft-refreshing': refreshing }"
    class="card card-pad"
  >
    <div v-if="draggingCell" class="move-hint">
      <ZkIcon name="move" :size="14" />
      <span>
        正在拖动「<b>{{ draggingCell.courseName }}</b>」：放到<b>空格子</b>，这节就改到那个时间上课；
        放到<b>别的教师的课次</b>上，放开后可选<b>并入这一节</b>或<b>互换上课时间</b>；
        放到<b>同一教师的课次</b>上，只能<b>互换上课时间</b>
      </span>
    </div>
    <!-- 空态提示：选中学期后查不到课次时，大概率是课次没关联学期（term_id 为 NULL）被筛掉 -->
    <div v-if="!loadError && !loading && !refreshing && !allCells.length && filters.termId" class="move-hint">
      <ZkIcon name="alert-triangle" :size="14" />
      <span>
        当前学期筛选下没有课次（本周课程可能未关联学期，被学期过滤排除了）——把上方「学期」切回
        <b>全部学期</b>即可看到。
      </span>
    </div>
    <!-- 翻周条：课表上方——上一周贴左 · 日期范围+本周按钮居中 · 下一周贴右 -->
    <div class="week-pager">
      <button class="btn btn-outline" @click="shiftWeek(-7)">
        <ZkIcon name="chevron-left" :size="15" style="margin-right: 4px" />上一周
      </button>
      <div class="week-center">
        <button class="btn btn-outline" @click="gotoThisWeek">本周</button>
        <div class="sched-week">{{ weekRangeLabel }}</div>
        <!-- 2026-10-29 需求：取消「第 N 周」显示（原 week-no 胶囊已移除） -->
      </div>
      <button class="btn btn-outline" @click="shiftWeek(7)">
        下一周<ZkIcon name="chevron-right" :size="15" style="margin-left: 4px" />
      </button>
    </div>
    <!-- 本周摘要条（UI 对标第 5 项）：当前筛选下的课次总量/教师/教室/冲突一眼可见 -->
    <div class="week-stats">
      <template v-if="weekStats.total">
        <span>本周共 <b>{{ weekStats.total }}</b> 节课</span>
        <span class="sep">·</span>
        <span>{{ weekStats.teachers }} 位教师</span>
        <span class="sep">·</span>
        <span>{{ weekStats.rooms }} 间教室</span>
        <span v-if="weekStats.conflicts" class="stat-conflict">
          · {{ weekStats.conflicts }} 处冲突待调整
        </span>
      </template>
      <span v-else class="muted">{{
        loading
          ? '正在读取本周课次…'
          : loadError
            ? '读取失败，下面不是真实课表'
            : allCells.length
              ? `当前筛选下没有课次（本周实有 ${allCells.length} 节，清空筛选即可看到）`
              : '本周暂无课次'
      }}</span>
    </div>
    <!-- 失败态（2026-10-22 缺陷 2）：读取失败时明确说「读取失败」并给重试入口，不再与空表同形 -->
    <div v-if="loadError" class="move-hint is-error">
      <ZkIcon name="alert-triangle" :size="14" />
      <span>课表读取失败——下面的空格子不代表本周没课，是接口没返回。</span>
      <button class="btn btn-outline btn-sm" type="button" :disabled="loading" @click="load()">重试</button>
    </div>
    <table class="sched">
      <thead>
        <tr>
          <th style="width: 96px">节次</th>
          <th v-for="d in WEEKDAYS" :key="d.v" :class="{ 'is-today': d.v === todayWeekday }">
            {{ d.label }}<span class="th-date">{{ dateOf(d.v).slice(5) }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in grid" :key="row.period.seq" :class="{ 'row-evening': row.period.evening }">
          <td class="slot">
            {{ row.period.label }}<br />
            <span class="muted">{{ timeRange(row.period) }}</span>
          </td>
          <td
            v-for="c in row.cells"
            :key="c.weekday"
            class="cell"
            :data-wd="c.weekday"
            :data-pn="row.period.seq"
            :class="{
              'is-today-col': c.weekday === todayWeekday,
              'drop-ok': dropMode(c.weekday, row.period.seq) === 'ok',
              'drop-swap': dropMode(c.weekday, row.period.seq) === 'swaponly',
              'drop-no': dropMode(c.weekday, row.period.seq) === 'no'
            }"
            @dragover="onCellDragOver(c.weekday, row.period.seq, $event)"
            @dragleave="onCellDragLeave"
            @drop="onCellDrop(c.weekday, row.period.seq, $event)"
          >
            <!-- 该节次内的课次（可以有多节：同时间不同教师/教室并行）。
                 多节时默认叠成一叠牌：最上面一张显示全部内容，
                 下面每张只从底部露出一条边框边；点击任意处展开平铺 -->
            <div
              v-if="c.list.length"
              class="cell-stack"
              :class="{ 'is-collapsed': isCollapsedCell(c.weekday, row.period.seq, c.list.length) }"
            >
              <!-- 叠牌容器：折叠态高度 = 顶卡高度（按节数自适应）+ 每张底下露出 3px -->
              <div
                class="cards-deck"
                :style="
                  isCollapsedCell(c.weekday, row.period.seq, c.list.length)
                    ? { height: deckGeom(c.list.length).deckH + 'px' }
                    : undefined
                "
              >
                <!-- 三重认证门槛（2026-10-29）：c-uncertified = 存量未认证课次不藏，标灰保留可见（隐藏会让课次"静默消失"） -->
                <div
                  v-for="(s, idx) in c.list"
                  :key="s.scheduleId"
                  class="cblock"
                  :data-sid="s.scheduleId"
                  :class="[
                    conflictOf(s).length ? 'c-conf' : ['c-ok', courseTone(s.courseId)],
                    {
                      'c-dragging': draggingCell?.scheduleId === s.scheduleId,
                      'c-peer': hoverCourseId !== null && String(s.courseId) === String(hoverCourseId),
                      'c-join-target': isChoiceHover(c.weekday, row.period.seq, s),
                      'c-swap-target': isSwapOnlyHover(c.weekday, row.period.seq, s),
                      'c-jump': String(s.scheduleId) === String(jumpTargetId),
                      'c-uncertified': !certPassed(s.courseId)
                    }
                  ]"
                  :style="
                    isCollapsedCell(c.weekday, row.period.seq, c.list.length)
                      ? { top: idx * 3 + 'px', zIndex: c.list.length - idx, height: deckGeom(c.list.length).cardH + 'px' }
                      : undefined
                  "
                  draggable="true"
                  role="button"
                  :tabindex="cardTabindex(c.weekday, row.period.seq, s.scheduleId)"
                  :aria-label="cardAria(s, c.list.length)"
                  @dragstart="onCellBlockDragStart(s, $event)"
                  @dragend="onDragEnd"
                  @dragover.stop="onBlockDragOver(c.weekday, row.period.seq, s, $event)"
                  @drop.stop="onBlockDrop(c.weekday, row.period.seq, s, $event)"
                  @mouseenter="onCardEnter($event, s, c.weekday, row.period.seq)"
                  @mouseleave="onCardLeave"
                  @focus="onCardFocus(s, c.weekday, row.period.seq, $event)"
                  @blur="hideCardTip"
                  @keydown="onGridKey($event, c.weekday, row.period.seq, s)"
                  @click="onCardClick(s, c.weekday, row.period.seq, c.list.length)"
                >
                  <!-- 未发布标识（C-24）：draft 课次学生/教师端不可见，点「发布课表」后才可见 -->
                  <span v-if="s.status === 'draft'" class="draft-tag">未发布</span>
                  <!-- 三重认证门槛（2026-10-29）：存量未认证课次的角标；该卡不可拖（见 onCellBlockDragStart） -->
                  <span v-if="!certPassed(s.courseId)" class="uncert-tag" title="该课程未通过三重认证，不能排课/移动/互换">未认证</span>
                  <!-- 悬停反馈：不同教师 ⇒ 放下后可选「并入 / 互换」；同一教师 ⇒ 只能互换 -->
                  <span v-if="isChoiceHover(c.weekday, row.period.seq, s)" class="card-tag">
                    <ZkIcon name="plus" :size="11" />{{ draggingCell ? '可并入 / 可互换' : '也排到这一节' }}
                  </span>
                  <span
                    v-else-if="draggingCell && isSwapOnlyHover(c.weekday, row.period.seq, s)"
                    class="card-tag is-warn"
                  >
                    <ZkIcon name="arrow-left-right" :size="11" />同一教师 · 只能互换
                  </span>
                  <b><span class="tone-mark" aria-hidden="true">{{ courseMark(s.courseId) }}</span>{{ s.courseName || '（未命名课程）' }}</b>
                  <span class="who"><ZkIcon name="users" :size="11" />{{ s.clazzName || '未填班级' }}</span>
                  <span class="who"><ZkIcon name="user" :size="11" />{{ s.teacherName || '—' }}</span>
                  <span class="who"><ZkIcon name="map-pin" :size="11" />{{ s.roomName || '未指定教室' }}</span>
                  <!-- 冲突原因（本地推导）：让红卡"为什么红"一眼可见 -->
                  <span v-for="w in conflictOf(s)" :key="w" class="who">
                    <ZkIcon name="alert-triangle" :size="11" />{{ w }}
                  </span>
                  <!-- ★ 叠牌常驻标志：不用悬停也能一眼看出下面还压着课 -->
                  <span
                    v-if="idx === 0 && c.list.length > 1"
                    class="stack-chip"
                  >
                    <ZkIcon name="copy" :size="10" />共 {{ c.list.length }} 节
                  </span>
                </div>
                <!-- 悬停浮现的展开提示（纯 CSS hover 显隐，不占布局、不挡点击） -->
                <span class="stack-hint">
                  <i class="icaret icaret--sm" aria-hidden="true"></i>同段共 {{ c.list.length }} 节 · 点击展开
                </span>
              </div>
            </div>
            <!-- 完全展开后：收起条 -->
            <button
              v-if="c.list.length > 1 && !isCollapsedCell(c.weekday, row.period.seq, c.list.length)"
              class="more-strip is-open"
              type="button"
              @click.stop="toggleCellExpand(c.weekday, row.period.seq)"
            >
              <i class="icaret icaret--up" aria-hidden="true"></i>收起（同段共 {{ c.list.length }} 节）
            </button>
            <!-- 空格子：点一下手动新增（键盘：方向键走到本格按回车，同一条路径） -->
            <div
              v-if="!c.list.length"
              class="cblock c-empty"
              role="button"
              :tabindex="emptyTabindex(c.weekday, row.period.seq)"
              :aria-label="emptyCellAria(c.weekday, row.period.seq)"
              @focus="onEmptyFocus(c.weekday, row.period.seq)"
              @keydown="onGridKey($event, c.weekday, row.period.seq, null)"
              @click="openCreate(c.weekday, row.period.seq)"
            >
              <template v-if="dropMode(c.weekday, row.period.seq) === 'ok'">
                <ZkIcon name="move" :size="16" />
                <span class="drop-text">{{ draggingCell ? '移动到这里' : '放这里排课' }}</span>
              </template>
              <ZkIcon v-else name="plus" :size="16" />
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 全网格共用的卡片明细悬浮层：虚拟触发（不克隆卡片节点，DOM 结构零改动），
         显示/隐藏由卡片的 mouseenter/focus 驱动，manual 模式故 EP 不会自行接线 -->
    <el-tooltip
      v-model:visible="cardTipVisible"
      trigger="manual"
      effect="dark"
      placement="right"
      virtual-triggering
      :virtual-ref="cardTipEl"
      :persistent="false"
      :show-arrow="false"
      popper-class="sched-card-popper"
    >
      <template #content>
        <div class="sched-tip">
          <div
            v-for="(ln, i) in cardTipLines"
            :key="i"
            class="sched-tip-line"
            :class="{ 'is-head': i === 0 }"
          >
            {{ ln }}
          </div>
          <div class="sched-tip-hint">{{ cardTipHint }}</div>
        </div>
      </template>
    </el-tooltip>

    <!-- 冲突处置 + 视角概览（2026-10-22 用户要求：从工具栏移到课表下面，看过课再操作） -->
    <div class="grid-tools">
      <button
        class="btn btn-outline"
        :class="{ 'btn-primary': onlyConflicts }"
        type="button"
        :disabled="!conflictCount"
        :title="conflictCount ? '课表只显示命中冲突的课次' : '本周当前筛选下没有冲突课次'"
        @click="onlyConflicts = !onlyConflicts"
      >
        只看冲突{{ conflictCount ? `（${conflictCount}）` : '' }}
      </button>
      <!-- 逐个跳转：按「节次 → 星期」的阅读顺序走，跳到时自动展开叠牌格并描边 -->
      <div v-if="onlyConflicts && conflictQueue.length" class="conflict-jump">
        <button class="btn btn-outline" type="button" :disabled="jumpIdx <= 0" @click="jumpConflict(-1)">上一处</button>
        <span class="muted small mono">{{ jumpIdx >= 0 ? jumpIdx + 1 : '—' }} / {{ conflictQueue.length }}</span>
        <button class="btn btn-outline" type="button" @click="jumpConflict(1)">下一处</button>
      </div>
      <!-- 撤回组（2026-10-26 用户指令：从翻周条中列挪到课表左下、贴着「只看冲突」）。
           撤回栈存到 30 步，界面只露最后一步不够 ⇒ 另挂「本次调整记录」列出每一步并可回退到任意一步之前 -->
      <span class="undo-group">
        <button
          class="btn btn-outline"
          type="button"
          :disabled="!historyStack.length || busy"
          :title="undoLabel ? `撤回上一步：${undoLabel}` : '暂无可撤回的调整（仅记录本次打开页面后的操作）'"
          @click="undoLast"
        >
          <ZkIcon name="undo-2" :size="16" style="margin-right: 4px" />撤回
        </button>
        <el-dropdown trigger="click" popper-class="sched-undo-popper" @command="(n: number) => undoToStep(n)">
          <button
            class="btn btn-outline"
            type="button"
            :disabled="!historyStack.length || busy"
            title="列出本次打开页面后的每一步调整；点某一步 = 连撤到这一步之前"
          >
            本次调整记录（{{ historyStack.length }}）<i class="icaret" aria-hidden="true"></i>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="h in undoHistory" :key="h.no" :command="h.depth">第 {{ h.no }} 步 · {{ h.label }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </span>
      <span class="spacer" style="flex: 1"></span>
      <div class="view-switch">
        <button
          v-for="v in VIEW_OPTIONS"
          :key="v.m"
          class="btn btn-outline"
          :class="{ 'btn-primary': viewMode === v.m }"
          type="button"
          :title="`按${v.t}看本周谁占了几节、谁的课撞了（点同一按钮退出）`"
          @click="setViewMode(v.m)"
        >
          {{ v.t }}视角
        </button>
      </div>
    </div>
    <!-- 视角概览：点一行 = 课表只看它（只在渲染层收窄，其余行仍可点，切换不用先取消） -->
    <div v-if="viewMode && roster.length" class="roster-bar">
      <div class="small muted" style="margin-bottom: 8px">{{ rosterHead }}</div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px">
        <button
          v-for="r in roster"
          :key="r.key"
          class="btn btn-outline"
          :class="{ 'btn-primary': rosterFocus === r.key }"
          type="button"
          :title="rosterFocus === r.key ? '取消「只看它」，恢复整周课表' : `课表只看「${r.label}」${r.conflicts ? ` · 其中 ${r.conflicts} 节有冲突` : ''}`"
          @click="pickRoster(r)"
        >
          {{ r.label }} · {{ r.lessons }} 节<span v-if="r.conflicts" class="roster-conf"> · 冲突 {{ r.conflicts }}</span>
        </button>
      </div>
    </div>

    <div class="row mt16" style="gap: 16px; flex-wrap: wrap">
      <span class="row small"><i class="legend-dot ok"></i>正常</span>
      <span class="row small"><i class="legend-dot conf"></i>冲突</span>
      <span class="row small"><i class="legend-dot drop"></i>可放置（拖动中）</span>
      <span class="small muted">拖动调课：拖到空格即移动 · 拖到已有课可并入或互换（同一教师只能互换）</span>
      <span class="spacer" style="flex: 1"></span>
      <button class="btn btn-primary" @click="onPublish">发布课表</button>
    </div>
  </div>

  <!-- 课次详情 / 调整（C-19：教室与备注可改，时间坐标原样回传，不改上课时间） -->
  <el-dialog v-model="detailVisible" :title="`调整课次 · ${detailCell?.courseName ?? ''}`" width="460px">
    <template v-if="detailCell">
      <div class="detail-row">
        <span class="detail-k">时间</span>
        <span>
          周{{ CN[(detailCell.weekday ?? 1) - 1] }} {{ detailPeriod?.label ?? '' }}（{{
            detailPeriod ? timeRange(detailPeriod) : ''
          }}）
        </span>
      </div>
      <div class="detail-row"><span class="detail-k">课程</span><span>{{ detailCell.courseName || '—' }}</span></div>
      <div class="detail-row"><span class="detail-k">课程码</span><span>{{ detailCell.courseCode || '—' }}</span></div>
      <div class="detail-row">
        <span class="detail-k">专业</span>
        <el-select
          v-model="editForm.major"
          placeholder="全部专业（可先选专业再选班级）"
          clearable
          filterable
          style="flex: 1; min-width: 0"
        >
          <el-option v-for="m in majorNames" :key="m" :label="m" :value="m" />
        </el-select>
      </div>
      <div class="detail-row">
        <span class="detail-k">班级</span>
        <el-select
          v-model="editForm.clazzName"
          placeholder="未填班级"
          clearable
          filterable
          style="flex: 1; min-width: 0"
        >
          <el-option v-for="n in filteredClassOptions" :key="n" :label="n" :value="n" />
        </el-select>
      </div>
      <div class="detail-row">
        <span class="detail-k">教师</span>
        <!-- 2026-10-29 只读化：教师 = 提交三重认证的老师（课程自带），同新增弹门口径，不可改 -->
        <div v-if="detailTeacher" class="teacher-ro" style="flex: 1; min-width: 0">
          {{ detailTeacher.name }}
        </div>
        <div v-else class="small muted" style="flex: 1">未指定教师</div>
      </div>
      <div class="detail-row">
        <span class="detail-k">教室</span>
        <div style="flex: 1; min-width: 0">
          <el-select
            v-model="editForm.classroomId"
            placeholder="未指定教室"
            clearable
            filterable
            style="width: 100%"
          >
            <el-option v-for="o in roomOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <!-- 容量校验：教室容量 < 课程选课人数时提示（不硬拦） -->
          <div v-if="detailCapacityWarn" class="small" style="color: var(--error, #d92d20)">
            {{ detailCapacityWarn }}
          </div>
        </div>
      </div>
      <!-- 每周节数核对（只读）：按周统计该课程实际排了几节，缺节的周提示手动补齐 -->
      <div class="detail-row">
        <span class="detail-k">每周节数</span>
        <div style="flex: 1; min-width: 0">
          <span v-if="!weeklyCheck || weeklyCheck.loading" class="small muted">统计中…</span>
          <template v-else>
            <div class="small">{{ weeklyCheck.text }}</div>
            <div v-if="weeklyCheck.uneven" class="small" style="color: var(--warning, #b45309); line-height: 1.7">
              各周节数不均：翻到缺节的那一周，把「待排课程」签拖到空格（或点空格新增）即可补齐
            </div>
            <div class="small muted">以当前显示周为第 1 周向后统计 25 周（已放回待排的课次不计）</div>
          </template>
        </div>
      </div>
      <div class="detail-row">
        <span class="detail-k">备注</span>
        <el-input
          v-model="editForm.remark"
          placeholder="如：本周由助教代课 / 调换至机房"
          maxlength="200"
          style="flex: 1; min-width: 0"
        />
      </div>
      <p class="move-hint">
        <ZkIcon name="move" :size="14" />
        <span>拖动这张卡片即可改上课时间：<b>拖到空格即移动 · 拖到别的教师的课可并入或互换 · 拖到同一教师的课只能互换</b></span>
      </p>
    </template>
    <template #footer>
      <div style="display: flex; justify-content: space-between; width: 100%">
        <span style="display: inline-flex; gap: 8px">
          <!-- C-23 删除课程：删的是课程主记录（级联删全部课次），双重确认 -->
          <el-button
            v-if="detailCell?.courseId !== undefined && detailCell?.courseId !== null"
            type="danger"
            :loading="deletingCourse"
            @click="confirmCourseDelete(detailCell.courseId, detailCell.courseName || '该课程')"
          >
            <ZkIcon name="trash-2" :size="14" style="margin-right: 4px" />删除
          </el-button>
          <el-button type="danger" plain :loading="returning" @click="detailCell && returnToPool(detailCell)">
            <ZkIcon name="undo-2" :size="14" style="margin-right: 4px" />放回待排
          </el-button>
        </span>
        <span>
          <el-button @click="detailVisible = false">关闭</el-button>
          <el-button type="primary" :loading="detailSaving" :disabled="!detailDirty" @click="saveDetail">
            保存调整
          </el-button>
        </span>
      </div>
    </template>
  </el-dialog>

  <!-- 「并入 或 互换」二选一：拖已有课次落到**不同教师**的课次卡片上时弹出 -->
  <el-dialog v-model="choiceVisible" title="这两节课怎么处理？" width="500px">
    <p class="choice-lead">
      你把「<b>{{ choiceFrom?.courseName || '该课次' }}</b>」（{{
        choiceFrom?.teacherName || '未填教师'
      }}）拖到了 <b>{{ slotText(choiceTo) }}</b> 已有的一节课上。两节课教师不同，两种做法都可行，请选一个：
    </p>
    <div class="choice-opts">
      <button class="choice-opt" @click="applyChoice('join')">
        <ZkIcon name="plus" :size="16" />
        <b>并入这一节</b>
        <span>
          「{{ choiceFrom?.courseName || '该课次' }}」也排到 {{ slotText(choiceTo) }}，与「{{
            choiceTo?.courseName || '该课次'
          }}」<b>同一时段</b>；原来那节课<b>不动</b>
        </span>
      </button>
      <button class="choice-opt is-warn" @click="applyChoice('swap')">
        <ZkIcon name="arrow-left-right" :size="16" />
        <b>互换上课时间</b>
        <span>
          两节课的<b>上课时间对调</b>：{{ slotText(choiceFrom) }} ⇄ {{ slotText(choiceTo) }}；
          课程 / 教师 / 教室各跟各的课
        </span>
      </button>
    </div>
    <template #footer>
      <el-button @click="choiceVisible = false">取消（什么都不改）</el-button>
    </template>
  </el-dialog>

  <!-- 待排课程展开浮层：非模态 + 可拖动，方便与课表对照着拖课排课。
       ★ modal-penetrable 必须加：EP 的 :modal="false" 仍会渲染一个全屏 fixed 透明层
        （el-overlay 的 mask=false 分支），把底下课表格子的 dragover/drop 全部拦掉 ——
        从浮层拖课到课表永远落不下去。加穿透后 overlay 变 pointer-events:none、
        对话框本体恢复 auto，拖拽/点击都能到达课表 -->
  <el-dialog
    v-model="poolPanelVisible"
    title="全部待排课程"
    width="640px"
    :modal="false"
    modal-penetrable
    draggable
    append-to-body
  >
    <div class="panel-tools">
      <el-input v-model="panelKeyword" placeholder="搜索课程名" clearable size="small" style="flex: 1">
        <template #prefix><ZkIcon name="search" :size="13" /></template>
      </el-input>
      <el-select v-model="panelTeacherId" placeholder="全部教师" clearable filterable size="small" style="width: 150px">
        <el-option v-for="o in teacherOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <span class="small muted" style="white-space: nowrap">共 {{ panelEntries.length }} 条</span>
    </div>
    <div class="panel-list">
      <div
        v-for="c in panelEntries"
        :key="c.key"
        class="panel-card"
        draggable="true"
        :title="`拖到课表格子完成排课：${c.courseName}`"
        @dragstart="onDragStart(c, $event)"
        @dragend="onDragEnd"
      >
        <ZkIcon name="grip-vertical" :size="13" class="grip" />
        <div class="panel-info">
          <b>{{ c.courseName }}</b>
          <span class="small muted">{{ c.teacherName || '未指定教师' }} · {{ c.studentCount ?? 0 }} 人</span>
        <!-- 重复排课入口的可视化（2026-10-30 P0-A）：这门课还在课表上，这张签是放回留下的软删记录 -->
        <span
          v-if="c.inSchedule"
          class="badge badge-warning"
          title="该课程在课表上已有课次，这张签是「放回」留下的记录。自动排课默认跳过它（否则会把整门课重排一遍）；要整门重排请先把该课全部节次放回"
        >已在课表</span>
        </div>
        <button
          class="btn btn-outline btn-sm"
          @click="openCreate(null, null, { courseId: String(c.courseId) }); poolPanelVisible = false"
        >排课</button>
      </div>
      <div v-if="!panelEntries.length" class="pool-empty">
        <ZkIcon name="check" :size="14" />没有匹配的待排课程
      </div>
    </div>
    <p class="move-hint" style="margin-top: 10px">
      <ZkIcon name="move" :size="14" />
      <span>把课程<b>拖到课表的空格子</b>即可排课；也可以点「排课」按钮手动选时间。</span>
    </p>
  </el-dialog>

  <!-- 新增课次（C-17 真接口，带冲突检查） -->
  <el-dialog v-model="createVisible" :title="createTitle" width="460px" @opened="onCreateOpened">
    <el-form label-width="92px" label-position="right">
      <el-form-item label="课程" required>
        <el-select v-model="form.courseId" placeholder="请选择课程（仅列已通过三重认证的课）" filterable style="width: 100%">
          <el-option v-for="o in certifiedCourseOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="授课教师" required>
        <!-- 2026-10-29 只读化：教师 = 提交三重认证的老师（课程接口带出），不可手选 -->
        <div v-if="form.teacherId" class="teacher-ro">
          {{ courseById.get(String(form.courseId))?.teacherName || ('教师 #' + form.teacherId) }}
          <span class="small muted">自动带出</span>
        </div>
        <div v-else class="small muted">请先选择课程——教师自动带出</div>
      </el-form-item>
      <el-form-item label="上课班级" required>
        <el-select
          ref="clazzSelRef"
          v-model="form.clazzName"
          placeholder="请选择班级"
          filterable
          style="width: 100%"
        >
          <el-option v-for="n in classListOptions" :key="n" :label="n" :value="n" />
        </el-select>
      </el-form-item>
      <el-form-item label="上课教室">
        <el-select v-model="form.classroomId" placeholder="可不填" clearable style="width: 100%">
          <el-option v-for="o in roomOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <!-- 容量校验：教室容量 < 课程选课人数时提示（不硬拦） -->
        <div v-if="createCapacityWarn" class="small" style="color: var(--error, #d92d20); width: 100%">
          {{ createCapacityWarn }}
        </div>
      </el-form-item>
      <el-form-item label="节次">
        <el-select v-model="form.periodNo" style="width: 100%">
          <el-option
            v-for="p in PERIODS"
            :key="p.seq"
            :label="`${p.label}（${timeRange(p)}）`"
            :value="p.seq"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="星期">
        <el-select v-model="form.weekday" style="width: 100%">
          <el-option v-for="d in WEEKDAYS" :key="d.v" :label="d.label" :value="d.v" />
        </el-select>
      </el-form-item>
      <!-- 每周节数（2026-10-20）：一周多节的课一次排完，每节可分别定时间 -->
      <el-form-item label="每周节数">
        <div style="display: flex; gap: 8px; width: 100%; align-items: center">
          <el-input-number v-model="repeatForm.weekly" :min="1" :max="5" @change="syncRepeatTotal" style="width: 110px" />
          <span class="small muted">大于 1 时可为每节分别选时间</span>
        </div>
      </el-form-item>
      <el-form-item
        v-for="(s, i) in extraSlotList"
        :key="'extra-slot-' + i"
        :label="`第${i + 2}节`"
      >
        <div style="display: flex; gap: 8px; width: 100%">
          <el-select v-model="s.weekday" style="width: 100%">
            <el-option v-for="d in WEEKDAYS" :key="d.v" :label="d.label" :value="d.v" />
          </el-select>
          <el-select v-model="s.periodNo" style="width: 100%">
            <el-option
              v-for="p in PERIODS"
              :key="p.seq"
              :label="`${p.label}（${timeRange(p)}）`"
              :value="p.seq"
            />
          </el-select>
        </div>
      </el-form-item>
      <!-- 周次重复（2026-10-20）：排一次 = 按周展开成整学期的课次，翻周即可见 -->
      <el-form-item label="重复">
        <div style="display: flex; gap: 8px; width: 100%; align-items: center; flex-wrap: wrap">
          <el-select v-model="repeatForm.mode" style="flex: 1; min-width: 140px">
            <el-option v-for="(t, m) in REPEAT_TEXT" :key="m" :label="t" :value="m" />
          </el-select>
          <el-input-number
            v-if="repeatForm.mode !== 'once'"
            v-model="repeatForm.times"
            :min="1"
            :max="25"
            style="width: 110px"
          />
          <span v-if="repeatForm.mode !== 'once'" class="small muted">周</span>
        </div>
        <div v-if="repeatForm.mode !== 'once'" class="small muted" style="width: 100%">
          {{ repeatAnchorLabel }} · {{ repeatHint }}
        </div>
        <!-- 单双周锚定说明（2026-10-29）：默认按学期起点算奇偶，从哪周排都不错位；
             学期未配开始日期才回退「锚定当前浏览周」，此时才有对调风险（橙色提示去补日期） -->
        <div
          v-if="repeatForm.mode === 'odd' || repeatForm.mode === 'even'"
          class="small"
          :style="{ color: termAnchorMonday ? 'var(--ink-600, #52525b)' : 'var(--warning, #b45309)', width: '100%' }"
        >
          {{
            termAnchorMonday
              ? `按学期锚定：单周=学期第 1、3、5…周，双周=第 2、4、6…周（学期始于 ${termStartDateLabel}，可在基础数据-学期修改起点）`
              : '当前学期未配置开始日期，隔周只能锚定当前浏览的周——请先翻到学期第 1 周再保存，或先到基础数据-学期补开始日期'
          }}
        </div>
      </el-form-item>
      <!-- 总节数（2026-10-20）：满额可改小 —— 不够分时从最后一周往前少排（前满后少） -->
      <el-form-item v-if="repeatForm.mode !== 'once'" label="总节数">
        <div style="display: flex; gap: 8px; width: 100%; align-items: center; flex-wrap: wrap">
          <el-input-number
            v-model="repeatForm.total"
            :min="1"
            :max="repeatForm.weekly * effectiveRepeatTimes"
            style="width: 130px"
          />
          <span v-if="repeatForm.total < repeatForm.weekly * effectiveRepeatTimes" class="small" style="color: var(--warning, #b45309)">
            不足满额 {{ repeatForm.weekly * effectiveRepeatTimes }} 节：从最后一周往前少排（前满后少）
          </span>
          <span v-else class="small muted">满额 = 每周 {{ repeatForm.weekly }} 节 × {{ effectiveRepeatTimes }} 周</span>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <div style="display: flex; justify-content: space-between; width: 100%">
        <!-- C-23 删除课程：仅在已选课程时可用（删课程主记录，级联删课次，双重确认） -->
        <el-button
          type="danger"
          plain
          :disabled="!form.courseId"
          :loading="deletingCourse"
          @click="confirmCourseDelete(form.courseId, selectedCourseName)"
        >
          <ZkIcon name="trash-2" :size="14" style="margin-right: 4px" />删除课程
        </el-button>
        <span>
          <el-button @click="createVisible = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="submitCreate">保存课次</el-button>
        </span>
      </div>
    </template>
  </el-dialog>

  <!-- 自动排课（本地实现）：待排池贪心找空位，逐条真落库；结束出报告 -->
  <el-dialog v-model="autoVisible" title="自动排课" width="560px" :close-on-click-modal="!autoRunning">
    <template v-if="!autoReport && !autoPlan">
      <p class="small" style="margin-top: 0">把「待排课程」池里的课自动排进空位；<b>课表上已有的课一律不动</b>。</p>
      <!-- P0-A 护栏（2026-10-30）：池里会有「课程已在课表」的放回残留签（软删行一直成签），
           它们默认不参与排课，否则每排一次就把那门课重排一遍。这里如实报数，不静默跳。 -->
      <div v-if="autoSkippedInSchedule || autoIncludeScheduled" class="detail-row">
        <span class="detail-k">参与</span>
        <div class="small" style="flex: 1; min-width: 0">
          本次排 <b>{{ autoEntries.length }}</b> 条
          <span v-if="autoSkippedInSchedule" class="muted">
            · 已跳过 <b>{{ autoSkippedInSchedule }}</b> 条「课程已在课表」的放回记录（避免重复排课）
          </span>
          <div style="margin-top: 4px">
            <el-checkbox v-model="autoIncludeScheduled" size="small">
              连「已在课表」的也重排（会重复排课）
            </el-checkbox>
          </div>
        </div>
      </div>
      <!-- 写入范围（2026-10-30）：自动排课锚学期起点铺到学期末，范围与条数在这里明示，
           避免「排完才发现只覆盖一半学期」——原实现从当前浏览周起算、写死 18 周，正是这个坑 -->
      <div class="detail-row">
        <span class="detail-k">范围</span>
        <div class="small" style="flex: 1; min-width: 0">
          {{ autoTermRangeLabel }}；每周课写 <b>{{ termWeekCount }}</b> 条，单/双周课写
          <b>{{ autoOddEvenTimes }}</b> 条
        </div>
      </div>
      <!-- 可行性预检：点「生成排课方案」之前就把「无论如何都排不进」的签点出来 -->
      <div v-if="autoFeasibility && autoFeasibility.blocked.length" class="detail-row">
        <span class="detail-k">预警</span>
        <div class="small" style="flex: 1; min-width: 0; color: var(--warning, #b45309)">
          {{ autoFeasibility.total }} 条里有 <b>{{ autoFeasibility.blocked.length }}</b> 条现在排不进
          （会原样出现在「排不进」列表里）：
          <div v-for="(b, i) in autoFeasibility.blocked.slice(0, 4)" :key="'fb' + i">
            ·「{{ b.e.courseName }}」{{ b.reason }}
          </div>
          <div v-if="autoFeasibility.blocked.length > 4" class="muted">
            …另 {{ autoFeasibility.blocked.length - 4 }} 条同类
          </div>
        </div>
      </div>
      <!-- 重复口径在待排池每条签上单独标（2026-10-29）：每周/单周/双周点胶囊切换；原弹窗内
           的「重复」下拉在口径与 runAuto 解耦后已是摆设，换成隔周汇总与锚定警告 -->
      <div v-if="poolParitySummary" class="detail-row">
        <span class="detail-k">隔周</span>
        <div class="small" style="flex: 1; min-width: 0; color: var(--warning, #b45309)">{{ poolParitySummary }}</div>
      </div>
      <p class="small muted" style="margin: 10px 0 0">在教师空闲时段里挑最优格（同班级分天、五天拉平、同人连着上），教室按容量最贴自动配，排不进的最后统一报告。</p>
      <!-- 班级（2026-10-22 丙）：课程接口不出班级字段，不选就排成"未填班级"的课次（按班级筛选看不到） -->
      <div class="detail-row">
        <span class="detail-k">班级</span>
        <div style="flex: 1; min-width: 0">
          <el-select v-model="autoClass" placeholder="不指定（放回的课次自动沿用原班级）" clearable filterable style="width: 100%">
            <el-option v-for="n in clazzNameList" :key="n" :label="n" :value="n" />
          </el-select>
        </div>
      </div>
      <p v-if="autoProgress" class="small" style="margin: 12px 0 0">
        <ZkIcon name="refresh-cw" :size="13" style="margin-right: 4px" />{{ autoProgress }}
      </p>
      <p v-else-if="autoRunning" class="small muted" style="margin: 12px 0 0">准备中…</p>
    </template>
    <!-- 预览视图（2026-10-29 规划/写库分离）：方案成型先过目，确认后才写库 -->
    <template v-else-if="autoPlan">
      <p style="margin-top: 0">
        <b>排课方案预览：可排 {{ autoPlan.items.length }} 门，排不进 {{ autoPlan.failures.length }} 门</b>
      </p>
      <p v-if="autoSkippedInSchedule" class="small muted" style="margin: 0 0 8px">
        另有 {{ autoSkippedInSchedule }} 条「课程已在课表」的放回记录已跳过，不会重复排课。
      </p>
      <p class="small muted" style="margin: 0 0 8px">
        已按「最紧的课先占位、排不进的尝试腾挪让位、多方案取最优」在本地算好；点「确认写入课表」才真正保存。
      </p>
      <ul class="small" style="padding-left: 18px; line-height: 2">
        <li v-for="(item, i) in autoPlan.items" :key="'plan' + i">{{ planItemText(item) }}</li>
      </ul>
      <div v-if="autoPlan.failures.length">
        <b class="small">排不进：</b>
        <ul class="small" style="color: var(--error, #d92d20); padding-left: 18px; line-height: 2">
          <li v-for="(f, i) in autoPlan.failures" :key="'pfail' + i">{{ f.label }}：{{ f.reason }}</li>
        </ul>
      </div>
      <p v-if="autoProgress" class="small" style="margin: 12px 0 0">
        <ZkIcon name="refresh-cw" :size="13" style="margin-right: 4px" />{{ autoProgress }}
      </p>
    </template>
    <template v-else-if="autoReport">
      <p style="margin-top: 0">
        <b>排课结果：成功 {{ autoReport.ok.length }} 门，跳过 {{ autoReport.skip.length }} 门</b>
      </p>
      <ul v-if="autoReport.ok.length" class="small" style="padding-left: 18px; line-height: 2">
        <li v-for="(t, i) in autoReport.ok" :key="'ok' + i">{{ t }}</li>
      </ul>
      <div v-if="autoReport.skip.length">
        <b class="small">未排入：</b>
        <ul class="small" style="color: var(--error, #d92d20); padding-left: 18px; line-height: 2">
          <li v-for="(t, i) in autoReport.skip" :key="'skip' + i">{{ t }}</li>
        </ul>
      </div>
    </template>
    <template #footer>
      <span v-if="autoReport">
        <el-button type="primary" @click="autoVisible = false">知道了</el-button>
      </span>
      <span v-else-if="autoPlan">
        <el-button :disabled="autoRunning" @click="autoPlan = null">返回修改</el-button>
        <el-button :disabled="autoRunning" @click="runAuto">重新规划</el-button>
        <el-button type="primary" :loading="autoRunning" @click="commitAuto">确认写入课表</el-button>
      </span>
      <span v-else>
        <el-button :disabled="autoRunning" @click="autoVisible = false">取消</el-button>
        <el-button type="primary" @click="runAuto">生成排课方案</el-button>
      </span>
    </template>
  </el-dialog>

  <!-- 全部教室：C-21 教室列表只读查看（数据与筛选下拉同源 loadPickers） -->
  <el-dialog v-model="roomsVisible" title="所有教室" width="880px">
    <div class="rooms-head">
      <el-input v-model="roomKeyword" placeholder="搜索名称 / 编码 / 位置 / 设备" clearable style="width: 260px" />
      <span class="small muted">共 {{ roomsFiltered.length }} 间教室（关键字即时过滤）</span>
    </div>
    <el-table :data="roomsFiltered" height="420" size="small">
      <el-table-column prop="name" label="名称" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.name || '—' }}</template>
      </el-table-column>
      <el-table-column prop="code" label="编码" width="96">
        <template #default="{ row }">{{ row.code || '—' }}</template>
      </el-table-column>
      <el-table-column prop="roomType" label="类型" width="90">
        <template #default="{ row }">{{ ROOM_TYPE_TEXT[String(row.roomType)] ?? row.roomType ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="capacity" label="容量" width="70" align="center">
        <template #default="{ row }">{{ row.capacity ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="location" label="位置" min-width="110" show-overflow-tooltip>
        <template #default="{ row }">{{ row.location || '—' }}</template>
      </el-table-column>
      <el-table-column prop="device" label="设备" min-width="110" show-overflow-tooltip>
        <template #default="{ row }">{{ row.device || '—' }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="76" align="center">
        <template #default="{ row }">
          <span class="badge" :class="STATUS_CLS[String(row.status)] ?? 'badge-neutral'">
            {{ STATUS_TEXT[String(row.status)] ?? row.status ?? '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="100" show-overflow-tooltip>
        <template #default="{ row }">{{ row.remark || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="70" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openRoomEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="roomsVisible = false">关闭</el-button>
    </template>
  </el-dialog>

  <!-- 编辑教室（C-21 PUT）：从「所有教室」行内进入 -->
  <el-dialog v-model="roomEditVisible" title="编辑教室" width="460px" append-to-body>
    <el-form label-width="72px">
      <el-form-item label="名称" required>
        <el-input v-model="roomEditForm.name" placeholder="如：教A-301" maxlength="50" />
      </el-form-item>
      <el-form-item label="编码">
        <el-input v-model="roomEditForm.code" placeholder="如：A301" maxlength="20" />
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="roomEditForm.roomType" style="width: 100%">
          <el-option label="物理教室" value="physical" />
          <el-option label="虚拟教室" value="virtual" />
        </el-select>
      </el-form-item>
      <el-form-item label="容量">
        <el-input-number v-model="roomEditForm.capacity" :min="0" :max="9999" style="width: 100%" />
      </el-form-item>
      <el-form-item label="位置">
        <el-input v-model="roomEditForm.location" placeholder="如：明德楼 3 层" maxlength="100" />
      </el-form-item>
      <el-form-item label="设备">
        <el-input v-model="roomEditForm.device" placeholder="如：投影 / 录播" maxlength="100" />
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="roomEditForm.status" style="width: 100%">
          <el-option label="启用" value="active" />
          <el-option label="停用" value="inactive" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="roomEditForm.remark" type="textarea" :rows="2" maxlength="200" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="roomEditVisible = false">取消</el-button>
      <el-button type="primary" :loading="roomEditSaving" @click="saveRoomEdit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.week-nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 翻周条：三列网格——上一周贴左、日期范围严格居中、下一周贴右（1fr auto 1fr 保证居中不受两侧按钮宽度差影响） */
.week-pager {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  /* 1024px 一带三列刚好塞满（98+529+98 vs 容器 727）⇒ 左右按钮与中列贴死（实测间距 0）
     留 12px 列间距，窄到放不下时由下面的断点让中列换行 */
  column-gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  padding: 0 4px;
}
.week-pager > button {
  justify-self: start;
}
.week-pager > button:last-child {
  justify-self: end;
}
/* 翻周条中列：日期范围标签 + 本周按钮成组，grid 1fr auto 1fr 下该列整体居中 */
.week-center {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 两个框统一尺寸：同高 38px、同内边距，与全站 .btn（38px）一个口径
   （原先定 36px 是为了和日期标签配对，结果同页并存 31/36/38 三档按钮高度） */
.week-center .sched-week {
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 14px;
}
.week-center .btn {
  height: 38px;
  padding: 0 14px;
}
/* 撤回组：两个控件当一个整体（现挂在课表下方工具条 `.grid-tools` 里，跟着那条的 8px 间距口径） */
.undo-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.undo-group > .btn,
.undo-group :deep(.el-dropdown) > .btn {
  white-space: nowrap;
}
/* 下拉 / 收起指示角：ZkIcon 白名单里没有 chevron-down、chevron-up（未登记的名字只画一个淡灰方块，
   页面上就是一个空灰格子）。图标表在 components/* 属禁改路径 ⇒ 页内用纯 CSS 三角补上 */
.icaret {
  display: inline-block;
  width: 0;
  height: 0;
  margin-left: 6px;
  vertical-align: middle;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
}
.icaret--up {
  border-top: 0;
  border-bottom: 5px solid currentColor;
}
.icaret--sm {
  margin-left: 0;
  border-left-width: 3px;
  border-right-width: 3px;
  border-top-width: 4px;
}
/* 周日期范围：翻周条中间的块状标签。
   ★ 中性深灰描边样式，刻意与课程签（品牌绿底）区分——两者都是"块状"，同色系会混淆 */
.sched-week {
  display: inline-block;
  font-size: 16px;
  font-weight: 700;
  color: var(--ink-900);
  background: var(--bg-soft);
  border: 1px solid var(--border-strong);
  padding: 4px 14px;
  border-radius: 8px;
  white-space: nowrap;
}
/* 日期选择器与右侧筛选框高度对齐（38px）。
   ★ 必须 :deep()：EP date-picker 根元素不带本组件 scoped 属性，
   普通 .week-nav .el-date-editor 选择器匹配不上 */
.week-nav :deep(.el-date-editor) {
  height: 38px;
}
.week-nav :deep(.el-input__inner) {
  height: 34px;
  line-height: 34px;
}
/* 筛选下拉弹性等分剩余宽度（日期组之外）：
   宽度由 flex 决定、与选项文本无关 ⇒ 展开下拉/切换选项都不会引起工具栏回流变形 */
/* 工具栏窄视口兜底：筛选框放不下时整组换行（否则教室组被挤出可视区、要横向滚动才能看到） */
.toolbar {
  flex-wrap: wrap;
  row-gap: 8px;
}
.toolbar .select.grow {
  flex: 1 1 0;
  min-width: 96px;
}
/* el-select 版筛选框：同 38px 高、flex 等分，可输入关键字搜索（filterable） */
.toolbar .f-select {
  flex: 1 1 0;
  min-width: 110px;
  --el-component-size: 38px;
}
.toolbar .f-select :deep(.el-select__wrapper) {
  min-height: 38px;
}
/* 教室筛选 = 下拉 + 「打开」按钮拼成一个控件组（无缝、共用圆角），
   按钮从属于下拉一眼可见；组内含按钮 ⇒ 分配比纯下拉稍多的宽度 */
.room-filter {
  display: inline-flex;
  flex: 1.5 1 0;
  /* 组内下拉要 100px + 「打开」按钮 ~84px + 边框 ⇒ 整组至少 196px，
     否则 1280/900 一带整组会被挤到溢出（实测 sw 187 > cw 176） */
  min-width: 196px;
}
.room-filter .f-select {
  flex: 1 1 auto;
  /* 曾设 min-width:0 ⇒ 组内下拉能被压到 49px，「全部教室」四个字直接被裁（1280px 实测 sw 56 > cw 49）
     给到能放下占位文 + 箭头的宽度 */
  min-width: 100px;
}
.room-filter .f-select :deep(.el-select__wrapper) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.room-filter .btn {
  height: 38px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  margin-left: -1px;
  white-space: nowrap;
}
/* 「全部教室」弹窗头部：搜索框 + 计数 */
.rooms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.week-label {
  min-width: 154px;
  text-align: center;
}
/* 以下 .sched / .cblock 系列原为原型页面内联样式（不在 theme.css），此处照搬 */
.sched {
  border-collapse: separate;
  border-spacing: 4px;
  width: 100%;
  /* 固定布局：各列等宽，不被某格的长内容（如长课程名）撑宽变形 */
  table-layout: fixed;
}
.sched th:first-child,
.sched td.slot {
  width: 96px;
}
.sched th {
  font-size: 12px;
  color: var(--ink-500);
  font-weight: 500;
  padding: 8px;
  background: var(--bg-subtle);
  border-radius: 8px;
}
.sched td.slot {
  background: var(--bg-subtle);
  color: var(--ink-500);
  font-size: 12px;
  text-align: center;
  padding: 8px;
  border-radius: 8px;
  white-space: nowrap;
  line-height: 1.5;
}
.sched td.cell {
  background: var(--bg-soft);
  border-radius: 8px;
  /* ★ 97px = 折叠叠牌 84px 顶卡 + 露边 3px + 上下 padding 5×2 —— 给「大卡」留足高度，
     整叠（87px ≤ 内容区 87px）完整压在浅灰格内。
     ⚠️ 不能回到 78px：内容区只剩 68px，84px 大卡物理上放不下，
     行高一旦不被别的内容撑起就向下溢出 14px（10-18 04:00 实测）。
     行高是表格行的下限，所有行统一 97px，课表观感整齐 */
  height: 97px;
  vertical-align: top;
  padding: 5px;
  min-width: 140px;
  /* ★ 空格子的虚线框用绝对定位撑满（见 .c-empty）：
     定高内容块贴不住格子底 —— 用户看到"虚线框下面离浅灰框很远"就是这么来的 */
  position: relative;
  /* 压缩叠加态的卡片层用绝对定位悬浮在格子内（不占布局流），
     数学上保证多课格**永远不会撑大**浅灰格子 —— 格子大小只由 78px 与行内其他格决定 */
  position: relative;
  transition: 0.12s;
}
.cblock {
  position: relative;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  /* ★ 用 min-height 而不是 height:100% —— 一个节次格现在可以叠多节课，
     每张卡按自身内容高度排布，格子（td 的 height 在表格里本就是下限）自然被撑高。 */
  min-height: 68px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  cursor: grab;
  transition: 0.12s;
  /* ★ 叠牌态卡片是固定高度（deckGeom），课程名/班级名变长换行会把内容顶出卡片、
     连带超出浅灰格子 —— 内容一律单行省略 + 卡片裁边，双保险 */
  overflow: hidden;
}
/* 同一个节次格里的第 2、3… 节课 */
.cblock + .cblock {
  margin-top: 4px;
}

/* ---------- 多课格子的叠牌态（默认）与完全展开态 ---------- */
.cell-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.cards-deck {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
}
/* 叠牌态：整层绝对定位悬浮在格子内（不占布局流 ⇒ 不改变浅灰格子大小）；
   卡片全部同位重叠，第 idx 张下移 idx*3px（模板内联 style），
   顶卡显示全部内容，下面每张只露出自己的底边框 —— 一叠纸的效果 */
.cell-stack.is-collapsed {
  position: absolute;
  left: 5px;
  right: 5px;
  top: 5px;
  /* 基础样式里的 width:100% 会让 right:5px 失效（过约束）⇒ 右侧冲出格子，必须改回自适应 */
  width: auto;
  cursor: pointer;
  overflow: visible;
}
.cell-stack.is-collapsed .cards-deck .cblock {
  position: absolute;
  left: 0;
  right: 0;
  /* 定高兜底 84px（内联 style 会按 deckGeom 覆盖）：td.cell 97px（border-box）− padding 5×2
     = 内容区 87px，84 + 露边 3px×(n−1) ≤ 87 ⇒ 整叠永远压在格内。
     ⚠️ 基础 .cblock 的 min-height:68px 会压过更矮的内联卡高（节数 ≥8 时），
     折叠态 .who 行已隐藏，必须归零 */
  height: 84px;
  min-height: 0;
  padding: 3px 8px;
  overflow: hidden;
}
/* 非顶卡：只留卡片底色与描边（露出的底缘），内容全部隐藏 —— 圆角缝隙也不透字 */
.cell-stack.is-collapsed .cards-deck .cblock:not(:first-child) {
  box-shadow: 0 0 0 1px var(--border);
}
/* ★ 折叠卡是绝对定位（top: idx*step px），基础样式里的 .cblock + .cblock { margin-top:4px }
   会额外下压 4px ⇒ 下层底缘冲出叠牌容器。折叠态必须归零。 */
.cell-stack.is-collapsed .cards-deck .cblock + .cblock {
  margin-top: 0;
}
.cell-stack.is-collapsed .cards-deck .cblock:not(:first-child) > * {
  visibility: hidden;
}
/* 悬停浮现的展开提示：默认透明，鼠标移入叠牌才浮现；
   pointer-events:none ⇒ 点击穿透到卡片，点哪都是展开 */
.stack-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.3;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.cell-stack.is-collapsed:hover .stack-hint {
  opacity: 1;
}
/* ★ 叠牌常驻标志：顶卡右上角品牌色胶囊「共 N 节」，不用悬停即可见 */
.stack-chip {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--brand-600);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.4;
  pointer-events: none;
}

/* 显眼的展开/收起条 */
.more-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  margin-top: 4px;
  padding: 4px 6px;
  border: 1.5px dashed var(--brand-600);
  border-radius: 8px;
  background: var(--brand-100);
  color: var(--brand-600);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
  cursor: pointer;
  transition: 0.12s;
}
.more-strip:hover {
  background: var(--brand-600);
  border-style: solid;
  color: #fff;
}
.more-strip.is-open {
  border-style: solid;
  background: transparent;
}
.cblock:hover {
  transform: translateY(-1px);
  box-shadow: var(--sh-1);
}
.cblock b {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cblock .who {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  opacity: 0.85;
  /* 单行省略：班级/教师名过长时不换行撑高卡片（叠牌态高度固定） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.c-ok {
  background: var(--brand-100);
  color: var(--brand-800);
  border: 1px solid var(--brand-300);
}
.c-conf {
  background: var(--error-soft);
  color: var(--error);
  border: 1px solid #fca5a5;
}
/* 正在被拖动的课次卡片（表内移动 C-19 / 互换 C-20）：淡出 + 虚线，表示"已拿起" */
.c-dragging {
  opacity: 0.45;
  border-style: dashed;
  cursor: grabbing;
}
/* 逐个跳转的当前目标卡：描边 + 外发光，1.6s 后自动撤（不改底色，冲突红仍然可见） */
.cblock.c-jump {
  box-shadow: 0 0 0 3px var(--error), 0 6px 18px rgba(239, 68, 68, 0.35);
  transform: translateY(-1px);
}
/* 「只看冲突」旁边的上一处/下一处计数组 */
.conflict-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 视角切换三按钮：与筛选框同行，靠右成组 */
.view-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 课表下方工具条（2026-10-22 从工具栏移来：看完课再决定"只看冲突 / 换视角"） */
.grid-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
/* 视角概览条：跟着上面的按钮，聚焦态用淡底强调 */
.roster-bar {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
}
.roster-conf {
  color: var(--error);
}
/**
 * ★ 落库后回读用的是「软遮罩」：可见（用户知道在刷新）但不吃指针事件。
 * Element Plus 的 .el-loading-mask 默认 rgba(255,255,255,.9) + z-index 2000 + pointer-events:auto，
 * 覆盖整块课表 ⇒ 刷新期间按在卡片上，按下会落在遮罩上，dragstart 永远不触发。
 * 而"刚拖完一节、马上拖下一节"恰好总在这个窗口里 ⇒ 表现为「有时候按住拖动不了」。
 * 整体替换（首次加载 / 切周）仍走 loading，遮罩照旧阻挡。
 */
.is-soft-refreshing :deep(.el-loading-mask) {
  pointer-events: none;
}
/* 拖动提示条（课表上方拖动中显示 / 课次详情弹窗底部说明）
   ★ 文字必须整段包在一个 <span> 里：flex 会把被 <b> 切开的每段文字当成独立 flex 项，
     逐项被压到最小宽度，结果文字竖着挤成一绺（备注"太拥挤"的真实原因）。 */
.move-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--brand-100);
  border: 1px solid var(--brand-300);
  color: var(--brand-800);
  font-size: 12px;
  line-height: 1.6;
}
.move-hint > :first-child {
  flex: none;
  margin-top: 2px;
}
.move-hint > span {
  flex: 1;
  min-width: 0;
}
/* 失败态（2026-10-22 缺陷 2）：复用提示条布局，只换配色，与「拖动提示」区分开 */
.move-hint.is-error {
  background: rgba(217, 45, 32, 0.08);
  border-color: var(--error, #d92d20);
  color: var(--error, #d92d20);
}
.c-empty {
  /* ★ 绝对定位撑满格子（td.cell 已 position:relative）：上下左右各留 5px 与 padding 对齐，
     虚线框永远贴住浅灰格四壁，行头把行撑多高它就跟着多高 */
  position: absolute;
  top: 5px;
  left: 5px;
  right: 5px;
  bottom: 5px;
  min-height: 0;
  background: transparent;
  border: 1px dashed var(--border-strong);
  color: var(--ink-400);
  align-items: center;
  opacity: 0.45;
  cursor: pointer;
}
.c-empty:hover {
  opacity: 1;
  border-color: var(--brand-600);
  color: var(--brand-600);
}
/* ---- 拖动排课：投放目标高亮 ---- */
.sched td.cell.drop-ok {
  outline: 2px dashed var(--brand-600);
  outline-offset: -3px;
  background: var(--brand-100);
}
.sched td.cell.drop-no {
  outline: 2px dashed #fca5a5;
  outline-offset: -3px;
  background: var(--error-soft);
}
/* 可互换：拖动已有课次悬停到**同一教师**的另一节课上 ⇒ 放下去只能互换（C-20）。
   用告警色而非品牌色 —— 与「可放置」在视觉上区分开。 */
.sched td.cell.drop-swap {
  outline: 2px dashed var(--warning);
  outline-offset: -3px;
  background: var(--warning-soft);
}
/* 不同教师 ⇒ 放开后可选「并入 / 互换」，用品牌色（与"可放置"同一语义） */
.cblock.c-join-target {
  box-shadow: 0 0 0 2px var(--brand-600) inset;
}
/* 同一教师 ⇒ 只能互换，用告警色 */
.cblock.c-swap-target {
  box-shadow: 0 0 0 2px var(--warning) inset;
}
/* 卡片右上角的状态角标：只占一角，不遮挡卡片内容（整卡遮罩会把课程名盖住） */
.card-tag {
  position: absolute;
  top: -1px;
  right: -1px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 0 8px 0 8px;
  background: var(--brand-600);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.card-tag.is-warn {
  background: var(--warning);
}
/* 未发布（draft）标识：中性灰、左上角 —— 避开右上角的拖拽悬停标签 */
.draft-tag {
  position: absolute;
  top: -1px;
  left: -1px;
  padding: 1px 6px;
  border-radius: 8px 0 8px 0;
  background: var(--ink-500);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  z-index: 1;
}
/* 三重认证门槛（2026-10-29）：未认证存量课次标灰 + 左下角标；不隐藏（隐藏=课次静默消失） */
.cblock.c-uncertified {
  opacity: 0.45;
  filter: grayscale(0.9);
  cursor: not-allowed;
}
.cblock.c-uncertified.c-jump {
  opacity: 0.85;
}
.uncert-tag {
  position: absolute;
  bottom: -1px;
  left: -1px;
  padding: 1px 6px;
  border-radius: 0 8px 0 8px;
  background: var(--ink-500);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  z-index: 1;
}
/* 新增弹窗：授课教师只读展示（2026-10-29） */
.teacher-ro {
  width: 100%;
  padding: 5px 11px;
  border: 1px solid var(--line, #e5e7eb);
  border-radius: 6px;
  background: var(--bg-muted, #f9fafb);
  font-size: 13px;
  color: var(--ink-800, #1f2937);
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  box-sizing: border-box;
}
.sched td.cell.drop-ok .c-empty {
  opacity: 1;
  border-color: var(--brand-600);
  border-style: solid;
  color: var(--brand-700);
}
/* ---- 「并入 或 互换」二选一弹窗 ---- */
.choice-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
}
.choice-opts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.choice-opt {
  display: grid;
  grid-template-columns: 18px 1fr;
  align-items: start;
  gap: 2px 8px;
  padding: 10px 12px;
  border: 1px solid var(--brand-300, #bfdbfe);
  border-radius: 10px;
  background: var(--brand-100);
  color: var(--ink-700, #334155);
  text-align: left;
  cursor: pointer;
  transition: 0.12s;
}
.choice-opt:hover {
  border-color: var(--brand-600);
  background: #fff;
}
.choice-opt > b {
  font-size: 13px;
  color: var(--brand-800, #1e40af);
}
.choice-opt > span {
  grid-column: 2;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-500, #64748b);
}
.choice-opt.is-warn {
  border-color: #fcd34d;
  background: var(--warning-soft);
}
.choice-opt.is-warn > b {
  color: var(--warning);
}
.drop-text {
  font-size: 11px;
  margin-top: 2px;
}
.row-evening td.slot {
  color: var(--ink-400);
}
/* ---- 课程池 ---- */
.pool-card {
  position: relative;
  margin-bottom: 10px;
}
/* 拖已有课次悬停到池上：整卡高亮为可放回落点 */
.pool-card.pool-drop-target {
  outline: 2px dashed var(--brand-600);
  outline-offset: -2px;
}
.pool-drop-hint {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: inherit;
  background: color-mix(in srgb, var(--brand-600) 12%, transparent);
  color: var(--brand-600);
  font-size: 14px;
  font-weight: 700;
  pointer-events: none;
}
.pool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
/**
 * ★ 全局 theme.css 的 `.card-title{ margin-bottom:12px }` 是给**块布局**用的。
 * 这里 .card-title 是 flex 行的一个 item，那个 12px 下边距会让它的 margin 盒变成
 * 22.5+12=34.5 高，在 align-items:center 下内容被整体顶高 6px ⇒ 与旁边那行小字错开 6px
 *（实测 deltaCenterY = 6，正是 12/2）。所以在 flex 行里必须清零，并显式给图标留间距
 *（原来图标与文字间距 0，"待"字被图标压住，看着像重叠）。
 */
.pool-head .card-title {
  margin-bottom: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pool-list {
  display: flex;
  /* ★ 竖向滑动：课程多时折行显示，超出约三行的高度后上下滚动浏览。
     ⛔ 不能写 scrollbar-width / scrollbar-color 标准属性：Chrome 121+ 一旦设置，
     ::-webkit-scrollbar 自绘整体失效，回落 Win11 悬浮滚动条 —— 不滚动时完全隐形
     （10-18「超过四个就看不到」的根因）。删掉后自绘条强制常显 */
  flex-wrap: wrap;
  align-content: flex-start;
  max-height: 132px;
  overflow-y: auto;
  gap: 8px;
  padding-right: 4px;
}
.pool-list::-webkit-scrollbar {
  width: 8px;
}
.pool-list::-webkit-scrollbar-track {
  background: var(--bg-soft);
}
.pool-list::-webkit-scrollbar-thumb {
  background: var(--brand-400, var(--brand-300));
  border-radius: 4px;
}
.pool-list::-webkit-scrollbar-thumb:hover {
  background: var(--brand-500, var(--brand-400));
}
.pool-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid var(--brand-300);
  background: var(--brand-100);
  color: var(--brand-800);
  border-radius: 8px;
  font-size: 12px;
  cursor: grab;
  user-select: none;
  transition: 0.12s;
  white-space: nowrap;
  flex: none;
}
.pool-chip:hover {
  transform: translateY(-1px);
  box-shadow: var(--sh-1);
}
/* 自动排课口径胶囊（2026-10-29）：默认淡灰示「每周」，切成隔周后亮品牌色提示这是非默认口径 */
.chip-parity {
  margin-left: auto;
  flex: none;
  padding: 0 8px;
  height: 18px;
  line-height: 16px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--brand-800) 25%, transparent);
  background: transparent;
  color: var(--brand-800);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.chip-parity.is-alt {
  background: var(--brand-800);
  border-color: var(--brand-800);
  color: #fff;
  font-weight: 600;
}
/* ---- 待排课程展开浮层 ---- */
.panel-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 56vh;
  overflow-y: auto;
  /* ⛔ 与 .pool-list 同理：不能设 scrollbar-width/color，否则 Chrome 121+ 自绘失效、
     Win11 悬浮条隐形。自绘常显滚动条与池子条带同款 */
  padding-right: 4px;
}
.panel-list::-webkit-scrollbar {
  width: 8px;
}
.panel-list::-webkit-scrollbar-track {
  background: var(--bg-soft);
  border-radius: 4px;
}
.panel-list::-webkit-scrollbar-thumb {
  background: var(--brand-400, var(--brand-300));
  border-radius: 4px;
}
.panel-list::-webkit-scrollbar-thumb:hover {
  background: var(--brand-500, var(--brand-400));
}
.panel-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--brand-300);
  background: var(--brand-100);
  border-radius: 8px;
  cursor: grab;
  transition: 0.12s;
}
.panel-card:hover {
  box-shadow: var(--sh-1);
}
.panel-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.panel-info b {
  font-size: 13px;
  color: var(--brand-800);
}
.pool-chip:active {
  cursor: grabbing;
}
.pool-chip .grip {
  opacity: 0.45;
}
.pool-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-500);
  font-size: 12px;
}
.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: inline-block;
}
.legend-dot.ok {
  background: var(--brand-200);
}
.legend-dot.conf {
  background: #fca5a5;
}
.legend-dot.drop {
  background: transparent;
  border: 2px dashed var(--brand-600);
}
.legend-dot.swap {
  background: transparent;
  border: 2px dashed var(--warning);
}
.spacer {
  flex: 1;
}
.detail-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 14px;
}
.detail-k {
  width: 56px;
  color: var(--ink-500);
  flex: none;
}
.gap-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 12px 0 0;
  padding: 8px 10px;
  background: var(--warning-soft);
  color: var(--warning);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}
/* 同上：图标不参与压缩，文字整段作为单个 flex 项换行 */
.gap-hint > :first-child {
  flex: none;
  margin-top: 2px;
}
.gap-hint > span {
  flex: 1;
  min-width: 0;
}

/* ========== 2026-10-20 UI 惯例对标：今天列高亮 + 课程配色 + hover 联动 + 摘要条 ========== */

/* 列头日期小字（WebUntis 惯例：周一 10/20） */
.th-date {
  display: block;
  font-size: 10px;
  font-weight: 400;
  color: var(--ink-400);
  line-height: 1.3;
}

/* 今天列头：Google Calendar 同款强调（填充色 + 反白） */
.sched th.is-today {
  background: var(--brand-600);
  color: #fff;
  font-weight: 600;
}
.sched th.is-today .th-date {
  color: rgba(255, 255, 255, 0.85);
}

/* 今天整列铺淡底。拖拽放置态（drop-ok/swap/no）优先——它们在拖动中临时覆盖本底色 */
.sched td.cell.is-today-col:not(.drop-ok):not(.drop-swap):not(.drop-no) {
  background: #f2faf6;
}

/* 课程卡一门课一色：低饱和 tint 底 + 同系深字（密集网格不花、扫读快）。
   仅覆盖 c-ok 的三件套（背景/文字/描边），布局样式不动；冲突红走 c-conf，天然优先。 */
.cblock.t1 { background: #eef2ff; color: #3730a3; border-color: #c7d2fe; }
.cblock.t2 { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.cblock.t3 { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.cblock.t4 { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
.cblock.t5 { background: #fdf2f8; color: #be185d; border-color: #fbcfe8; }
.cblock.t6 { background: #f0fdfa; color: #0f766e; border-color: #99f6e4; }
.cblock.t7 { background: #faf5ff; color: #7e22ce; border-color: #e9d5ff; }
.cblock.t8 { background: #fefce8; color: #a16207; border-color: #fde68a; }
.cblock.t9 { background: #f8fafc; color: #334155; border-color: #cbd5e1; }
.cblock.t10 { background: #ecfeff; color: #0e7490; border-color: #a5f3fc; }

/* hover 联动：悬停某节课时，同课程的所有课次描边高亮（WebUntis 惯例）。
   用 outline 不占布局、不挤叠牌几何；色彩取品牌绿，与冲突红/可放置虚线可区分。 */
.cblock.c-peer {
  outline: 2px solid var(--brand-600);
  outline-offset: -1px;
}

/* 本周摘要条：翻周条与课表之间的一行小字 */
.week-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -4px 0 10px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--ink-500);
}
.week-stats b {
  color: var(--ink-900);
}
.week-stats .sep {
  color: var(--ink-300);
}
.week-stats .stat-conflict {
  color: var(--error);
  font-weight: 600;
}

/* 学期周次标注 CSS：2026-10-29 随「取消第几周显示」一并移除 */

/* ---------- 键盘可达（2026-10-22 第一档）：可见焦点环 ----------
 * outline 不占布局，不改叠牌几何；取深品牌色，与冲突红、可放置虚线区分得开 */
.cblock:focus-visible {
  outline: 2px solid var(--brand-800);
  outline-offset: 1px;
}

/* 配色第二通道：形状标记（色相 + 形状双编码，色觉障碍与黑白打印下仍可分辨课程） */
.tone-mark {
  margin-right: 3px;
  font-size: 9px;
}

/* 卡片明细悬浮层的内部结构（tooltip 插槽里的节点带本组件 scope，样式照常命中） */
.sched-tip {
  max-width: 320px;
  line-height: 1.7;
}
.sched-tip-line.is-head {
  font-weight: 600;
}
.sched-tip-hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.28);
  font-size: 11px;
  opacity: 0.78;
}

/* ---------- 窄视口（≤900px，2026-10-22 补第一处响应式）----------
 * 现状：全页零条 @media，6 列固定布局在 900px 以下把卡片压成一列文字、按钮溢出卡片。
 * 课表列宽不能靠换行解决（节次行头 96px + 5 天），所以这里给课表一条横向滚动，
 * 其余条状区域改为换行。宽视口下这些规则不命中，渲染结果与改动前逐像素相同。 */
/* 1024~1180：翻周条中列（本周按钮 + 日期范围 + 周次徽标）放不下时让它换行，而不是把左右按钮挤到相贴 */
@media (max-width: 1180px) {
  .week-center {
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 8px;
  }
}
/* ≤480：页头标题与右侧按钮组叠成两行（这一档下 layout/.shell 的固定侧栏本身就会顶出视口，
   见 20261023 全功能实测报告第五节，页内先把"自己贡献的那一段"收住） */
@media (max-width: 480px) {
  .page-head {
    flex-direction: column;
    align-items: flex-start;
    row-gap: 10px;
  }
  .page-head .actions {
    width: 100%;
    justify-content: flex-start;
  }
}
@media (max-width: 900px) {
  .card-pad {
    overflow-x: auto;
  }
  .sched {
    min-width: 620px;
  }
  .page-head,
  .toolbar,
  .week-pager,
  .week-stats,
  .grid-tools,
  .roster-bar {
    flex-wrap: wrap;
    row-gap: 8px;
  }
  /* 页头右侧按钮组：全局规则 .page-head .actions{display:flex;gap:10px} 不换行，
     765px 视口下整组 530px 宽、比容器多出 17px ⇒ 顶穿 main 让页面横向滚动。
     这里只在本页作用域内允许它换行（全局样式不在我可改范围） */
  .page-head .actions {
    flex-wrap: wrap;
    justify-content: flex-end;
    row-gap: 6px;
  }
  /* 780px 下翻周条的 1fr auto 1fr 仍会把中列撑到溢出：改用 flex 居中并允许换行
     （上一周/下一周跟着一起排，不再钉在两端） */
  .week-pager {
    display: flex;
    justify-content: center;
    column-gap: 8px;
  }
  .week-center,
  .undo-group {
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 8px;
  }
  /* 10-27 实测：780 档容器只有 447px，「上一周(109)+中列(318)+下一周(109)+两条 8px 间距」= 546 放不下
     ⇒ 下一周被挤到第二行，第一行只剩「上一周 + 中列」，中列右偏 53px。
     让中列独占第一行（flex-basis 100% + order -1），两个翻周按钮并排到下一行后各自都居中。 */
  .week-center {
    order: -1;
    flex: 1 1 100%;
  }
  .sched th,
  .sched td.slot {
    padding: 6px 4px;
    font-size: 11px;
  }
  .cblock {
    font-size: 11px;
  }
  .cblock .who {
    font-size: 10px;
  }
}

/* 节次降级提示条（施工项 #3）：淡黄底信息条，页面可用状态下的降级说明，非错误。
   放 scoped：类名本页独占，但不给全局样式表添条目是本文件既有惯例（4470 行后的
   全局块只放 popper 覆写这类"必须穿透 scoped"的东西） */
.periods-fallback {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 16px 8px;
  padding: 8px 12px;
  border: 1px solid var(--warn-200, #f5e3b3);
  border-radius: 8px;
  background: var(--warn-50, #fdf8ec);
  color: var(--warn-700, #8a6116);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>

<style>
/* 悬浮层与下拉面板被 teleport 到 body 上，scoped 选择器（[data-v-*]）够不到它们的根节点，
   故单独开这一块。只写这两条，类名带 sched- 前缀不会撞到其他页面 */
.sched-card-popper {
  max-width: 340px;
}
.sched-undo-popper {
  max-height: 320px;
  overflow-y: auto;
}
</style>
