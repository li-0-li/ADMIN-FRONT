<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  createClazz,
  createClassroom,
  createDept,
  createMajor,
  createSchool,
  createTerm,
  deleteClazz,
  deleteClassroom,
  deleteDept,
  deleteMajor,
  deleteSchool,
  deleteTerm,
  listClasses,
  listClassrooms,
  listMajors,
  listSchools,
  listTerms,
  updateClazz,
  updateClassroom,
  updateDept,
  updateMajor,
  updateSchool,
  updateTerm
} from '@/api/admin/basicdata';
import { listDeptTree, listUsers, type DeptNodeVo } from '@/api/admin/users';
import type { BasicDataQuery } from '@/types/admin';

/* ---------------- tab 定义（与原型 admin-basicdata.html 的 8 个 pill 一致） ---------------- */
type TabKey = 'school' | 'dept' | 'major' | 'teacher' | 'clazz' | 'student' | 'term' | 'room';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'school', label: '学校' },
  { key: 'dept', label: '院系' },
  { key: 'major', label: '专业' },
  { key: 'teacher', label: '教师' },
  { key: 'clazz', label: '班级' },
  { key: 'student', label: '学生' },
  { key: 'term', label: '学期' },
  { key: 'room', label: '教室' }
];

/**
 * 只读 tab 提示位（B1 已落地：后端 10-30 补授 system:dept:*（103/1016~1019 → role 100），
 * 院系 tab 已切到写路径。此结构留给未来可能出现的缺口 tab 复用。
 */
const READ_ONLY_TABS: Partial<Record<TabKey, string>> = {};

const active = ref<TabKey>('school');

/* ---------------- 通用列表状态 ---------------- */
const loading = ref(false);
const rows = ref<Record<string, unknown>[]>([]);

/**
 * 各 tab 的数据源是不同接口（学校/专业/班级/学期/账号），返回的具体类型各异且**不带索引签名**，
 * 无法直接赋给表格用的 Record<string, unknown>[]（表格按 c.prop 动态取值，只能走索引）。
 * 这里统一收口，避免每处报警告。
 */
const asRows = (list: unknown) => (list ?? []) as Record<string, unknown>[];
const total = ref(0);
const query = reactive<BasicDataQuery>({ page: 1, pageSize: 10, keyword: '' });

const STATUS_TEXT: Record<string, string> = { active: '启用', inactive: '停用', '0': '启用', '1': '停用' };
const STATUS_CLS: Record<string, string> = { active: 'badge-success', inactive: 'badge-neutral', '0': 'badge-success', '1': 'badge-neutral' };
const statusLabel = (v: unknown) => STATUS_TEXT[String(v)] ?? String(v ?? '—');
const statusCls = (v: unknown) => STATUS_CLS[String(v)] ?? 'badge-neutral';
const STATUS_OPTIONS = [
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' }
];
/** 院系走若依原生口径：'0' 正常 / '1' 停用（statusLabel/statusCls 已兼容这两个值） */
const DEPT_STATUS_OPTIONS = [
  { value: '0', label: '正常' },
  { value: '1', label: '停用' }
];

/* ---------------- 筛选（用户 11-02 拍板：前端全量本地过滤 + 下拉 + chips） ----------------
 * 后端 BasicDataQueryBo 只认 keyword，状态/关联筛选要等 B2 ⇒ 各域量级实测个位数~几十条，
 * 进 tab 拉一次全量（pageSize=1000）在本地过滤，分页也本地切。数据涨到千级再切服务端。
 * school 保持服务端分页（用户明确不加筛选）；teacher/student 是账号接口（量大），同样不开放。 */
const FILTER_TABS: TabKey[] = ['dept', 'major', 'clazz', 'term', 'room'];

type FilterDef = { prop: string; label: string; optionsKey?: 'majors' | 'schools' | 'depts'; options?: { value: string; label: string }[] };
const FILTER_FIELDS: Partial<Record<TabKey, FilterDef[]>> = {
  dept: [{ prop: 'status', label: '状态', options: DEPT_STATUS_OPTIONS }],
  major: [
    { prop: 'deptId', label: '所属院系', optionsKey: 'depts' },
    { prop: 'status', label: '状态', options: STATUS_OPTIONS }
  ],
  clazz: [
    { prop: 'schoolId', label: '学校', optionsKey: 'schools' },
    { prop: 'majorId', label: '所属专业', optionsKey: 'majors' },
    { prop: 'gradeYear', label: '年级' /* options 由全量数据派生（fetchList 里填 gradeOptions） */ },
    { prop: 'status', label: '状态', options: STATUS_OPTIONS }
  ],
  term: [
    { prop: 'schoolId', label: '学校', optionsKey: 'schools' },
    { prop: 'isCurrent', label: '当前学期', options: [{ value: '1', label: '是' }, { value: '0', label: '否' }] },
    { prop: 'status', label: '状态', options: STATUS_OPTIONS }
  ],
  room: [
    { prop: 'schoolId', label: '学校', optionsKey: 'schools' },
    { prop: 'status', label: '状态', options: STATUS_OPTIONS }
  ]
};

const gradeOptions = ref<{ value: string; label: string }[]>([]);
/** 每个 tab 独立记忆筛选（切 tab 不清，回来还在；会话级，不落 localStorage） */
const filters = reactive<Partial<Record<TabKey, Record<string, string>>>>({});

