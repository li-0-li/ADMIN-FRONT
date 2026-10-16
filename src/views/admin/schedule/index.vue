<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { createSchedule, deleteSchedule, listCoursePool, listSchedules, moveSchedule, swapSchedules } from '@/api/admin/schedules';
import { deleteCourse } from '@/api/admin/courses';
import { listClasses, listClassrooms, listMajors, listTerms, updateClassroom } from '@/api/admin/basicdata';
import { listUsers } from '@/api/admin/users';
import type { Classroom, CourseBrief, ScheduleCell } from '@/types/admin';

/**
 * 节次表（库表 class_period 无查询接口 ⇒ 前端恒定一份）。
 * 时间由业务方给出：每段 110 分钟，第 5 段为晚课。
 * ⚠️ 与库内 class_period 原值不一致（库里是 08:30/10:25/14:00/15:55/19:00 各 95 分钟），
 *    以业务方口径为准；库表已同步（见工作汇报台账）。
 */
const PERIODS = [
  { seq: 1, label: '1-2 节', start: '08:00', end: '09:50', duration: 110 },
  { seq: 2, label: '3-4 节', start: '10:10', end: '12:00', duration: 110 },
  { seq: 3, label: '5-6 节', start: '14:30', end: '16:20', duration: 110 },
  { seq: 4, label: '7-8 节', start: '16:40', end: '18:30', duration: 110 },
  { seq: 5, label: '9-10 节', start: '19:00', end: '20:50', duration: 110, evening: true }
];
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
const filters = reactive({ courseId: '', teacherId: '', clazzName: '', classroomId: '', major: '', termId: '' });
/** 学期下拉（后端 ScheduleQueryBo 支持 termId 过滤 ⇒ 服务端筛，变化即重查） */
const terms = ref<{ termId: number; name: string }[]>([]);
/** 班级名 → 专业名 映射（schedule.target_class 是冗余字符串、无 clazzId 外键，
 *  专业信息只能借基础数据的班级列表接口按名称映射） */
const clazzMajorMap = ref<Record<string, string>>({});

/**
 * 拉取本周课次。
 * @param soft 落库后的回读（同周同筛选，只是重读一遍）⇒ 遮罩不阻挡；否则整体替换 ⇒ 遮罩阻挡。
 */
