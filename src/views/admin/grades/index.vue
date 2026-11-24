<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { useUserStore } from '@/store/user';
import {
  downloadGradeExport,
  getGradeExportOptions,
  listGradeExportOfferings,
  listGradeExportTasks,
  previewGradeExport,
  type GradeExportDatasetOption,
  type GradeExportOffering,
  type GradeExportResult,
  type GradeExportRow,
  type GradeExportTask
} from '@/api/admin/gradeExport';

/**
 * 成绩导出（管理端）
 * ============================================================================
 * 设计要点：
 *  1. **六类数据集共享一套筛选**：切类型不丢条件，避免「换个表重新选一遍课程」。
 *  2. **列由后端下发**：columns/rows 同源，前端不写死字段，口径调整不会出现屏上与文件两套列。
 *  3. **「一行是什么」常显**：汇总表（学生/教学班/班级）与明细表（任务/评分记录）混在一页，
 *     不写清一行是什么，用户会把「教学班汇总」当「学生明细」导出后去对数。
 *  4. **导出与预览同一份数据**：导出走同一 build()，不依赖预览是否加载完，
 *     但会在导出前提示「当前条件导的是全量 N 行」，避免拿一页 20 行当全量。
 */

const loadingOptions = ref(false);
const loading = ref(false);
const exporting = ref(false);
const errorText = ref('');
const loaded = ref(false);

const datasets = ref<GradeExportDatasetOption[]>([]);
const terms = ref<Array<Record<string, unknown>>>([]);
const courses = ref<Array<Record<string, unknown>>>([]);
const teachers = ref<Array<Record<string, unknown>>>([]);
const classes = ref<Array<Record<string, unknown>>>([]);
const offerings = ref<GradeExportOffering[]>([]);
const tasks = ref<GradeExportTask[]>([]);

const query = reactive({
  dataset: 'student_summary',
  termId: '',
  courseId: '',
  offeringId: '',
  taskType: 'all' as 'all' | 'homework' | 'experiment',
  taskId: '',
  classId: '',
  status: 'all' as 'all' | 'unsubmitted' | 'pending' | 'graded' | 'late',
  keyword: '',
  dateRange: [] as string[]
});

const result = ref<GradeExportResult | null>(null);
const page = ref(1);
const pageSize = ref(20);

const currentDataset = computed(() => datasets.value.find(d => d.code === query.dataset) ?? null);
const courseName = computed(() => {
  const c = courses.value.find(x => str(x.courseId) === query.courseId);
  return c ? str(c.courseName) : '';
});
const canQuery = computed(() => !!query.courseId);

/**
 * 页面权限：后端四个端点都挂了 `admin:grade:export`。
 * 前端不做假放行 —— 无权限时直接写清原因（否则用户点了只会看到一条 403 toast，
 * 还会以为是系统坏了）。
 */
const userStore = useUserStore();
const canExportPerm = computed(() => userStore.hasPermi('admin:grade:export'));

/** summary 指标的中文名与顺序（后端按数据集给不同 key） */
const SUMMARY_META: Record<string, string> = {
  studentCount: '学生数',
  scoredCount: '有成绩人数',
  avgScore: '平均分',
  gradedCount: '已批改',
  pendingCount: '待批改',
  unsubmittedCount: '未提交',
  lateCount: '迟交',
  missingCount: '欠交条数',
  offeringCount: '教学班数',
  classCount: '班级数',
  recordCount: '评分记录',
  aiCount: 'AI 评分',
  teacherCount: '教师评分',
  unassignedCount: '未分配教学班'
};
const summaryItems = computed(() => {
  const s = result.value?.summary ?? {};
  return Object.keys(SUMMARY_META)
    .filter(k => s[k] !== undefined && s[k] !== null && s[k] !== '')
    .map(k => ({ key: k, label: SUMMARY_META[k], value: String(s[k]) }));
});