function setFilter(prop: string, v: string) {
  const cur = filters[active.value] ?? (filters[active.value] = {});
  if (v) cur[prop] = v;
  else delete cur[prop];
  query.page = 1;
  fetchList();
}
function clearFilters() {
  filters[active.value] = {};
  query.page = 1;
  fetchList();
}

const activeFilterDefs = computed<FilterDef[]>(() => FILTER_FIELDS[active.value] ?? []);
const filterOptions = (d: FilterDef) => d.options ?? (d.optionsKey ? dynamicOptions(d.optionsKey) : []);
const activeChips = computed(() =>
  activeFilterDefs.value
    .map(d => {
      const v = filters[active.value]?.[d.prop] ?? '';
      if (!v) return null;
      const opt = filterOptions(d).find(o => o.value === v);
      return { prop: d.prop, label: d.label, text: opt?.label ?? v };
    })
    .filter((x): x is { prop: string; label: string; text: string } => x !== null)
);
const hasActiveFilters = computed(() => activeChips.value.length > 0);

/** 筛选下拉的关联数据（depts/majors/schools）进 tab 就备好，不等首次点开 */
function ensureFilterOptions() {
  (FILTER_FIELDS[active.value] ?? []).forEach(d => {
    if (d.optionsKey) OPTION_LOADERS[d.optionsKey]();
  });
}

/** 各 tab 拉全量（导出用 pageSize=1000；院系走树接口，本地按关键词过滤） */
async function fetchTab(tab: TabKey, q: BasicDataQuery): Promise<{ list: Record<string, unknown>[]; total: number }> {
  if (tab === 'school') {
    const r = await listSchools(q);
    return { list: asRows(r?.list), total: r?.total ?? 0 };
  }
  if (tab === 'major' || tab === 'clazz' || tab === 'term' || tab === 'room') {
    // 全量拉取（筛选/关键词/分页全在本地，见 applyLocalFilters；fetchList 传 page=1&pageSize=1000）
    const loaders = { major: listMajors, clazz: listClasses, term: listTerms, room: listClassrooms } as const;
    const r = await loaders[tab]({ page: 1, pageSize: 1000 });
    const list = asRows(r?.list);
    return { list, total: list.length };
  }
  if (tab === 'teacher' || tab === 'student') {
    // 教师 / 学生复用账号接口，按角色键过滤（量大，保持服务端分页，不开放本地筛选）
    const r = await listUsers({ page: q.page, pageSize: q.pageSize, keyword: q.keyword, roleKey: tab });
    return { list: asRows(r?.list), total: r?.total ?? 0 };
  }
  // dept：若依原生院系树。行里**保留原生全字段**（parentId/orderNum/leader/phone/email），
  // 编辑回显与保存都要用；parentName 只是展示用的派生列。
  // 这里只出平铺全量：关键词/状态过滤与树形组装统一在 fetchList 做（导出与列表共用同一过滤口径）。
  const res = await listDeptTree();
  if (!res.ok) return { list: [], total: 0 };
  const all = res.list.filter(d => d.delFlag !== '2');
  const nameById = new Map(all.map(d => [String(d.deptId), d.deptName]));
  const flat = all.map(d => ({
    ...d,
    deptId: String(d.deptId),
    parentName: nameById.get(String(d.parentId ?? '')) ?? '—',
    children: [] as Record<string, unknown>[]
  }));
  return { list: flat, total: flat.length };
}

/** 本地过滤（FILTER_TABS 共用口径：列表分页与 CSV 导出同一份结果）。
 *  关键词匹配业务名/编码；筛选项 String 归一比较（isCurrent 1/0、状态 active 与 '0' 口径不同，各自匹配） */
function applyLocalFilters(list: Record<string, unknown>[]): Record<string, unknown>[] {
  const kw = (query.keyword ?? '').trim();
  const f = filters[active.value] ?? {};
  return list.filter(row => {
    if (kw) {
      const hay = [row.name, row.deptName, row.clazzName, row.code, row.clazzCode, row.majorCode].filter(Boolean).join(' ');
      if (!hay.includes(kw)) return false;
    }
    for (const [k, v] of Object.entries(f)) {
      if (!v) continue;
      if (String(row[k] ?? '') !== String(v)) return false;
    }
    return true;
  });
}

