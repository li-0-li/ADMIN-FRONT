<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  assignRolePermissions,
  fetchPermissionTree,
  fetchRoleMenuIds,
  listRoles
} from '@/api/admin/roles';
import type { AdminRoleVo, PermissionNodeVo } from '@/types/admin';

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<AdminRoleVo[]>([]);

async function fetchList() {
  loading.value = true;
  try {
    rows.value = (await listRoles()) ?? [];
  } finally {
    loading.value = false;
  }
}

function statusLabel(s: string) {
  return s === '0' ? '正常' : '停用';
}
function statusBadge(s: string) {
  return s === '0' ? 'badge-success' : 'badge-neutral';
}

/* ---------------- 权限配置弹窗 ---------------- */
const permVisible = ref(false);
const permLoading = ref(false);
const permSaving = ref(false);
const currentRole = ref<AdminRoleVo | null>(null);
const treeData = ref<PermissionNodeVo[]>([]);
const treeRef = ref();
/** 勾选期间开 strictly，回显已授权集合不做父子级联；nextTick 后关掉恢复级联交互 */
const checkStrictly = ref(false);

async function openPerms(row: AdminRoleVo) {
  currentRole.value = row;
  permVisible.value = true;
  permLoading.value = true;
  try {
    const [tree, menuIds] = await Promise.all([fetchPermissionTree(), fetchRoleMenuIds(row.roleId)]);
    treeData.value = tree ?? [];
    checkStrictly.value = true;
    await nextTick();
    treeRef.value?.setCheckedKeys(menuIds ?? []);
    await nextTick();
    checkStrictly.value = false;
  } finally {
    permLoading.value = false;
  }
}

async function savePerms() {
  if (!currentRole.value) return;
  // 半选的父节点也要带上：B-8 是整表重建，丢了父级会导致菜单树断链
  const checked = [...treeRef.value.getCheckedKeys(), ...treeRef.value.getHalfCheckedKeys()];
  permSaving.value = true;
  try {
    await assignRolePermissions(currentRole.value.roleId, checked);
    ElMessage.success('权限已保存');
    permVisible.value = false;
    await fetchList();
  } finally {
    permSaving.value = false;
  }
}

onMounted(fetchList);
</script>

<template>
  <div class="page-head">
    <h1>角色管理</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="$router.push('/admin/accounts')">
        <ZkIcon name="arrow-left" :size="16" />返回账号管理
      </a>
    </div>
  </div>

  <div class="card">
    <div class="between" style="padding: 14px 16px 0">
      <span class="small muted">维护各角色的功能权限；角色成员在账号管理页分配</span>
    </div>
    <el-table v-loading="loading" :data="rows" style="margin-top: 10px">
      <el-table-column label="角色" min-width="140">
        <template #default="{ row }">
          <div class="role-name">
            {{ row.roleName }}
            <!-- 若依基座出厂演示角色（role_id=2），业务上未使用 -->
            <span v-if="row.roleId === 2" class="badge badge-neutral ry-tag">若依内置</span>
          </div>
          <div class="small muted">{{ row.roleKey }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span class="badge" :class="statusBadge(row.status)">{{ statusLabel(row.status) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="成员数" width="100" align="center">
        <template #default="{ row }">
          <!-- 成员反查：点击跳账号管理页并自动按该角色过滤 -->
          <el-link
            type="primary"
            :underline="false"
            :title="`查看「${row.roleName}」的账号列表`"
            @click="$router.push({ path: '/admin/accounts', query: { roleKey: row.roleKey } })"
          >
            {{ row.memberCount }}
          </el-link>
        </template>
      </el-table-column>
      <el-table-column label="已授权限数" width="130">
        <template #default="{ row }">
          <!-- 超管权力来自代码硬编码 *:*:*，不读授权表：64 只是管理端业务登记数，别误导 -->
          <span v-if="row.builtIn" class="small muted">全部权限（硬编码）</span>
          <span v-else>{{ row.menuCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="220" prop="remark">
        <template #default="{ row }">{{ row.remark || '—' }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="170" prop="createTime" />
      <el-table-column label="操作" width="140" align="right">
        <template #default="{ row }">
          <el-button
            text size="small"
            :disabled="!!row.builtIn"
            :title="row.builtIn ? '内置超级管理员无需分配权限' : undefined"
            @click="openPerms(row)"
          >
            <ZkIcon name="shield-check" :size="14" style="margin-right: 3px" />配置权限
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <!-- 配置权限 -->
  <el-dialog
    v-model="permVisible"
    :title="`配置权限 · ${currentRole?.roleName ?? ''}`"
    width="520px"
  >
    <div v-loading="permLoading" class="perm-tree-box">
      <el-tree
        ref="treeRef"
        :data="treeData"
        node-key="menuId"
        show-checkbox
        :check-strictly="checkStrictly"
        default-expand-all
        :props="{ label: 'menuName', children: 'children' }"
      >
        <template #default="{ data }">
          <span class="perm-node">
            {{ data.menuName }}
            <span v-if="data.perms" class="small muted perm-code">{{ data.perms }}</span>
          </span>
        </template>
      </el-tree>
    </div>
    <template #footer>
      <el-button @click="permVisible = false">取消</el-button>
      <el-button type="primary" :loading="permSaving" @click="savePerms">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.role-name {
  font-weight: 600;
}
.perm-tree-box {
  max-height: 52vh;
  overflow: auto;
}
.perm-node {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.perm-code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.ry-tag {
  margin-left: 6px;
  font-size: 11px;
}
</style>
