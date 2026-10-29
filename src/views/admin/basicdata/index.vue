<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  createClazz,
  createClassroom,
  createMajor,
  createSchool,
  createTerm,
  deleteClazz,
  deleteClassroom,
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
  updateMajor,
  updateSchool,
  updateTerm
} from '@/api/admin/basicdata';
import { listUsers } from '@/api/admin/users';
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

/** 后端未提供接口的 tab（按缺口处理，不做假数据）。教室已随 C-21 补齐（2026-10-15），院系仍缺口 */
const GAP_TABS: Partial<Record<TabKey, string>> = {
  dept: '院系'
};

const active = ref<TabKey>('school');
const isGap = computed(() => Boolean(GAP_TABS[active.value]));

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

async function fetchList() {
  if (isGap.value) {
    rows.value = [];
    total.value = 0;
    return;
  }
  loading.value = true;
  try {
    const q: BasicDataQuery = { ...query };
    if (active.value === 'school') {
      const r = await listSchools(q);
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    } else if (active.value === 'major') {
      const r = await listMajors(q);
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    } else if (active.value === 'clazz') {
      const r = await listClasses(q);
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    } else if (active.value === 'term') {
      const r = await listTerms(q);
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    } else if (active.value === 'room') {
      const r = await listClassrooms(q);
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    } else if (active.value === 'teacher' || active.value === 'student') {
      // 教师 / 学生复用账号接口，按角色键过滤
      const r = await listUsers({ page: q.page, pageSize: q.pageSize, keyword: q.keyword, roleKey: active.value });
      rows.value = asRows(r?.list);
      total.value = r?.total ?? 0;
    }
  } finally {
    loading.value = false;
  }
}

function switchTab(key: TabKey) {
  active.value = key;
  query.page = 1;
  query.keyword = '';
  fetchList();
}

function onSearch() {
  query.page = 1;
  fetchList();
}

onMounted(fetchList);

/* ---------------- 增删改（只对有接口的 tab 开放） ---------------- */
const CRUD_TABS: TabKey[] = ['school', 'major', 'clazz', 'term', 'room'];
const canCrud = computed(() => CRUD_TABS.includes(active.value));

const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const saving = ref(false);
const form = reactive<Record<string, unknown>>({});