async function fetchList() {
  loading.value = true;
  try {
    const tab = active.value;
    const serverPaginated = !FILTER_TABS.includes(tab);
    const r = await fetchTab(tab, { ...query, ...(serverPaginated ? {} : { page: 1, pageSize: 1000, keyword: '' }) });
    if (serverPaginated) {
      rows.value = r.list;
      total.value = r.total;
      return;
    }
    if (tab === 'clazz') {
      // 年级筛选项从全量数据派生（年级取值随录入变化，不写死）
      gradeOptions.value = [...new Set(r.list.map(x => x.gradeYear).filter(v => v !== undefined && v !== null && v !== ''))]
        .map(v => ({ value: String(v), label: `${v} 级` }))
        .sort((a, b) => Number(a.value) - Number(b.value));
    }
    const filtered = applyLocalFilters(r.list);
    total.value = filtered.length;
    if (tab === 'dept') {
      const treeMode = !(query.keyword ?? '').trim() && !Object.values(filters[tab] ?? {}).some(Boolean);
      if (treeMode) {
        // 树形：只把根交给表格，子级挂 children（total 用平铺计数，上方已设）
        const byId = new Map(filtered.map(d => [String(d.deptId), d]));
        const roots: Record<string, unknown>[] = [];
        filtered.forEach(d => {
          const parent = byId.get(String(d.parentId ?? ''));
          if (parent && parent !== d) (parent.children as unknown[]).push(d);
          else roots.push(d);
        });
        rows.value = roots;
      } else {
        // 过滤态平铺：命中行的父级未必命中，树形会断链；剥掉空 children 防无意义展开箭头
        rows.value = filtered.map(({ children: _c, ...rest }) => rest);
      }
      return;
    }
    const start = ((query.page ?? 1) - 1) * (query.pageSize ?? 10);
    rows.value = filtered.slice(start, start + (query.pageSize ?? 10));
  } finally {
    loading.value = false;
  }
}

function switchTab(key: TabKey) {
  active.value = key;
  query.page = 1;
  query.keyword = '';
  ensureFilterOptions();
  fetchList();
}

function onSearch() {
  query.page = 1;
  fetchList();
}

/** 重置 = 清关键词 + 回第一页（保留当前 tab，与课程总览页的「重置」口径一致） */
function resetQuery() {
  query.keyword = '';
  query.page = 1;
  fetchList();
}

onMounted(() => {
  ensureFilterOptions();
  fetchList();
});

/* ---------------- 增删改（只对有接口的 tab 开放；院系只读） ---------------- */
const CRUD_TABS: TabKey[] = ['school', 'dept', 'major', 'clazz', 'term', 'room'];
const canCrud = computed(() => CRUD_TABS.includes(active.value));

/** 各 CRUD tab 的主键字段名（删除/编辑都要用，收口一处避免五处各写一份） */
const CRUD_ID_KEYS: Record<string, string> = { school: 'schoolId', dept: 'deptId', major: 'majorId', clazz: 'clazzId', term: 'termId', room: 'classroomId' };

/**
 * 旧包探测（能力检测，判据用 typeof 而不是值比较）：
 * 10-28 eb3400b 后端才把基础数据主键 @JsonFormat(STRING) 字符串化；更早的运行包
 * 返回的是**裸 19 位数字**，JSON.parse 阶段就已经截断（> Number.MAX_SAFE_INTEGER）。
 * 表现特征：id 字段是 number 且 !Number.isSafeInteger —— 旧包+小自增 id（安全整数）不误报，
 * 新包（string）也不误报。命中时编辑/删除会定位到错误 id，必须停用并提示换包。
 */
const idsCorrupted = computed(() =>
  rows.value.some(r => {
    const v = r[CRUD_ID_KEYS[active.value]];
    return typeof v === 'number' && !Number.isSafeInteger(v);
  })
);

/* ---------------- 表单（动态关联下拉：专业/学校，数据现成接口拉一次缓存） ---------------- */
const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const saving = ref(false);
const form = reactive<Record<string, unknown>>({});

const majorOptions = ref<{ value: string; label: string }[]>([]);
const schoolOptions = ref<{ value: string; label: string }[]>([]);
const deptOptions = ref<{ value: string; label: string }[]>([]);
const OPTION_LOADERS: Record<string, () => Promise<void>> = {
  depts: async () => {
    if (deptOptions.value.length) return;
    const res = await listDeptTree();
    if (res.ok) deptOptions.value = res.list.map(d => ({ value: String(d.deptId), label: d.deptName }));
  },
  majors: async () => {
    if (majorOptions.value.length) return;
    const r = await listMajors({ page: 1, pageSize: 500 });
    majorOptions.value = asRows(r?.list).map(m => ({ value: String(m.majorId), label: String(m.name ?? m.majorId) }));
  },
  schools: async () => {
    if (schoolOptions.value.length) return;
    const r = await listSchools({ page: 1, pageSize: 500 });
    schoolOptions.value = asRows(r?.list).map(s => ({ value: String(s.schoolId), label: String(s.name ?? s.schoolId) }));
  }
};

type FormField = {
  prop: string;
  label: string;
  type?: 'select' | 'date' | 'number';
  options?: { value: string; label: string }[];
  /** 动态下拉：渲染时从 OPTION_LOADERS 缓存取，避免 FORM_FIELDS 里写死数据 */
  optionsKey?: 'majors' | 'schools' | 'depts';
};

