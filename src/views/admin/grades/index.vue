<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
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

/* 导出弹窗：字段自选 + 条件摘要（对标学习通/主流 B 端的「导出设置」） */
const exportVisible = ref(false);
const exportColumns = ref<string[]>([]);

const currentDataset = computed(() => datasets.value.find(d => d.code === query.dataset) ?? null);
const courseName = computed(() => {
  const c = courses.value.find(x => str(x.courseId) === query.courseId);
  return c ? str(c.courseName) : '';
});
const canQuery = computed(() => !!query.courseId);

/** 状态枚举的中文名：下拉、条件摘要、空态提示共用一份，避免三处文案打架 */
const STATUS_TEXT: Record<string, string> = {
  all: '',
  unsubmitted: '未提交 / 未参与',
  pending: '待批改',
  graded: '已批改',
  late: '迟交'
};

/**
 * 导出弹窗的条件摘要：只列真正生效的条件。
 * 导出文件会和这份摘要一致（后端把同一份条件写进「导出条件」sheet），
 * 用户拿文件回去核对时不用再回忆当时筛了什么。
 */
const filterSummary = computed(() => {
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };
  const offering = offerings.value.find(o => str(o.offeringId) === query.offeringId);
  const task = tasks.value.find(t => str(t.taskId) === query.taskId);
  const clazz = classes.value.find(c => str(c.clazzId) === query.classId);
  add('数据集', currentDataset.value?.label ?? '');
  add('课程', courseName.value);
  add('教学班', offering ? `${offering.teacherName || '未指定教师'} · ${offering.classText}` : '');
  add('任务类型', query.taskType === 'all' ? '' : query.taskType === 'homework' ? '仅作业' : '仅实验');
  add('任务', task?.label ?? '');
  add('状态', STATUS_TEXT[query.status] ?? '');
  add('班级', clazz ? str(clazz.clazzName) : '');
  add('学生', query.keyword.trim());
  add('截止日期', query.dateRange?.length === 2 ? `${query.dateRange[0]} ~ ${query.dateRange[1]}` : '');
  return rows;
});

const allColumnsSelected = computed(
  () => !!result.value && exportColumns.value.length === result.value.columns.length
);

function selectAllColumns() {
  exportColumns.value = result.value ? result.value.columns.map(c => c.key) : [];
}

function invertColumns() {
  if (!result.value) return;
  const picked = new Set(exportColumns.value);
  exportColumns.value = result.value.columns.filter(c => !picked.has(c.key)).map(c => c.key);
}

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

/** 打开导出设置：先有预览结果才知道有哪些列可选 */
function openExport() {
  if (!canQuery.value) {
    ElMessage.warning('请先选择课程');
    return;
  }
  if (!result.value || !result.value.columns.length) {
    ElMessage.warning('等预览出来再导出：要先知道这张表有哪些列');
    return;
  }
  exportColumns.value = result.value.columns.map(c => c.key);
  exportVisible.value = true;
}

