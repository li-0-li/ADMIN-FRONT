<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TableInstance } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { deleteCourse, exportCourses, listCourses } from '@/api/admin/courses';
import type { AdminCourseOrderBy, AdminCourseVo } from '@/api/admin/courses';
import { getCertDetail, reviewCertification } from '@/api/admin/certifications';
import { listSchedules } from '@/api/admin/schedules';
import { listTerms } from '@/api/admin/basicdata';
import { useUserStore } from '@/store/user';
import type { CertDetail } from '@/types/admin';

/**
 * 课程总览（2026-10-29 新增）
 * ============================================================================
 * 定位：**审核已通过的课程**在这里，课程审核页只放待审队列。
 * 两页的边界靠状态字段切：审核通过后后端把 course.status 置为 active（C-15 裁决的副作用），
 * 本页固定查 status=active —— 数据源与审核页完全分离，不需要前端搬数据。
 *
 * ★ 为什么不用 /api/v1/certifications?status=approved 当数据源：
 *   实测（10-29）该接口传 status=rejected 返回的却是 approved 记录 ⇒ status 参数只可靠识别
 *   pending，不能按 approved 精确筛；而且它返回的是"认证聚合行"，没有学期/选课人数/课程代码。
 *   课程列表 C-12 的 status 过滤实测可靠（active 10 / 全集 11），所以本页用它。
 *
 * ★ 认证材料不是本页主数据：C-14 详情按 courseId 取，历史课程可能没有认证记录
 *   （演示库 10 门 active 课里只有 2 门有 approved 认证）⇒ 详情失败只降级成一句说明，
 *   不弹红条、不阻塞列表——这是"可选信息"，不是"页面必需数据"。
 */

const loading = ref(false);
/** 只为 clearSort 服务：清筛选时要同时熄灭表头排序箭头 */
const tableRef = ref<TableInstance>();
const rows = ref<AdminCourseVo[]>([]);
const total = ref(0);
/** 失败态与空态分开存：接口挂了不能显示成"没有课程"（账号页同款处理） */
const loadError = ref('');
const router = useRouter();
const userStore = useUserStore();
/**
 * 导出按钮的显示条件是「真有这个权限」，不是「后端换了包」：
 * admin:courses:export 目前既没建菜单也没授角色（10-29 实测 /system/menu/list 里无此 perms），
 * 非超管账号点了必然 403。规范做法是没权限就不显示，而不是摆一个点不动的按钮。
 */
const canExport = computed(() => userStore.hasPermi('admin:courses:export'));
/** scheduleState：排课状态筛选（'' 全部 / 'scheduled' 已排课 / 'unscheduled' 未排课）
 *  见下方 fetchList 的说明：这个条件没法交给后端分页，只能本地筛。 */
const query = reactive<{
  page: number;
  pageSize: number;
  keyword: string;
  semester: string;
  scheduleState: string;
  orderBy: AdminCourseOrderBy | '';
  orderDir: 'asc' | 'desc' | '';
}>({ page: 1, pageSize: 10, keyword: '', semester: '', scheduleState: '', orderBy: '', orderDir: '' });
/** 排课筛选下的补充说明（例如全量没拉完），空串=无话可说 */
const filterNote = ref('');
/** 是否存在任一筛选条件：决定空态给「清空筛选」还是「去课程审核」 */
const hasFilter = computed(() => !!query.keyword.trim() || !!query.semester || !!query.scheduleState);

const terms = ref<{ termId: number; name: string }[]>([]);
const termOptionsReady = computed(() => terms.value.length > 0);

const STATUS_LABEL: Record<string, string> = { active: '已通过', creating: '创建中' };
const STATUS_BADGE: Record<string, string> = { active: 'badge-success', creating: 'badge-neutral' };
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s ?? '—';
const statusBadge = (s: string) => STATUS_BADGE[s] ?? 'badge-neutral';

/* ---------------- 排课情况（2026-10-29 业主新增列）----------------
 * 课程列表接口（C-12）没有排课字段，只能从课次接口反查：
 *   GET /api/v1/admin/schedules?startDate&endDate&pageSize 一次拉回课次，按 courseId 聚合计数。
 * ★ 三个实测要点（10-29，8080）：
 * 1. 必须走**管理端路径** `/api/v1/admin/schedules`：学生端 `/api/v1/schedules` 按当前登录者过滤，
 *    管理员调它恒返回 0 条（实测 0，差点误判成"全都没排课"）。
 * 2. `startDate`/`endDate` 是**必填**（缺了直接 code=422「startDate 与 endDate 不能为空」）。
 *    "是否排过课"是历史事实、不该受区间限制 ⇒ 给一个足够宽的区间（后端不校验跨度，实测 2000~2100 可拿全量）。
 * 3. 返回里的 `deleted` 默认已排除软删（实测 313 条全为 0）⇒ 放回待排的课次不会误算成"已排课"。
 * 一次拉不完（total > 拉回数）时只统计已拉部分，并把列头标注为统计不全，不假装是全量。
 */
const scheduleCount = ref<Map<string, number>>(new Map());
const scheduleStatsLoading = ref(false);
/** 统计是否成功拿到过。★ 不能只看 Map 是否为空：接口失败时 Map 也是空的，
 *  若此时把"没有记录"当"0 节"，整页课程会全部误报成「未排课」——所以失败一律显示 — */
const scheduleStatsReady = ref(false);
/** 课次总量超过一次拉取上限 ⇒ 计数是部分统计，列头要说明，不能让用户当全量看 */
const scheduleStatsPartial = ref(false);
const SCHEDULE_WIDE_START = '2000-01-01';
const SCHEDULE_WIDE_END = '2100-12-31';
const SCHEDULE_FETCH_LIMIT = 1000;

/* ---------------- 后端能力探测（2026-10-29）----------------
 * 后端 5edbfbb 给课程列表补了 scheduleCount 字段、orderBy/orderDir 排序、POST /export 导出，
 * 但**运行包（8080 的 10-26 包）还没有**：实测无 scheduleCount 字段、asc/desc 顺序完全一致、
 * POST /export 返回 code:500「Request method 'POST' is not supported」。
 * 所以这里用「列表首行有没有 scheduleCount 这个 key」当版本探针——一次列表请求即可判断，
 * 不用额外打探测请求，也不会误判（旧包是**没有这个 key**，不是值为 null）：
 *   新包 → 课次数直接用字段（零请求零聚合）、表头可服务端排序、导出可用
 *   旧包 → 回退到课次接口聚合、排序表头禁用（否则点了没反应更像 bug）、导出按钮明确提示不可用
 */
const serverHasScheduleCount = ref(false);
/** 排序与导出同属 5edbfbb 这一批，一次探测同时决定三者 */
const canServerSort = computed(() => serverHasScheduleCount.value);

