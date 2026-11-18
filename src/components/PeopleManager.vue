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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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

/** 单个列表行的高度（与 `.list-row` 的 height 一致，改样式要同步这里） */
const ROW_H = 38;
/**
 * 每页行数按可视高度**自适应**，让列表正好填满左侧卡片。
 * 固定 8 行时卡片只有 400 出头，卡片下方会空掉大半屏；固定 20 行则在 768 高的笔记本上
 * 把卡片顶出视口。所以按「可用高度 / 行高」算，两端各夹一个合理区间。
 *   可用高度 = 视口 - 56 顶栏 - 24 上内边距 - 50 页头 - 24 下内边距
 *   扣掉工具条 42 + 卡片内边距 24 + 分页器 34
 */
function calcPageSize() {
  const avail = window.innerHeight - 154;
  const chrome = 42 + 24 + 34;
  return Math.min(24, Math.max(6, Math.floor((avail - chrome) / ROW_H)));
}

const query = reactive({ page: 1, pageSize: calcPageSize(), keyword: '' });

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

/* 窗口尺寸变化（拉窗口 / 分屏）后重算每页行数，否则列表要么留白要么顶出视口。
   防抖 200ms：拖拽过程中不反复请求；只在行数真的变了才回到第 1 页重取。 */
let rzTimer: number | undefined;
function onResize() {
  window.clearTimeout(rzTimer);
  rzTimer = window.setTimeout(() => {
    const next = calcPageSize();
    if (next === query.pageSize) return;
    query.pageSize = next;
    query.page = 1;
    void fetchList(false);
  }, 200);
}

onMounted(() => {
  void fetchList(false);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.clearTimeout(rzTimer);
  window.removeEventListener('resize', onResize);
});
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
          <span class="row-name">{{ r.nickName || r.username }}</span>
          <!-- 昵称为空时上面显示的就是账号，这里不再重复一遍 -->
          <span v-if="r.nickName && r.nickName !== r.username" class="row-acc mono">{{ r.username }}</span>
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
/* 左右两卡等高：stretch 让矮的那张（详情）拉到与列表同高，底边对齐。
   原来是 flex-start ⇒ 两卡各按自己内容定高，详情内容短时右下方吊出一个大缺口，
   页面看着「没对齐、留白很多」。 */
.g6-wrap {
  display: flex;
  gap: 16px;
  align-items: stretch;
  /* 撑满视口剩余高度（100vh - 顶栏 56 - main 上内边距 24 - 页头约 50 - main 下内边距 24 = 154）：
     卡片只按内容定高时，两卡 400 出头、下面空掉大半屏，看着像页面没做完。
     内容超过这个高度时由 .g6-list / .g6-detail 的 max-height 兜住，各自卡内滚动。 */
  min-height: calc(100vh - 154px);
}
/* 两卡共用同一个高度上限（100vh - 顶栏 56 - main 上内边距 24 - 页头约 50 - main 下内边距 24 = 154），
   上限不一致时内容超长又会重新错开。 */
.g6-list {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 12px;
  max-height: calc(100vh - 154px);
  min-height: 0;
}
.g6-detail {
  flex: 1;
  min-width: 0;
  max-height: calc(100vh - 154px);
  /* 详情比列表长时在卡内滚动，不把整页撑长、也不让两卡再次错高 */
  overflow-y: auto;
  display: flex;
  flex-direction: column;
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
/* 单行紧凑行：姓名 + 账号 + 状态 挤在一行，行高 38（原先是姓名/账号两行、约 53）。
   左列表是「选人」的入口，不需要卡片式的宽松排版；行一矮，整块卡片跟着变矮，
   右详情栏底部那片用不上的空白也就一起收掉了。 */
.list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
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
.row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-800, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-acc {
  flex: none;
  max-width: 104px;
  font-size: 11.5px;
  color: var(--ink-400, #9aa3b2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