async function doExport() {
  if (!exportColumns.value.length) {
    ElMessage.warning('请至少保留一列');
    return;
  }
  const total = result.value?.total ?? 0;
  if (total > 2000) {
    try {
      await ElMessageBox.confirm(
        `本次将导出 ${total} 行 × ${exportColumns.value.length} 列。行数较多时生成需要几秒到十几秒，请勿关闭页面。`,
        '确认导出',
        { confirmButtonText: '继续导出', cancelButtonText: '取消', type: 'warning' }
      );
    } catch {
      return;
    }
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
      endDate: query.dateRange?.[1] || undefined,
      // 全选时不传，交给后端按数据集默认列出；少选时只传勾中的
      columns: allColumnsSelected.value ? undefined : exportColumns.value
    });
    const label = currentDataset.value?.label ?? '成绩';
    const safeCourse = (courseName.value || '课程').replace(/[\\/:*?"<>|]/g, '').slice(0, 24);
    saveBlob(blob, `成绩导出_${label}_${safeCourse}_${stamp()}.xlsx`);
    ElMessage.success(`已导出全量 ${total} 行（预览只显示一页，文件是全部）`);
    exportVisible.value = false;
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

/** 学号/姓名钉在左侧：列一多就得横向滚，滚走了就不知道这行是谁 */
function colFixed(key: string): 'left' | undefined {
  return key === 'studentNo' || key === 'studentName' ? 'left' : undefined;
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
      <button
        class="btn btn-primary"
        :disabled="!canQuery || !result || exporting || !canExportPerm"
        :title="!result ? '先查询出结果，再选择要导出的列' : ''"
        @click="openExport"
      >
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
    <!-- 导出类型：只列类型名，一行是什么放在结果区标题下（选中后就看得见，不必先读六行小字） -->
    <div class="card card-pad">
      <div class="card-title">导出类型</div>
      <div v-if="loadingOptions && !datasets.length" class="small muted">正在加载…</div>
      <div v-else class="ds-grid">
        <button
          v-for="d in datasets"
          :key="d.code"
          type="button"
          class="ds-card"
          :class="{ active: query.dataset === d.code }"
          :title="d.rowMeaning"
          @click="onDatasetChange(d.code)"
        >
          <span class="ds-label">{{ d.label }}</span>
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
    </div>

    <!-- 未选课程 -->
    <div v-if="!canQuery" class="card card-pad empty-state">
      <ZkIcon name="table" :size="28" />
      <div class="empty-title">先选择一门课程</div>
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
          :fixed="colFixed(col.key)"
          show-overflow-tooltip
        >
          <template #default="{ row }">{{ cellText(row, col.key) }}</template>
        </el-table-column>
      </el-table>

      <div v-else-if="result" class="empty-state" style="padding: 28px 0">
        <div class="small muted">
          当前条件下没有数据。可以换一个任务、放宽状态，或确认这门课的学生是否已选课、任务是否已发布。
        </div>
        <div
          v-if="query.status !== 'all' || query.taskId || query.classId || query.keyword || query.dateRange.length"
          class="empty-actions"
        >
          <span class="small muted">一键放宽：</span>
          <button v-if="query.status !== 'all'" class="btn btn-outline btn-sm" @click="query.status = 'all'">
            清空状态（{{ STATUS_TEXT[query.status] }}）
          </button>
          <button v-if="query.taskId" class="btn btn-outline btn-sm" @click="query.taskId = ''">清空任务筛选</button>
          <button v-if="query.classId" class="btn btn-outline btn-sm" @click="query.classId = ''">清空班级筛选</button>
          <button v-if="query.keyword" class="btn btn-outline btn-sm" @click="query.keyword = ''">清空学生筛选</button>
          <button v-if="query.dateRange.length" class="btn btn-outline btn-sm" @click="query.dateRange = []">
            清空日期范围
          </button>
        </div>
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

  <!-- 导出设置：把「导的是哪批数据、哪几列」在落盘前说清楚。
       条件摘要与后端「导出条件」sheet 同源，字段勾选只裁列不裁行。 -->
  <el-dialog v-model="exportVisible" title="导出 Excel" width="580px">
    <div class="dlg-block">
      <div class="dlg-title">这批数据是什么</div>
      <div class="summary-grid">
        <div v-for="f in filterSummary" :key="f.label" class="summary-item">
          <span class="summary-label">{{ f.label }}</span>
          <span class="summary-value">{{ f.value }}</span>
        </div>
      </div>
      <div class="small muted" style="margin-top: 8px">
        共 <b>{{ result?.total ?? 0 }}</b> 行；文件含「数据」「导出条件」两个 sheet，条件页会记录本次筛选与导出人。
      </div>
    </div>

    <div class="dlg-block">
      <div class="dlg-title">
        导出列
        <span class="small muted" style="font-weight: 400; margin-left: 8px">不勾只是不写进文件，行数不变</span>
        <span class="col-ops">
          <button class="btn btn-outline btn-sm" @click="selectAllColumns">全选</button>
          <button class="btn btn-outline btn-sm" @click="invertColumns">反选</button>
        </span>
      </div>
      <el-checkbox-group v-model="exportColumns" class="col-group">
        <el-checkbox v-for="c in result?.columns ?? []" :key="c.key" :value="c.key">{{ c.label }}</el-checkbox>
      </el-checkbox-group>
      <div v-if="!exportColumns.length" class="small" style="color: var(--warn-600, #b45309)">
        至少保留一列，否则文件里只剩条件页。
      </div>
    </div>

    <template #footer>
      <button class="btn btn-outline" @click="exportVisible = false">取消</button>
      <button class="btn btn-primary" :disabled="exporting || !exportColumns.length" @click="doExport">
        {{ exporting ? '正在导出…' : `确认导出 ${result?.total ?? 0} 行` }}
      </button>
    </template>
  </el-dialog>
</template>

<style scoped>
.grade-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ds-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
  margin-top: 4px;
}
/* 只有类型名，卡片按单行标签收窄，六类两行排满不占高度 */
.ds-card {
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
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

/* ---- 导出设置弹窗 ---- */
.dlg-block + .dlg-block {
  margin-top: 16px;
}
.dlg-title {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-900);
  margin-bottom: 8px;
}
.col-ops {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px 16px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.summary-item {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
  min-width: 0;
}
.summary-label {
  flex: 0 0 62px;
  color: var(--ink-500);
}
.summary-value {
  color: var(--ink-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-group {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 4px 8px;
}
.col-group :deep(.el-checkbox) {
  margin-right: 0;
}
.empty-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
</style>