async function loadScheduleCounts() {
  scheduleStatsLoading.value = true;
  try {
    const res = await listSchedules({
      startDate: SCHEDULE_WIDE_START,
      endDate: SCHEDULE_WIDE_END,
      page: 1,
      pageSize: SCHEDULE_FETCH_LIMIT
    });
    const list = res?.list ?? [];
    const m = new Map<string, number>();
    for (const c of list) {
      const id = String(c.courseId ?? '');
      if (!id) continue;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    scheduleCount.value = m;
    scheduleStatsPartial.value = (res?.total ?? 0) > list.length;
    scheduleStatsReady.value = true;
  } catch {
    /* 排课情况是附加信息：拉不到就显示 —，不影响课程列表本身（与认证材料同思路） */
    scheduleCount.value = new Map();
    scheduleStatsPartial.value = false;
    scheduleStatsReady.value = false;
  } finally {
    scheduleStatsLoading.value = false;
  }
  // 返回是否拿到：排课状态筛选依赖它，拿不到就不能假装筛过了（否则会筛出空列表冒充"没有未排课的课"）
  return scheduleStatsReady.value;
}

/** 该课程的节次数；null = 数字还没拿到（与"0 节/未排课"必须区分开，否则会误报未排课）
 *  ★ 优先用后端字段（新包）：一行就带着课次数，既不用拉 1000 条课次，也不会因拉取上限漏数；
 *    旧包没有这个 key，才回退到本页聚合的 Map。判断用 typeof，0 是合法值。 */
function scheduledCount(row: AdminCourseVo): number | null {
  if (typeof row.scheduleCount === 'number') return row.scheduleCount;
  if (!scheduleStatsReady.value) return null;
  return scheduleCount.value.get(String(row.courseId)) ?? 0;
}

/** 「排课情况」列头悬浮说明：把"数据来源 + 能否排序"一次讲清，避免用户点了表头没反应却不知道为什么 */
const scheduleHeaderTitle = computed(() => {
  const base = scheduleStatsPartial.value
    ? '课次总数超出单次拉取上限，此处仅统计已拉取部分'
    : '按全部课次统计，放回待排的课次不计入';
  return canServerSort.value
    ? `${base}；点表头可按课次数排序`
    : `${base}；当前运行包不支持服务端排序，换包后可按课次数排序`;
});

async function loadTerms() {
  try {
    // ★ listTerms 的形参必填（BasicDataQuery），不传会类型报错；这里给一页足够用的量
    const res = await listTerms({ page: 1, pageSize: 50 });
    terms.value = (res?.list ?? [])
      .filter(t => t.name)
      .map(t => ({ termId: Number(t.termId ?? 0), name: String(t.name) }));
  } catch {
    /* 学期下拉是辅助筛选，拉不到不影响列表（可按关键词搜）；不打扰用户 */
    terms.value = [];
  }
}

/**
 * 列表取数
 * ----------------------------------------------------------------------------
 * 两种模式，按「有没有启用排课状态筛选」分流：
 *  A. 默认（不按排课筛）：服务端分页，与之前一致——数据量变大后这才是正解。
 *  B. 按排课状态筛：**只能本地筛**。原因是排课节次并不在课程列表接口里，
 *     而是本页用课次接口聚合出来的 Map（见上方排课情况注释）；服务端分页的 total
 *     是"全部 active 课程"的 total，拿它当筛选后的总数会直接把分页器画错。
 *     所以该模式下改为「一次拉回全量 active（受关键词/学期约束）→ 本地过滤 → 本地分页」。
 *     ⚠️ 失效条件：active 课程数超过 SCHEDULE_FILTER_FETCH_LIMIT 时只能筛到已拉部分，
 *     此时页脚会明确写出"仅在已拉取的 N 门内筛选"，不假装是全量结果。
 */
const SCHEDULE_FILTER_FETCH_LIMIT = 500;

async function fetchList() {
  loading.value = true;
  try {
    const base = {
      keyword: query.keyword.trim() || undefined,
      semester: query.semester || undefined,
      status: 'active' as const,
      // 排序：白名单外的值后端会静默回退 courseId desc，所以这里只在有值时才传
      orderBy: query.orderBy || undefined,
      orderDir: query.orderDir || undefined
    };
    if (query.scheduleState) {
      // 排课筛选的前提是"知道每门课的节次数"：新包行里直接带 scheduleCount，旧包才需要先聚合
      if (!serverHasScheduleCount.value && !scheduleStatsReady.value) {
        await loadScheduleCounts();
      }
      if (!serverHasScheduleCount.value && !scheduleStatsReady.value) {
        rows.value = [];
        total.value = 0;
        filterNote.value = '';
        loadError.value = '排课情况统计未取到，无法按排课状态筛选。可清空「排课情况」条件，或稍后重试。';
        return;
      }
      const res = await listCourses({ ...base, page: 1, pageSize: SCHEDULE_FILTER_FETCH_LIMIT });
      const all = res?.list ?? [];
      detectCapabilities(all);
      const onlyScheduled = query.scheduleState === 'scheduled';
      // 逐行判断：有新字段用字段（0 是合法的"未排课"），没有才查聚合 Map
      const countOf = (c: AdminCourseVo) =>
        typeof c.scheduleCount === 'number' ? c.scheduleCount : scheduleCount.value.get(String(c.courseId)) ?? 0;
      const filtered = all.filter((c) => (onlyScheduled ? countOf(c) > 0 : countOf(c) === 0));
      total.value = filtered.length;
      const start = (query.page - 1) * query.pageSize;
      rows.value = filtered.slice(start, start + query.pageSize);
      const serverTotal = res?.total ?? 0;
      filterNote.value =
        serverTotal > all.length
          ? `排课筛选仅在已拉取的 ${all.length} 门课内进行（共 ${serverTotal} 门，超出单次拉取上限 ${SCHEDULE_FILTER_FETCH_LIMIT}）`
          : `按排课情况筛选：${onlyScheduled ? '已排课' : '未排课'} ${filtered.length} 门`;
      loadError.value = '';
      return;
    }
    filterNote.value = '';
    const res = await listCourses({ ...base, page: query.page, pageSize: query.pageSize });
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
    detectCapabilities(rows.value);
    loadError.value = '';
  } catch {
    /* 失败必须清列表 + 归零总数，否则会留着上一次筛选的结果冒充本次结果 */
    rows.value = [];
    total.value = 0;
    filterNote.value = '';
    loadError.value = '课程列表加载失败：没有取到课程数据，可能是网络中断、后端服务未启动或登录状态已过期。';
  } finally {
    loading.value = false;
  }
}

/**
 * 版本探针：用"首行有没有 scheduleCount 这个 key"判断后端是不是 5edbfbb 之后的新包。
 * ★ 空列表不更新结论（没法判断），保留上一次结果 —— 否则筛选到空页会把能力误判成"旧包"，
 *   排序表头突然变灰、导出按钮突然不可用，看着像故障。
 */
function detectCapabilities(list: AdminCourseVo[]) {
  if (!list.length) return;
  serverHasScheduleCount.value = 'scheduleCount' in list[0];
}

/** 表头排序（服务端）：element 的 sort-change 给 { prop, order: 'ascending'|'descending'|null } */
function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  if (!canServerSort.value) return;
  if (!order || !prop) {
    query.orderBy = '';
    query.orderDir = '';
  } else {
    query.orderBy = prop as AdminCourseOrderBy;
    query.orderDir = order === 'ascending' ? 'asc' : 'desc';
  }
  query.page = 1;
  fetchList();
}

