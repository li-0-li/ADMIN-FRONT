<script setup lang="ts">
/**
 * 师生管理（G6）两页共用的「左列表 + 右详情」骨架。
 * `/admin/teachers` 与 `/admin/students` 各自只传一个 `mode`，列表查询与详情加载逻辑只写一份。
 *
 * 数据来源：
 *  - 列表 = `GET /api/v1/admin/users?roleKey=teacher|student`（账号页同一套分页与筛选，实测可用）
 *  - 详情 = `GET /api/v1/admin/teachers|students/{userId}/profile`（聚合详情）
 * ★ 学生列表接口实测**不返回 roleKeys**（教师返回了）⇒ 列表渲染一律不依赖该字段。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import ProfileDetail from '@/components/ProfileDetail.vue';
import { listUsers } from '@/api/admin/users';
import { getStudentProfile, getTeacherProfile, type StudentProfile, type TeacherProfile } from '@/api/admin/profiles';
import type { AdminUserVo } from '@/types/admin';

const props = defineProps<{ mode: 'teacher' | 'student' }>();

const isTeacher = computed(() => props.mode === 'teacher');
const roleKey = computed(() => (isTeacher.value ? 'teacher' : 'student'));
const pageTitle = computed(() => (isTeacher.value ? '教师管理' : '学生管理'));
const pageHint = computed(() =>
  isTeacher.value
    ? '左侧选人，右侧看基本资料、可授课程与授课记录（按学期分组）。'
    : '左侧选人，右侧看基本资料与选课记录（本期只读）。'
);

/* ---------------- 列表 ---------------- */
const listLoading = ref(false);
const rows = ref<AdminUserVo[]>([]);
const total = ref(0);
const listError = ref('');
const query = reactive({ page: 1, pageSize: 10, keyword: '' });

async function fetchList(keepSelection = true) {
  listLoading.value = true;
  listError.value = '';
  try {
    const res = await listUsers({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      roleKey: roleKey.value
    });
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
    // 首屏（或当前选中的人被筛掉）自动选第一条，避免右侧空着让人多点一次
    const stillThere = rows.value.some((r) => String(r.userId) === selectedUserId.value);
    if (!keepSelection || !stillThere) {
      selectedUserId.value = rows.value.length ? String(rows.value[0].userId) : '';
    }
  } catch {
    rows.value = [];
    total.value = 0;
    selectedUserId.value = '';
    listError.value = '列表未取到，可点刷新重试。';
  } finally {
    listLoading.value = false;
  }
}

function onSearch() {
  query.page = 1;
  void fetchList(false);
}

/* ---------------- 详情 ---------------- */
const selectedUserId = ref('');
const detailLoading = ref(false);
const profile = ref<TeacherProfile | StudentProfile | null>(null);
const detailError = ref('');

async function loadProfile() {
  if (!selectedUserId.value) {
    profile.value = null;
    return;
  }
  detailLoading.value = true;
  detailError.value = '';
  profile.value = null;
  try {
    profile.value = isTeacher.value
      ? await getTeacherProfile(selectedUserId.value)
      : await getStudentProfile(selectedUserId.value);
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    // 后端对"账号角色不符"会回 500 + 中文说明（如「该账号不是学生」）——这不算前端故障，
    // 如实转述，别吞成"加载失败"
    detailError.value = msg || '详情未取到';
  } finally {
    detailLoading.value = false;
  }
}

watch(selectedUserId, () => { void loadProfile(); });

function selectRow(r: AdminUserVo) {
  selectedUserId.value = String(r.userId);
}

function statusText(s?: string | null) {
  if (s === undefined || s === null || s === '') return '—';
  return ({ '0': '正常', '1': '停用' } as Record<string, string>)[String(s)] ?? String(s);
}

function onSaved() {
  // 保存成功后刷新列表（昵称/状态可能改了）与详情
  void fetchList(true);
  void loadProfile();
}

onMounted(() => { void fetchList(false); });
</script>

