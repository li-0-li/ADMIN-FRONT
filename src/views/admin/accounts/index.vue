<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus
} from '@/api/admin/users';
import type { AdminUserVo } from '@/types/admin';
import { useUserStore } from '@/store/user';

/* ---------------- 词典 ---------------- */
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
/** 角色下拉选项（口径取自演示库实际存在的 roleKey） */
const ROLE_OPTIONS = [
  { value: '', label: '全部角色' },
  { value: 'admin', label: '管理员' },
  { value: 'teacher', label: '教师' },
  { value: 'student', label: '学生' }
];

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<AdminUserVo[]>([]);
const total = ref(0);
const query = reactive({ page: 1, pageSize: 20, keyword: '', roleKey: '' });

async function fetchList() {
  loading.value = true;
  try {
    const res = await listUsers(query);
    // ★ 本地排序：最新创建的排最上面（createTime 为 'yyyy-MM-dd HH:mm:ss'，字符串比较即时间序）
    rows.value = [...(res?.list ?? [])].sort((a, b) => String(b.createTime ?? '').localeCompare(String(a.createTime ?? '')));
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
  fetchList();
}

function onSearch() {
  query.page = 1;
  fetchList();
}

function resetQuery() {
  query.keyword = '';
  query.roleKey = '';
  query.page = 1;
  fetchList();
}

/** ✕ 仅清关键字（不动角色筛选），与课程审核页口径一致 */
function clearKeyword() {
  query.keyword = '';
  query.page = 1;
  fetchList();
}

onMounted(fetchList);

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
 */
const isAdminUser = (row: AdminUserVo) => row.userId === 1;
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
  if (row.userId === 1) return ADMIN_LOCK_TIP;
  if (!isSuperAdmin.value && isAdminRow(row) && row.username !== userStore.username) return ADMIN_EDIT_TIP;
  return null;
}
/** 重置密码专用锁（用户拍板 10-19 16:00）：非超管对管理员角色的行一律不可重置，含自己的行（自己改密走右上角「修改密码」） */
function resetLockTip(row: AdminUserVo): string | null {
  if (row.userId === 1) return ADMIN_LOCK_TIP;
  if (!isSuperAdmin.value && isAdminRow(row)) return ADMIN_RESET_TIP;
  return null;
}
/** 编辑/新增时表单里可用的角色选项：非超管不给「管理员」，但编辑管理员本人时保留原值可显示 */
const formRoleOriginal = ref('');
const roleOptionsForForm = computed(() => {
  const all = ROLE_OPTIONS.filter(x => x.value);
  if (isSuperAdmin.value || form.role === 'admin') return all;
  return all.filter(x => x.value !== 'admin');
});

/* ---------------- 新增 / 编辑 ---------------- */
const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const saving = ref(false);
/** 表单模型（含单选角色，提交时包成后端要求的 roleKeys 数组） */
const form = reactive<{ username: string; nickName: string; email: string; phone: string; userNo: string; remark: string; role: string; userId?: number }>({ username: '', nickName: '', email: '', phone: '', userNo: '', remark: '', role: '', userId: undefined });
const formRef = ref<FormInstance>();
/** 编辑超管时锁死角色下拉（双保险：行按钮已禁用，弹窗内再兜一层） */
const editingAdmin = computed(() => formMode.value === 'edit' && form.userId === 1);

/* 表单校验（用户拍板 10-19）：必填=登录账号/用户名/角色/工号学号；选填但格式校验=邮箱/手机号。
   错误以内联红字显示在输入框下方。 */
const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const rules: FormRules = {
  username: [{ required: true, message: '登录账号为必填', trigger: 'blur' }],
  nickName: [{ required: true, message: '用户名为必填', trigger: 'blur' }],
  role: [{ required: true, message: '角色为必选', trigger: 'change' }],
  userNo: [{ required: true, message: '工号/学号为必填', trigger: 'blur' }],
  email: [{ pattern: EMAIL_RE, message: '邮箱格式不正确', trigger: 'blur' }],
  phone: [{ pattern: PHONE_RE, message: '手机号格式不正确', trigger: 'blur' }]
};

