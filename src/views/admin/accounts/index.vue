<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules, TableInstance } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  createUser,
  deleteUser,
  downloadImportTemplate,
  exportUsers,
  getUserFootprint,
  importUsers,
  listDeptTree,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus
} from '@/api/admin/users';
import type { DeptNodeVo } from '@/api/admin/users';
import type { AdminUserVo, FootprintVo, ImportResultVo, UserSaveBo } from '@/types/admin';
import { useUserStore } from '@/store/user';

/* ---------------- 词典 ---------------- */
const route = useRoute();

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  teacher: '教师',
  student: '学生',
  common: '普通用户'
};
const ROLE_BADGE: Record<string, string> = {
  admin: 'badge-info',
  teacher: 'badge-brand',
  student: 'badge-success',
  common: 'badge-neutral'
};
/** 筛选器用的角色词典（口径取自演示库实际存在的 roleKey）。
 *  ★ common（普通用户）留在筛选器与徽标映射里，存量 common 账号要能筛出来、要显示得对；
 *    但它已从「新增/编辑表单」的候选里下架，见 roleOptionsForForm（编号 24）。 */
const ROLE_OPTIONS = [
  { value: '', label: '全部角色' },
  { value: 'admin', label: '管理员' },
  { value: 'teacher', label: '教师' },
  { value: 'student', label: '学生' },
  { value: 'common', label: '普通用户' }
];

/** 状态下拉选项（若依字典 sys_normal_disable：'0'=启用、'1'=停用；与列表徽标同一口径） */
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: '0', label: '启用' },
  { value: '1', label: '停用' }
];

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<AdminUserVo[]>([]);
const total = ref(0);
const query = reactive({ page: 1, pageSize: 20, keyword: '', roleKey: '', status: '', deptId: undefined as string | undefined, sortField: 'createTime', sortOrder: 'desc' as 'asc' | 'desc' });

/* ---------------- 院系候选（A6 / 编号 23）----------------
 * 10-26 起换成全量：后端选路线②（给 role 100 授 `system:dept:list`），前端接若依原生 GET /system/dept/list。
 * 旧实现是「拉前 200 条账号去重当候选」，账号总数一涨就有院系静默缺项，连同触顶提示一起删掉。
 *
 * ★ 候选范围取「学校根的子树」，不是整棵 sys_dept。后端 10-26 说明按 schoolId 过滤做不了
 *   （school 表无 dept_id、sys_dept 无 school_id、zhike_dev 无 DDL 权限），可落地的口径只有按根截 ancestors；
 *   基础数据页（乙线）按同一口径，两页候选集才一致。
 *   根不写死：拿 DEFAULT_DEPT_ID 在平铺返回里查自己的 ancestors —— "0" 即本身是根，
 *   "0,200" 这类取第一个非 0 节点，日后 200 挂到更上层时这里不用改。
 */
const deptOptions = ref<{ id: string; name: string }[]>([]);
/** 接口不通、或按子树筛完为空，都在浮层底部说明；「下拉是空的」不能只让人自己猜 */
const deptLoadFailed = ref(false);

/** 取某节点所在学校的根 id（一律 String() 归一：原生端点的 deptId 实测还是裸数字，日后加了注解也不用改这里） */
function schoolRootId(list: DeptNodeVo[], selfId: string): string {
  const self = list.find(d => String(d.deptId) === selfId);
  const chain = (self?.ancestors ?? '').split(',').map(s => s.trim()).filter(s => s && s !== '0');
  return chain.length ? chain[0] : selfId;
}