<template>
  <div class="page-head">
    <h1>{{ pageTitle }}</h1>
    <div class="actions">
      <span class="small muted">{{ pageHint }}</span>
    </div>
  </div>

  <div class="g6-wrap">
    <!-- 左：账号列表 -->
    <div class="card g6-list">
      <div class="list-toolbar">
        <el-input
          v-model="query.keyword"
          :placeholder="isTeacher ? '姓名 / 工号' : '姓名 / 学号'"
          clearable
          size="small"
          @keyup.enter="onSearch"
          @clear="onSearch"
        >
          <template #prefix><ZkIcon name="search" :size="13" /></template>
        </el-input>
        <el-button class="tb-icon" size="small" :loading="listLoading" title="刷新" @click="fetchList(true)">
          <ZkIcon v-if="!listLoading" name="refresh-cw" :size="14" />
        </el-button>
      </div>

      <div v-loading="listLoading" class="list-body">
        <div v-if="listError" class="list-tip">
          <span>{{ listError }}</span>
        </div>
        <div v-else-if="!rows.length && !listLoading" class="empty-block">
          <ZkIcon :name="isTeacher ? 'graduation-cap' : 'user'" :size="24" />
          <div class="empty-title">{{ query.keyword ? '没有匹配的账号' : (isTeacher ? '还没有教师账号' : '还没有学生账号') }}</div>
          <div v-if="query.keyword" class="small muted">换个关键词，或清空搜索框。</div>
        </div>
        <div
          v-for="r in rows"
          :key="r.userId"
          class="list-row"
          :class="{ active: String(r.userId) === selectedUserId }"
          @click="selectRow(r)"
        >
          <div class="row-main">
            <span class="row-name">{{ r.nickName || r.username }}</span>
            <span class="row-acc mono">{{ r.username }}</span>
          </div>
          <span class="row-status" :class="{ off: String(r.status) === '1' }">{{ statusText(r.status) }}</span>
        </div>
      </div>

      <div v-if="total > query.pageSize" class="list-pager">
        <el-pagination
          v-model:current-page="query.page"
          :page-size="query.pageSize"
          :total="total"
          layout="prev, pager, next"
          small
          @current-change="() => fetchList(false)"
        />
      </div>
    </div>

    <!-- 右：详情（两页共用） -->
    <div class="card card-pad g6-detail">
      <div v-if="detailError" class="banner-err">
        <ZkIcon name="alert-triangle" :size="15" style="flex: none; margin-top: 1px" />
        <span>{{ detailError }}</span>
      </div>
      <ProfileDetail
        v-else
        :mode="props.mode"
        :user-id="selectedUserId"
        :profile="profile"
        :loading="detailLoading"
        @saved="onSaved"
      />
    </div>
  </div>
</template>

<style scoped>
.g6-wrap {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.g6-list {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 12px;
  max-height: calc(100vh - 190px);
}
.g6-detail {
  flex: 1;
  min-width: 0;
}
.list-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.list-body {
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
}
.list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--r-md, 8px);
  cursor: pointer;
  transition: background 0.12s;
}
.list-row:hover {
  background: var(--ink-50, #f8fafc);
}
.list-row.active {
  background: var(--brand-50, #eef2ff);
}
.row-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-800, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-acc {
  font-size: 11.5px;
  color: var(--ink-400, #9aa3b2);
}
.row-status {
  flex: none;
  font-size: 11.5px;
  color: #15803d;
}
.row-status.off {
  color: #b91c1c;
}
.list-tip {
  padding: 12px 6px;
  font-size: 12.5px;
  color: #b45309;
}
.list-pager {
  padding-top: 8px;
  display: flex;
  justify-content: center;
}
.banner-err {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #991b1b;
  border-radius: var(--r-md, 8px);
  font-size: 12.5px;
  line-height: 1.7;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 30px 10px;
  color: var(--ink-400, #9aa3b2);
}
.empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-700, #374151);
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
</style>