function onSearch() {
  query.page = 1;
  fetchList();
}

function resetQuery() {
  query.keyword = '';
  query.semester = '';
  query.scheduleState = '';
  query.orderBy = '';
  query.orderDir = '';
  query.page = 1;
  // 表头的排序箭头是 el-table 自己的状态，清 query 不会让它熄灭 —— 不调这个，
  // 会出现"箭头还亮着但数据已按默认序"的错位显示
  tableRef.value?.clearSort();
  fetchList();
}

/** 刷新：保留当前筛选与排序，重拉列表（新包不必再拉课次；旧包顺带刷新聚合） */
async function refreshAll() {
  await fetchList();
  if (!serverHasScheduleCount.value) void loadScheduleCounts();
}

/** 跳排课页并只看这门课。
 *  ★ 排课页（schedule/index.vue:612-624）**已支持** ?course=<courseId> 参数，
 *  它只在"切专业"时才校验并清空 courseId，本跳转不改专业 ⇒ 不会被清掉。不需要改排课页。 */
function goSchedule(row: AdminCourseVo) {
  void router.push({ path: '/admin/schedule', query: { course: String(row.courseId) } });
}

/* ================= 列设置（A-1）=================
 * 依据 Ant Design Pro / 通用数据表规范：次要列可以藏，**主键列（课程名称）不能藏**——
 * 藏掉标识列以后用户没法确认这一行是谁。选择存 localStorage，下次进来还是这套列。
 */
interface ColumnDef {
  key: string;
  label: string;
  locked?: boolean;
}
const COLUMN_DEFS: ColumnDef[] = [
  { key: 'courseCode', label: '课程代码' },
  { key: 'courseName', label: '课程名称', locked: true },
  { key: 'teacherName', label: '授课教师' },
  { key: 'semester', label: '学期' },
  { key: 'studentCount', label: '选课人数' },
  { key: 'status', label: '状态' },
  { key: 'scheduleCount', label: '排课情况' }
];
const COLUMN_STORAGE_KEY = 'zk_courses_columns';
const columnVisible = reactive<Record<string, boolean>>({});
COLUMN_DEFS.forEach((c) => { columnVisible[c.key] = true; });
const visibleColumnCount = computed(() => COLUMN_DEFS.filter((c) => columnVisible[c.key]).length);

function loadColumnPrefs() {
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, boolean>;
    for (const c of COLUMN_DEFS) {
      // locked 列一律强制可见：旧版本存过"名称隐藏"也要纠正回来
      if (c.locked) { columnVisible[c.key] = true; continue; }
      if (typeof saved[c.key] === 'boolean') columnVisible[c.key] = saved[c.key];
    }
  } catch {
    /* 存储内容坏了就当没存过，不影响使用 */
  }
}
function saveColumnPrefs() {
  try {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columnVisible));
  } catch {
    /* 隐私模式等写不进去：忽略，只影响"下次还记得" */
  }
}
loadColumnPrefs();

/* ================= 筛选条件 chips（A-2）=================
 * 筛完只剩几条时，用户最容易怀疑"数据是不是丢了"。把已生效条件摆成可逐个删除的 chip，
 * 一眼就知道"为什么少"。这是通用数据表规范里最常被提的一条。
 */
type FilterKey = 'keyword' | 'semester' | 'scheduleState';
interface FilterChip {
  key: FilterKey;
  label: string;
  text: string;
}
const SCHEDULE_STATE_TEXT: Record<string, string> = { scheduled: '已排课', unscheduled: '未排课' };
const activeFilterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = [];
  if (query.keyword.trim()) chips.push({ key: 'keyword', label: '关键词', text: query.keyword.trim() });
  if (query.semester) chips.push({ key: 'semester', label: '学期', text: query.semester });
  if (query.scheduleState) {
    chips.push({ key: 'scheduleState', label: '排课情况', text: SCHEDULE_STATE_TEXT[query.scheduleState] ?? query.scheduleState });
  }
  return chips;
});

/** 逐项去掉某个条件（不用整页重置，其它条件保留） */
function removeFilter(key: FilterKey) {
  query[key] = '';
  query.page = 1;
  fetchList();
}

/* ================= 骨架屏（A-3）=================
 * 只在"首次加载、还一条都没有"时显示：之后刷新要保留旧数据（v-loading 盖一层就够了），
 * 否则每点一次搜索整张表闪成骨架，比转圈更晃眼。
 */
const showSkeleton = computed(() => loading.value && rows.value.length === 0 && !loadError.value);
/** 骨架条的宽度比例，大致对应真实列宽（code/name/teacher/semester/status） */
const SKELETON_WIDTHS = ['9%', '24%', '13%', '11%', '10%'];

/* ================= 筛选视图（B-1）=================
 * 把"关键词 + 学期 + 排课情况 + 排序"存成一个命名视图，下次一键回到这个组合。
 * 存 localStorage：本项目没有"用户偏好"后端接口，不做跨设备同步（也不该假装做了）。
 */
interface FilterView {
  id: string;
  name: string;
  keyword: string;
  semester: string;
  scheduleState: string;
  orderBy: string;
  orderDir: string;
}
const VIEW_STORAGE_KEY = 'zk_courses_views';
const ORDER_BY_WHITELIST: AdminCourseOrderBy[] = ['semester', 'studentCount', 'scheduleCount'];
const savedViews = ref<FilterView[]>([]);

function loadViews() {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw) as FilterView[];
    savedViews.value = Array.isArray(arr) ? arr.filter((v) => v && v.id && v.name) : [];
  } catch {
    savedViews.value = [];
  }
}
function persistViews() {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(savedViews.value));
  } catch {
    /* 忽略 */
  }
}
loadViews();