async function load(soft = false) {
  if (soft) refreshing.value = true;
  else loading.value = true;
  try {
    const res = await listSchedules({
      startDate: weekStartStr.value,
      endDate: weekEndStr.value,
      termId: filters.termId || undefined,
      page: 1,
      pageSize: PAGE_SIZE,
      includeDeleted: true
    });
    const rows = res?.list ?? [];
    allCells.value = rows.filter(c => !c.deleted);
    // 软删行 = 本周被放回待排的课次 → 这些课程即使还有别的课次在课表也显示在待排池
    returnedCourseIds.value = new Set(rows.filter(c => c.deleted).map(c => String(c.courseId)));
  } catch {
    allCells.value = [];
    returnedCourseIds.value = new Set();
  } finally {
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

/* ---------- 下拉选项：从本周数据去重推导（学期字段 VO 未提供 ⇒ 学期下拉只读） ---------- */
type IdKey = 'courseId' | 'teacherId' | 'classroomId';
type NameKey = 'courseName' | 'teacherName' | 'roomName';
function deriveOptions(rows: ScheduleCell[], idKey: IdKey, nameKey: NameKey) {
  const m = new Map<string, string>();
  for (const r of rows) {
    const id = r[idKey];
    if (id === undefined || id === null) continue;
    const k = String(id);
    if (!m.has(k)) m.set(k, String(r[nameKey] ?? k));
  }
  return Array.from(m, ([value, label]) => ({ value, label }));
}
/** 课程选项：选中专业后只保留**教给该专业班级**的课程（联动收窄）；未选专业 = 全部 */
const courseOptions = computed(() => {
  const rows = filters.major
    ? allCells.value.filter(r => majorOf(r.clazzName) === filters.major)
    : allCells.value;
  return deriveOptions(rows, 'courseId', 'courseName');
});
const teacherOptions = computed(() => deriveOptions(allCells.value, 'teacherId', 'teacherName'));

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

/** 班级筛选：schedule.target_class 是冗余字符串列（VO 只有 clazzName、无 clazzId）⇒ 按名称去重与过滤。
 *  ⛔ clazzName 为空的课次（「未填班级」）**不生成选项** —— 空字符串选项没有筛选意义，且下拉里出现空白项。 */
const clazzOptions = computed(() => {
  const m = new Map<string, string>();
  for (const r of allCells.value) {
    const n = r.clazzName;
    if (!n) continue;
    // 选中专业后只保留该专业的班级（联动收窄）
    if (filters.major && majorOf(n) !== filters.major) continue;
    if (!m.has(n)) m.set(n, n);
  }
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
/** 专业选项：课次班级推导出的专业去重；「未填班级」不产生选项 */
const majorOptions = computed(() => {
  const m = new Map<string, string>();
  for (const r of allCells.value) {
    const major = majorOf(r.clazzName);
    if (!major) continue;
    if (!m.has(major)) m.set(major, major);
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

const keyOf = (weekday: number, periodNo: number) => `${weekday}-${periodNo}`;

/**
 * 节次格 → 该格内的**全部**课次。
 * ★ 一个节次格可以容纳多节课：同一时间不同教师、不同教室并行上课是合法的
 *   （后端只把「同教师」或「同教室」判为冲突，见 countConflict）。
 *   所以这里必须是数组，不能像原来那样一格只留最后一节课（会把并行的课吞掉）。
 */
const cellMap = computed(() => {
  const m: Record<string, ScheduleCell[]> = {};
  for (const c of filtered.value) {
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
const conflictCells = computed(() => filtered.value.filter(c => !!c.conflict));

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
 * ⛔ 仍不实现：/schedules/auto 自动排课、/schedules/publish 发布课表、删除课次
 *   （后端未提供，按钮点击只做缺口提示、不发请求）。
 */
const poolCourses = ref<CourseBrief[]>([]);

/** 本周被「放回待排」过的课程 id 集（软删课次的课程）：这些课程即使还有别的课次在课表也显示在池里 */
const returnedCourseIds = ref(new Set<string>());

/** 当前学期 id（loadPickers 拉学期列表时记录）：未选学期（=全部学期）时池子按它判定「已排」 */
const currentTermId = ref('');

/**
 * 未排课程 = 课程池中「**学期口径内**本周课表里没出现过」或「本周有被放回的课次」的课程；
 * 跟随课程/教师筛选一起收窄。
 * ★ 口径一（学期）：「已排」判定锁定学期（选中学期；全部学期按当前学期），否则全部学期视图池恒空。
 * ★ 口径二（放回即回池）：拖回一节课 = 那节课待重排 ⇒ 课程立刻回池，不必等全部课次放回
 *   （2026-10-16 按用户要求改的语义；从池里重新排课时后端会消费掉那条软删槽位）。
 */
const pool = computed(() => {
  const scope = filters.termId || currentTermId.value;
  const inScope = scope
    ? allCells.value.filter(c => c.termId !== undefined && c.termId !== null && String(c.termId) === String(scope))
    : allCells.value;
  const used = new Set(inScope.map(c => String(c.courseId)));
  return poolCourses.value.filter(c => {
    if (used.has(String(c.courseId)) && !returnedCourseIds.value.has(String(c.courseId))) return false;
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
const panelPool = computed(() =>
  pool.value.filter(c => {
    if (panelKeyword.value && !(c.courseName ?? '').toLowerCase().includes(panelKeyword.value.trim().toLowerCase())) return false;
    if (panelTeacherId.value && String(c.teacherId ?? '') !== panelTeacherId.value) return false;
    return true;
  })
);
function openPoolPanel() {
  panelKeyword.value = '';
  panelTeacherId.value = '';
  poolPanelVisible.value = true;
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
/** 折叠叠牌几何：浅灰格内容区只有 88px（td 98 − 上下 padding 5×2）。
 * 顶卡最多 84px；节数多时顶卡按 88 − 3×(n−1) 压矮，保证整叠永远不出格子。 */
const CELL_CONTENT_H = 88;
const CARD_MAX_H = 84;
const REVEAL_PX = 3;
function deckGeom(n: number) {
  const cardH = Math.max(48, Math.min(CARD_MAX_H, CELL_CONTENT_H - (n - 1) * REVEAL_PX));
  return { cardH, deckH: cardH + (n - 1) * REVEAL_PX };
}
/** 压缩态点击卡片＝展开该格；展开态点击卡片＝打开详情 */
function onCardClick(s: ScheduleCell, weekday: number, periodNo: number, count: number) {
  if (isCollapsedCell(weekday, periodNo, count)) toggleCellExpand(weekday, periodNo);
  else openDetail(s);
}
/** 并入/新建落到某格成功后自动展开，让"多节并存"立刻可见 */
function expandCell(weekday: number, periodNo: number) {
  if (!expandedCells.value.has(cellKey(weekday, periodNo))) {
    expandedCells.value = new Set(expandedCells.value).add(cellKey(weekday, periodNo));
  }
}

/** 本周 weekday 对应的日期（1=周一） */
function dateOf(weekday: number) {
  const d = new Date(weekStart.value);
  d.setDate(d.getDate() + (weekday - 1));
  return fmt(d);
}

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
  draggingCourse.value = null;
  draggingCell.value = cell;
  dragOverKey.value = '';
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
 *   'no'       不允许 —— 拖到自己所在的那张卡片上（原地放下没有意义）
 * ★ 一个节次格可容纳多节课（同时间不同教师/教室并行）：**不同教师并存合法、同一教师并存必冲突**，
 *   规则据此分成「可选并入/互换」与「只能互换」两种。
 * ★ 互换会**把对方也挪走**（比"并入"破坏性大），所以两种都可行时必须让用户显式选，
 *   不做任何默认自动决定 —— 避免"我只是想把他俩放一起，怎么把另一节挪走了"。
 * ★ 真正的冲突仍由后端在落库时判定，前端只负责"这里哪几种操作可行"的引导。
 */
type DropMode = '' | 'ok' | 'swaponly' | 'no';
/** 悬停到的**卡片本体**所属课次 id（0＝不是卡片本体） */
const dragOverCardId = ref(0);

/** 两节课是否同一教师：优先比 id，id 缺失时退回比姓名（都拿不准就当作"不同"） */
function isSameTeacher(a: ScheduleCell, b: ScheduleCell) {
  const ai = a.teacherId ?? null;
  const bi = b.teacherId ?? null;
  if (ai !== null && bi !== null) return String(ai) === String(bi);
  const an = (a.teacherName ?? '').trim();
  const bn = (b.teacherName ?? '').trim();
  return !!an && an === bn;
}

function dropMode(weekday: number, periodNo: number): DropMode {
  if (!draggingCourse.value && !draggingCell.value) return '';
  if (dragOverKey.value !== keyOf(weekday, periodNo)) return '';
  if (draggingCell.value) {
    // 拖回自己那张卡片：原地放下没有意义
    if (dragOverCardId.value === draggingCell.value.scheduleId) return 'no';
    // 同一教师的另一节课 ⇒ 只能互换（同一教师不可能在同一节次上两门课）
    const hovered = filtered.value.find(x => x.scheduleId === dragOverCardId.value);
    if (hovered && isSameTeacher(draggingCell.value, hovered)) return 'swaponly';
  }
  return 'ok';
}
/** 悬停在某张**别的教师**的卡片上 ⇒ 放开后由用户选：并入 / 互换 */
function isChoiceHover(weekday: number, periodNo: number, s: ScheduleCell) {
  return dragOverCardId.value === s.scheduleId && dropMode(weekday, periodNo) === 'ok';
}
/** 悬停在**同一教师**的另一节课卡片上 ⇒ 只能互换 */
function isSwapOnlyHover(weekday: number, periodNo: number, s: ScheduleCell) {
  return dragOverCardId.value === s.scheduleId && dropMode(weekday, periodNo) === 'swaponly';
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
async function handleDrop(weekday: number, periodNo: number, targetCardId: number) {
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
    if (targetCardId) {
      // ①-1 落回自己 → 原地放下没有意义
      if (targetCardId === movingCell.scheduleId) {
        ElMessage.warning('这就是它当前所在的格子');
        return;
      }
      const target = filtered.value.find(x => x.scheduleId === targetCardId);
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
        `「${cell.courseName ?? '该课次'}」无法移到${target}：${res.conflictMsg || '该时段教师或教室已被占用'}`
      );
      return;
    }
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
        `「${fromLabel}」与「${toLabel}」无法互换：${res.conflictMsg || '互换后该时段教师或教室已被占用'}`
      );
      return;
    }
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
  const scopeCells = scope
    ? allCells.value.filter(c => c.termId !== undefined && c.termId !== null && String(c.termId) === String(scope))
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
  const id = Number(courseId);
  if (!id) {
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
    await deleteCourse(id);
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

/** 与原值比对，没改就不让点保存（避免无意义写库） */
const detailDirty = computed(() => {
  const c = detailCell.value;
  if (!c) return false;
  const cur = c.classroomId === undefined || c.classroomId === null ? '' : String(c.classroomId);
  const curT = c.teacherId === undefined || c.teacherId === null ? '' : String(c.teacherId);
  return (
    editForm.classroomId !== cur ||
    editForm.remark !== (c.note ?? '') ||
    editForm.clazzName !== (c.clazzName ?? '') ||
    editForm.teacherId !== curT
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
  detailSaving.value = true;
  try {
    const res = await moveSchedule(c.scheduleId, {
      classTime: `${dateOf(weekday)} ${period.start}:00`,
      durationMin: period.duration,
      weekday,
      periodNo: period.seq,
      classroomId: editForm.classroomId ? Number(editForm.classroomId) : undefined,
      remark: editForm.remark,
      targetClass: editForm.clazzName.trim(),
      teacherId: editForm.teacherId ? Number(editForm.teacherId) : undefined
    });
    if (res?.conflict) {
      ElMessage.warning(`调整未保存：${res.conflictMsg || '该时段教师或教室已被占用'}`);
      return;
    }
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
const courseList = ref<{ value: string; label: string }[]>([]);
/** 新增课次弹窗「删除课程」按钮上显示的课程名（按当前选中项反查） */
const selectedCourseName = computed(
  () => courseList.value.find(o => o.value === form.courseId)?.label || '该课程'
);
const teacherList = ref<{ value: string; label: string }[]>([]);
/** 拖动/点击课程卡进来时，记录来源课程，用于自动预选授课教师 */
const presetCourseId = ref('');

async function loadPickers() {
  if (!courseList.value.length) {
    try {
      const res = await listCoursePool();
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
        .map(t => ({ termId: t.termId as number, name: t.name || String(t.termId) }));
      // 默认选中「当前学期」（此前是写死的只读「2026 秋」占位）
      if (!filters.termId) {
        const cur = res?.list?.find(t => t.isCurrent === 1) ?? res?.list?.[0];
        if (cur?.termId !== undefined) filters.termId = String(cur.termId);
      }
      // 记录当前学期：池子「已排」判定在「全部学期」视图下按它收口
      const curTerm = res?.list?.find(t => t.isCurrent === 1) ?? res?.list?.[0];
      currentTermId.value = curTerm?.termId !== undefined ? String(curTerm.termId) : '';
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
  await loadPickers();
  form.classroomId = preset.classroomId ?? '';
  form.clazzName = '';
  form.weekday = weekday ?? 1;
  form.periodNo = periodNo ?? 1;
  presetCourseId.value = preset.courseId ?? '';
  form.courseId = preset.courseId ?? '';

  // 拖动排课：课程自带授课教师 → 自动预选（教师不在可选列表里则不预选，交由人工选）
  form.teacherId = '';
  if (form.courseId) {
    const hit = poolCourses.value.find(x => String(x.courseId) === form.courseId);
    const tid = hit?.teacherId;
    if (tid && teacherList.value.some(t => String(t.value) === String(tid))) {
      form.teacherId = String(tid);
    }
  }

  const period = PERIODS.find(x => x.seq === periodNo);
  createTitle.value =
    weekday && period ? `拖动排课 · 周${CN[weekday - 1]} ${period.label}` : '新增课次 · 手动选择时间';
  createVisible.value = true;
}

async function submitCreate() {
  if (!form.courseId) {
    ElMessage.warning('请选择课程');
    return;
  }
  if (!form.teacherId) {
    ElMessage.warning('请选择授课教师');
    return;
  }
  const period = PERIODS.find(x => x.seq === form.periodNo);
  if (!period) {
    ElMessage.warning('节次不合法');
    return;
  }
  const d = new Date(weekStart.value);
  d.setDate(d.getDate() + (form.weekday - 1));
  saving.value = true;
  try {
    const res = await createSchedule({
      courseId: Number(form.courseId),
      teacherId: Number(form.teacherId),
      classroomId: form.classroomId ? Number(form.classroomId) : undefined,
      classTime: `${fmt(d)} ${period.start}:00`,
      durationMin: period.duration,
      weekday: form.weekday,
      periodNo: form.periodNo,
      targetClass: form.clazzName.trim() || undefined
    });
    if (res?.conflict) {
      ElMessage.warning(`未保存：${res.conflictMsg || '该时段教师或教室已被占用'}`);
    } else {
      ElMessage.success('课次已新增');
      createVisible.value = false;
      // 若该格原来已有课（并入式新建），自动展开让多节并存立刻可见
      expandCell(form.weekday, form.periodNo);
      await load(true);
    }
  } catch {
    /* 已在请求层提示 */
  } finally {
    saving.value = false;
  }
}

/* ---------- 缺口动作：后端既定不实现，前端不发请求 ---------- */
function onAuto() {
  ElMessage.info('后端未提供自动排课接口（/schedules/auto 属既定不实现范围），本按钮不发起请求。');
}
function onPublish() {
  ElMessage.info('后端未提供课表发布接口（/schedules/publish 属既定不实现范围），本按钮不发起请求。');
}

/* ---------- 导出：前端本地 CSV ---------- */
function exportCsv() {
  const rows = (filtered.value.length ? filtered.value : allCells.value).slice();
  if (!rows.length) {
    ElMessage.info('当前没有可导出的课次');
    return;
  }
  const head = ['节次', '时间', '星期', '课程', '班级', '教师', '教室', '备注'];
  const body = rows
    .sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.periodNo ?? 0) - (b.periodNo ?? 0))
    .map(r => {
      const p = PERIODS.find(x => x.seq === r.periodNo);
      return [
        p?.label ?? String(r.periodNo ?? ''),
        p ? timeRange(p) : '',
        `周${CN[(r.weekday ?? 1) - 1]}`,
        r.courseName ?? '',
        r.clazzName ?? '',
        r.teacherName ?? '',
        r.roomName ?? '',
        r.note ?? ''
      ];
    });
  const csv = [head, ...body]
    .map(cols => cols.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `课表_${weekStartStr.value}_${weekEndStr.value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('课表已导出（CSV，可用 Excel/WPS 打开）');
}

onMounted(async () => {
  await Promise.all([load(), loadPickers()]);
});

/** 学期切换（服务端过滤）⇒ 重查本周课次 */
watch(
  () => filters.termId,
  () => load()
);
</script>

<template>
  <div class="page-head">
    <h1>智能排课</h1>
    <div class="actions">
      <button class="btn btn-outline" @click="exportCsv">
        <ZkIcon name="download" :size="16" style="margin-right: 4px" />导出课表
      </button>
      <button class="btn btn-primary" @click="onAuto">
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
          @update:model-value="onDatePick"
        />
        <button class="btn btn-outline" @click="gotoThisWeek">本周</button>
      </div>
      <el-select v-model="filters.termId" class="f-sel-term" placeholder="全部学期" clearable filterable style="width: 150px">
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="String(t.termId)" />
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
      <span class="badge" :class="conflictCells.length ? 'badge-error' : 'badge-neutral'">
        <ZkIcon v-if="conflictCells.length" name="alert-triangle" :size="12" style="margin-right: 4px" />
        {{ conflictCells.length ? `${conflictCells.length} 处冲突待调整` : '本周无冲突' }}
      </span>
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
      <span class="small muted">共 {{ pool.length }} 门未排入本周课表 —— 拖到下方课表格子完成排课</span>
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
    <div v-if="pool.length" class="pool-list">
      <div
        v-for="c in pool"
        :key="c.courseId"
        class="pool-chip"
        draggable="true"
        :title="`拖动排课，或点击打开新增表单：${c.courseName}`"
        @dragstart="onDragStart(c, $event)"
        @dragend="onDragEnd"
        @click="openCreate(null, null, { courseId: String(c.courseId) })"
      >
        <ZkIcon name="grip-vertical" :size="13" class="grip" />
        <b>{{ c.courseName }}</b>
        <span class="small muted">{{ c.teacherName || '未指定教师' }} · {{ c.studentCount ?? 0 }} 人</span>
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
    <table class="sched">
      <thead>
        <tr>
          <th style="width: 96px">节次</th>
          <th v-for="d in WEEKDAYS" :key="d.v">{{ d.label }}</th>
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
            :class="{
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
                <div
                  v-for="(s, idx) in c.list"
                  :key="s.scheduleId"
                  class="cblock"
                  :class="[
                    s.conflict ? 'c-conf' : 'c-ok',
                    {
                      'c-dragging': draggingCell?.scheduleId === s.scheduleId,
                      'c-join-target': isChoiceHover(c.weekday, row.period.seq, s),
                      'c-swap-target': isSwapOnlyHover(c.weekday, row.period.seq, s)
                    }
                  ]"
                  :style="
                    isCollapsedCell(c.weekday, row.period.seq, c.list.length)
                      ? { top: idx * 3 + 'px', zIndex: c.list.length - idx, height: deckGeom(c.list.length).cardH + 'px' }
                      : undefined
                  "
                  draggable="true"
                  title="点击查看/调整；拖到空格子或别的教师的课次上，可改上课时间；拖到同一教师的课次上，只能互换上课时间"
                  @dragstart="onCellBlockDragStart(s, $event)"
                  @dragend="onDragEnd"
                  @dragover.stop="onBlockDragOver(c.weekday, row.period.seq, s, $event)"
                  @drop.stop="onBlockDrop(c.weekday, row.period.seq, s, $event)"
                  @click="onCardClick(s, c.weekday, row.period.seq, c.list.length)"
                >
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
                  <b>{{ s.courseName || '（未命名课程）' }}</b>
                  <span class="who"><ZkIcon name="users" :size="11" />{{ s.clazzName || '未填班级' }}</span>
                  <span class="who"><ZkIcon name="user" :size="11" />{{ s.teacherName || '—' }}</span>
                  <span class="who"><ZkIcon name="map-pin" :size="11" />{{ s.roomName || '未指定教室' }}</span>
                  <!-- ★ 叠牌常驻标志：不用悬停也能一眼看出下面还压着课 -->
                  <span
                    v-if="idx === 0 && c.list.length > 1"
                    class="stack-chip"
                  >
                    <ZkIcon name="layers" :size="10" />共 {{ c.list.length }} 节
                  </span>
                </div>
                <!-- 悬停浮现的展开提示（纯 CSS hover 显隐，不占布局、不挡点击） -->
                <span class="stack-hint">
                  <ZkIcon name="chevron-down" :size="10" />同段共 {{ c.list.length }} 节 · 点击展开
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
              <ZkIcon name="chevron-up" :size="12" />收起（同段共 {{ c.list.length }} 节）
            </button>
            <!-- 空格子：点一下手动新增 -->
            <div
              v-if="!c.list.length"
              class="cblock c-empty"
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
          size="small"
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
          allow-create
          default-first-option
          size="small"
          style="flex: 1; min-width: 0"
        >
          <el-option v-for="n in filteredClassOptions" :key="n" :label="n" :value="n" />
        </el-select>
      </div>
      <div class="detail-row">
        <span class="detail-k">教师</span>
        <el-select
          v-model="editForm.teacherId"
          placeholder="未指定教师"
          filterable
          size="small"
          style="flex: 1; min-width: 0"
        >
          <el-option v-for="o in teacherList" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div class="detail-row">
        <span class="detail-k">教室</span>
        <el-select
          v-model="editForm.classroomId"
          placeholder="未指定教室"
          clearable
          filterable
          size="small"
          style="flex: 1; min-width: 0"
        >
          <el-option v-for="o in roomOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div class="detail-row">
        <span class="detail-k">备注</span>
        <el-input
          v-model="editForm.remark"
          placeholder="如：本周由助教代课 / 调换至机房"
          maxlength="200"
          size="small"
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

  <!-- 待排课程展开浮层：非模态 + 可拖动，方便与课表对照着拖课排课 -->
  <el-dialog
    v-model="poolPanelVisible"
    title="全部待排课程"
    width="640px"
    :modal="false"
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
      <span class="small muted" style="white-space: nowrap">共 {{ panelPool.length }} 门</span>
    </div>
    <div class="panel-list">
      <div
        v-for="c in panelPool"
        :key="c.courseId"
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
        </div>
        <button
          class="btn btn-outline btn-sm"
          @click="openCreate(null, null, { courseId: String(c.courseId) }); poolPanelVisible = false"
        >排课</button>
      </div>
      <div v-if="!panelPool.length" class="pool-empty">
        <ZkIcon name="check" :size="14" />没有匹配的待排课程
      </div>
    </div>
    <p class="move-hint" style="margin-top: 10px">
      <ZkIcon name="move" :size="14" />
      <span>把课程<b>拖到课表的空格子</b>即可排课；也可以点「排课」按钮手动选时间。</span>
    </p>
  </el-dialog>

  <!-- 新增课次（C-17 真接口，带冲突检查） -->
  <el-dialog v-model="createVisible" :title="createTitle" width="460px">
    <el-form label-width="92px" label-position="right">
      <el-form-item label="课程" required>
        <el-select v-model="form.courseId" placeholder="请选择课程" filterable style="width: 100%">
          <el-option v-for="o in courseList" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="授课教师" required>
        <el-select v-model="form.teacherId" placeholder="请选择教师" filterable style="width: 100%">
          <el-option v-for="o in teacherList" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="上课教室">
        <el-select v-model="form.classroomId" placeholder="可不填" clearable style="width: 100%">
          <el-option v-for="o in roomOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="上课班级">
        <el-select
          v-model="form.clazzName"
          placeholder="可不填"
          clearable
          filterable
          allow-create
          default-first-option
          style="width: 100%"
        >
          <el-option v-for="n in classListOptions" :key="n" :label="n" :value="n" />
        </el-select>
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
/* 日期选择器与「本周」按钮高度对齐右侧筛选框（38px） */
.week-nav .el-date-editor {
  height: 38px;
}
.week-nav :deep(.el-input__inner) {
  height: 34px;
  line-height: 34px;
}
/* 筛选下拉弹性等分剩余宽度（日期组之外）：
   宽度由 flex 决定、与选项文本无关 ⇒ 展开下拉/切换选项都不会引起工具栏回流变形 */
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
  flex: 1.35 1 0;
  min-width: 150px;
}
.room-filter .f-select {
  flex: 1 1 auto;
  min-width: 0;
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
  height: 78px;
  vertical-align: top;
  padding: 5px;
  min-width: 140px;
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
   卡片全部同位重叠，第 idx 张下移 idx*4px（模板内联 style），
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
  /* 必须定高：自然高 87.5px 会顶穿浅灰格（内容区仅 88px）。
     84px = 4 行内容 72 + 间距 6 + 内边距 6（上下各 3，行距/间距仍与普通卡一致）；
     84 + 下层露边 3px×(n-1) ≤ 88 ⇒ 整叠永远压在格内 */
  height: 84px;
  padding: 3px 8px;
  overflow: hidden;
}
/* 非顶卡：只留卡片底色与描边（露出的底缘），内容全部隐藏 —— 圆角缝隙也不透字 */
.cell-stack.is-collapsed .cards-deck .cblock:not(:first-child) {
  box-shadow: 0 0 0 1px var(--border);
}
/* ★ 折叠卡是绝对定位（top: idx*3px），基础样式里的 .cblock + .cblock { margin-top:4px }
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
.c-empty {
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
  /* ★ 单排横向滑动：课程多时不再折行撑高卡片，超出的左右滑动浏览；
     全部浏览/筛选请点「展开」按钮打开浮层 */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  gap: 8px;
  padding-bottom: 4px;
  scrollbar-width: thin;
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
  font-size: 13px;
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
</style>