/** 未匹配到教学班的行数（全量）—— 数据问题，屏上必须点明，否则会被读成「老师漏了」 */
const unassignedCount = computed(() => Number(result.value?.summary?.unassignedCount ?? 0));

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

function findTerm(id: string) {
  return terms.value.find(t => str(t.termId) === id);
}
function termLabel(t: Record<string, unknown>) {
  const name = str(t.termName) || str(t.termCode);
  return t.isCurrent ? `${name}（当前）` : name;
}
function courseLabel(c: Record<string, unknown>) {
  const no = str(c.courseCode);
  return no ? `${str(c.courseName)}（${no}）` : str(c.courseName);
}

/* ---------------- 初始化 ---------------- */

async function loadOptions() {
  loadingOptions.value = true;
  errorText.value = '';
  try {
    const opt = await getGradeExportOptions();
    terms.value = opt.terms ?? [];
    courses.value = opt.courses ?? [];
    teachers.value = opt.teachers ?? [];
    classes.value = opt.classes ?? [];
    datasets.value = opt.datasets ?? [];
    loaded.value = true;
  } catch {
    /* request 内部已弹提示 */
  } finally {
    loadingOptions.value = false;
  }
}

async function loadOfferings() {
  if (!query.courseId) {
    offerings.value = [];
    query.offeringId = '';
    return;
  }
  try {
    offerings.value = await listGradeExportOfferings(query.courseId);
  } catch {
    offerings.value = [];
  }
  // 选过的教学班不属于新课程时清掉，避免带着旧 offeringId 去筛一门不相关的课
  if (query.offeringId && !offerings.value.some(o => str(o.offeringId) === query.offeringId)) {
    query.offeringId = '';
  }
}

async function loadTasks() {
  if (!query.courseId) {
    tasks.value = [];
    query.taskId = '';
    return;
  }
  try {
    tasks.value = await listGradeExportTasks(query.courseId, query.taskType);
  } catch {
    tasks.value = [];
  }
  if (query.taskId && !tasks.value.some(t => str(t.taskId) === query.taskId)) {
    query.taskId = '';
  }
}

/* ---------------- 预览 ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;

function schedulePreview(immediate = false) {
  if (timer) clearTimeout(timer);
  if (!canQuery.value) {
    result.value = null;
    return;
  }
  timer = setTimeout(() => void runPreview(), immediate ? 0 : 260);
}

async function runPreview() {
  if (!canQuery.value) {
    result.value = null;
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    result.value = await previewGradeExport({
      dataset: query.dataset,
      termId: query.termId || undefined,
      courseId: query.courseId,
      offeringId: query.offeringId || undefined,
      classId: query.classId || undefined,
      taskType: query.taskType,
      taskId: query.taskId || undefined,
      status: query.status,
      keyword: query.keyword.trim() || undefined,
      startDate: query.dateRange?.[0] || undefined,
      endDate: query.dateRange?.[1] || undefined,
      pageNum: page.value,
      pageSize: pageSize.value
    });
  } catch (e) {
    result.value = null;
    errorText.value = (e as Error)?.message ?? '预览失败';
  } finally {
    loading.value = false;
  }
}

/* ---------------- 条件联动 ---------------- */

watch(
  () => query.courseId,
  async () => {
    page.value = 1;
    query.offeringId = '';
    query.taskId = '';
    await Promise.all([loadOfferings(), loadTasks()]);
    schedulePreview(true);
  }
);

watch(
  () => query.taskType,
  async () => {
    query.taskId = '';
    await loadTasks();
    page.value = 1;
    schedulePreview();
  }
);

watch(
  () => [query.dataset, query.offeringId, query.taskId, query.classId, query.status, query.keyword, query.dateRange],
  () => {
    page.value = 1;
    schedulePreview();
  },
  { deep: true }
);

watch(
  () => [page.value, pageSize.value],
  () => schedulePreview(true)
);

function onDatasetChange(code: string) {
  if (query.dataset === code) return;
  query.dataset = code;
  page.value = 1;
}