async function loadDeptOptions() {
  try {
    const res = await listDeptTree();
    const root = schoolRootId(res.list, DEFAULT_DEPT_ID);
    const inSchool = res.list.filter(
      d => String(d.deptId) === root || (d.ancestors ?? '').split(',').map(s => s.trim()).includes(root)
    );
    deptOptions.value = inSchool
      .map(d => ({ id: String(d.deptId), name: d.deptName }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    deptLoadFailed.value = !res.ok || deptOptions.value.length === 0;
  } catch {
    /* 候选拉不到不影响列表本身（request.ts 已提示），置失败态让浮层说清原因 */
    deptLoadFailed.value = true;
  }
}

const tableRef = ref<TableInstance>();

/** 勾选只在翻页时保留（跨页批量）。EP 的 reserve-selection 在 setData 时一律不裁选
    （store/index.mjs:35 只调 assertRowKey），换筛选或写操作后若不由调用方清空，
    批量启用/停用/删除就会打到不在屏幕上的账号 ⇒ 除 goPage 外全部按默认值清空勾选。 */
async function fetchList(keepSelection = false) {
  if (!keepSelection) tableRef.value?.clearSelection();
  loading.value = true;
  try {
    const res = await listUsers(query);
    // 排序已交服务端（sortField/sortOrder 随 query 发出）⇒ 这里不再页内排序，页内排序只能整当前页，
    // 跨页会各页自己重排一遍，正是 10-22 那句「跨页仍按后端默认序」承认过的缺陷。
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

/* ---------------- 自定义合并式分页器（‹ [页码] / N 页 | 跳转 ›，与课程审核页同款） ---------------- */
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)));
const pageInput = ref(1);
watch(
  () => query.page,
  (p) => { pageInput.value = p; },
  { immediate: true }
);
function goPage(n: number) {
  const target = Math.min(Math.max(1, Math.trunc(n) || 1), pageCount.value);
  if (target === query.page) { pageInput.value = target; return; }
  query.page = target;
  fetchList(true);
}

/** 表格「序号」列的序号：跨页连续（第 2 页从 21 起）。EP 默认每页从 1 重计，看不出这是全局第几行。 */
function rowIndex(i: number) {
  return (query.page - 1) * query.pageSize + i + 1;
}

function onSearch() {
  // 去首尾空格：粘贴「张三 」或表格复制来的账号名很常见，带着空格走 LIKE '% 张三 %' 实测 0 命中
  query.keyword = query.keyword.trim();
  query.page = 1;
  fetchList();
}

function resetQuery() {
  query.keyword = '';
  query.roleKey = '';
  query.status = '';
  query.deptId = undefined;
  query.page = 1;
  query.sortField = 'createTime';
  query.sortOrder = 'desc';
  // 表头箭头要跟数据一致：clearSort 会派发一次 sort-change（order=null），
  // 下面 onSortChange 的「已是默认态就直接返回」那条拦住它，避免多打一次接口。
  tableRef.value?.clearSort();
  fetchList();
}

/**
 * 可排序列的口径（后端 10-27 已追认，编号 12 结案）：参数名 sortField + sortOrder（值 asc/desc）。
 * 白名单是 username/nickName/deptName/status/createTime/loginDate（AdminAccountServiceImpl.java:94-97），
 * 名单外的字段 WARN 后回落默认序、不报错；本页只开放**实测确认过的四列**，别猜。
 * nickName/deptName 后端支持排序，但本页把两者放进「登录账号」列的副行、不是独立列 ⇒ 不挂箭头（挂了也没有可点表头）。
 */
const SORTABLE_FIELDS: Record<string, string> = { username: 'username', status: 'status', createTime: 'createTime', loginDate: 'loginDate' };

function onSortChange(prop: string, order: string | null) {
  const nextField = order && SORTABLE_FIELDS[prop] ? SORTABLE_FIELDS[prop] : 'createTime';
  const nextOrder = order === 'ascending' ? 'asc' : 'desc';
  // 第三次点击 = 取消态：数据回到默认序（createTime desc），但 EP 不会自己把箭头指回去，
  // 表头就变成「无箭头 + 有顺序」的误导状态（10:48 真浏览器复现：th 的 descending 类直接消失）。
  // sort() 会再派发一次 sort-change，被下面那条「已是目标态就返回」吃掉 ⇒ 不多发请求。
  if (!order) tableRef.value?.sort('createTime', 'descending');
  if (query.sortField === nextField && query.sortOrder === nextOrder) return;
  query.sortField = nextField;
  query.sortOrder = nextOrder;
  query.page = 1;
  fetchList();
}

/** ✕ 仅清关键字（不动角色筛选），与课程审核页口径一致 */
function clearKeyword() {
  query.keyword = '';
  query.page = 1;
  fetchList();
}

/* ---------------- 窄视口把三个筛选下拉收进「筛选」浮层 ----------------
 * 折行本身不裁切内容（实测溢出 0），但工具栏在 1366/1440 下折成两行、高 102px，
 * 把列表首屏往下推 ~44px。单行需要 左组固有宽 + 右组固有宽 + 间距 + 内边距，
 * 实测值见 style 里 .toolbar 那条注释 ⇒ 视口要到 ~1627px 才容得下，所以断点定在 1680px 以下启用浮层。
 * 只用 CSS 换容器、不复制一份下拉（两套下拉会各自记住弹层状态，筛选值虽然同源但维护成本翻倍）；
 * 浮层里改筛选 = 走同一个 onSearch，切换断点不丢值。
 */
const FILTER_BREAKPOINT = 1680;
const compactFilter = ref(false);
const filterPanelOpen = ref(false);
const filterHostRef = ref<HTMLElement>();
let filterMql: MediaQueryList | null = null;

/** 已生效的筛选条件数（关键词不算：它有自带的 ✕ 和独立视觉位置）。
    用 truthy 而不是 `!== ''`：EP 的 clearable 清空时发的是 undefined，按空串比会把已清掉的筛选计进徽标。 */
const filterCount = computed(
  () => [query.roleKey, query.status].filter(Boolean).length + (query.deptId != null ? 1 : 0)
);

function toggleFilterPanel() {
  filterPanelOpen.value = !filterPanelOpen.value;
}
/** 点浮层与开关按钮之外任意处即收起（用捕获阶段，先于浮层内控件的 click，才能靠 contains 判边界）。
    ★ EP 的下拉面板被传送到 body，不在 .filter-host 里 ⇒ 不加这条例外，选完一个筛选就会被当成「点外面」
      把整个浮层收掉（实测到：选「学生」后浮层关闭，想再加一个状态筛选得重开）。
      浮层开着时能出现在屏幕上的 popper 只可能是它自己的三个下拉，所以按 .el-popper 整类放行是安全的。 */
function onDocClick(event: MouseEvent) {
  const host = filterHostRef.value;
  if (!host) return;
  const target = event.target as HTMLElement | null;
  if (typeof target?.closest === 'function' && target.closest('.el-popper')) return;
  if (!host.contains(target)) filterPanelOpen.value = false;
}
function syncCompactFilter(matches: boolean) {
  compactFilter.value = matches;
  if (!matches) filterPanelOpen.value = false;
}
function onFilterBreakpoint(e: MediaQueryListEvent) {
  syncCompactFilter(e.matches);
}

onMounted(() => {
  filterMql = window.matchMedia(`(max-width: ${FILTER_BREAKPOINT - 1}px)`);
  syncCompactFilter(filterMql.matches);
  filterMql.addEventListener('change', onFilterBreakpoint);
});
onUnmounted(() => {
  filterMql?.removeEventListener('change', onFilterBreakpoint);
  document.removeEventListener('click', onDocClick, true);
});
watch(filterPanelOpen, (open) => {
  document.removeEventListener('click', onDocClick, true);
  if (open) document.addEventListener('click', onDocClick, true);
});

onMounted(() => {
  // 角色成员反查入口：/admin/accounts?roleKey=teacher（来自角色管理页成员数点击）
  const v = route.query.roleKey;
  if (typeof v === 'string') query.roleKey = v;
  fetchList();
  loadDeptOptions();
});

/** 已挂载期间入口参数变化（如角色页再点另一角色）→ 同步筛选 */
watch(
  () => route.query.roleKey,
  (v) => {
    if (typeof v === 'string' && v !== query.roleKey) {
      query.roleKey = v;
      query.page = 1;
      fetchList();
    }
  }
);

/** 若依字典 sys_normal_disable：'0' 正常/启用，'1' 停用；统一转字符串比较，兼容后端返回数字 */
const statusLabel = (s: unknown) => (String(s) === '0' ? '启用' : '停用');
const statusBadge = (s: unknown) => (String(s) === '0' ? 'badge-success' : 'badge-neutral');

function rolesText(row: AdminUserVo) {
  // 去重：演示库存在两个角色共用 role_key='admin'（role_id 1/100），不去重会显示「管理员、管理员」
  const keys = [...new Set(row.roleKeys ?? [])];
  if (!keys.length) return '—';
  return keys.map(k => ROLE_LABEL[k] ?? k).join('、');
}
function primaryRoleKey(row: AdminUserVo) {
  return (row.roleKeys ?? [])[0] ?? 'common';
}

/* ---------------- 超级管理员保护 ----------------
 * 若依口径：userId=1 为超管，后端停用/删除均拒绝（checkUserAllowed）。
 * 前端按用户拍板锁死其行操作，防止误操作产生「显示学生徽标的超管」这类误导展示。
 * ★ 编号 26：后端 10-26 起把 userId 下发成 19 位字符串（`@JsonFormat(shape=STRING)`），判定跟契约一起改字符串。
 *   留着 `=== 1` 的后果不是编译不过，而是恒为假 ⇒ 超管行不再被锁，删除/停用照发、后端照拒、前端照提示成功。
 */
const SUPER_ADMIN_ID = '1';
const isAdminUser = (row: AdminUserVo) => row.userId === SUPER_ADMIN_ID;
const ADMIN_LOCK_TIP = '超级管理员受保护，不可操作（改密请用右上角「修改密码」）';

/* ---------------- 管理权收敛（用户拍板 10-19）----------------
 * 其他管理员与 admin 权限拉平（数据层 role 100 已挂全菜单），
 * 但「管理员账号」的增改只有超管可以做：非超管不能新增管理员角色账号、不能编辑其他管理员。
 * 当前用户是否超管 = permissions 含 *:*:*（若依 userId==1 硬编码的唯一标记）。
 */
const userStore = useUserStore();
const isSuperAdmin = computed(() => userStore.permissions.includes('*:*:*'));
/** 行是否为管理员角色账号 */
const isAdminRow = (row: AdminUserVo) => (row.roleKeys ?? []).includes('admin');
const ADMIN_EDIT_TIP = '只有超级管理员可以添加或编辑管理员账号';
const ADMIN_RESET_TIP = '只有超级管理员可以重置管理员密码（改自己的密码请用右上角「修改密码」）';
/** 行操作锁：超管保护 或 非超管管理其他管理员 */
function opLockTip(row: AdminUserVo): string | null {
  if (row.userId === SUPER_ADMIN_ID) return ADMIN_LOCK_TIP;
  if (!isSuperAdmin.value && isAdminRow(row) && row.username !== userStore.username) return ADMIN_EDIT_TIP;
  return null;
}
/** 重置密码专用锁（用户拍板 10-19 16:00）：非超管对管理员角色的行一律不可重置，含自己的行（自己改密走右上角「修改密码」） */
function resetLockTip(row: AdminUserVo): string | null {
  if (row.userId === SUPER_ADMIN_ID) return ADMIN_LOCK_TIP;
  if (!isSuperAdmin.value && isAdminRow(row)) return ADMIN_RESET_TIP;
  return null;
}
/** 编辑/新增时表单里可用的角色选项（编号 24 + A5）：
 *  · 非超管不给「管理员」；
 *  · `common`（普通用户）已从表单候选下架 —— 后端 `IMPORT_ALLOWED_ROLES` 只认 teacher/student/admin
 *    （AdminAccountServiceImpl.java:87），而且实测连手工新建发 common 也回 code=500（`resolveRoleIds` 拒授框架内置角色），
 *    给一个必然报错的取值没有意义；筛选器与徽标映射仍保留 common，存量 common 账号照样能筛出来、照样显示。
 *  · 编辑态把该行**全部**原角色补回候选（A5）：一是 common 这类已下架值要能显示原样，
 *    二是多角色账号补回全部才不会让提示里的角色在下拉里找不到。 */
const formRolesOriginal = ref<string[]>([]);
const roleOptionsForForm = computed(() => {
  const all = ROLE_OPTIONS.filter(x => x.value && x.value !== 'common');
  const list = isSuperAdmin.value ? all : all.filter(x => x.value !== 'admin');
  const missing = formRolesOriginal.value.filter(k => k && !list.some(x => x.value === k));
  if (!missing.length) return list;
  return [...list, ...missing.map(k => ({ value: k, label: ROLE_LABEL[k] ?? k }))];
});
/** 该账号原有多于一个角色时的提示文案（A5：单选是 10-19 拍板，但后端契约是数组，静默降级必须说出来） */
const multiRoleHint = computed(() => {
  const keys = formRolesOriginal.value;
  if (formMode.value !== 'edit' || keys.length < 2) return '';
  return `该账号原有 ${keys.length} 个角色（${keys.map(k => ROLE_LABEL[k] ?? k).join('、')}），本页角色为单选，保存后只保留所选的那一个`;
});

/* ---------------- 新增 / 编辑 ---------------- */
const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const saving = ref(false);
/** 新增账号默认落在的院系（演示库 200=示例大学）；A2 起这个值在弹窗里可选可改。
 *  写成字符串字面量：契约里 UserSaveBo.deptId 是 string，且这个值同时是「学校根」的查找入口（见 schoolRootId），
 *  集中在这一个常量里，赋值点不再各自 String()。 */
const DEFAULT_DEPT_ID = '200';
/** 表单模型（含单选角色，提交时包成后端要求的 roleKeys 数组） */
const form = reactive<{ username: string; nickName: string; email: string; phone: string; userNo: string; remark: string; role: string; userId?: string; deptId?: string | null }>({ username: '', nickName: '', email: '', phone: '', userNo: '', remark: '', role: '', userId: undefined, deptId: undefined });
const formRef = ref<FormInstance>();
/** 编辑超管时锁死角色下拉（双保险：行按钮已禁用，弹窗内再兜一层） */
const editingAdmin = computed(() => formMode.value === 'edit' && form.userId === SUPER_ADMIN_ID);
/** 编辑的行原本未入院系 —— 下拉要显式说出来，否则空下拉会被读成「候选没加载出来」 */
const deptWasEmpty = computed(() => formMode.value === 'edit' && form.deptId == null);

/* 表单校验（用户拍板 10-19，A3 起 nickName 的中文口径统一为「姓名」，与导入模板列头同词）：
   必填=登录账号/姓名/角色/工号学号；选填但格式校验=邮箱/手机号。错误以内联红字显示在输入框下方。 */
const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const rules: FormRules = {
  username: [{ required: true, message: '登录账号为必填', trigger: 'blur' }],
  nickName: [{ required: true, message: '姓名为必填', trigger: 'blur' }],
  role: [{ required: true, message: '角色为必选', trigger: 'change' }],
  userNo: [{ required: true, message: '工号/学号为必填', trigger: 'blur' }],
  email: [{ pattern: EMAIL_RE, message: '邮箱格式不正确', trigger: 'blur' }],
  phone: [{ pattern: PHONE_RE, message: '手机号格式不正确', trigger: 'blur' }]
};

function openCreate() {
  formMode.value = 'create';
  Object.assign(form, { username: '', nickName: '', email: '', phone: '', userNo: '', remark: '', role: '', userId: undefined, deptId: DEFAULT_DEPT_ID });
  formRolesOriginal.value = [];
  formRef.value?.clearValidate();
  formVisible.value = true;
}

function openEdit(row: AdminUserVo) {
  formMode.value = 'edit';
  Object.assign(form, {
    userId: row.userId,
    username: row.username,
    nickName: row.nickName,
    email: row.email ?? '',
    phone: row.phone ?? '',
    userNo: row.userNo ?? '',
    remark: row.remark ?? '',
    // A2：行原院系回填后可在弹窗里改；null（未入院系）如实带着，提交时省略该键即保持原值不变
    deptId: row.deptId || null,
    role: (row.roleKeys ?? [])[0] ?? 'common'
  });
  formRolesOriginal.value = [...(row.roleKeys ?? [])];
  formRef.value?.clearValidate();
  formVisible.value = true;
}

async function submitForm() {
  // 管理权收敛：非超管不能创建/提升为管理员角色（编辑管理员本人保持原角色不拦）
  if (!isSuperAdmin.value && form.role === 'admin' && !formRolesOriginal.value.includes('admin')) {
    ElMessage.warning(ADMIN_EDIT_TIP);
    return;
  }
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  // 提交前去空白，保证格式口径一致
  form.username = form.username.trim();
  form.nickName = form.nickName.trim();
  form.userNo = form.userNo.trim();
  form.email = form.email.trim();
  form.phone = form.phone.trim();
  saving.value = true;
  try {
    // 后端 BO 收 roleKeys 数组（若依 sys_user_role 关联表），单选包一层。
    // ★ 逐键显式列写（不用 {...form} 摊开）：form 里带 deptId: null 与前端专用的 role，
    //   摊开会污染契约类型；且「省略某个键」正是下面院系那条保原值的手法，必须能精确控制发什么。
    const payload: UserSaveBo = {
      userId: form.userId,
      username: form.username,
      nickName: form.nickName,
      email: form.email,
      phone: form.phone,
      userNo: form.userNo,
      remark: form.remark,
      roleKeys: [form.role]
    };
    if (formMode.value === 'create') {
      // A2：院系由弹窗里选（默认 200 示例大学）；|| 兜底只为防「下拉取不到候选」时发出去一个空值
      payload.deptId = form.deptId || DEFAULT_DEPT_ID;
      const res = await createUser(payload);
      ElMessage.success('新增成功');
      if (res?.tempPassword) {
        pwdMode.value = 'create';
        pwdTitle.value = '请转交给使用者';
        pwdResult.value = res.tempPassword;
        pwdVisible.value = true;
      }
    } else {
      // A2 + A1：编辑态院系下拉回填原值，用户改了就发新值；原本是「未入院系」(null) 且没选新院系 ⇒ 省略该键保持原样。
      // ★ 这里刻意**不提供**「主动摘掉院系」的选项：省略键 ≠ 跳过该列 —— 后端 AdminAccountServiceImpl:169 setDeptId(null)
      //   → SysUserMapper.xml:183 `<if test="deptId != 0">` 在 OGNL 下 null != 0 为真 ⇒ 照样执行 dept_id = NULL。
      //   所以对有院系的行发 null 会真的摘掉院系，而契约 UserSaveBo.deptId 类型是 `string`（不含 null），
      //   要支持这条高危动作得先改契约并让后端确认语义，不在本次范围内。
      // 旧代码一律发 200，会把「计算机学院(201)」等账号静默挪进「示例大学(200)」—— 这条由 A1 保原值挡掉。
      if (form.deptId != null) payload.deptId = form.deptId;
      else delete payload.deptId;
      // 编号 25 备注：编辑态已回填原值（列表接口现在带 remark），故此键始终如实发出 ——
      // 留空发空串即真清空（后端 SysUserMapper.xml:194 `<if test="remark != null">` 对空串成立，只有不发键才跳过该列）
      // 编辑时带原 userId（★ PUT /users 没有 path 段，userId 在 body 里）
      // 编辑时带原 userId（★ PUT /users 没有 path 段，userId 在 body 里）
      await updateUser(payload);
      ElMessage.success('保存成功');
    }
    formVisible.value = false;
    fetchList();
  } finally {
    saving.value = false;
  }
}

/* ---------------- Excel 导入 / 导出（B-7 / B-8 / B-8a） ---------------- */
const exporting = ref(false);
/** 后端把导出行数写死成 page=1 / pageSize=1000（AdminAccountServiceImpl.java:312-317 buildExportRows），
    超出部分静默少导、不报错 ⇒ 条数必须由前端在点导出时说清楚。 */
const EXPORT_MAX_ROWS = 1000;

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

async function onExport() {
  exporting.value = true;
  try {
    // 关键词输入框实时绑定 query，用户可能只敲了字没点「搜索」。
    // 先按当前筛选查一次：既保证「屏幕所见 = 实际所导」，又拿到准确的命中条数用于截断提示（传 true 保留勾选）。
    await fetchList(true);
    const hit = total.value;
    if (!hit) {
      ElMessage.info('当前筛选条件下没有可导出的账号');
      return;
    }
    // 导出与列表同一套筛选（后端复用 UserQueryBo），否则页面筛完导出的行数对不上眼前所见
    const blob = await exportUsers({
      keyword: query.keyword || undefined,
      roleKey: query.roleKey || undefined,
      status: query.status || undefined,
      deptId: query.deptId
    });
    saveBlob(blob, `账号数据_${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (hit > EXPORT_MAX_ROWS) {
      ElMessage.warning(
        `本次筛选命中 ${hit} 条，单次最多导出 ${EXPORT_MAX_ROWS} 条，未导出 ${hit - EXPORT_MAX_ROWS} 条。请缩小筛选范围后分次导出。`
      );
    } else {
      ElMessage.success(`导出完成：本次筛选共 ${hit} 条已全部导出`);
    }
  } catch {
    /* fetchList / exportUsers 任一失败，接口层已提示 */
  } finally {
    exporting.value = false;
  }
}

const importVisible = ref(false);
const importing = ref(false);
const importUpdateSupport = ref(false);
const importFile = ref<File | null>(null);
const importResult = ref<ImportResultVo | null>(null);

function openImport() {
  importFile.value = null;
  importResult.value = null;
  importUpdateSupport.value = false;
  importVisible.value = true;
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement;
  importFile.value = input.files && input.files[0] ? input.files[0] : null;
}

async function onDownloadTemplate() {
  const blob = await downloadImportTemplate();
  saveBlob(blob, '账号导入模板.xlsx');
}

async function onSubmitImport() {
  if (!importFile.value) {
    ElMessage.warning('请先选择 .xlsx 文件');
    return;
  }
  importing.value = true;
  try {
    const r = await importUsers(importFile.value, importUpdateSupport.value);
    importResult.value = r;
    ElMessage.success(`导入完成：新建 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}，失败 ${r.failed}`);
    await fetchList();
  } catch {
    /* 已提示 */
  } finally {
    importing.value = false;
  }
}

/* ---------------- 启停 / 重置密码 / 删除 ----------------
 * ★ 这几处的确认框必须就地接住「取消」：ElMessageBox.confirm 在点取消/按 ESC 时是
 *   **reject** 的 Promise，事件处理函数里不 catch 会冒成 Vue 的
 *   「Unhandled error during execution of component event handler」（实测：停用一个账号
 *   再点取消 = 控制台 1 条 warn），把「0 控制台报错」的验收口径打掉。
 *   接口失败同理（request.ts 已弹过 ElMessage，这里吞掉即可，不重复提示）。
 */
async function toggleStatus(row: AdminUserVo) {
  const next = row.status === '0' ? '1' : '0';
  const ok = await ElMessageBox.confirm(`确定要${next === '0' ? '启用' : '停用'}账号「${row.username}」吗？`, '提示', { type: 'warning' }).catch(() => false);
  if (!ok) return;
  try {
    // ★ status 走 query
    await updateUserStatus(row.userId, next);
  } catch {
    return;
  }
  // 提示写明做了什么、对哪个账号（request.ts 只在失败时弹提示，成功这条由本页发，不会重复）
  ElMessage.success(`${next === '0' ? '已启用' : '已停用'}账号「${row.username}」`);
  fetchList();
}

const pwdVisible = ref(false);
const pwdResult = ref('');
const pwdTitle = ref('重置密码');
/** 口令弹窗的两条来源要分别给标题和正文：新建账号没有「原密码」，重置密码也不是「转交新口令」。
    标题原本只在新增分支改写、重置分支不回落 ⇒ 先新增再重置会沿用「请转交给使用者」（实测到）。 */
const pwdMode = ref<'create' | 'reset'>('reset');
const pwdLead = computed(() =>
  pwdMode.value === 'create'
    ? '已给该账号下发初始密码，请转交本人；对方首次登录时须改为自己设置的密码。'
    : '已重置为默认密码，原密码立即失效。对方首次登录时须修改为新密码。'
);
async function doResetPwd(row: AdminUserVo) {
  const ok = await ElMessageBox.confirm(`确定要重置账号「${row.username}」的登录密码吗？原密码将立即失效。`, '重置密码', { type: 'warning' }).catch(() => false);
  if (!ok) return;
  let res;
  try {
    res = await resetUserPassword(row.userId);
  } catch {
    return;
  }
  pwdResult.value = res?.tempPassword ?? '';
  pwdMode.value = 'reset';
  pwdTitle.value = '重置密码';
  pwdVisible.value = true;
}

/**
 * 复制临时口令。注意：不能直接在模板里写 navigator.clipboard ——
 * 模板表达式的作用域是组件实例，`navigator` 会被当成实例属性而取不到（vue-tsc 亦会报错）。
 */
async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制到剪贴板');
  } catch {
    // 兜底：clipboard API 不可用（非安全上下文/无权限）时走 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) { ElMessage.success('已复制到剪贴板'); return; }
      throw new Error('execCommand failed');
    } catch {
      ElMessage.warning('复制失败，请手动选中复制');
    }
  }
}

async function copyPwd() {
  await copyText(pwdResult.value);
}

async function doDelete(row: AdminUserVo) {
  const ok = await ElMessageBox.confirm(`确定要删除账号「${row.username}」吗？`, '删除账号', { type: 'warning', confirmButtonText: '删除' }).catch(() => false);
  if (!ok) return;
  try {
    await deleteUser(row.userId);
  } catch {
    return;
  }
  ElMessage.success('已删除');
  fetchList();
}

/**
 * 操作列「更多」下拉的分发。低频四项（足迹 / 重置密码 / 停用启用 / 删除）收进下拉后，
 * 列宽从 390px 降到实测值（见 style 里 .op-col 那条），1366 视口不必横向滚动就能看全「操作」列。
 * 锁定关系原样带过来：足迹不锁、重置密码走 resetLockTip、其余走 opLockTip。
 */
function onMoreCommand(cmd: string, row: AdminUserVo) {
  if (cmd === 'footprint') openFootprint(row);
  else if (cmd === 'reset') doResetPwd(row);
  else if (cmd === 'toggle') toggleStatus(row);
  else if (cmd === 'delete') doDelete(row);
}

/* ---------------- 批量启停 / 批量删除（循环调既有单条接口，后端护栏兜底） ---------------- */
const selectedRows = ref<AdminUserVo[]>([]);
const batchLoading = ref(false);

function onSelectionChange(rows: AdminUserVo[]) {
  selectedRows.value = rows;
}

type BatchKind = 'enable' | 'disable' | 'delete';
const BATCH_LABEL: Record<BatchKind, string> = { enable: '批量启用', disable: '批量停用', delete: '批量删除' };
// 三种动作的后果不一样，确认框中间那句必须跟着变（原本批量启用也写着「停用后立即踢下线」）
const BATCH_NOTE: Record<BatchKind, string> = {
  delete: '删除后不可恢复，',
  disable: '停用后立即踢下线，',
  enable: '启用后对方即可正常登录，'
};

async function runBatch(kind: BatchKind) {
  const rows = selectedRows.value;
  if (!rows.length) return;
  const admins = rows.filter(isAdminRow);
  const targets = rows.filter((r) => !isAdminRow(r));
  if (!targets.length) {
    ElMessage.warning('选中项均为管理员账号，仅超级管理员可操作，已取消');
    return;
  }
  const nameList = targets.map((r) => r.username).join('、');
  const verb = kind === 'delete' ? '删除' : kind === 'enable' ? '启用' : '停用';
  const confirmed = await ElMessageBox.confirm(
    `确定要${verb}以下 ${targets.length} 个账号吗？${BATCH_NOTE[kind]}该操作逐个生效。\n${nameList}` +
      (admins.length ? `\n（另有 ${admins.length} 个管理员账号已自动跳过）` : ''),
    BATCH_LABEL[kind],
    { type: 'warning', confirmButtonText: `确定${verb}` }
  ).catch(() => false);
  if (!confirmed) return;
  batchLoading.value = true;
  let ok = 0;
  const fails: string[] = [];
  try {
    for (const r of targets) {
      try {
        if (kind === 'delete') await deleteUser(r.userId);
        else await updateUserStatus(r.userId, kind === 'enable' ? '0' : '1');
        ok += 1;
      } catch (e) {
        fails.push(`${r.username}（${e instanceof Error ? e.message : '失败'}）`);
      }
    }
  } finally {
    batchLoading.value = false;
  }
  if (fails.length) {
    await ElMessageBox.alert(`成功 ${ok} 个，失败 ${fails.length} 个：\n${fails.join('\n')}`, '批量结果', { type: 'warning' });
  } else {
    ElMessage.success(`${BATCH_LABEL[kind]}完成：共 ${ok} 个`);
  }
  fetchList();
}

/* ---------------- 查看详情 ---------------- */
const detailVisible = ref(false);
const detailRow = ref<AdminUserVo | null>(null);
function openDetail(row: AdminUserVo) {
  detailRow.value = row;
  detailVisible.value = true;
}

/* ---------------- F-1 账号足迹（登录记录 + 操作记录） ---------------- */
const fpVisible = ref(false);
const fpLoading = ref(false);
const fpTab = ref<'logins' | 'opers'>('logins');
const fpData = ref<FootprintVo | null>(null);

/** sys_oper_log.business_type → 中文 */
const BIZ_TYPES: Record<number, string> = {
  0: '其它', 1: '新增', 2: '修改', 3: '删除', 4: '授权',
  5: '导出', 6: '导入', 7: '强退', 8: '生成代码', 9: '清空'
};
function bizTypeLabel(t: number | undefined) {
  return t === undefined || t === null ? '其它' : BIZ_TYPES[t] ?? `类型${t}`;
}

async function openFootprint(row: AdminUserVo) {
  fpVisible.value = true;
  fpLoading.value = true;
  fpTab.value = 'logins';
  fpData.value = null;
  try {
    fpData.value = await getUserFootprint(row.userId);
  } catch {
    ElMessage.error('足迹加载失败');
  } finally {
    fpLoading.value = false;
  }
}
</script>

<template>
  <div class="page-head">
    <h1>账号管理</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="$router.push('/admin/roles')">
        <ZkIcon name="shield-check" :size="16" />角色管理
      </a>
      <a class="btn btn-outline" href="javascript:void(0)" @click="$router.push('/admin/logs')">
        <ZkIcon name="history" :size="16" />操作日志
      </a>
    </div>
  </div>

  <div class="toolbar">
    <div class="right" style="gap: 10px">
      <el-button type="primary" @click="openCreate">
        <ZkIcon name="plus" :size="15" style="margin-right: 4px" />新增账号
      </el-button>
      <!-- 导入 / 导出已移到列表最下方：这一行原本是「3 个操作 + 分隔线 + 3 个批量 + 搜索单元 + 3 个下拉 + 重置」，
           单行固有宽超过窄视口可用宽（实测见 style 里 .toolbar 那条），低频的导入导出先挪到底部（见 .table-foot-bar） -->
      <el-divider direction="vertical" />
      <el-tooltip content="勾选后可用（翻页保留，改筛选即清空）" :disabled="!!selectedRows.length" placement="top">
        <el-button :disabled="!selectedRows.length" :loading="batchLoading" @click="runBatch('enable')">
          <ZkIcon name="power" :size="15" style="margin-right: 4px" />启用{{ selectedRows.length ? `（${selectedRows.length}）` : '' }}
        </el-button>
      </el-tooltip>
      <el-tooltip content="勾选后可用（翻页保留，改筛选即清空）" :disabled="!!selectedRows.length" placement="top">
        <el-button :disabled="!selectedRows.length" :loading="batchLoading" @click="runBatch('disable')">
          <ZkIcon name="ban" :size="15" style="margin-right: 4px" />停用{{ selectedRows.length ? `（${selectedRows.length}）` : '' }}
        </el-button>
      </el-tooltip>
      <el-tooltip content="勾选后可用（翻页保留，改筛选即清空）" :disabled="!!selectedRows.length" placement="top">
        <el-button :disabled="!selectedRows.length" :loading="batchLoading" type="danger" plain @click="runBatch('delete')">
          <ZkIcon name="trash-2" :size="15" style="margin-right: 4px" />删除{{ selectedRows.length ? `（${selectedRows.length}）` : '' }}
        </el-button>
      </el-tooltip>
    </div>
    <div class="right">
      <!-- 搜索整体单元（与课程审核页同款）：占位文案用覆盖层，物理杜绝选中复制 -->
      <div class="search-unit">
        <ZkIcon name="search" :size="14" class="su-icon" />
        <div class="su-field">
          <input
            v-model="query.keyword"
            class="su-input"
            aria-label="搜索登录账号 / 姓名 / 手机号 / 工号学号"
            @keyup.enter="onSearch"
          />
          <span v-if="!query.keyword" class="su-ph">搜索登录账号 / 姓名 / 手机号 / 工号学号</span>
        </div>
        <button v-if="query.keyword" class="su-clear" title="清空" aria-label="清空搜索" @click="clearKeyword">
          <ZkIcon name="x" :size="13" />
        </button>
        <button class="su-btn" @click="onSearch">搜索</button>
      </div>
      <!-- placeholder 必须显式写：三个下拉的「全部」项值都是空串，EP 对空值显示 placeholder
           而不是 option 的 label ⇒ 不写就会一起显示默认的「请选择」，看不出这是筛选器。
           （原此处有「角色筛选」小字标签，2026-10-22 用户要求删除；placeholder 已自带语义，不补别的标签。）
           三个下拉一律 clearable：点 ✕ 即回到「全部」并触发查询，与搜索单元的 ✕ 同一口径。 -->
      <div ref="filterHostRef" class="filter-host" :class="{ compact: compactFilter, open: filterPanelOpen }">
        <el-button
          v-if="compactFilter"
          class="filter-toggle"
          :type="filterCount ? 'primary' : 'default'"
          :aria-expanded="filterPanelOpen"
          @click="toggleFilterPanel"
        >筛选{{ filterCount ? `（${filterCount}）` : '' }}</el-button>
        <div class="filter-panel">
          <el-select v-model="query.roleKey" filterable clearable style="width: 130px" placeholder="全部角色" @change="onSearch">
            <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select v-model="query.status" filterable clearable style="width: 110px" placeholder="全部状态" @change="onSearch">
            <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <!-- 院系候选 = 若依原生 /system/dept/list 里「学校根子树」的全量节点（编号 23，10-26 换掉原来的账号去重快照）。
               范围与基础数据页同一口径；筛出 0 条是「该院系下确实没有账号」，不是候选缺项。 -->
          <el-select v-model="query.deptId" filterable clearable style="width: 160px" placeholder="全部院系" @change="onSearch">
            <el-option v-for="o in deptOptions" :key="o.id" :label="o.name" :value="o.id" />
            <!-- 只在取不到候选时出现：静默空下拉会被读成「库里没院系」，这是 1022-P2-1 同类的隐形缺陷，必须说清 -->
            <template v-if="deptLoadFailed" #footer>
              <div class="small muted dept-foot-tip">
                院系候选取不到（可能未授权 system:dept:list，或该学校根下没有院系节点）；可改用关键词搜索定位账号。
              </div>
            </template>
          </el-select>
        </div>
      </div>
      <el-button text @click="resetQuery">重置</el-button>
    </div>
  </div>

  <div class="card">
    <el-table ref="tableRef" v-loading="loading" row-key="userId" :data="rows" style="width: 100%" :default-sort="{ prop: 'createTime', order: 'descending' }" @selection-change="onSelectionChange" @sort-change="(s: { prop: string; order: string | null }) => onSortChange(s.prop, s.order)">
      <el-table-column type="selection" width="42" reserve-selection />
      <!-- 列宽全部按真页面实测取（10-23 同源 iframe 造 1366 视口，量各列内容宽 + 单元格左右内边距 24px）：
           登录账号列需 240（副行原为「姓名 · 邮箱」，A1 起改成「姓名 · 院系」；院系名比邮箱短 ⇒ 240 仍是够的，
           隐藏态 viewport=0x0 量不了宽，这条按"变短方向"判断，可视窗口里要复扫一次溢出）、角色「普通用户」需 90、
           状态徽标「启用」需 66、两个时间列「2026-10-23 10:19:31」各需 154 ⇒ 依次给 64 / 240 / 100 / 84 / 164，每列留 10~18px 余量。
           八列合计 42+64+240+100+84+164+164+196 = 1054 ≤ 1366 视口可用的 1069 ⇒ 不再需要横向滚动（收纳前是 1276，差 207）。
           ★ A1 决定不另开「院系」列（加 120 要腾 105，能省的只有 38），改成把院系放进本列副行 ⇒ 零列宽代价。 -->
      <el-table-column type="index" label="序号" width="64" align="center" :index="rowIndex" />
      <el-table-column label="登录账号" min-width="240" prop="username" sortable="custom">
        <template #default="{ row }">
          <div class="row" style="gap: 8px">
            <span class="avatar sm">{{ (row.nickName || row.username || '?').slice(0, 1) }}</span>
            <span>
              <div style="font-weight: 600; color: var(--ink-900)">{{ row.username }}</div>
              <!-- A1：副行 = 姓名 · 院系，让「按院系筛选」在列表上就能核对；邮箱挪到详情抽屉与编辑弹窗 -->
              <div class="small muted">{{ row.nickName }} · {{ row.deptName || '未入院系' }}</div>
            </span>
          </div>
        </template>
      </el-table-column>
      <!-- 角色列不给排序：后端按 roleKeys 排会落回默认列（10-26 实测），给了箭头就是假可排序 -->
      <el-table-column label="角色" min-width="100">
        <template #default="{ row }">
          <span class="badge" :class="ROLE_BADGE[primaryRoleKey(row)]">{{ rolesText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="84" prop="status" sortable="custom">
        <template #default="{ row }">
          <span class="badge" :class="statusBadge(row.status)">{{ statusLabel(row.status) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="164" prop="createTime" sortable="custom">
        <template #default="{ row }">{{ row.createTime || '—' }}</template>
      </el-table-column>
      <el-table-column label="最近登录" width="164" prop="loginDate" sortable="custom">
        <template #default="{ row }">{{ row.loginDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="196" align="right" class-name="op-col" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" @click="openDetail(row)">
            <ZkIcon name="eye" :size="14" style="margin-right: 3px" />查看
          </el-button>
          <el-button
            text size="small"
            :disabled="!!opLockTip(row)"
            :title="opLockTip(row) ?? undefined"
            @click="openEdit(row)"
          >编辑</el-button>
          <!-- 低频四项收进「更多」：常驻 6 个按钮要 367px，收到 196px 后 1366 视口不必横向滚动就看得全 -->
          <el-dropdown trigger="click" @command="(c: string | number | object) => onMoreCommand(String(c), row)">
            <el-button text size="small" class="op-more">更多</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="footprint">足迹</el-dropdown-item>
                <el-dropdown-item command="reset" :disabled="!!resetLockTip(row)">重置密码</el-dropdown-item>
                <el-dropdown-item command="toggle" :disabled="!!opLockTip(row)">
                  {{ row.status === '0' ? '停用' : '启用' }}
                </el-dropdown-item>
                <el-dropdown-item command="delete" :disabled="!!opLockTip(row)" class="op-danger">删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>

    <div class="between page-foot" style="padding: 12px 16px">
      <span class="small muted">
        共 {{ total }} 条记录
        <span class="muted small">（点表头排序走服务端，整表重排、跨页连续）</span>
      </span>
      <div class="mini-pager">
        <button
          class="mp-btn"
          :disabled="query.page <= 1 || loading"
          aria-label="上一页"
          @click="goPage(query.page - 1)"
        >
          <ZkIcon name="chevron-left" :size="14" />
        </button>
        <input
          v-model.number="pageInput"
          class="mp-input"
          type="number"
          min="1"
          :max="pageCount"
          title="输入页码后按回车跳转"
          @keyup.enter="goPage(pageInput)"
        />
        <span class="mp-total">/ {{ pageCount }} 页</span>
        <button class="mp-go" title="跳转到输入的页码" @click="goPage(pageInput)">跳转</button>
        <button
          class="mp-btn"
          :disabled="query.page >= pageCount || loading"
          aria-label="下一页"
          @click="goPage(query.page + 1)"
        >
          <ZkIcon name="chevron-right" :size="14" />
        </button>
      </div>
    </div>

    <!-- 导入 / 导出（从工具栏移下来，见上方注释）：紧贴「共 N 条记录」，导出范围就在按钮旁边说清 -->
    <div class="row table-foot-bar">
      <el-button @click="openImport">
        <ZkIcon name="upload" :size="15" style="margin-right: 4px" />导入
      </el-button>
      <el-button :loading="exporting" @click="onExport">
        <ZkIcon name="download" :size="15" style="margin-right: 4px" />导出
      </el-button>
      <span class="small muted">导出按上方筛选（关键词 / 角色 / 状态 / 院系）取，单次最多 1000 条；命中更多时只导前 1000 条，导出后会写明少导了多少。</span>
    </div>
  </div>

  <!-- 新增 / 编辑 -->
  <el-dialog v-model="formVisible" :title="formMode === 'create' ? '新增账号' : '编辑账号'" width="480px">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="86px" label-position="left">
      <!-- 必填在前（带红星），选填在后；错误内联红字显示。
           ★ 占位文案全部用自绘覆盖层（.fc-ph）：原生 ::placeholder 在部分浏览器可被选中复制 -->
      <el-form-item label="登录账号" prop="username">
        <el-input v-model="form.username" :disabled="formMode === 'edit'" />
        <span v-if="formMode === 'create' && !form.username" class="fc-ph">用于登录，创建后不可改</span>
      </el-form-item>
      <el-form-item label="姓名" prop="nickName">
        <el-input v-model="form.nickName" />
        <span v-if="!form.nickName" class="fc-ph">真实姓名（导入模板同列头也叫「姓名」）</span>
      </el-form-item>
      <el-form-item label="角色" prop="role">
        <el-select v-model="form.role" style="width: 100%" :disabled="editingAdmin" placeholder="请选择角色">
          <el-option v-for="o in roleOptionsForForm" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <div v-if="editingAdmin" class="small muted" style="margin-top: 2px">超级管理员角色不可修改</div>
        <!-- A5：本页角色是单选（10-19 拍板），而后端契约 roleKeys 是数组 ⇒ 多角色账号必须当场说清会降级 -->
        <div v-if="multiRoleHint" class="small" style="margin-top: 2px; color: var(--warn-600, #b45309)">{{ multiRoleHint }}</div>
      </el-form-item>
      <!-- A2：院系可选可改（候选 = 编号 23 打通的本校子树全量）；不提供「主动摘掉院系」，理由写在提交分支的注释里 -->
      <el-form-item label="所属院系" prop="deptId">
        <el-select v-model="form.deptId" filterable clearable style="width: 100%" :placeholder="formMode === 'create' ? '示例大学（默认）' : '选择院系'">
          <el-option v-for="o in deptOptions" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
        <div v-if="deptWasEmpty" class="small muted" style="margin-top: 2px">该账号当前未入院系；不选则保持不变，选一个院系即归入</div>
      </el-form-item>
      <el-form-item label="工号/学号" prop="userNo">
        <el-input v-model="form.userNo" />
        <span v-if="!form.userNo" class="fc-ph">教师填工号，学生填学号</span>
      </el-form-item>
      <el-form-item label="手机号" prop="phone">
        <el-input v-model="form.phone" maxlength="11" />
        <span v-if="!form.phone" class="fc-ph">选填</span>
      </el-form-item>
      <el-form-item label="邮箱" prop="email">
        <el-input v-model="form.email" />
        <span v-if="!form.email" class="fc-ph">选填</span>
      </el-form-item>
      <el-form-item label="备注" prop="remark">
        <el-input v-model="form.remark" type="textarea" :rows="2" />
        <!-- 编辑态会把原备注回填进来，所以「留空」在两种来源下语义不同，提示分开写 -->
        <span v-if="!form.remark" class="fc-ph ta">{{ formMode === 'create' ? '选填' : '留空并保存会清掉该账号的原备注' }}</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
    </template>
  </el-dialog>

  <!-- 重置密码结果 -->
  <el-dialog v-model="pwdVisible" :title="pwdTitle" width="420px">
    <p class="muted small" style="margin-top: 0">{{ pwdLead }}</p>
    <div class="rowline" style="margin-top: 10px">
      <span class="mono" style="font-size: 16px; font-weight: 700">{{ pwdResult }}</span>
      <el-button text @click="copyPwd">
        <ZkIcon name="copy" :size="14" style="margin-right: 3px" />复制
      </el-button>
    </div>
    <template #footer>
      <el-button type="primary" @click="pwdVisible = false">知道了</el-button>
    </template>
  </el-dialog>

  <!-- 查看详情 -->
  <el-dialog v-model="detailVisible" title="账号详情" width="480px">
    <div v-if="detailRow" class="stack" style="gap: 10px">
      <div class="pf-row"><span class="k">登录账号</span><span>{{ detailRow.username }}</span></div>
      <div class="pf-row"><span class="k">姓名</span><span>{{ detailRow.nickName }}</span></div>
      <div class="pf-row"><span class="k">角色</span><span>{{ rolesText(detailRow) }}</span></div>
      <div class="pf-row"><span class="k">状态</span><span class="badge" :class="statusBadge(detailRow.status)">{{ statusLabel(detailRow.status) }}</span></div>
      <div class="pf-row"><span class="k">邮箱</span><span>{{ detailRow.email || '—' }}</span></div>
      <div class="pf-row"><span class="k">手机号</span><span>{{ detailRow.phone || '—' }}</span></div>
      <div class="pf-row"><span class="k">工号/学号</span><span>{{ detailRow.userNo || '—' }}</span></div>
      <div class="pf-row"><span class="k">所属学校</span><span>{{ detailRow.schoolName || '—' }}</span></div>
      <div class="pf-row"><span class="k">所属院系</span><span>{{ detailRow.deptName || '—' }}</span></div>
      <div class="pf-row"><span class="k">创建时间</span><span>{{ detailRow.createTime || '—' }}</span></div>
      <div class="pf-row"><span class="k">首次登录需改密</span><span>{{ detailRow.mustChangePwd ? '是' : '否' }}</span></div>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>

  <!-- 批量导入（B-8） -->
  <el-dialog v-model="importVisible" title="批量导入账号" width="520px">
    <div class="stack" style="gap: 12px">
      <div class="small muted" style="line-height: 1.7">
        1. 先<a href="javascript:void(0)" style="color: var(--brand-600)" @click="onDownloadTemplate">下载导入模板</a>，
        按列头填好（<b>登录账号</b>、<b>角色标识</b>必填；角色标识只能填 <code>teacher</code> / <code>student</code> / <code>admin</code>，
        与后端白名单逐字一致，填别的值只有该行失败、其余行照常导入）；<br />
        2. 模板里的「状态」「最近登录」「创建时间」三列是导出留档用的，导入时忽略，填了不生效；<br />
        3. 新导入的账号一律发默认密码 <b>zk123456</b>，首次登录强制改密，与手工新建口径一致；<br />
        4. 单次最多 500 行；导入 admin（管理员）角色行需要超级管理员身份；<br />
        5. 导入的账号统一归入<b>示例大学</b>（模板不含院系列，院系名在校内不唯一、按名称解析必歧义）；需归入具体学院，请导入后用该行的「编辑」改。
      </div>
      <label class="imp-file" :class="{ active: importFile }">
        <input type="file" accept=".xlsx,.xls" @change="onFilePick" />
        <ZkIcon name="upload" :size="18" />
        <span>{{ importFile ? importFile.name : '点击选择 Excel 文件' }}</span>
      </label>
      <div class="row" style="gap: 8px">
        <el-switch v-model="importUpdateSupport" />
        <span class="small">账号已存在时执行更新（关闭则跳过该行）</span>
      </div>
      <div v-if="importResult" class="imp-result">
        <div>
          结果：新建 <b>{{ importResult.created }}</b>，更新 <b>{{ importResult.updated }}</b>，
          跳过 <b>{{ importResult.skipped }}</b>，失败 <b>{{ importResult.failed }}</b>
        </div>
        <ul v-if="importResult.errors.length" class="imp-errors">
          <li v-for="(e, i) in importResult.errors" :key="i">{{ e }}</li>
        </ul>
      </div>
    </div>
    <template #footer>
      <el-button @click="importVisible = false">关闭</el-button>
      <el-button type="primary" :loading="importing" :disabled="!importFile" @click="onSubmitImport">开始导入</el-button>
    </template>
  </el-dialog>

  <!-- F-1 账号足迹抽屉（登录记录 + 操作记录，复用若依自带日志表） -->
  <el-drawer v-model="fpVisible" size="460px" :with-header="true">
    <template #header>
      <div>
        <div style="font-size: 15px; font-weight: 500">账号足迹 · {{ fpData?.userName || '…' }}</div>
        <div class="small muted" style="margin-top: 2px">登录与操作历史（数据来自系统日志）</div>
      </div>
    </template>
    <div v-loading="fpLoading">
      <template v-if="fpData">
        <div class="fp-metrics">
          <div class="fp-metric">
            <span class="k">累计登录</span>
            <span class="v">{{ fpData.loginTotal }}</span>
          </div>
          <div class="fp-metric">
            <span class="k">近 7 天操作</span>
            <span class="v">{{ fpData.weekOperCount }}</span>
          </div>
        </div>
        <div class="fp-tabs">
          <button :class="{ on: fpTab === 'logins' }" @click="fpTab = 'logins'">登录记录</button>
          <button :class="{ on: fpTab === 'opers' }" @click="fpTab = 'opers'">操作记录</button>
        </div>
        <div v-if="fpTab === 'logins'" class="fp-list">
          <div v-for="it in fpData.logins" :key="it.infoId" class="fp-item">
            <div class="fp-item-head">
              <span :class="it.status === '0' ? 'fp-ok' : 'fp-bad'">{{ it.status === '0' ? '登录成功' : '登录失败' }}</span>
              <span class="fp-time">{{ it.loginTime }}</span>
            </div>
            <div class="fp-item-sub">
              {{ [it.browser, it.os, it.ipaddr].filter(Boolean).join(' · ') || '—' }}
            </div>
          </div>
          <div v-if="!fpData.logins.length" class="small muted" style="padding: 12px 0">暂无登录记录</div>
        </div>
        <div v-else class="fp-list">
          <div v-for="it in fpData.opers" :key="it.operId" class="fp-item">
            <div class="fp-item-head">
              <span :class="it.status === '0' ? 'fp-ok' : 'fp-bad'">
                {{ bizTypeLabel(it.businessType) }} · {{ it.title }}{{ it.status === '0' ? '' : '（失败）' }}
              </span>
              <span class="fp-time">{{ it.operTime }}</span>
            </div>
            <div class="fp-item-sub">
              {{ [it.requestMethod, it.operIp].filter(Boolean).join(' · ') }}
              <span v-if="it.errorMsg" class="fp-bad">{{ it.errorMsg }}</span>
            </div>
          </div>
          <div v-if="!fpData.opers.length" class="small muted" style="padding: 12px 0">暂无操作记录</div>
        </div>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
/* 工具栏允许换行：共享样式 .toolbar 是 flex + nowrap（theme.css:216-217），窄视口下不会折行、只会溢出。
   真页面实测（同源 iframe 造视口，10-23）：左组固有宽 425 + 右组 878 + 间距 12 + 内边距 32 = 单行需 1347px，
   加侧栏 224 与主区内边距 56 ⇒ 视口要到 ~1627px 才容得下单行；1366 可用 1069、1440 可用 1143 ⇒ 都会折成两行（实测高 102px）。
   折行只压纵向高度、不裁内容（实测溢出 0、搜索单元仍 380），所以保留 wrap 兜底；
   ≤1679px 另走「筛选」浮层：右组缩成 搜索 380 + 开关 58~94 + 重置 46 + 两处间距 20 = 504~540，
   与左组 425 相加 973~1009 ≤ 1069 ⇒ 1366 起回到单行（开关带计数时最宽 540，仍放得下）。
   .right 也要能换行：只给 .toolbar 换行时，1024 视口下右组 878 > 可用 711，仍溢出 151px。
   只改本页作用域（scoped 选择器带 data-v，不影响其它页面的 .toolbar），共享 theme.css 不动。 */
.toolbar {
  flex-wrap: wrap;
}
.toolbar .right {
  flex-wrap: wrap;
}

/* 筛选组：宽视口就地平铺（.right 的直接子项换成这一个组，项间距仍按 theme.css .right 的 10px，
   4 个间隔位不变 ⇒ 总宽与收纳前一致，不会因多包一层而变宽）；
   窄视口换成「筛选」开关 + 绝对定位浮层，浮层里竖排、下拉拉满宽度（内联 style 的宽度只能用 !important 覆盖）。 */
.filter-host {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
}
.filter-panel {
  display: flex;
  align-items: center;
  gap: 10px;
}
.filter-host.compact .filter-panel {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: 220px;
  padding: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--sh-2, 0 8px 24px rgba(15, 23, 42, 0.12));
}
.filter-host.compact.open .filter-panel {
  display: flex;
}
.filter-host.compact :deep(.el-select) {
  width: 100% !important;
}

/* 列表底部：导入 / 导出（从工具栏移下来） */
.table-foot-bar {
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
/* 院系下拉「候选可能不全」提示：只在账号总数超过快照大小时出现 */
.dept-foot-tip {
  line-height: 1.6;
  white-space: normal;
}

/* F-1 足迹抽屉 */
.fp-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}
.fp-metric {
  background: var(--surface-2, #f6f7f9);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fp-metric .k {
  font-size: 12px;
  color: var(--muted, #8a8f99);
}
.fp-metric .v {
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
}
.fp-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.fp-tabs button {
  border: 0.5px solid var(--border, #e2e4e9);
  background: transparent;
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  color: var(--muted, #8a8f99);
  cursor: pointer;
}
.fp-tabs button.on {
  background: var(--brand-50, #eef4ff);
  color: var(--brand-600, #2f6bff);
  border-color: transparent;
}
.fp-list {
  display: flex;
  flex-direction: column;
}
.fp-item {
  padding: 8px 0 8px 12px;
  border-left: 2px solid var(--border, #e2e4e9);
  margin-left: 2px;
}
.fp-item + .fp-item {
  margin-top: 4px;
}
.fp-item-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.fp-time {
  font-size: 12px;
  color: var(--muted, #8a8f99);
  white-space: nowrap;
}
.fp-item-sub {
  font-size: 12px;
  color: var(--muted, #8a8f99);
  margin-top: 2px;
  word-break: break-all;
}
.fp-ok {
  color: var(--success, #22a06b);
}
.fp-bad {
  color: var(--error, #e5484d);
  margin-left: 6px;
}
/* 操作列：查看 / 编辑 常驻，其余四项（足迹、重置密码、停用启用、删除）收进「更多」下拉。
   为什么收：常驻 6 个按钮在真页面实测内容宽 343px + 单元格左右内边距 24px = 需 367px，列宽给到 390；
   八列合计 1276px 超过 1366 视口可用的 1069px（差 207）⇒「重置密码/停用/删除」落到可视区外，
   而横向滚动条不可见（EP 自绘条 display:none、容器 scrollbar-width:none）⇒ 使用方看不出右边还有按钮。
   收纳后的列宽按实测取（同一份收紧规则在 Chrome 150 里量 .workbuddy/tmp/fe-jia/measure-more-col.html）：
   查看 55 + 编辑 38 + 更多 38 + 两处间距 16 ⇒ 内容需 154、加内边距 178 ⇒ 列宽给 196（余 18）。
   八列合计随之降到 1054 ≤ 1069 ⇒ 1366 起不必横向滚动；≤1280 仍要滚，所以该列另加 fixed="right" 钉在右侧。
   EP 的 text 按钮只换颜色与边框，内边距仍由 size 给
   （theme-chalk/el-button.css：.el-button--small{padding:5px 11px} 与 .el-button+.el-button{margin-left:12px}）⇒ 一并收紧。 */
:deep(.op-col) .cell {
  white-space: nowrap;
}
:deep(.op-col) .el-button {
  padding: 5px 7px;
}
:deep(.op-col) .el-button + .el-button {
  margin-left: 8px;
}
:deep(.op-col) .el-button + .el-dropdown {
  margin-left: 8px;
}
/* EP 的 .el-dropdown 自带 margin-top:-1px 与 vertical-align:top，跟同行的 text 按钮会对不齐 */
:deep(.op-col) .el-dropdown {
  margin-top: 0;
  vertical-align: middle;
}
:deep(.op-col) .op-more {
  margin: 0;
}

/* 表单标签对齐：星号绝对定位脱离文字流，所有标签统一 padding-left:12px
   → 必填/选填文字左缘由同一条规则决定，严格同列，不受星形字形宽度影响 */
:deep(.el-form-item.is-required) > .el-form-item__label {
  position: relative;
  padding-left: 12px;
}
:deep(.el-form-item.is-required) > .el-form-item__label::before {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: auto;
  margin-right: 0;
}
:deep(.el-form-item:not(.is-required)) > .el-form-item__label {
  padding-left: 12px;
}

/* ===== 以下两套控件与课程审核页同款（保持全后台一致） ===== */

/* 自定义合并式分页器：‹ [页码] / N 页 | 跳转 › 整合进同一个边框容器 */
.mini-pager {
  display: flex;
  align-items: stretch;
  width: fit-content;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.mini-pager:focus-within {
  border-color: var(--brand-400);
  box-shadow: 0 0 0 3px var(--brand-100);
}
.mp-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--ink-600);
  cursor: pointer;
  padding: 0;
}
.mp-btn:hover:not(:disabled) {
  color: var(--primary-hover);
  background: var(--primary-softer);
}
.mp-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mp-input {
  box-sizing: border-box;
  width: 32px;
  height: 100%;
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  text-align: center;
  font-family: inherit;
  font-size: 13px;
  color: var(--ink-900);
  padding: 0;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
.mp-input::-webkit-outer-spin-button,
.mp-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.mp-input:focus {
  box-shadow: none;
}
.mp-total {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 400;
  color: var(--ink-600);
  padding: 0 6px 0 2px;
  cursor: default;
  user-select: none;
}
.mp-go {
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--primary-hover);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 12px;
  height: 100%;
}
.mp-go:hover {
  background: var(--primary-softer);
}
.mp-go + .mp-btn {
  border-left: 1px solid var(--border);
}

/* 搜索整体单元：图标 + 输入 + 清空 + 搜索按钮合为一个带边框圆角的控件 */
/* 380px（原 300px）：占位文案「搜索账号 / 姓名 / 手机号 / 工号学号」实测宽 217px
   （离线复刻页在 Chrome 150 里量 .su-ph 的 offsetWidth；我先前口算 ~245px，偏大 28）。
   输入区（.su-field）可用宽 = 单元总宽 − 图标区 28px（14 图标 + 左 10 右 4 边距）− 「搜索」按钮 54px（实测）− 上下边框 1px×2。
   ⇒ 300px 时实测只剩 217px（占位文案要 217px）＝ 零余量，文案 nowrap 正好压在「搜索」按钮左缘上
     （2026-10-22 用户反馈，复刻页 phHitsBtn=true）；
     380px 时实测输入区 297px，余 80px，键入后出现的清空按钮（18px + 2px 右边距 = 20px）也吃得下。 */
.search-unit {
  display: flex;
  align-items: stretch;
  width: 380px;
  height: 30px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.search-unit:focus-within {
  border-color: var(--brand-400);
  box-shadow: 0 0 0 3px var(--brand-100);
}
.su-icon {
  align-self: center;
  margin: 0 4px 0 10px;
  color: var(--ink-400);
  flex: none;
}
.su-field {
  position: relative;
  flex: 1;
  min-width: 0;
}
.su-input {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  line-height: 28px;
  color: var(--ink-900);
  padding: 0 4px;
}
/* 自绘占位文案：不响应鼠标事件、不可选中复制 */
.su-ph {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: var(--ink-400);
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}
/* ★ 弹窗表单占位文案同款防复制方案（父级 .el-form-item__content 自带 position:relative） */
.fc-ph {
  position: absolute;
  left: 12px;
  top: 0;
  height: 32px;
  display: flex;
  align-items: center;
  font-size: 14px;
  color: var(--ink-400);
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}
/* textarea 多行版：贴左上角，不垂直居中 */
.fc-ph.ta {
  top: 6px;
  height: auto;
  display: block;
  line-height: 1.5;
}
/* 下拉框占位文字同样不可选中 */
:deep(.el-select__placeholder) {
  user-select: none;
}
.su-clear {
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 2px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-400);
  cursor: pointer;
  padding: 0;
}
.su-clear:hover {
  background: var(--bg-soft);
  color: var(--ink-700);
}
.su-btn {
  flex: none;
  border: none;
  background: var(--primary-soft);
  color: var(--primary-hover);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 14px;
}
.su-btn:hover {
  background: var(--brand-200);
}

.imp-file {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 12px;
  border: 1px dashed var(--line-400, #ccc);
  border-radius: 8px;
  cursor: pointer;
  color: var(--ink-600, #666);
  transition: border-color 0.15s;
}
.imp-file:hover {
  border-color: var(--brand-600, #4a7dff);
}
.imp-file.active {
  border-color: var(--brand-600, #4a7dff);
  color: var(--ink-900, #111);
}
.imp-file input {
  display: none;
}
.imp-result {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-100, #f6f7fa);
  font-size: 12px;
  line-height: 1.7;
}
.imp-errors {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--danger-600, #d54941);
  max-height: 140px;
  overflow: auto;
}
</style>
