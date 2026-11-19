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
import { listDeptTree, listUsers, type DeptNodeVo } from '@/api/admin/users';
import { listClasses } from '@/api/admin/basicdata';
import { getStudentProfile, getTeacherProfile, type StudentProfile, type TeacherProfile } from '@/api/admin/profiles';
import type { AdminUserVo } from '@/types/admin';

const props = defineProps<{ mode: 'teacher' | 'student' }>();

const isTeacher = computed(() => props.mode === 'teacher');
const roleKey = computed(() => (isTeacher.value ? 'teacher' : 'student'));
const pageTitle = computed(() => (isTeacher.value ? '教师管理' : '学生管理'));

/* ---------------- 列表 ---------------- */
const listLoading = ref(false);
const rows = ref<AdminUserVo[]>([]);
const total = ref(0);
const listError = ref('');

/* 卡片高度已固定（见样式 .g6-wrap），每页行数必须跟着算，否则固定行数只占一半、左卡下面吊一大截空白。
   可用高度 = 卡片高度 - 内边距 24 - 工具条 44（34 高输入框 + 10 下间距）
              - 筛选行 44（34 高下拉 + 10 下间距） - 分页器预留 40；行高 38。
   上下界 6~24：太小翻页太碎，太大一屏塞不下。 */
const WRAP_MAX_H = 620;
const ROW_H = 38;
function calcPageSize() {
  const avail = Math.min(Math.max(window.innerHeight - 154, 420), WRAP_MAX_H);
  const body = avail - 24 - 44 - 44 - 40;
  return Math.max(6, Math.min(24, Math.floor(body / ROW_H)));
}

const query = reactive({
  page: 1,
  pageSize: calcPageSize(),
  keyword: '',
  /** 筛选维度：教师 = 院系（deptId），学生 = 班级（clazzId）。两页取值不同，
   *  但控件只有一个下拉、一种布局，观感一致、逻辑各管各的。 */
  dim: '',
  status: ''
});

/* ---------------- 筛选候选（教师=院系 / 学生=班级） ----------------
 * 后端 UserQueryBo 认 deptId / clazzId / status（金丝雀实测：clazzId=-1 返回 0 条）。
 * 但 10-26 那批老包的 UserQueryBo 连 clazzId 都没有 ⇒ 参数被静默忽略：人选了「计科2026-1班」，
 * 列表纹丝不动，还以为看到的就是那个班的人。所以进页先用 clazzId=-1 探一次，
 * 不认就整块不渲染，不留「选了却不筛」的下拉。 */
const dimSupported = ref<boolean | null>(null);
const dimOptions = ref<{ id: string; name: string }[]>([]);
const dimLoadFailed = ref(false);

async function probeDimSupport() {
  try {
    const res = await listUsers({ page: 1, pageSize: 1, roleKey: roleKey.value, clazzId: '-1' });
    dimSupported.value = (res?.total ?? 0) === 0;
  } catch {
    dimSupported.value = false;
  }
}

