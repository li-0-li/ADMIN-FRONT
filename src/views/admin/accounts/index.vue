<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserStatus
} from '@/api/admin/users';
import type { AdminUserVo, UserSaveBo } from '@/types/admin';

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
const query = reactive({ page: 1, pageSize: 10, keyword: '', roleKey: '' });

async function fetchList() {
  loading.value = true;
  try {
    const res = await listUsers(query);
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
  } finally {
    loading.value = false;
  }
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

onMounted(fetchList);

/** 若依字典 sys_normal_disable：'0' 正常/启用，'1' 停用；统一转字符串比较，兼容后端返回数字 */
const statusLabel = (s: unknown) => (String(s) === '0' ? '启用' : '停用');
const statusBadge = (s: unknown) => (String(s) === '0' ? 'badge-success' : 'badge-neutral');

function rolesText(row: AdminUserVo) {
  const keys = row.roleKeys ?? [];
  if (!keys.length) return '—';
  return keys.map(k => ROLE_LABEL[k] ?? k).join('、');
}
function primaryRoleKey(row: AdminUserVo) {
  return (row.roleKeys ?? [])[0] ?? 'common';
}

/* ---------------- 新增 / 编辑 ---------------- */
const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const saving = ref(false);
const form = reactive<UserSaveBo>({});

function openCreate() {
  formMode.value = 'create';
  Object.assign(form, { userId: undefined, username: '', nickName: '', email: '', phone: '', roleKeys: ['teacher'], deptId: 200, userNo: '', remark: '' });
  formVisible.value = true;
}

function openEdit(row: AdminUserVo) {
  formMode.value = 'edit';
  Object.assign(form, {
    userId: row.userId,
    username: row.username,
    nickName: row.nickName,
    email: row.email,
    phone: row.phone,
    roleKeys: [...(row.roleKeys ?? [])],
    deptId: row.deptId,
    userNo: row.userNo ?? '',
    remark: ''
  });
  formVisible.value = true;
}

async function submitForm() {
  if (!form.username || !form.nickName) {
    ElMessage.warning('登录账号与用户名为必填');
    return;
  }
  saving.value = true;
  try {
    if (formMode.value === 'create') {
      const res = await createUser({ ...form });
      ElMessage.success('新增成功');
      if (res?.tempPassword) {
        ElMessageBox.alert(`一次性临时口令：${res.tempPassword}`, '请转交给使用者', { confirmButtonText: '知道了' });
      }
    } else {
      // ★ PUT /users 没有 path 段，userId 在 body 里
      await updateUser({ ...form });
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
async function copyPwd() {
  if (!pwdResult.value) return;
  try {
    await navigator.clipboard.writeText(pwdResult.value);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.warning('复制失败，请手动选中复制');
  }
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
      <el-input
        v-model="query.keyword"
        placeholder="搜索账号 / 姓名 / 邮箱"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
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
          <el-button text size="small" @click="openEdit(row)">编辑</el-button>
          <el-button text size="small" @click="doResetPwd(row)">
            <ZkIcon name="key-round" :size="14" style="margin-right: 3px" />重置密码
          </el-button>
          <el-button text size="small" @click="toggleStatus(row)">{{ row.status === '0' ? '停用' : '启用' }}</el-button>
          <el-button text size="small" style="color: var(--error)" @click="doDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">共 {{ total }} 条记录</span>
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="prev, pager, next, sizes"
        @current-change="fetchList"
        @size-change="onSearch"
      />
    </div>
  </div>

  <!-- 新增 / 编辑 -->
  <el-dialog v-model="formVisible" :title="formMode === 'create' ? '新增账号' : '编辑账号'" width="480px">
    <el-form label-width="86px" label-position="left">
      <el-form-item label="登录账号" required>
        <el-input v-model="form.username" :disabled="formMode === 'edit'" placeholder="用于登录，创建后不可改" />
      </el-form-item>
      <el-form-item label="用户名" required>
        <el-input v-model="form.nickName" placeholder="真实姓名" />
      </el-form-item>
      <el-form-item label="角色">
        <el-select v-model="form.roleKeys" multiple style="width: 100%">
          <el-option v-for="o in ROLE_OPTIONS.filter(x => x.value)" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="form.email" placeholder="选填" />
      </el-form-item>
      <el-form-item label="手机号">
        <el-input v-model="form.phone" placeholder="选填" />
      </el-form-item>
      <el-form-item label="工号/学号">
        <el-input v-model="form.userNo" placeholder="选填" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="选填" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="formVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
    </template>
  </el-dialog>

  <!-- 重置密码结果 -->
  <el-dialog v-model="pwdVisible" title="重置密码" width="420px">
    <p class="muted small" style="margin-top: 0">后端已生成一次性临时口令，原密码立即失效，有效期 24 小时。</p>
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
</style>