function openCreate() {
  formMode.value = 'create';
  Object.assign(form, { username: '', nickName: '', email: '', phone: '', userNo: '', remark: '', role: '', userId: undefined });
  formRoleOriginal.value = '';
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
    remark: '',
    role: (row.roleKeys ?? [])[0] ?? 'common'
  });
  formRoleOriginal.value = form.role;
  formRef.value?.clearValidate();
  formVisible.value = true;
}

async function submitForm() {
  // 管理权收敛：非超管不能创建/提升为管理员角色（编辑管理员本人保持原角色不拦）
  if (!isSuperAdmin.value && form.role === 'admin' && formRoleOriginal.value !== 'admin') {
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
    // 后端 BO 收 roleKeys 数组（若依 sys_user_role 关联表），单选包一层
    const payload = { ...form, roleKeys: [form.role], deptId: 200 };
    if (formMode.value === 'create') {
      const res = await createUser(payload);
      ElMessage.success('新增成功');
      if (res?.tempPassword) {
        pwdTitle.value = '请转交给使用者';
        pwdResult.value = res.tempPassword;
        pwdVisible.value = true;
      }
    } else {
      // 编辑时带原 userId（★ PUT /users 没有 path 段，userId 在 body 里）
      await updateUser({ ...payload });
      ElMessage.success('保存成功');
    }
    formVisible.value = false;
    fetchList();
  } finally {
    saving.value = false;
  }
}

/* ---------------- 启停 / 重置密码 / 删除 ---------------- */
async function toggleStatus(row: AdminUserVo) {
  const next = row.status === '0' ? '1' : '0';
  await ElMessageBox.confirm(`确定要${next === '0' ? '启用' : '停用'}账号「${row.username}」吗？`, '提示', { type: 'warning' });
  // ★ status 走 query
  await updateUserStatus(row.userId, next);
  ElMessage.success('操作成功');
  fetchList();
}

const pwdVisible = ref(false);
const pwdResult = ref('');
const pwdTitle = ref('重置密码');
async function doResetPwd(row: AdminUserVo) {
  await ElMessageBox.confirm(`确定要重置账号「${row.username}」的登录密码吗？原密码将立即失效。`, '重置密码', { type: 'warning' });
  const res = await resetUserPassword(row.userId);
  pwdResult.value = res?.tempPassword ?? '';
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
  await ElMessageBox.confirm(`确定要删除账号「${row.username}」吗？`, '删除账号', { type: 'warning', confirmButtonText: '删除' });
  await deleteUser(row.userId);
  ElMessage.success('已删除');
  fetchList();
}

/* ---------------- 查看详情 ---------------- */
const detailVisible = ref(false);
const detailRow = ref<AdminUserVo | null>(null);
function openDetail(row: AdminUserVo) {
  detailRow.value = row;
  detailVisible.value = true;
}
</script>