const FORM_FIELDS: Record<string, { prop: string; label: string; type?: 'select' | 'date' | 'number'; options?: { value: string; label: string }[] }[]> = {
  school: [
    { prop: 'name', label: '学校名称' },
    { prop: 'code', label: '学校编码' },
    { prop: 'domain', label: '域名' },
    { prop: 'bindMode', label: '绑定方式', type: 'select', options: [{ value: 'auto', label: '自动' }, { value: 'manual', label: '人工' }] },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  major: [
    { prop: 'name', label: '专业名称' },
    { prop: 'majorCode', label: '专业编码' },
    { prop: 'sortNo', label: '排序号', type: 'number' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  clazz: [
    { prop: 'clazzName', label: '班级名称' },
    { prop: 'clazzCode', label: '班级编码' },
    { prop: 'gradeYear', label: '年级', type: 'number' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  term: [
    { prop: 'name', label: '学期名称' },
    { prop: 'code', label: '学期编码' },
    { prop: 'startDate', label: '开始日期', type: 'date' },
    { prop: 'endDate', label: '结束日期', type: 'date' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ],
  room: [
    { prop: 'name', label: '教室名称' },
    { prop: 'code', label: '教室编码' },
    { prop: 'roomType', label: '类型', type: 'select', options: [{ value: 'physical', label: '物理教室' }, { value: 'virtual', label: '虚拟教室' }] },
    { prop: 'capacity', label: '容纳人数', type: 'number' },
    { prop: 'location', label: '位置' },
    { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS }
  ]
};

const currentFields = computed(() => FORM_FIELDS[active.value] ?? []);

function openCreate() {
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

function openEdit(row: Record<string, unknown>) {
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

async function doDelete(row: Record<string, unknown>) {
  const idKey: Record<string, string> = { school: 'schoolId', major: 'majorId', clazz: 'clazzId', term: 'termId', room: 'classroomId' };
  const id = Number(row[idKey[active.value]]);
  const name = String(row.name ?? row.clazzName ?? row.code ?? id);
  await ElMessageBox.confirm(`确定要删除「${name}」吗？`, '删除', { type: 'warning', confirmButtonText: '删除' });
  if (active.value === 'school') await deleteSchool(id);
  else if (active.value === 'major') await deleteMajor(id);
  else if (active.value === 'clazz') await deleteClazz(id);
  else if (active.value === 'term') await deleteTerm(id);
  else if (active.value === 'room') await deleteClassroom(id);
  ElMessage.success('已删除');
  fetchList();
}

/* ---------------- 列定义 ---------------- */
type Col = { prop: string; label: string; render?: (row: Record<string, unknown>) => string; badge?: (row: Record<string, unknown>) => string };

const columns = computed<Col[]>(() => {
  switch (active.value) {
    case 'school':
      return [
        { prop: 'name', label: '学校名称' },
        { prop: 'code', label: '编码' },
        { prop: 'domain', label: '域名' },
        { prop: 'bindMode', label: '绑定方式', badge: r => (String(r.bindMode) === 'auto' ? 'badge-brand' : 'badge-neutral'), render: r => (String(r.bindMode) === 'auto' ? '自动' : '人工') },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'major':
      return [
        { prop: 'name', label: '专业名称' },
        { prop: 'majorCode', label: '专业编码' },
        { prop: 'sortNo', label: '排序号' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'clazz':
      return [
        { prop: 'clazzName', label: '班级名称' },
        { prop: 'clazzCode', label: '班级编码' },
        { prop: 'majorName', label: '所属专业' },
        { prop: 'gradeYear', label: '年级' },
        { prop: 'studentCount', label: '学生数' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'term':
      return [
        { prop: 'name', label: '学期名称' },
        { prop: 'code', label: '学期编码' },
        { prop: 'startDate', label: '开始日期' },
        { prop: 'endDate', label: '结束日期' },
        { prop: 'isCurrent', label: '当前学期', render: r => (Number(r.isCurrent) === 1 ? '是' : '否') },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'room':
      return [
        { prop: 'name', label: '教室名称' },
        { prop: 'code', label: '教室编码' },
        { prop: 'roomType', label: '类型', render: r => (String(r.roomType) === 'virtual' ? '虚拟教室' : '物理教室') },
        { prop: 'capacity', label: '容纳人数' },
        { prop: 'location', label: '位置' },
        { prop: 'status', label: '状态', badge: r => statusCls(r.status), render: r => statusLabel(r.status) }
      ];
    case 'teacher':
      return [
        { prop: 'username', label: '登录账号' },
        { prop: 'nickName', label: '姓名' },
        { prop: 'email', label: '邮箱' },
        { prop: 'deptName', label: '所属院系' },
        { prop: 'createTime', label: '创建时间' }
      ];
    case 'student':
      return [
        { prop: 'username', label: '登录账号' },
        { prop: 'nickName', label: '姓名' },
        { prop: 'email', label: '邮箱' },
        { prop: 'deptName', label: '所属院系' },
        { prop: 'createTime', label: '创建时间' }
      ];
    default:
      return [];
  }
});
</script>

<template>
  <div class="page-head">
    <h1>基础数据</h1>
    <div class="actions">
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
    <div class="right" v-if="!isGap">
      <el-input v-model="query.keyword" placeholder="关键词" clearable style="width: 180px" @keyup.enter="onSearch" @clear="onSearch" />
      <el-button text @click="onSearch">查询</el-button>
    </div>
  </div>

  <!-- 缺口 tab -->
  <div v-if="isGap" class="card card-pad">
    <div class="center" style="padding: 30px 0">
      <div class="icon-box lg" style="margin: 0 auto 12px"><ZkIcon name="database" :size="26" /></div>
      <div class="card-title" style="margin-bottom: 6px">{{ GAP_TABS[active] }} · 后端未提供接口</div>
      <div class="muted small">
        当前接口清单（/v3/api-docs）里没有{{ GAP_TABS[active] }}的增删改查端点，按缺口处理，不接假数据。
      </div>
      <div class="muted small mt8">已有的基础数据端点：学校 / 专业 / 班级 / 学期 / 教室（教室随 C-21 于 2026-10-15 补齐）。</div>
    </div>
  </div>

  <div v-else class="card">
    <el-table v-loading="loading" :data="rows" style="width: 100%">
      <el-table-column v-for="c in columns" :key="c.prop" :label="c.label" :prop="c.prop" min-width="130">
        <template #default="{ row }">
          <span v-if="c.badge" class="badge" :class="c.badge(row)">{{ c.render ? c.render(row) : row[c.prop] }}</span>
          <span v-else>{{ c.render ? c.render(row) : (row[c.prop] ?? '—') }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="canCrud" label="操作" width="150" align="right">
        <template #default="{ row }">
          <el-button text size="small" @click="openEdit(row)">编辑</el-button>
          <el-button text size="small" style="color: var(--error)" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted small" style="padding: 18px 0">
          {{ active === 'teacher' || active === 'student' ? '暂无数据（数据源＝账号接口按角色过滤）' : '暂无数据' }}
        </div>
      </template>
    </el-table>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">
        共 {{ total }} 条记录
        <span v-if="active === 'teacher' || active === 'student'">（数据来自账号接口，按角色过滤）</span>
      </span>
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="prev, pager, next"
        @current-change="fetchList"
      />
    </div>
  </div>

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