const FORM_FIELDS: Record<string, FormField[]> = {
  school: [
    { prop: 'name', label: '学校名称' },
    { prop: 'code', label: '学校编码' },
    { prop: 'domain', label: '域名' },
    { prop: 'bindMode', label: '绑定方式', type: 'select', options: [{ value: 'auto', label: '自动' }, { value: 'manual', label: '人工' }] },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  dept: [
    { prop: 'deptName', label: '院系名称' },
    { prop: 'parentId', label: '上级部门', type: 'select', optionsKey: 'depts' },
    { prop: 'orderNum', label: '显示顺序', type: 'number' },
    { prop: 'leader', label: '负责人' },
    { prop: 'phone', label: '联系电话' },
    { prop: 'email', label: '邮箱' },
    { prop: 'status', label: '状态', type: 'select', options: DEPT_STATUS_OPTIONS }
  ],
  major: [
    { prop: 'name', label: '专业名称' },
    { prop: 'majorCode', label: '专业编码' },
    // 后端 createMajor 硬校验 deptId 必填（「所属院系不能为空」）——2026-11-02 探针实测发现，
    // 上轮补班级关联字段时漏了专业这个必填项
    { prop: 'deptId', label: '所属院系', type: 'select', optionsKey: 'depts' },
    { prop: 'sortNo', label: '排序号', type: 'number' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  clazz: [
    { prop: 'clazzName', label: '班级名称' },
    { prop: 'clazzCode', label: '班级编码' },
    { prop: 'schoolId', label: '所属学校', type: 'select', optionsKey: 'schools' },
    { prop: 'majorId', label: '所属专业', type: 'select', optionsKey: 'majors' },
    { prop: 'gradeYear', label: '年级', type: 'number' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  term: [
    { prop: 'name', label: '学期名称' },
    { prop: 'code', label: '学期编码' },
    { prop: 'schoolId', label: '所属学校', type: 'select', optionsKey: 'schools' },
    { prop: 'startDate', label: '开始日期', type: 'date' },
    { prop: 'endDate', label: '结束日期', type: 'date' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  room: [
    { prop: 'name', label: '教室名称' },
    { prop: 'code', label: '教室编码' },
    { prop: 'schoolId', label: '所属学校', type: 'select', optionsKey: 'schools' },
    { prop: 'roomType', label: '类型', type: 'select', options: [{ value: 'physical', label: '物理教室' }, { value: 'virtual', label: '虚拟教室' }] },
    { prop: 'capacity', label: '容纳人数', type: 'number' },
    { prop: 'location', label: '位置' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ]
};

const currentFields = computed(() =>
  (FORM_FIELDS[active.value] ?? []).map(f => {
    if (!f.optionsKey) return f;
    let options = f.options ?? dynamicOptions(f.optionsKey);
    // 上级部门下拉排除自己：把自己选成自己的父级会造出环，若依后端不一定拦
    if (f.prop === 'parentId' && form.deptId !== undefined && form.deptId !== null && form.deptId !== '') {
      options = options.filter(o => o.value !== String(form.deptId));
    }
    return { ...f, options };
  })
);
const dynamicOptions = (key: 'majors' | 'schools' | 'depts') =>
  key === 'majors' ? majorOptions.value : key === 'schools' ? schoolOptions.value : deptOptions.value;

async function openCreate() {
  // 关联下拉数据先备齐再开弹窗，避免弹窗里下拉是空的
  const keys = (FORM_FIELDS[active.value] ?? []).map(f => f.optionsKey).filter(Boolean) as ('majors' | 'schools')[];
  await Promise.all([...new Set(keys)].map(k => OPTION_LOADERS[k]()));
  formMode.value = 'create';
  const init: Record<string, unknown> = {};
  currentFields.value.forEach(f => {
    init[f.prop] = f.type === 'select' ? (f.options?.[0]?.value ?? '') : f.type === 'number' ? 0 : '';
  });
  if (active.value === 'school') init.schoolId = undefined;
  Object.keys(form).forEach(k => delete form[k]);
  Object.assign(form, init);
  formVisible.value = true;
}

async function openEdit(row: Record<string, unknown>) {
  const keys = (FORM_FIELDS[active.value] ?? []).map(f => f.optionsKey).filter(Boolean) as ('majors' | 'schools')[];
  await Promise.all([...new Set(keys)].map(k => OPTION_LOADERS[k]()));
  formMode.value = 'edit';
  Object.keys(form).forEach(k => delete form[k]);
  Object.assign(form, JSON.parse(JSON.stringify(row)));
  // 日期字段归一化到 YYYY-MM-DD：后端实返 "2026-08-24 00:00:00"，与 el-date-picker 的
  // value-format 不一致，不截的话回显解析不稳、原样保存还会把时分秒带回后端
  currentFields.value.forEach(f => {
    if (f.type === 'date' && typeof form[f.prop] === 'string') form[f.prop] = (form[f.prop] as string).slice(0, 10);
  });
  formVisible.value = true;
}

async function submitForm() {
  saving.value = true;
  try {
    if (active.value === 'school') {
      formMode.value === 'create' ? await createSchool({ ...form }) : await updateSchool({ ...form });
    } else if (active.value === 'major') {
      formMode.value === 'create' ? await createMajor({ ...form }) : await updateMajor({ ...form });
    } else if (active.value === 'dept') {
      formMode.value === 'create' ? await createDept({ ...form }) : await updateDept({ ...form });
    } else if (active.value === 'clazz') {
      formMode.value === 'create' ? await createClazz({ ...form }) : await updateClazz({ ...form });
    } else if (active.value === 'term') {
      formMode.value === 'create' ? await createTerm({ ...form }) : await updateTerm({ ...form });
    } else if (active.value === 'room') {
      formMode.value === 'create' ? await createClassroom({ ...form }) : await updateClassroom({ ...form });
    }
    ElMessage.success(formMode.value === 'create' ? '新增成功' : '保存成功');
    formVisible.value = false;
    fetchList();
  } finally {
    saving.value = false;
  }
}

/* ---------------- 批量删除（前端循环版：B3 端点未落地前的替代，量级小够用） ---------------- */
const tableRef = ref<{ clearSelection: () => void } | null>(null);
const selectionRows = ref<Record<string, unknown>[]>([]);
function onSelectionChange(rows: Record<string, unknown>[]) {
  // dept 树形域无 selection 列（级联风险，见模板注释）；这里兜底防串台
  selectionRows.value = active.value === 'dept' ? [] : rows;
}

/** 逐条循环删除：串行而不是并行——单条失败要能继续走完并给完整清单 */
async function doBatchDelete() {
  const n = selectionRows.value.length;
  if (!n) return;
  await ElMessageBox.confirm(
    `确定要删除所选的 ${n} 条记录吗？基础数据删除为软删；个别记录可能因存在引用（如院系下仍有用户）而失败，失败项会跳过并在结果里说明。`,
    '批量删除',
    { type: 'warning', confirmButtonText: '全部删除' }
  );
  let ok = 0;
  const fails: string[] = [];
  for (const row of selectionRows.value) {
    const rawId = row[CRUD_ID_KEYS[active.value]];
    const id =
      typeof rawId === 'string' && rawId ? rawId
      : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId)
      : null;
    if (!id) {
      fails.push(`${String(row.name ?? row.deptName ?? row.clazzName ?? '未知')}: 主键缺失（${idsCorrupted.value ? '运行包过旧' : '数据异常'}）`);
      continue;
    }
    const name = String(row.name ?? row.deptName ?? row.clazzName ?? row.code ?? id);
    try {
      if (active.value === 'school') await deleteSchool(id);
      else if (active.value === 'dept') await deleteDept(id);
      else if (active.value === 'major') await deleteMajor(id);
      else if (active.value === 'clazz') await deleteClazz(id);
      else if (active.value === 'term') await deleteTerm(id);
      else if (active.value === 'room') await deleteClassroom(id);
      ok++;
    } catch (e) {
      fails.push(`${name}: ${(e as Error)?.message?.slice(0, 60) ?? '删除失败'}`);
    }
  }
  if (fails.length) {
    ElMessageBox.alert(
      `成功 ${ok} 条，失败 ${fails.length} 条：\n${fails.join('\n')}`.replace(/\n/g, '<br>'),
      '批量删除结果',
      { dangerouslyUseHTMLString: true, type: 'warning', confirmButtonText: '知道了' }
    ).catch(() => {});
  } else {
    ElMessage.success(`已删除 ${ok} 条`);
  }
  tableRef.value?.clearSelection();
  fetchList();
}

async function doDelete(row: Record<string, unknown>) {
  // 主键保持后端原样（string）：历史版本在这里 Number(row.id) 强转，
  // 19 位雪花 id 截断后拼进 URL，删除打到不存在的记录上——这是编号 68 之外本页真正的 P1。
  // 旧包返回的小自增 id（安全整数）仍放行，只有真被截断的才拦下。
  const rawId = row[CRUD_ID_KEYS[active.value]];
  const id =
    typeof rawId === 'string' && rawId ? rawId
    : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId)
    : null;
  if (!id) {
    ElMessage.warning('该行缺少有效主键，无法删除' + (idsCorrupted.value ? '（运行包过旧，需换包）' : ''));
    return;
  }
  const name = String(row.name ?? row.deptName ?? row.clazzName ?? row.code ?? id);
  await ElMessageBox.confirm(`确定要删除「${name}」吗？`, '删除', { type: 'warning', confirmButtonText: '删除' });
  if (active.value === 'school') await deleteSchool(id);
  else if (active.value === 'dept') await deleteDept(id);
  else if (active.value === 'major') await deleteMajor(id);
  else if (active.value === 'clazz') await deleteClazz(id);
  else if (active.value === 'term') await deleteTerm(id);
  else if (active.value === 'room') await deleteClassroom(id);
  ElMessage.success('已删除');
  fetchList();
}

/* ---------------- 列定义 ---------------- */
type Col = {
  prop: string;
  label: string;
  render?: (row: Record<string, unknown>) => string;
  badge?: (row: Record<string, unknown>) => string;
  /** 名称列：可点开只读详情抽屉（A2），渲染为主链接样式并冻结首列 */
  link?: boolean;
  align?: 'right' | 'center';
};

const columns = computed<Col[]>(() => {
  switch (active.value) {
    case 'school':
      return [
        { prop: 'name', label: '学校名称', link: true },
        { prop: 'code', label: '编码' },
        { prop: 'domain', label: '域名' },
        { prop: 'bindMode', label: '绑定方式', badge: r => (String(r.bindMode) === 'auto' ? 'badge-brand' : 'badge-neutral'), render: r => (String(r.bindMode) === 'auto' ? '自动' : '人工') },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'dept':
      return [
        { prop: 'deptName', label: '院系名称', link: true },
        { prop: 'deptId', label: '编号', align: 'center' },
        { prop: 'parentName', label: '上级院系' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'major':
      return [
        { prop: 'name', label: '专业名称', link: true },
        { prop: 'majorCode', label: '专业编码' },
        { prop: 'sortNo', label: '排序号', align: 'right' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'clazz':
      return [
        { prop: 'clazzName', label: '班级名称', link: true },
        { prop: 'clazzCode', label: '班级编码' },
        { prop: 'majorName', label: '所属专业' },
        { prop: 'gradeYear', label: '年级', align: 'right' },
        { prop: 'studentCount', label: '学生数', align: 'right' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'term':
      return [
        { prop: 'name', label: '学期名称', link: true },
        { prop: 'code', label: '学期编码' },
        { prop: 'startDate', label: '开始日期' },
        { prop: 'endDate', label: '结束日期' },
        { prop: 'isCurrent', label: '当前学期', align: 'center', render: r => (Number(r.isCurrent) === 1 ? '是' : '否') },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'room':
      return [
        { prop: 'name', label: '教室名称', link: true },
        { prop: 'code', label: '教室编码' },
        { prop: 'roomType', label: '类型', render: r => (String(r.roomType) === 'virtual' ? '虚拟教室' : '物理教室') },
        { prop: 'capacity', label: '容纳人数', align: 'right' },
        { prop: 'location', label: '位置' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'teacher':
      return [
        { prop: 'username', label: '登录账号' },
        { prop: 'nickName', label: '姓名', link: true },
        { prop: 'email', label: '邮箱' },
        { prop: 'deptName', label: '所属院系' },
        { prop: 'createTime', label: '创建时间' }
      ];
    case 'student':
      return [
        { prop: 'username', label: '登录账号' },
        { prop: 'nickName', label: '姓名', link: true },
        { prop: 'email', label: '邮箱' },
        { prop: 'deptName', label: '所属院系' },
        { prop: 'createTime', label: '创建时间' }
      ];
    default:
      return [];
  }
});

/* ---------------- A4 列设置（显隐记忆，名称列锁定显示） ---------------- */
const COLS_STORE_KEY = 'zk_basicdata_columns';
const hiddenCols = ref<Record<string, string[]>>(readColsStore());

function readColsStore(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_STORE_KEY) ?? '{}');
    return typeof raw === 'object' && raw ? raw : {};
  } catch {
    return {};
  }
}
function persistCols() {
  localStorage.setItem(COLS_STORE_KEY, JSON.stringify(hiddenCols.value));
}
const visibleColumns = computed(() => {
  const hidden = hiddenCols.value[active.value] ?? [];
  return columns.value.filter(c => c.link || !hidden.includes(c.prop));
});
function toggleCol(prop: string, show: boolean) {
  const cur = hiddenCols.value[active.value] ?? [];
  const next = show ? cur.filter(p => p !== prop) : [...cur, prop];
  hiddenCols.value = { ...hiddenCols.value, [active.value]: next };
  persistCols();
}
function resetCols() {
  hiddenCols.value = { ...hiddenCols.value, [active.value]: [] };
  persistCols();
}

/* ---------------- A2 详情抽屉（只读，复用列定义取值） ---------------- */
const detailVisible = ref(false);
const detailRow = ref<Record<string, unknown> | null>(null);
const detailTitle = ref('');
function openDetail(row: Record<string, unknown>) {
  detailRow.value = row;
  const nameCol = columns.value.find(c => c.link);
  detailTitle.value = nameCol ? String(nameCol.render?.(row) ?? row[nameCol.prop] ?? '') : '详情';
  detailVisible.value = true;
}

/* ---------------- A3 本地 CSV 导出（当前 tab + 关键词，最多 1000 行） ---------------- */
const exporting = ref(false);
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportCsv() {
  exporting.value = true;
  try {
    // 与列表同口径：FILTER_TABS 走「全量 + 本地关键词/筛选」，school/teacher/student 走服务端
    const local = FILTER_TABS.includes(active.value);
    const r = await fetchTab(active.value, { ...query, ...(local ? { page: 1, pageSize: 1000, keyword: '' } : {}) });
    const list = local ? applyLocalFilters(r.list) : r.list;
    const cols = columns.value;
    const head = cols.map(c => csvCell(c.label)).join(',');
    const body = list.map(row => cols.map(c => csvCell(c.render ? c.render(row) : (row[c.prop] ?? ''))).join(','));
    const csv = '\uFEFF' + [head, ...body].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const tabLabel = TABS.find(t => t.key === active.value)?.label ?? active.value;
    a.download = `基础数据-${tabLabel}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    ElMessage.success(`已导出 ${list.length} 条（含当前关键词与筛选条件，上限 1000）`);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="page-head">
    <h1>基础数据</h1>
    <div class="actions">
      <el-button text :loading="exporting" @click="exportCsv">
        <ZkIcon name="download" :size="15" style="margin-right: 4px" />导出 CSV
      </el-button>
      <!-- ⚠️ 院系不提供批量删除：el-table 树形勾选父行会级联勾选全部子孙（探针实测：点 1 行 → 选中整棵树
           → 5 个叶子部门被连带软删）。树形域语义复杂且后端对「有下级/有用户」本就拒绝，批量无收益纯风险。 -->
      <el-button v-if="canCrud && active !== 'dept' && selectionRows.length" style="color: var(--error)" @click="doBatchDelete">
        <ZkIcon name="trash-2" :size="15" style="margin-right: 4px" />删除所选（{{ selectionRows.length }}）
      </el-button>
      <el-button v-if="canCrud" type="primary" @click="openCreate">
        <ZkIcon name="plus" :size="15" style="margin-right: 4px" />新增
      </el-button>
    </div>
  </div>

  <div class="toolbar">
    <span class="pilltabs">
      <span
        v-for="t in TABS"
        :key="t.key"
        class="pill"
        :class="{ active: active === t.key }"
        @click="switchTab(t.key)"
        >{{ t.label }}</span
      >
    </span>
    <div class="right">
      <el-input v-model="query.keyword" placeholder="关键词" clearable style="width: 180px" @keyup.enter="onSearch" @clear="onSearch" />
      <el-button text @click="onSearch">查询</el-button>
      <el-button text @click="resetQuery">重置</el-button>
      <!-- A4 列设置：名称列锁定显示，其余列显隐记忆到 localStorage -->
      <el-popover placement="bottom-end" :width="200" trigger="click">
        <template #reference>
          <el-button text circle title="列设置"><ZkIcon name="settings" :size="16" /></el-button>
        </template>
        <div class="col-set">
          <div class="small muted" style="margin-bottom: 6px">显示列（名称列固定显示）</div>
          <el-checkbox
            v-for="c in columns"
            :key="c.prop"
            :model-value="c.link || !(hiddenCols[active] ?? []).includes(c.prop)"
            :disabled="c.link"
            @change="(v: any) => toggleCol(c.prop, Boolean(v))"
            >{{ c.label }}</el-checkbox
          >
          <div style="margin-top: 8px; text-align: right">
            <el-button text size="small" @click="resetCols">恢复默认</el-button>
          </div>
        </div>
      </el-popover>
    </div>
  </div>

  <!-- 筛选条（FILTER_TABS 前端本地过滤；school/教师/学生不开放。改任意下拉即查询并回第一页） -->
  <div v-if="activeFilterDefs.length" class="filter-bar">
    <span class="small muted">筛选</span>
    <el-select
      v-for="d in activeFilterDefs"
      :key="d.prop"
      :model-value="filters[active]?.[d.prop] ?? ''"
      :placeholder="'全部' + d.label"
      clearable
      style="width: 132px"
      @change="(v: unknown) => setFilter(d.prop, String(v ?? ''))"
    >
      <el-option v-for="o in filterOptions(d)" :key="o.value" :label="o.label" :value="o.value" />
    </el-select>
  </div>

  <!-- 已生效的筛选条件 chips（课程总览页同款交互）：可逐个移除，「清空全部」一键重置 -->
  <div v-if="activeChips.length" class="filter-chips">
    <span class="chips-label">已筛选</span>
    <span v-for="c in activeChips" :key="c.prop" class="chip">
      {{ c.label }}：{{ c.text }}
      <a class="chip-x" href="javascript:void(0)" title="移除该条件" @click="setFilter(c.prop, '')">×</a>
    </span>
    <a class="chips-clear" href="javascript:void(0)" @click="clearFilters">清空全部</a>
  </div>

  <!-- 旧运行包警示：主键被 JSON.parse 截断，写路径不可用（能力检测，换包后自动消失） -->
  <div v-if="idsCorrupted" class="ids-warn">
    <strong>编辑 / 删除暂不可用：</strong>当前运行包（10-26）返回的 19 位主键已被截断，直接操作会定位到错误记录。需发布线换新包（10-28 之后的构建）后自动恢复，列表查看不受影响。
  </div>

  <div class="card">
    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="rows"
      style="width: 100%"
      max-height="calc(100vh - 360px)"
      :row-key="active === 'dept' ? 'deptId' : undefined"
      :tree-props="active === 'dept' ? { children: 'children' } : undefined"
      default-expand-all
      @selection-change="onSelectionChange"
    >
      <!-- 批量删除选择列（A1 序号列 + A5 首列冻结） -->
      <el-table-column v-if="canCrud && active !== 'dept'" type="selection" width="42" align="center" fixed="left" />
      <el-table-column type="index" label="#" width="56" align="center" fixed="left" />
      <el-table-column v-for="c in visibleColumns" :key="c.prop" :label="c.label" :prop="c.prop" min-width="130" :align="c.align" :fixed="c.link ? 'left' : undefined">
        <template #default="{ row }">
          <span v-if="c.badge" class="badge" :class="c.badge(row)">{{ c.render ? c.render(row) : row[c.prop] }}</span>
          <a v-else-if="c.link" class="name-link" href="javascript:void(0)" @click="openDetail(row)">{{ c.render ? c.render(row) : (row[c.prop] ?? '—') }}</a>
          <span v-else>{{ c.render ? c.render(row) : (row[c.prop] ?? '—') }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="canCrud" label="操作" width="150" align="right" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" :disabled="idsCorrupted" @click="openEdit(row)">编辑</el-button>
          <el-button text size="small" style="color: var(--error)" :disabled="idsCorrupted" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted small" style="padding: 18px 0">
          <template v-if="active === 'teacher' || active === 'student'">暂无数据（数据源＝账号接口按角色过滤）</template>
          <template v-else-if="query.keyword || hasActiveFilters">没有匹配当前{{ query.keyword ? '关键词' : '筛选条件' }}的记录</template>
          <template v-else>
            暂无数据
            <el-button v-if="canCrud" text type="primary" size="small" @click="openCreate">去新增</el-button>
          </template>
        </div>
      </template>
    </el-table>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">
        共 {{ total }} 条记录<template v-if="hasActiveFilters || query.keyword">（已按当前条件过滤）</template>
        <span v-if="active === 'teacher' || active === 'student'">（数据来自账号接口，按角色过滤）</span>
        <span v-else-if="active === 'dept'">（来自若依组织架构 sys_dept，删除前须先清空该院系下的用户）</span>
      </span>
      <el-pagination
        v-if="active !== 'dept'"
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="prev, pager, next"
        @current-change="fetchList"
      />
    </div>
  </div>

  <!-- A2 只读详情抽屉：字段取自当前 tab 的列定义（render 后的业务语言） -->
  <el-drawer v-model="detailVisible" :title="detailTitle" size="420px">
    <div v-if="detailRow" class="detail-list">
      <div v-for="c in columns" :key="c.prop" class="detail-item">
        <span class="detail-label">{{ c.label }}</span>
        <span v-if="c.badge" class="badge" :class="c.badge(detailRow)">{{ c.render ? c.render(detailRow) : detailRow[c.prop] }}</span>
        <span v-else>{{ c.render ? c.render(detailRow) : (detailRow[c.prop] ?? '—') }}</span>
      </div>
      <div v-if="detailRow.remark" class="detail-item">
        <span class="detail-label">备注</span><span>{{ detailRow.remark }}</span>
      </div>
      <div v-if="detailRow.createTime" class="detail-item">
        <span class="detail-label">创建时间</span><span>{{ detailRow.createTime }}</span>
      </div>
    </div>
  </el-drawer>

  <el-dialog v-model="formVisible" :title="formMode === 'create' ? '新增' : '编辑'" width="440px">
    <el-form label-width="88px" label-position="left">
      <el-form-item v-for="f in currentFields" :key="f.prop" :label="f.label">
        <el-select v-if="f.type === 'select'" v-model="form[f.prop]" style="width: 100%">
          <el-option v-for="o in f.options" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-date-picker
          v-else-if="f.type === 'date'"
          v-model="form[f.prop]"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
        <el-input-number v-else-if="f.type === 'number'" v-model="form[f.prop]" style="width: 100%" />
        <el-input v-else v-model="form[f.prop]" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 编号 68：EP 分页器「当前页」实测是两层规则叠加——
   ① background-color: var(--el-color-primary)（桥接 = --brand-600 #0d9488）
   ② color: var(--el-pagination-hover-color)（默认又指回 --el-color-primary）
   ⇒ brand-600 字压 brand-600 底，纯函数对比 1.0（台账里记的 3.74 是按白底口径算的另一处）。
   确定性覆盖：--brand-700 底 + 白字 = 5.48:1（编号 42 对同一组色复算过 5.47），过 AA。
   只覆盖本页；analytics / courses / logs 同根因，全局修属共享样式批次，另行派单。 */
:deep(.el-pagination .el-pager li.is-active) {
  background-color: var(--brand-700);
  color: #fff;
}

/* 「查询/重置」两个文字按钮：EP 默认 .el-button+.el-button{margin-left:12px} 叠加 .right 的 gap:10px
   会变成 22px（课程总览页修过的同一处坑），归零交给 gap 管 */
.toolbar .right :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* 8 个 tab pill + 搜索框一行放不下（1024/1080 视口实测溢出），允许换行；
   pill 胶囊组自身也可换行，避免在窄视口被压出容器 */
.toolbar {
  flex-wrap: wrap;
}
.toolbar .pilltabs {
  flex-wrap: wrap;
}

/* 旧包警示条 / 院系只读提示：用 warning 文字专用深阶保证 AA */
.ids-warn {
  border: 1px solid var(--warning);
  background: var(--warning-soft);
  color: var(--warning-strong);
  border-radius: var(--r-lg);
  padding: 10px 16px;
  font-size: 13px;
  margin-bottom: 16px;
}

/* A2 名称链接：主色加深一档保证白底对比度，hover 出下划线 */
.name-link {
  color: var(--brand-700);
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.name-link:hover {
  text-decoration: underline;
}

/* 详情抽屉键值对 */
.detail-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.detail-item {
  display: flex;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
}
.detail-label {
  flex: 0 0 76px;
  color: var(--ink-500);
}
.detail-item > span:last-child {
  color: var(--ink-900);
  word-break: break-all;
}

/* 筛选条（FILTER_TABS 前端本地过滤） */
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

/* 已生效筛选 chips（与课程总览页同款视觉） */
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
  color: var(--ink-400);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--brand-200);
  border-radius: 999px;
  background: var(--brand-50);
  color: var(--brand-700);
  font-size: 12px;
  line-height: 1.6;
}
.chip-x {
  color: var(--brand-600);
  text-decoration: none;
  font-size: 13px;
  line-height: 1;
}
.chip-x:hover {
  color: var(--error);
}
.chips-clear {
  font-size: 12px;
  color: var(--ink-500);
  text-decoration: none;
}
.chips-clear:hover {
  color: var(--brand-600);
  text-decoration: underline;
}

/* 列设置弹层 */
.col-set {
  display: flex;
  flex-direction: column;
}
</style>