<template>
  <div class="page-head">
    <h1>账号管理</h1>
    <div class="actions">
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
    </div>
    <div class="right">
      <!-- 搜索整体单元（与课程审核页同款）：占位文案用覆盖层，物理杜绝选中复制 -->
      <div class="search-unit">
        <ZkIcon name="search" :size="14" class="su-icon" />
        <div class="su-field">
          <input
            v-model="query.keyword"
            class="su-input"
            aria-label="搜索账号 / 姓名 / 邮箱"
            @keyup.enter="onSearch"
          />
          <span v-if="!query.keyword" class="su-ph">搜索账号 / 姓名 / 邮箱</span>
        </div>
        <button v-if="query.keyword" class="su-clear" title="清空" aria-label="清空搜索" @click="clearKeyword">
          <ZkIcon name="x" :size="13" />
        </button>
        <button class="su-btn" @click="onSearch">搜索</button>
      </div>
      <span class="muted small">角色筛选</span>
      <el-select v-model="query.roleKey" style="width: 130px" @change="onSearch">
        <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button text @click="resetQuery">重置</el-button>
    </div>
  </div>

  <div class="card">
    <el-table v-loading="loading" :data="rows" style="width: 100%">
      <el-table-column label="用户名" min-width="240">
        <template #default="{ row }">
          <div class="row" style="gap: 8px">
            <span class="avatar sm">{{ (row.nickName || row.username || '?').slice(0, 1) }}</span>
            <span>
              <div style="font-weight: 600; color: var(--ink-900)">{{ row.username }}</div>
              <div class="small muted">{{ row.nickName }}<span v-if="row.email"> · {{ row.email }}</span></div>
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="角色" min-width="110">
        <template #default="{ row }">
          <span class="badge" :class="ROLE_BADGE[primaryRoleKey(row)]">{{ rolesText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span class="badge" :class="statusBadge(row.status)">{{ statusLabel(row.status) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="170" prop="createTime" />
      <el-table-column label="操作" width="400" align="right" class-name="op-col">
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
          <el-button
            text size="small"
            :disabled="!!resetLockTip(row)"
            :title="resetLockTip(row) ?? undefined"
            @click="doResetPwd(row)"
          >
            <ZkIcon name="key-round" :size="14" style="margin-right: 3px" />重置密码
          </el-button>
          <el-button
            text size="small"
            :disabled="!!opLockTip(row)"
            :title="opLockTip(row) ?? undefined"
            @click="toggleStatus(row)"
          >{{ row.status === '0' ? '停用' : '启用' }}</el-button>
          <el-button
            text size="small"
            style="color: var(--error)"
            :disabled="!!opLockTip(row)"
            :title="opLockTip(row) ?? undefined"
            @click="doDelete(row)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="between page-foot" style="padding: 12px 16px">
      <span class="small muted">共 {{ total }} 条记录</span>
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
      <el-form-item label="用户名" prop="nickName">
        <el-input v-model="form.nickName" />
        <span v-if="!form.nickName" class="fc-ph">真实姓名</span>
      </el-form-item>
      <el-form-item label="角色" prop="role">
        <el-select v-model="form.role" style="width: 100%" :disabled="editingAdmin" placeholder="请选择角色">
          <el-option v-for="o in roleOptionsForForm" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <div v-if="editingAdmin" class="small muted" style="margin-top: 2px">超级管理员角色不可修改</div>
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
        <span v-if="!form.remark" class="fc-ph ta">选填</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
    </template>
  </el-dialog>

  <!-- 重置密码结果 -->
  <el-dialog v-model="pwdVisible" :title="pwdTitle" width="420px">
    <p class="muted small" style="margin-top: 0">已重置为默认密码，原密码立即失效。对方首次登录时须修改为新密码。</p>
    <div class="rowline" style="margin-top: 10px">
      <span class="mono" style="font-size: 16px; font-weight: 700">{{ pwdResult }}</span>
      <el-button text @click="copyPwd">
        <ZkIcon name="check" :size="14" style="margin-right: 3px" />复制
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
      <div class="pf-row"><span class="k">用户名</span><span>{{ detailRow.nickName }}</span></div>
      <div class="pf-row"><span class="k">角色</span><span>{{ rolesText(detailRow) }}</span></div>
      <div class="pf-row"><span class="k">状态</span><span class="badge" :class="statusBadge(detailRow.status)">{{ statusLabel(detailRow.status) }}</span></div>
      <div class="pf-row"><span class="k">邮箱</span><span>{{ detailRow.email || '—' }}</span></div>
      <div class="pf-row"><span class="k">手机号</span><span>{{ detailRow.phone || '—' }}</span></div>
      <div class="pf-row"><span class="k">工号/学号</span><span>{{ detailRow.userNo || '—' }}</span></div>
      <div class="pf-row"><span class="k">所属学校</span><span>{{ detailRow.schoolName || '—' }}</span></div>
      <div class="pf-row"><span class="k">所属院系</span><span>{{ detailRow.deptName || '—' }}</span></div>
      <div class="pf-row"><span class="k">创建时间</span><span>{{ detailRow.createTime }}</span></div>
      <div class="pf-row"><span class="k">首次登录需改密</span><span>{{ detailRow.mustChangePwd ? '是' : '否' }}</span></div>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 操作列有 5 个动作，窄列会把按钮挤成两行、撑高行高 —— 强制单行 */
:deep(.op-col) .cell {
  white-space: nowrap;
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
.search-unit {
  display: flex;
  align-items: stretch;
  width: 300px;
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
</style>