async function saveCurrentView() {
  if (!activeFilterChips.value.length) {
    ElMessage.info('当前没有筛选条件，先设好条件再保存');
    return;
  }
  let name = '';
  try {
    const { value } = await ElMessageBox.prompt('给这个筛选组合起个名字，下次一键回到这套条件', '保存筛选视图', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：本学期未排课',
      inputValidator: (v: string) => (v && v.trim() ? true : '名字不能为空')
    });
    name = value.trim();
  } catch {
    return; // 用户取消
  }
  const exist = savedViews.value.find((v) => v.name === name);
  const payload: FilterView = {
    id: exist?.id ?? String(Date.now()),
    name,
    keyword: query.keyword,
    semester: query.semester,
    scheduleState: query.scheduleState,
    orderBy: query.orderBy,
    orderDir: query.orderDir
  };
  // 同名覆盖而不是堆一堆同名视图
  savedViews.value = exist ? savedViews.value.map((v) => (v.id === exist.id ? payload : v)) : [...savedViews.value, payload];
  persistViews();
  ElMessage.success(`已保存视图「${name}」`);
}

function applyView(v: FilterView) {
  query.keyword = v.keyword ?? '';
  query.semester = v.semester ?? '';
  query.scheduleState = v.scheduleState ?? '';
  // 白名单校验：视图是本地存的，可能来自旧版本或被手改，非法排序字段不能直接发给后端
  query.orderBy = ORDER_BY_WHITELIST.includes(v.orderBy as AdminCourseOrderBy) ? (v.orderBy as AdminCourseOrderBy) : '';
  query.orderDir = v.orderDir === 'asc' || v.orderDir === 'desc' ? v.orderDir : '';
  query.page = 1;
  fetchList();
}