function onReset() {
  query.dataset = 'student_summary';
  query.termId = '';
  query.courseId = '';
  query.offeringId = '';
  query.taskType = 'all';
  query.taskId = '';
  query.classId = '';
  query.status = 'all';
  query.keyword = '';
  query.dateRange = [];
  page.value = 1;
  result.value = null;
}

/* ---------------- 导出 ---------------- */

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function onExport() {
  if (!canQuery.value) {
    ElMessage.warning('请先选择课程');
    return;
  }
  exporting.value = true;
  try {
    const blob = await downloadGradeExport({
      dataset: query.dataset,
      termId: query.termId || undefined,
      courseId: query.courseId,
      offeringId: query.offeringId || undefined,
      classId: query.classId || undefined,
      taskType: query.taskType,
      taskId: query.taskId || undefined,
      status: query.status,
      keyword: query.keyword.trim() || undefined,
      startDate: query.dateRange?.[0] || undefined,
      endDate: query.dateRange?.[1] || undefined
    });
    const label = currentDataset.value?.label ?? '成绩';
    const safeCourse = (courseName.value || '课程').replace(/[\\/:*?"<>|]/g, '').slice(0, 24);
    saveBlob(blob, `成绩导出_${label}_${safeCourse}_${stamp()}.xlsx`);
    ElMessage.success(
      result.value
        ? `已导出全量 ${result.value.total} 行（预览只显示一页，文件是全部）`
        : '已导出'
    );
  } catch {
    /* requestBlob 内部已弹具体原因（无权限 / 导出失败） */
  } finally {
    exporting.value = false;
  }
}

/* ---------------- 表格 ---------------- */

function colMinWidth(key: string): number {
  if (key === 'studentNo') return 120;
  if (key === 'studentName') return 90;
  if (key === 'clazzName') return 120;
  if (key === 'courseName') return 150;
  if (key === 'offeringLabel') return 110;
  if (key === 'teacherName') return 100;
  if (key === 'taskTitle') return 190;
  if (key === 'rowStatus' || key === 'missingStatus') return 130;
  if (key === 'comment') return 160;
  if (key === 'createTime' || key === 'submitTime' || key === 'deadline') return 150;
  return 100;
}

function cellText(row: GradeExportRow, key: string): string {
  const v = row[key];
  return v === undefined || v === null ? '' : String(v);
}

onMounted(loadOptions);
</script>

<template>
  <div class="page-head">
    <h1>成绩导出</h1>
    <div class="actions">
      <button class="btn btn-outline" :disabled="loading" @click="onReset">重置条件</button>
      <button class="btn btn-primary" :disabled="!canQuery || exporting || !canExportPerm" @click="onExport">
        <ZkIcon name="download" :size="16" style="margin-right: 4px" />
        {{ exporting ? '正在导出…' : '导出 Excel' }}
      </button>
    </div>
  </div>

  <div class="grade-body">
    <div v-if="!canExportPerm" class="gap-warn small">
      <ZkIcon name="alert-triangle" :size="14" style="vertical-align: -2px; margin-right: 6px" />
      当前账号没有「成绩导出」权限（admin:grade:export），页面可浏览但无法查询与导出；请联系管理员在角色里授权。
    </div>
    <!-- 导出类型：决定「一行是什么」 -->
    <div class="card card-pad">
      <div class="card-title">
        导出类型
        <span class="small muted" style="font-weight: 400; margin-left: 8px">
          类型决定「一行是什么」，下方筛选条件六类通用
        </span>
      </div>
      <div v-if="loadingOptions && !datasets.length" class="small muted">正在加载…</div>
      <div v-else class="ds-grid">
        <button
          v-for="d in datasets"
          :key="d.code"
          type="button"
          class="ds-card"
          :class="{ active: query.dataset === d.code }"
          @click="onDatasetChange(d.code)"
        >
          <span class="ds-label">{{ d.label }}</span>
          <span class="ds-desc">{{ d.rowMeaning }}</span>
        </button>
      </div>
    </div>

    <!-- 筛选条件 -->
    <div class="card card-pad">
      <div class="filter-bar">
        <div class="f-item">
          <span class="f-label">课程</span>
          <el-select
            v-model="query.courseId"
            class="f-sel"
            placeholder="必选：选择课程"
            filterable
            :loading="loadingOptions"
            no-match-text="没有匹配的课程"
          >
            <el-option
              v-for="c in courses"
              :key="str(c.courseId)"
              :label="courseLabel(c)"
              :value="str(c.courseId)"
            />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">教学班</span>
          <el-select v-model="query.offeringId" class="f-sel" placeholder="全部教学班" clearable>
            <el-option
              v-for="o in offerings"
              :key="str(o.offeringId)"
              :label="`教学班 ${o.offeringIndex} · ${o.teacherName || '未指定教师'} · ${o.classText}`"
              :value="str(o.offeringId)"
            />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">任务类型</span>
          <el-select v-model="query.taskType" class="f-sel-sm">
            <el-option label="作业 + 实验" value="all" />
            <el-option label="仅作业" value="homework" />
            <el-option label="仅实验" value="experiment" />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">任务</span>
          <el-select
            v-model="query.taskId"
            class="f-sel"
            placeholder="全部任务"
            clearable
            filterable
            no-match-text="没有匹配的任务"
          >
            <el-option v-for="t in tasks" :key="`${t.taskType}-${str(t.taskId)}`" :label="t.label" :value="str(t.taskId)" />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">状态</span>
          <el-select v-model="query.status" class="f-sel-sm">
            <el-option label="全部状态" value="all" />
            <el-option label="未提交 / 未参与" value="unsubmitted" />
            <el-option label="待批改" value="pending" />
            <el-option label="已批改" value="graded" />
            <el-option label="迟交" value="late" />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">班级</span>
          <el-select v-model="query.classId" class="f-sel-sm" placeholder="全部班级" clearable filterable>
            <el-option v-for="c in classes" :key="str(c.clazzId)" :label="str(c.clazzName)" :value="str(c.clazzId)" />
          </el-select>
        </div>

        <div class="f-item">
          <span class="f-label">学生</span>
          <el-input v-model="query.keyword" class="f-sel-sm" placeholder="学号 / 姓名" clearable />
        </div>

        <div class="f-item">
          <span class="f-label">截止日期</span>
          <el-date-picker
            v-model="query.dateRange"
            class="f-date"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始"
            end-placeholder="结束"
            range-separator="~"
          />
        </div>

        <div class="f-item">
          <button class="btn btn-outline" :disabled="!canQuery || loading" @click="schedulePreview(true)">
            <ZkIcon name="refresh-cw" :size="15" style="margin-right: 4px" />重新查询
          </button>
        </div>
      </div>

      <div class="small muted filter-hint">
        学期参考：{{ query.termId ? (findTerm(query.termId)?.termName ?? '') : (terms.find(t => t.isCurrent) ? termLabel(terms.find(t => t.isCurrent)!) : '全部学期') }}；
        学生范围按「已选课（enrolled）」口径，仅绑定班级但没有选课记录的学生不会出现在结果里。
      </div>
    </div>

    <!-- 未选课程 -->
    <div v-if="!canQuery" class="card card-pad empty-state">
      <ZkIcon name="table" :size="28" />
      <div class="empty-title">先选择一门课程</div>
      <div class="small muted">成绩导出以课程为根：六类数据集、学生名单、作业与实验任务都按课程取。</div>
    </div>

    <!-- 结果 -->
    <div v-else class="card card-pad" v-loading="loading">
      <div class="result-head">
        <div>
          <div class="result-title">
            {{ result?.datasetLabel ?? currentDataset?.label ?? '成绩' }}
            <span v-if="result" class="badge badge-info" style="margin-left: 8px">全量 {{ result.total }} 行</span>
          </div>
          <div class="small muted" style="margin-top: 4px">
            {{ result?.rowMeaning ?? currentDataset?.rowMeaning }}
          </div>
        </div>
        <div class="small muted" v-if="result?.generatedAt">数据时刻：{{ result.generatedAt }}</div>
      </div>

      <div v-if="errorText" class="gap-warn small" style="margin-top: 10px">
        <ZkIcon name="alert-triangle" :size="14" style="vertical-align: -2px; margin-right: 6px" />{{ errorText }}
      </div>

      <div v-if="summaryItems.length" class="metric-row">
        <div v-for="s in summaryItems" :key="s.key" class="metric">
          <div class="metric-value">{{ s.value }}</div>
          <div class="metric-label">{{ s.label }}</div>
        </div>
      </div>

      <div v-if="result?.caliber" class="caliber small">
        <span class="caliber-tag">口径</span>{{ result.caliber }}
      </div>

      <div v-if="unassignedCount > 0" class="gap-warn small" style="margin-bottom: 10px">
        <ZkIcon name="alert-triangle" :size="14" style="vertical-align: -2px; margin-right: 6px" />
        当前结果有 {{ unassignedCount }} 行没匹配到教学班（明细表按行计，同一学生会重复计入）：开课配置的「目标班级」
        没覆盖这些学生，教师列只能留空。请到「课程总览 → 编辑教学班」把缺失的班级补上，再重新导出。
      </div>

      <el-table
        v-if="result && result.rows.length"
        :data="result.rows"
        class="grade-table"
        border
        stripe
        max-height="520"
        size="small"
      >
        <el-table-column
          v-for="col in result.columns"
          :key="col.key"
          :prop="col.key"
          :label="col.label"
          :min-width="colMinWidth(col.key)"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ cellText(row, col.key) }}</template>
        </el-table-column>
      </el-table>

      <div v-else-if="result" class="empty-state small muted" style="padding: 28px 0">
        当前条件下没有数据。可以换一个任务、放宽状态，或确认这门课的学生是否已选课、任务是否已发布。
      </div>

      <div v-if="result && result.total > 0" class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="result.total"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          background
        />
        <span class="small muted">预览只翻页展示；导出始终是全部 {{ result.total }} 行</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grade-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ds-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
  margin-top: 4px;
}
.ds-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.ds-card:hover {
  border-color: var(--brand-300);
  box-shadow: var(--sh-1);
}
.ds-card.active {
  border-color: var(--primary);
  background: var(--primary-softer);
  box-shadow: inset 0 0 0 1px var(--primary);
}
.ds-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--ink-900);
}
.ds-card.active .ds-label {
  color: var(--brand-700);
}
.ds-desc {
  font-size: 12px;
  color: var(--ink-500);
  line-height: 1.45;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
}
/* 不参与收缩：日期区间控件一旦被压窄就只剩「开始 ~ 结束」，看起来像坏了 */
.f-item {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
/* 标签定宽右对齐，各行的输入框才会站在同一条竖线上 */
.f-label {
  width: 52px;
  text-align: right;
  font-size: 12px;
  color: var(--ink-500);
  white-space: nowrap;
}
.f-sel {
  width: 200px;
}
.f-sel-sm {
  width: 148px;
}
.f-date {
  width: 240px;
}
.filter-hint {
  margin-top: 10px;
  line-height: 1.6;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--ink-400);
  padding: 40px 0;
}
.empty-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink-700);
}

.result-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.result-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink-900);
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.metric {
  min-width: 108px;
  padding: 10px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.metric-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink-900);
  line-height: 1.2;
}
.metric-label {
  font-size: 12px;
  color: var(--ink-500);
  margin-top: 2px;
}

.caliber {
  margin: 12px 0 10px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border-left: 3px solid var(--brand-300);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  color: var(--ink-600);
  line-height: 1.6;
}
.caliber-tag {
  display: inline-block;
  margin-right: 8px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--brand-700);
  background: var(--brand-100);
  border-radius: var(--r-sm);
}

.grade-table {
  margin-top: 4px;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
</style>