/** 院系候选 = 若依原生院系树里「本校根子树」的节点（与账号管理页同一口径） */
const ROOT_DEPT_ID = '200';
function deptOptionsOf(list: DeptNodeVo[]) {
  const self = list.find((d) => String(d.deptId) === ROOT_DEPT_ID);
  const chain = (self?.ancestors ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== '0');
  const rootId = chain.length ? chain[0] : ROOT_DEPT_ID;
  return list
    .filter((d) => String(d.deptId) === rootId || (d.ancestors ?? '').split(',').map((s) => s.trim()).includes(rootId))
    .map((d) => ({ id: String(d.deptId), name: d.deptName }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

async function loadDimOptions() {
  try {
    if (isTeacher.value) {
      const res = await listDeptTree();
      dimOptions.value = res.ok ? deptOptionsOf(res.list) : [];
    } else {
      const res = await listClasses({ page: 1, pageSize: 500 });
      dimOptions.value = (res.list ?? []).map((c) => ({
        id: String(c.clazzId ?? ''),
        name: c.clazzName || c.clazzCode || String(c.clazzId ?? '')
      }));
    }
    dimLoadFailed.value = dimOptions.value.length === 0;
  } catch {
    dimLoadFailed.value = true;
  }
}

async function fetchList(keepSelection = true) {
  listLoading.value = true;
  listError.value = '';
  try {
    const res = await listUsers({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      roleKey: roleKey.value,
      status: query.status || undefined,
      // 维度筛选两页各走各的字段：教师按院系、学生按班级
      ...(isTeacher.value ? { deptId: query.dim || undefined } : { clazzId: query.dim || undefined })
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

/** 有没有任一筛选条件：决定空态说「没有符合条件」还是「还没有账号」 */
const hasFilter = computed(() => !!query.keyword.trim() || !!query.dim || !!query.status);

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

onMounted(() => {
  void fetchList(false);
  // 筛选候选与能力探测并行，别挡列表首屏
  void probeDimSupport();
  void loadDimOptions();
});

/* 视口变化 ⇒ 每页行数重算；只有行数真的变了才回第 1 页重取（否则白白丢当前页） */
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function onViewportResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const next = calcPageSize();
    if (next === query.pageSize) return;
    query.pageSize = next;
    query.page = 1;
    void fetchList(false);
  }, 200);
}
onMounted(() => { window.addEventListener('resize', onViewportResize); });
onBeforeUnmount(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  window.removeEventListener('resize', onViewportResize);
});
</script>

<template>
  <div class="page-head">
    <h1>{{ pageTitle }}</h1>
  </div>

  <div class="g6-wrap">
    <!-- 左：账号列表 -->
    <div class="card g6-list">
      <!-- 搜索框尺寸：原先 size="small" 只有 24px 高、字号 12px，在 320px 宽的卡片里
           又矮又细，输入时不好点。改成默认尺寸再把高度抬到 34px、字号 13px，
           与右侧详情区的正文同一档，刷新按钮同步对齐。 -->
      <div class="list-toolbar">
        <el-input
          v-model="query.keyword"
          class="tb-search"
          :placeholder="isTeacher ? '姓名 / 工号' : '姓名 / 学号'"
          clearable
          @keyup.enter="onSearch"
          @clear="onSearch"
        >
          <template #prefix><ZkIcon name="search" :size="14" /></template>
        </el-input>
        <el-button class="tb-icon" :loading="listLoading" title="刷新" @click="fetchList(true)">
          <ZkIcon v-if="!listLoading" name="refresh-cw" :size="15" />
        </el-button>
      </div>

      <!-- 筛选：两页的**维度不同**（教师按院系归属、学生按班级归属），但控件与布局完全一致。
           状态两页都有。维度下拉带能力闸门：后端不认 clazzId 时（老包）整块不渲染，
           不给「选了却不筛」的假下拉。 -->
      <div class="list-filters" :class="{ 'one-col': dimSupported === false }">
        <el-select
          v-if="dimSupported !== false"
          v-model="query.dim"
          class="ft-dim"
          :placeholder="isTeacher ? '全部院系' : '全部班级'"
          :disabled="dimLoadFailed"
          filterable
          clearable
          @change="onSearch"
        >
          <el-option v-for="o in dimOptions" :key="o.id" :label="o.name" :value="o.id" />
          <template v-if="dimLoadFailed" #footer>
            <div class="ft-tip">{{ isTeacher ? '院系' : '班级' }}候选取不到，可先用搜索定位</div>
          </template>
        </el-select>
        <el-select
          v-model="query.status"
          class="ft-status"
          placeholder="全部状态"
          clearable
          @change="onSearch"
        >
          <el-option label="正常" value="0" />
          <el-option label="停用" value="1" />
        </el-select>
      </div>

      <div v-loading="listLoading" class="list-body">
        <div v-if="listError" class="list-tip">
          <span>{{ listError }}</span>
        </div>
        <div v-else-if="!rows.length && !listLoading" class="empty-block">
          <ZkIcon :name="isTeacher ? 'graduation-cap' : 'user'" :size="24" />
          <div class="empty-title">{{ hasFilter ? '没有符合筛选条件的账号' : (isTeacher ? '还没有教师账号' : '还没有学生账号') }}</div>
          <div v-if="hasFilter" class="small muted">换个关键词，或清掉筛选条件再看。</div>
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
/* ★ 2026-11-19 业主口径：教师管理 / 学生管理两页格式必须一致。
   之前卡片高度是「按内容自然撑开」，教师页右侧有基本信息+可授课程+授课记录（3 条）⇒ 483，
   学生页右侧只有 1 条选课 ⇒ 412，两页一对比就是「栏位大小不一」。
   现在给两卡一个**与内容无关的固定高度**：min(视口剩余高度, 620px)。
   - 两端用同一个值，切到哪一页、选中哪个人，卡片尺寸都不变；
   - 620 是上限，大屏不会把卡片拉成一片空表；小屏自动降到视口剩余高度，不顶出滚动条。 */
.g6-wrap {
  display: flex;
  gap: 16px;
  align-items: stretch;
  height: min(calc(100vh - 154px), 620px);
  min-height: 420px;
}
.g6-list {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 12px;
  height: 100%;
  min-height: 0;
}
.g6-detail {
  flex: 1;
  min-width: 0;
  height: 100%;
  /* 详情比固定高度长时在卡内滚动，不把整页撑长、也不会把卡片顶高 */
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
/* 工具条用网格定死两列（输入框吃掉剩余宽度 + 34px 按钮），
   不再靠 flex 自适应 —— el-input 默认宽度有限，flex 下会在右边留一条空隙。 */
.list-toolbar {
  display: grid;
  grid-template-columns: 1fr 34px;
  gap: 8px;
  margin-bottom: 10px;
}
.list-toolbar :deep(.tb-search) {
  width: 100%;
  min-width: 0;
}
/* 搜索框 34px 高、13px 字（原 small 档 24px/12px 偏小）；图标与文案同一基线 */
.list-toolbar :deep(.tb-search .el-input__wrapper) {
  height: 34px;
  padding: 0 10px;
  font-size: 13px;
}
.list-toolbar :deep(.tb-search .el-input__inner) {
  font-size: 13px;
}
/* 刷新按钮跟搜索框等高，方形 34×34，不再是一个小窄条 */
.list-toolbar :deep(.tb-icon) {
  width: 34px;
  height: 34px;
  padding: 0;
  flex: none;
}
/* 筛选行：与搜索框同规格（34 高、13px 字），一个维度下拉 + 一个状态下拉；
   后端不认维度筛选时退化成一列（状态占满）。 */
.list-filters {
  display: grid;
  /* 108px 是「全部状态」+ 箭头不被截断的最小宽度（92 会截成「全部…」），其余给维度下拉 */
  grid-template-columns: 1fr 108px;
  gap: 8px;
  margin-bottom: 10px;
}
.list-filters.one-col {
  grid-template-columns: 1fr;
}
.list-filters :deep(.el-select__wrapper) {
  min-height: 34px;
  font-size: 13px;
}
.ft-tip {
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-400, #9aa3b2);
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