async function deleteView(v: FilterView) {
  try {
    await ElMessageBox.confirm(`删除视图「${v.name}」？（只删这个保存的筛选组合，不动课程数据）`, '删除视图', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  savedViews.value = savedViews.value.filter((x) => x.id !== v.id);
  persistViews();
}

/* ================= 批量操作（B-2）=================
 * 规范要求：勾选后才出现批量栏、要显示已选数量，并且**必须说明哪些不可能处理**。
 * 本页的现实约束：后端 C-23 对"名下还有课次"的课程直接拒绝删除 ⇒
 * 勾中这类课程要提前说清，而不是等用户点了批量删除再逐条报错。
 */
const canRemove = computed(() => userStore.hasPermi('admin:courses:remove'));
const selectedRows = ref<AdminCourseVo[]>([]);
const batchDeleting = ref(false);
const selectedWithSchedule = computed(() => selectedRows.value.filter((r) => (scheduledCount(r) ?? 0) > 0));
const selectedDeletable = computed(() => selectedRows.value.filter((r) => (scheduledCount(r) ?? 0) === 0));

function onSelectionChange(sel: AdminCourseVo[]) {
  selectedRows.value = sel;
}
function clearSelection() {
  tableRef.value?.clearSelection();
  selectedRows.value = [];
}

async function batchDelete() {
  const blocked = selectedWithSchedule.value.length;
  const targets = selectedDeletable.value;
  if (!targets.length) {
    ElMessage.warning(blocked ? `选中的 ${blocked} 门课程都还有课次，需先到排课页移除课表后才能删除` : '请先勾选要删除的课程');
    return;
  }
  const tip = blocked
    ? `将删除 ${targets.length} 门；另有 ${blocked} 门因"仍有课次"会被跳过（需先去排课页移除）。删除为软删，可追溯。`
    : `将删除 ${targets.length} 门课程（软删，可追溯）。`;
  try {
    await ElMessageBox.confirm(tip, '批量删除', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' });
  } catch {
    return;
  }
  batchDeleting.value = true;
  let ok = 0;
  const failures: string[] = [];
  // 后端只有单条删除接口，逐条发但**逐条收集结果**：一次失败不影响其余
  for (const row of targets) {
    try {
      await deleteCourse(row.courseId);
      ok += 1;
    } catch (e) {
      failures.push(`${row.courseName}：${(e as Error)?.message ?? '删除失败'}`);
    }
  }
  batchDeleting.value = false;
  clearSelection();
  await fetchList();
  if (!serverHasScheduleCount.value) void loadScheduleCounts();
  if (failures.length) {
    // 部分失败必须说清是哪几门、为什么——只报"删除失败"等于没说
    ElMessage.warning(`成功 ${ok} 门，失败 ${failures.length} 门：${failures.slice(0, 3).join('；')}${failures.length > 3 ? ' 等' : ''}`);
  } else {
    ElMessage.success(`已删除 ${ok} 门课程`);
  }
}

/* ---------------- 导出（C-12b）----------------
 * 按**当前筛选条件**导出（与列表同口径），但注意：排课状态是前端本地筛出来的，
 * 后端不认这个条件 ⇒ 带排课筛选时导出的仍是"该关键词/学期下的全部课程"。
 * 这一点必须明说，否则用户会以为导出的就是屏幕上看到的那些行。
 */
const exporting = ref(false);

async function onExport() {
  if (!serverHasScheduleCount.value) {
    // 旧包没有这个端点：实测 POST 会返回 code:500「Request method 'POST' is not supported」，
    // 与其让用户看到这句后端原话，不如直接说明原因
    ElMessage.warning('当前运行包不支持课程导出，需后端换包后可用');
    return;
  }
  exporting.value = true;
  try {
    const blob = await exportCourses({
      keyword: query.keyword.trim() || undefined,
      semester: query.semester || undefined,
      status: 'active',
      orderBy: query.orderBy || undefined,
      orderDir: query.orderDir || undefined
    });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    saveBlob(blob, `课程清单-${stamp}.xlsx`);
    ElMessage.success(
      query.scheduleState
        ? '已导出：含当前关键词/学期条件下的全部课程（排课情况筛选不参与导出）'
        : '已导出当前筛选结果'
    );
  } catch {
    /* requestBlob 内部已经弹过具体原因（无权限/下载失败），这里不再重复提示 */
  } finally {
    exporting.value = false;
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- 详情抽屉 ---------------- */
const detailVisible = ref(false);
const detailCourse = ref<AdminCourseVo | null>(null);
const detail = ref<CertDetail | null>(null);
const detailLoading = ref(false);
/** 认证材料的缺失原因（历史课程没有认证记录是常态，不是错误） */
const detailNote = ref('');

async function openDetail(row: AdminCourseVo) {
  detailCourse.value = row;
  detail.value = null;
  detailNote.value = '';
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getCertDetail(Number(row.courseId));
  } catch {
    detailNote.value = '该课程没有可查的认证材料记录（历史课程或认证数据已归档），课程本身仍可正常使用。';
  } finally {
    detailLoading.value = false;
  }
}

/* ---------------- 删除课程（C-23）----------------
 * 后端语义：软删主记录 + 级联软删课次；但**课程名下还有课次时会拒绝**（要先去排课移除）。
 * 所以失败文案不能写死"删除失败"——把后端给的原因透出来，用户才知道先去排课页处理。
 */
const deleting = ref<string>('');

async function doDelete(row: AdminCourseVo) {
  const ok = await ElMessageBox.confirm(
    `确定删除课程「${row.courseName}」（${row.courseCode}）吗？删除后该课程与其课次记录将不再出现在管理端。若课程名下仍有课次，系统会拒绝删除，需先到「智能排课」移除课次。`,
    '删除课程',
    { type: 'warning', confirmButtonText: '确定删除' }
  ).catch(() => false);
  if (!ok) return;
  deleting.value = row.courseId;
  try {
    await deleteCourse(row.courseId);
    ElMessage.success(`已删除课程「${row.courseName}」`);
    // 删掉最后一条时回退一页，避免停在空页
    if (rows.value.length === 1 && query.page > 1) query.page -= 1;
    await fetchList();
  } catch {
    /* request.ts 已弹后端原话（如"课程下还有课次，请先移除"），这里不重复 */
  } finally {
    deleting.value = '';
  }
}

/* ---------------- 撤销通过（承接原「课程审核」页的重新驳回）----------------
 * 为什么搬到这里：审核页 10-29 起只承载待审队列，已通过的课程不在那儿了，
 * 「重新驳回」这个既有能力必须跟着课程一起移到课程总览，否则撤销通道就断了。
 * 口径与原实现完全一致（双重确认 + 必填原因）；后端 C-15 不校验当前状态可直接驳回，
 * reject 分支会把 course.status 从 active 回退为 certifying ⇒ 本页刷新后该课程消失。
 * certId 只能从 C-14 详情拿（课程列表不含 certId），所以撤销入口放在详情抽屉里。
 */
const revoking = ref(false);

async function revokeApprove() {
  const course = detailCourse.value;
  const cert = detail.value;
  if (!course) return;
  if (!cert?.certId) {
    ElMessage.warning('该课程没有可用的认证记录，无法撤销通过；如需下架请用「删除」');
    return;
  }
  let reason = '';
  try {
    const { value } = await ElMessageBox.prompt(
      '将驳回该课程全部三项认证，教师需修改后重新提审。请输入驳回原因：',
      '撤销通过（驳回）',
      {
        confirmButtonText: '下一步',
        cancelButtonText: '取消',
        inputPlaceholder: '驳回原因（必填）',
        inputValidator: (v: string) => (v && v.trim().length > 0 ? true : '驳回原因不能为空')
      }
    );
    reason = value.trim();
  } catch {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `最终确认：课程「${course.courseName}」将退回「认证中」，已解锁的备课同步收回。确定执行？`,
      '最终确认',
      { type: 'warning', confirmButtonText: '确认驳回', cancelButtonText: '再想想' }
    );
  } catch {
    return;
  }
  revoking.value = true;
  try {
    await reviewCertification(cert.certId, { action: 'reject', rejectReason: reason });
    ElMessage.success(`已撤销通过：课程「${course.courseName}」已退回「认证中」`);
    detailVisible.value = false;
    // 该课程 status 已回退，本页固定查 active ⇒ 重查后自然消失
    await fetchList();
  } catch {
    /* request.ts 已提示后端原话 */
  } finally {
    revoking.value = false;
  }
}

onMounted(async () => {
  void loadTerms();
  // 先拿列表：首行的 scheduleCount 决定要不要再拉课次聚合。
  // 新包（有字段）省掉一次 pageSize=1000 的课次请求；旧包才需要自算。
  await fetchList();
  if (!serverHasScheduleCount.value) void loadScheduleCounts();
});
</script>

<template>
  <div class="page-head">
    <h1>课程总览</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="$router.push('/admin/review')">
        <ZkIcon name="badge-check" :size="16" />课程审核
      </a>
    </div>
  </div>

  <div class="toolbar">
    <!-- 列表级操作（刷新）：只重拉数据，不动当前筛选与排序。
         放在工具栏左侧，避免和右侧筛选条件混成一片 -->
    <div class="left">
      <el-button
        class="tb-icon"
        :loading="loading"
        title="刷新列表（保留当前筛选与排序）"
        @click="refreshAll"
      >
        <ZkIcon v-if="!loading" name="refresh-cw" :size="15" />
      </el-button>
      <!-- 列设置：次要列可藏、主键列锁定；选择存 localStorage -->
      <el-popover placement="bottom-start" :width="200" trigger="click">
        <template #reference>
          <el-button class="tb-icon" title="列设置（选择要显示的列）">
            <ZkIcon name="list-checks" :size="15" />
          </el-button>
        </template>
        <div class="col-set">
          <div class="col-set-title">显示列（{{ visibleColumnCount }}/{{ COLUMN_DEFS.length }}）</div>
          <label v-for="c in COLUMN_DEFS" :key="c.key" class="col-set-item">
            <el-checkbox
              v-model="columnVisible[c.key]"
              :disabled="c.locked"
              @change="saveColumnPrefs"
            />
            <span>{{ c.label }}</span>
            <span v-if="c.locked" class="col-set-lock">必显</span>
          </label>
        </div>
      </el-popover>
      <!-- 筛选视图：把当前条件组合存下来，下次一键回到 -->
      <el-popover placement="bottom-start" :width="260" trigger="click">
        <template #reference>
          <el-button class="tb-icon" title="筛选视图（保存 / 应用筛选组合）">
            <ZkIcon name="book-open" :size="15" />
          </el-button>
        </template>
        <div class="view-set">
          <div class="col-set-title">筛选视图</div>
          <div v-if="!savedViews.length" class="small muted" style="padding: 6px 0">
            还没有保存的视图。设好筛选条件后点下面按钮存下来。
          </div>
          <div v-for="v in savedViews" :key="v.id" class="view-row">
            <a class="view-name" href="javascript:void(0)" @click="applyView(v)">{{ v.name }}</a>
            <a class="view-del" href="javascript:void(0)" title="删除该视图" @click="deleteView(v)">删除</a>
          </div>
          <el-button size="small" style="margin-top: 8px; width: 100%" @click="saveCurrentView">
            保存当前筛选为视图
          </el-button>
        </div>
      </el-popover>
    </div>
    <div class="right" style="gap: 10px">
      <el-input
        v-model="query.keyword"
        placeholder="课程名称 / 课程代码"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-select
        v-model="query.semester"
        placeholder="全部学期"
        clearable
        filterable
        style="width: 160px"
        :disabled="!termOptionsReady"
        @change="onSearch"
      >
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="t.name" />
      </el-select>
      <!-- 排课情况筛选（10-29 新增）：与「排课情况」列同源，都基于课次聚合 -->
      <el-select
        v-model="query.scheduleState"
        placeholder="全部排课情况"
        clearable
        style="width: 140px"
        @change="onSearch"
      >
        <el-option label="已排课" value="scheduled" />
        <el-option label="未排课" value="unscheduled" />
      </el-select>
      <el-button type="primary" class="tb-btn tb-btn-main" @click="onSearch">
        <ZkIcon name="search" :size="15" style="margin-right: 4px" />搜索
      </el-button>
      <!-- 重置：与搜索同高同宽同圆角。Element Plus 会给相邻 el-button 加 margin-left:12px，
           和 .right 的 gap:10px 叠加后两者间距变成 22px（其它控件只有 10px），已在样式里清零 -->
      <el-button class="tb-btn tb-btn-reset" @click="resetQuery">
        <ZkIcon name="refresh-cw" :size="15" style="margin-right: 4px" />重置
      </el-button>
      <!-- 导出（C-12b）：按当前关键词/学期/排序导出。★ 排课情况筛选是前端本地筛，
           后端不认 ⇒ 带该条件时导出的是"该关键词/学期下的全部课程"，提示里会明说 -->
      <el-button v-if="canExport" class="tb-btn tb-btn-export" :loading="exporting" @click="onExport">
        <ZkIcon name="file-text" :size="15" style="margin-right: 4px" />导出
      </el-button>
    </div>
  </div>

  <!-- 已生效的筛选条件：可逐个移除。少了这一行，用户看到"只剩 3 条"会怀疑数据丢了 -->
  <div v-if="activeFilterChips.length" class="filter-chips">
    <span class="chips-label">已筛选</span>
    <span v-for="c in activeFilterChips" :key="c.key" class="chip">
      {{ c.label }}：{{ c.text }}
      <a class="chip-x" href="javascript:void(0)" title="移除该条件" @click="removeFilter(c.key)">×</a>
    </span>
    <a class="chips-clear" href="javascript:void(0)" @click="resetQuery">清空全部</a>
  </div>

  <div class="card">
    <!-- 失败态与空态分开画，理由同账号页：空表这一种视觉不能同时承载"没数据"和"没取到" -->
    <div v-if="loadError" class="load-fail" role="alert">
      <ZkIcon name="alert-triangle" :size="16" />
      <span class="load-fail-text">{{ loadError }}</span>
      <el-button text :loading="loading" @click="fetchList()">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="14" style="margin-right: 4px" />重新加载
      </el-button>
    </div>
    <!-- 骨架屏覆盖层与表格同容器：首次加载时表格已挂载但数据为空，
         用骨架盖住比整块空白更稳（不会在数据回来时整体跳一下） -->
    <div class="tbl-wrap">
      <el-table
        ref="tableRef"
        v-loading="loading && !showSkeleton"
        row-key="courseId"
        :data="rows"
        max-height="calc(100vh - 320px)"
        style="width: 100%"
        @sort-change="onSortChange"
        @selection-change="onSelectionChange"
      >
        <!-- 勾选列只对"能删"的人显示：没权限却摆勾选框，用户会以为能批量操作 -->
        <el-table-column v-if="canRemove" type="selection" width="44" fixed="left" />
        <el-table-column v-if="columnVisible.courseCode" label="课程代码" width="100" prop="courseCode" fixed="left">
          <template #default="{ row }">{{ row.courseCode || '—' }}</template>
        </el-table-column>
        <!-- 名称可能很长（如「小程序教师端测试课程1」）：规范要求超长以 … 省略、悬停看全文 -->
        <el-table-column v-if="columnVisible.courseName" label="课程名称" min-width="170" prop="courseName" show-overflow-tooltip>
          <template #default="{ row }">
            <!-- 主键列做成可点链接（Ant Design Pro 的标准做法）：点名称直接看详情，
                 比每次往右挪到「查看」快；右上角「查看」保留，两处入口不冲突 -->
            <a class="course-link" href="javascript:void(0)" @click="openDetail(row)">{{ row.courseName }}</a>
          </template>
        </el-table-column>
        <el-table-column v-if="columnVisible.teacherName" label="授课教师" width="110" prop="teacherName">
          <template #default="{ row }">{{ row.teacherName || '—' }}</template>
        </el-table-column>
        <el-table-column
          v-if="columnVisible.semester"
          label="学期"
          width="110"
          prop="semester"
          :sortable="canServerSort ? 'custom' : false"
        >
          <template #default="{ row }">{{ row.semester || '—' }}</template>
        </el-table-column>
        <el-table-column
          v-if="columnVisible.studentCount"
          label="选课人数"
          width="90"
          align="center"
          prop="studentCount"
          :sortable="canServerSort ? 'custom' : false"
        >
          <template #default="{ row }">{{ row.studentCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column v-if="columnVisible.status" label="状态" width="90">
          <template #default="{ row }">
            <span class="badge" :class="statusBadge(row.status)">{{ statusLabel(row.status) }}</span>
          </template>
        </el-table-column>
        <!-- 排课情况：三种状态必须可辨：— = 统计没拿到 / 未排课 = 真的 0 节 / N 节 = 已排 -->
        <el-table-column
          v-if="columnVisible.scheduleCount"
          width="130"
          align="center"
          prop="scheduleCount"
          :sortable="canServerSort ? 'custom' : false"
        >
          <template #header>
            <span :title="scheduleHeaderTitle">排课情况</span>
          </template>
          <template #default="{ row }">
            <span v-if="scheduledCount(row) === null" class="muted small">—</span>
            <!-- 未排课给直达入口：这列最常见的用途就是"挑一门没排的课去排" -->
            <div v-else-if="scheduledCount(row) === 0" class="sched-cell">
              <span class="badge badge-neutral">未排课</span>
              <a class="sched-link" href="javascript:void(0)" @click="goSchedule(row)">去排课</a>
            </div>
            <!-- 已排课也能点进去看课表：原来只有未排课能跳，想看已排的反而没入口 -->
            <a v-else class="sched-link" href="javascript:void(0)" @click="goSchedule(row)">
              <span class="badge badge-info">{{ scheduledCount(row) }} 节</span>
            </a>
          </template>
        </el-table-column>
        <!-- 操作列冻结：规范要求"数据列无法一屏展示时操作列默认冻结"，
             否则窗口一窄就只剩半截「查看」（10-29 实测过 1280 下被裁） -->
        <el-table-column label="操作" width="150" align="right" fixed="right" class-name="courses-op">
          <template #default="{ row }">
            <el-button text size="small" @click="openDetail(row)">
              <ZkIcon name="eye" :size="14" style="margin-right: 3px" />查看
            </el-button>
            <el-button
              v-if="canRemove"
              text
              size="small"
              style="color: var(--error)"
              :loading="deleting === row.courseId"
              @click="doDelete(row)"
            >删除</el-button>
          </template>
        </el-table-column>
        <!-- 空态说明"为什么空 + 去哪看"：本页只列已通过课程，用户最容易误以为课程丢了 -->
        <template #empty>
          <div class="empty-block">
            <ZkIcon name="book-open" :size="26" />
            <div class="empty-title">{{ loadError ? '数据未取到' : hasFilter ? '当前筛选条件下没有课程' : '还没有审核通过的课程' }}</div>
            <div v-if="loadError" class="small muted">原因见上方提示条，也可点下方按钮重试。</div>
            <div v-else-if="hasFilter" class="small muted">
              已通过审核的课程可能被关键词/学期/排课情况条件排除了，清空条件即可看到全部。
            </div>
            <div v-else class="small muted">课程在「课程审核」通过后才会出现在这里。</div>
            <div class="empty-actions">
              <el-button v-if="loadError" size="small" @click="fetchList">
                <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />重新加载
              </el-button>
              <template v-else-if="hasFilter">
                <el-button size="small" @click="resetQuery">
                  <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />清空筛选
                </el-button>
              </template>
              <el-button v-else size="small" type="primary" @click="router.push('/admin/review')">
                <ZkIcon name="badge-check" :size="14" style="margin-right: 4px" />去课程审核
              </el-button>
            </div>
          </div>
        </template>
      </el-table>

      <!-- 首次加载骨架：行数/列宽按真实列比例摆，数据回来时位置基本不跳 -->
      <div v-if="showSkeleton" class="tbl-skeleton" aria-hidden="true">
        <div class="sk-head">
          <span v-for="(w, i) in SKELETON_WIDTHS" :key="'h' + i" class="sk-cell" :style="{ width: w }"></span>
        </div>
        <div v-for="r in 6" :key="'r' + r" class="sk-row">
          <span v-for="(w, i) in SKELETON_WIDTHS" :key="'c' + i" class="sk-cell" :style="{ width: w }"></span>
        </div>
      </div>
    </div>

    <!-- 批量操作栏：勾选后才出现。规范要求必须显示"已选数量"和"哪些不可能处理"，
         否则用户会以为点了就该全删掉，结果发现少了几条却不知道为什么 -->
    <div v-if="canRemove && selectedRows.length" class="batch-bar">
      <span class="batch-count">已选 <b>{{ selectedRows.length }}</b> 门</span>
      <span v-if="selectedWithSchedule.length" class="batch-warn">
        其中 {{ selectedWithSchedule.length }} 门仍有课次，删除会被跳过（需先到排课页移除）
      </span>
      <span v-else class="batch-ok">均可删除</span>
      <div class="batch-actions">
        <el-button size="small" @click="clearSelection">取消选择</el-button>
        <el-button
          size="small"
          type="danger"
          :loading="batchDeleting"
          :disabled="!selectedDeletable.length"
          @click="batchDelete"
        >删除所选（{{ selectedDeletable.length }}）</el-button>
      </div>
    </div>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">
        <template v-if="loadError">记录数未取到（加载失败）</template>
        <template v-else>共 {{ total }} 门已通过课程</template>
        <!-- 总数口径说明：按排课筛时 total 是本地过滤后的数，与后端 total 不同，必须写明 -->
        <span v-if="filterNote" class="filter-note">{{ filterNote }}</span>
      </span>
      <!-- layout 必须含 sizes：改前只写 prev/pager/next，`:page-sizes` 虽然配了但选择器压根不渲染，
           用户无法改每页条数（属于"配了参数却没生效"的静默缺陷） -->
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        @current-change="fetchList"
        @size-change="onSearch"
      />
    </div>
  </div>

  <!-- 详情抽屉：课程基本信息 + 认证材料（材料缺失只降级说明，不当错误） -->
  <el-drawer v-model="detailVisible" :title="detailCourse?.courseName ?? '课程详情'" size="460px">
    <div v-if="detailCourse" class="stack" style="gap: 14px">
      <div class="pf-grid">
        <div class="pf-row"><span class="k">课程代码</span><span>{{ detailCourse.courseCode || '—' }}</span></div>
        <div class="pf-row"><span class="k">授课教师</span><span>{{ detailCourse.teacherName || '—' }}</span></div>
        <div class="pf-row"><span class="k">学期</span><span>{{ detailCourse.semester || '—' }}</span></div>
        <div class="pf-row"><span class="k">选课人数</span><span>{{ detailCourse.studentCount ?? 0 }}</span></div>
        <div class="pf-row">
          <span class="k">状态</span>
          <span class="badge" :class="statusBadge(detailCourse.status)">{{ statusLabel(detailCourse.status) }}</span>
        </div>
        <div class="pf-row">
          <span class="k">排课情况</span>
          <span>
            <template v-if="scheduledCount(detailCourse) === null">—</template>
            <template v-else-if="scheduledCount(detailCourse) === 0">未排课</template>
            <template v-else>已排 {{ scheduledCount(detailCourse) }} 节</template>
          </span>
        </div>
      </div>

      <div>
        <div class="section-title">认证材料</div>
        <div v-loading="detailLoading">
          <template v-if="detail">
            <!-- C-14 出参只有 certStatus + aiSuggestion（没有逐材料的 aiDecision，那在 materials[].aiResult） -->
            <div class="small muted" style="margin-bottom: 8px">
              审核结论：{{ detail.certStatus === 'approved' ? '已通过' : detail.certStatus === 'rejected' ? '已驳回' : detail.certStatus || '—' }}
              <span v-if="detail.aiSuggestion">　AI 初审：{{ detail.aiSuggestion }}</span>
            </div>
            <div v-if="(detail.materials ?? []).length" class="stack" style="gap: 8px">
              <div v-for="m in detail.materials" :key="m.materialId" class="material-row">
                <ZkIcon :name="m.type === 'video' ? 'video' : m.type === 'doc' ? 'file-text' : 'table'" :size="15" />
                <div>
                  <div style="font-weight: 600">{{ m.title || m.type }}</div>
                  <div v-if="m.desc" class="small muted">{{ m.desc }}</div>
                </div>
              </div>
            </div>
            <div v-else class="small muted">该课程认证记录下没有材料明细。</div>
          </template>
          <div v-else-if="!detailLoading" class="small muted">{{ detailNote || '无认证材料记录' }}</div>
        </div>
      </div>
    </div>
    <template #footer>
      <!-- 只在确认该课程确实处于已通过状态时给撤销入口，避免对没有认证记录的历史课误点 -->
      <el-button
        v-if="detail?.certStatus === 'approved'"
        type="warning"
        plain
        :loading="revoking"
        @click="revokeApprove"
      >撤销通过（驳回）</el-button>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
/* 失败提示条与空态块：与账号页同款视觉（同类语义在不同页应长得一样） */
.load-fail {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--danger-100, #fbe3e1);
  background: var(--danger-50, #fef6f5);
  color: var(--danger-600, #d54941);
  font-size: 13px;
}
.load-fail-text {
  flex: 1;
  min-width: 0;
  line-height: 1.6;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  color: var(--ink-400, #9aa3b2);
  line-height: 1.7;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #3a4256);
}
/* 空态里的下一步按钮：与说明文字留出距离，避免和正文黏在一起 */
.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 筛选区按钮组（10-29 业主反馈：搜索与重置间隔过大、大小不一样）
   1) 间隔：Element Plus 对相邻 el-button 默认 margin-left:12px，与 .right 的 gap:10px
      叠加成 22px，而其它控件之间只有 10px ⇒ 归零，整行间距统一 10px。
   2) 大小：两个按钮实测都是 78×32，但默认按钮边框是浅灰（#dcdfe6），
      衬得它比实心主按钮"窄一圈"。统一 min-width/height，并给重置更实的描边。 */
.toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}
.toolbar :deep(.tb-btn) {
  min-width: 78px;
  height: 32px;
  padding: 0 15px;
  border-radius: var(--r-md, 8px);
  font-size: 14px;
  box-sizing: border-box;
}
.toolbar :deep(.tb-btn-reset) {
  border-color: var(--border-strong, #cbd5e1);
  color: var(--ink-700, #3a4256);
}
.toolbar :deep(.tb-btn-reset:hover) {
  border-color: var(--brand-400, #7aa7f8);
  color: var(--brand-600, #2563eb);
  background: var(--brand-50, #eff6ff);
}
/* 导出：与重置同为次级按钮，仅图标换成文件图标；不做成主色，避免和「搜索」抢注意力 */
.toolbar .left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toolbar :deep(.tb-icon) {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--r-md, 8px);
  border-color: var(--border-strong, #cbd5e1);
  color: var(--ink-600, #475569);
}
.toolbar :deep(.tb-icon:hover) {
  border-color: var(--brand-400, #7aa7f8);
  color: var(--brand-600, #2563eb);
  background: var(--brand-50, #eff6ff);
}
/* 操作列两个文字按钮必须同排。列收窄后（1280 下要腾出排课列的位置）
   默认 white-space:normal 会把「删除」挤到第二行，行高直接翻倍。 */
:deep(.courses-op .cell) {
  white-space: nowrap;
}
/* 主键列（课程名称）做成链接样式：蓝色 + 悬停下划线，表明"可以点进去"，
   不能只靠加粗——加粗在表格里更像"强调"而不是"可点击" */
.course-link {
  font-weight: 600;
  color: var(--brand-600, #2563eb);
  text-decoration: none;
}
.course-link:hover {
  text-decoration: underline;
}
/* 未排课单元格：徽标 + 直达链接并排 */
.sched-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.sched-link {
  font-size: 12.5px;
  color: var(--brand-600, #2563eb);
  text-decoration: none;
  white-space: nowrap;
}
.sched-link:hover {
  text-decoration: underline;
}
/* 页脚的总数口径说明：换行显示，不挤掉右侧分页器 */
.filter-note {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--ink-400, #9aa3b2);
}
/* ---------- 筛选条件 chips ---------- */
.filter-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -6px 0 12px;
  padding: 0 2px;
}
.chips-label {
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--brand-200, #d6e4ff);
  border-radius: 999px;
  background: var(--brand-50, #eff6ff);
  color: var(--brand-700, #1d4ed8);
  font-size: 12px;
  line-height: 1.6;
}
.chip-x {
  color: var(--brand-600, #2563eb);
  text-decoration: none;
  font-size: 13px;
  line-height: 1;
}
.chip-x:hover {
  color: var(--error, #dc2626);
}
.chips-clear {
  font-size: 12px;
  color: var(--ink-500, #64748b);
  text-decoration: none;
}
.chips-clear:hover {
  color: var(--brand-600, #2563eb);
  text-decoration: underline;
}
/* ---------- 列设置 / 筛选视图 弹层 ---------- */
.col-set-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-700, #3a4256);
  margin-bottom: 8px;
}
.col-set-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 13px;
  color: var(--ink-700, #3a4256);
  cursor: pointer;
}
.col-set-lock {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-300, #b8c0cf);
}
.view-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--border, #eef1f6);
}
.view-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--brand-600, #2563eb);
  text-decoration: none;
}
.view-name:hover {
  text-decoration: underline;
}
.view-del {
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
  text-decoration: none;
}
.view-del:hover {
  color: var(--error, #dc2626);
}
/* ---------- 骨架屏 ---------- */
.tbl-wrap {
  position: relative;
}
.tbl-skeleton {
  position: absolute;
  inset: 0;
  padding: 0 16px;
  background: #fff;
  z-index: 3;
}
.sk-head,
.sk-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.sk-head {
  height: 40px;
  border-bottom: 1px solid var(--border, #eef1f6);
}
.sk-row {
  height: 48px;
  border-bottom: 1px solid var(--border, #eef1f6);
}
.sk-cell {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(90deg, #eef1f6 25%, #f6f8fb 37%, #eef1f6 63%);
  background-size: 400% 100%;
  animation: sk-shimmer 1.4s ease infinite;
}
@keyframes sk-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}
@media (prefers-reduced-motion: reduce) {
  .sk-cell { animation: none; }
}
/* ---------- 批量操作栏 ----------
 * 用 fixed 悬浮而不是 sticky：sticky 仍占文档流，会把表格撑高、
 * 看起来像"表格里多了一行"（10-29 第一版就是这个问题）。
 * 左偏移 +100px 是因为左侧导航固定 200px，纯 50% 会偏左。 */
.batch-bar {
  position: fixed;
  left: calc(50% + 100px);
  transform: translateX(-50%);
  bottom: 24px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(880px, calc(100vw - 280px));
  padding: 10px 14px;
  border: 1px solid var(--brand-200, #d6e4ff);
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  font-size: 13px;
}
.batch-count b {
  color: var(--brand-600, #2563eb);
}
/* fixed 定位时宽度由内容 shrink-to-fit，flex 子项会被压窄：
 * "已选 1 门"被折成两行就是这里没锁 nowrap 导致的 */
.batch-count,
.batch-warn,
.batch-ok {
  white-space: nowrap;
}
.batch-warn {
  color: var(--warn-700, #8a6116);
}
.batch-ok {
  color: var(--success-700, #15803d);
}
.batch-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex: none;
}
.pf-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-100, #f6f7fa);
}
.pf-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.pf-row .k {
  color: var(--ink-400, #9aa3b2);
  flex: none;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-700, #3a4256);
  margin-bottom: 8px;
}
.material-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line, #eceef3);
  border-radius: 8px;
  font-size: 13px;
}
</style>
