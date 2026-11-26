<script setup lang="ts">
/**
 * G2 · 题库管理（2026-11-10 派单）
 *
 * 口径：题库挂**基础课程**，不挂学期（会议 [23760]「题库和本学期没关系」）。
 * 端点见 `api/admin/questions.ts` 顶部注释（5 条，11-10 全部实测可用）。
 *
 * ★ 这一页最容易被误判成 bug 的三件事，先写在前面：
 *  1. `options` 在**非选择题上实测是 `null` 而不是 `[]`**，且后端遇到脏 json 会降级成 null
 *     （列是 json 类型，解析失败不抛错）⇒ 页面一律 `Array.isArray()` 兜底，绝不直接 `.length`。
 *  2. 知识点（`kpId`）**当前没有数据源**：题库 4 条全为 null，也没有知识点查询接口。
 *     所以本页不渲染「知识点」筛选（给了下拉也没选项，等于假控件）；参数通道留在 api 层。
 *  3. 派单文档说 `judge_config` 是「判断题配置」，但后端 `QuestionCreateBo` 注释明确它是
 *     **编程题**的判题方式 ⇒ 本页按后端口径：判断题只选正确/错误，编程题才给判题配置。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { useUserStore } from '@/store/user';
import { listCourses, type AdminCourseVo } from '@/api/admin/courses';
import {
  DIFFICULTY_OPTIONS,
  Q_TYPES,
  createQuestion,
  difficultyLabel,
  getQuestion,
  listQuestions,
  qTypeLabel,
  removeQuestion,
  updateQuestion,
  type QuestionOption,
  type QuestionSaveBo,
  type QuestionVo
} from '@/api/admin/questions';

/* ---------------- 课程下拉（题库的基础课程口径，不挂学期） ---------------- */
const courseOptions = ref<AdminCourseVo[]>([]);
const courseId = ref('');
const courseLoading = ref(false);

async function loadCourses() {
  courseLoading.value = true;
  try {
    // 题库属于课程内容，认证中（certifying）的课也可能要先录题 ⇒ 不按 status 过滤。
    // pageSize 给 200：当前库 21 门，留足余量且不至于拖慢首屏。
    const res = await listCourses({ page: 1, pageSize: 200 });
    courseOptions.value = res?.list ?? [];
    if (!courseId.value && courseOptions.value.length) courseId.value = String(courseOptions.value[0].courseId);
  } catch {
    courseOptions.value = [];
  } finally {
    courseLoading.value = false;
  }
}

/* ---------------- 列表 ---------------- */
const loading = ref(false);
const rows = ref<QuestionVo[]>([]);
const total = ref(0);
const loadError = ref('');
const query = reactive({ page: 1, pageSize: 10, qType: '', difficulty: '' as number | string, keyword: '' });

const hasFilter = computed(() => !!(query.qType || query.difficulty !== '' || query.keyword.trim()));

/* ---------------- 权限门禁（2026-11-15 补）
 * 权限点与后端 `AdminQuestionController` 的 @PreAuthorize 一一对应（sys_menu 3378~3382 已登记）：
 *   list=列表  query=详情  add=新增  edit=编辑  remove=删除
 * 页面本身由 list 权限把门（无 list 时后端 403，列表报错），所以这里只管三个写动作。
 * 观感与 courses 页一致：无权限直接不出按钮，而不是 disabled —— 免得用户反复点一个永远点不动的按钮。
 */
const userStore = useUserStore();
const canAdd = computed(() => userStore.hasPermi('admin:questions:add'));
const canEdit = computed(() => userStore.hasPermi('admin:questions:edit'));
const canRemove = computed(() => userStore.hasPermi('admin:questions:remove'));
/** 三个写权限一个都没有 ⇒ 页头挂「只读」徽标，说明为什么看不到新增/编辑/删除 */
const readOnly = computed(() => !canAdd.value && !canEdit.value && !canRemove.value);

async function fetchList() {
  if (!courseId.value) {
    rows.value = [];
    total.value = 0;
    loadError.value = '';
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    const res = await listQuestions(courseId.value, {
      page: query.page,
      pageSize: query.pageSize,
      qType: query.qType || undefined,
      difficulty: query.difficulty === '' ? undefined : Number(query.difficulty),
      keyword: query.keyword.trim() || undefined
    });
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
  } catch {
    // 请求层已弹提示，这里只负责把列表清空并标记，避免"空表看起来像没数据"
    rows.value = [];
    total.value = 0;
    loadError.value = '题目列表未取到，可点刷新重试。';
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  query.page = 1;
  void fetchList();
}

function resetQuery() {
  query.qType = '';
  query.difficulty = '';
  query.keyword = '';
  onSearch();
}

function onCourseChange() {
  query.page = 1;
  void fetchList();
}

/* ---------------- 展示辅助 ---------------- */
/** 题干摘要：列表列宽有限，截断交给 el-table 的 show-overflow-tooltip，这里只压掉换行 */
function contentBrief(s?: string | null) {
  return (s ?? '').replace(/\s+/g, ' ').trim() || '（空题干）';
}

/** options 的容错读取：null / 非数组 / 元素缺字段，一律降级成可渲染的结构 */
function safeOptions(q: QuestionVo): QuestionOption[] {
  if (!Array.isArray(q.options)) return [];
  return q.options
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({ ...o, key: String((o as QuestionOption).key ?? ''), text: String((o as QuestionOption).text ?? '') }));
}

function isChoice(qType: string) {
  return qType === 'single' || qType === 'multi';
}

/** 难度短标签：列表列宽有限，不用「3 · 中等」这种长文案 */
const DIFF_SHORT: Record<number, string> = { 1: '很易', 2: '较易', 3: '中等', 4: '较难', 5: '很难' };
function diffShort(d?: number | null) {
  const n = Number(d);
  return DIFF_SHORT[n] ?? '—';
}

/** 难度档位给颜色用（1-2 绿 / 3 蓝 / 4-5 橙红），脏值一律按中等 */
function diffLevel(d?: number | null) {
  const n = Number(d);
  if (!n || n < 1 || n > 5) return 3;
  return n;
}

/** 选项文字摘要：参考答案那一行要显示"A · 选项内容"，太长会撑破弹窗 */
function optBrief(t?: string | null) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '（未填内容）';
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

/* ---------------- 详情 ---------------- */
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<QuestionVo | null>(null);

async function openDetail(row: QuestionVo) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = row;
  try {
    // 列表已带全字段，仍走一次详情接口：确保看到的是**当前**库里的值（别人可能刚改过）
    detail.value = await getQuestion(row.questionId);
  } catch {
    /* 取不到就展示列表行，不阻塞查看 */
  } finally {
    detailLoading.value = false;
  }
}

/* ---------------- 新增 / 编辑 ---------------- */
const dialogVisible = ref(false);
const saving = ref(false);
const editingId = ref('');
const formRef = ref();

const form = reactive({
  qType: 'single' as string,
  difficulty: 3,
  content: '',
  answer: '',
  analysis: '',
  defaultScore: 5 as number | null,
  options: [] as QuestionOption[],
  /** 编程题判题配置（可选）。保留原始对象，保存时合并，避免把没编辑的字段（如 testCases）冲掉 */
  judgeMode: '' as string,
  timeLimitMs: null as number | null
});
/** 编辑时的原始 judgeConfig，保存时与界面上两个字段合并 */
let originalJudgeConfig: Record<string, unknown> | null = null;

/** 多选题答案 = 按选项顺序拼接的 key 串（后端注释建议 "ABD" 这种顺序存法） */
const multiAnswerKeys = ref<string[]>([]);
/** 判断题答案：true / false（库里暂无判断题样本，按布尔文本存；编辑回显时兼容"对/错/正确/错误"） */
const judgeAnswer = ref<'true' | 'false' | ''>('');

function resetForm() {
  form.qType = 'single';
  form.difficulty = 3;
  form.content = '';
  form.answer = '';
  form.analysis = '';
  form.defaultScore = 5;
  form.options = [
    { key: 'A', text: '' },
    { key: 'B', text: '' }
  ];
  form.judgeMode = '';
  form.timeLimitMs = null;
  multiAnswerKeys.value = [];
  judgeAnswer.value = '';
  originalJudgeConfig = null;
}

function openCreate() {
  if (!canAdd.value) {
    ElMessage.warning('当前账号没有新增题目的权限');
    return;
  }
  if (!courseId.value) {
    ElMessage.warning('先选一门课程，题目要挂在课程下');
    return;
  }
  editingId.value = '';
  resetForm();
  dialogVisible.value = true;
}

async function openEdit(row: QuestionVo) {
  if (!canEdit.value) {
    ElMessage.warning('当前账号没有编辑题目的权限');
    return;
  }
  editingId.value = row.questionId;
  resetForm();
  dialogVisible.value = true;
  let q = row;
  try {
    q = await getQuestion(row.questionId);
  } catch {
    /* 详情取不到就用列表行 */
  }
  form.qType = q.qType || 'single';
  form.difficulty = q.difficulty ?? 3;
  form.content = q.content ?? '';
  form.answer = q.answer ?? '';
  form.analysis = q.analysis ?? '';
  form.defaultScore = q.defaultScore ?? null;
  // ★ 保留元素上的额外字段（后端将来加 image 之类），只覆盖 key/text
  form.options = safeOptions(q);
  if (!form.options.length && isChoice(form.qType)) {
    form.options = [
      { key: 'A', text: '' },
      { key: 'B', text: '' }
    ];
  }
  if (form.qType === 'multi') {
    multiAnswerKeys.value = String(form.answer ?? '')
      .split('')
      .filter((c) => c.trim());
  }
  if (form.qType === 'judge') {
    const a = String(form.answer ?? '').trim().toLowerCase();
    judgeAnswer.value = ['true', '1', '对', '正确', 't', 'y', '是'].includes(a) ? 'true'
      : ['false', '0', '错', '错误', 'f', 'n', '否'].includes(a) ? 'false' : '';
  }
  originalJudgeConfig = q.judgeConfig && typeof q.judgeConfig === 'object' ? { ...q.judgeConfig } : null;
  const jm = originalJudgeConfig?.judgeMode;
  form.judgeMode = typeof jm === 'string' ? jm : '';
  const tl = originalJudgeConfig?.timeLimitMs;
  form.timeLimitMs = typeof tl === 'number' ? tl : null;
}

/** 选项增删：key 始终按位置重排 A/B/C/D...，避免删中间一项后 key 出现空洞导致答案对不上 */
function addOption() {
  const next = String.fromCharCode(65 + form.options.length);
  form.options.push({ key: next, text: '' });
}

function removeOption(idx: number) {
  if (form.options.length <= 2) {
    ElMessage.warning('选择题至少保留 2 个选项');
    return;
  }
  const removed = form.options[idx]?.key;
  form.options.splice(idx, 1);
  // key 重排后，已选答案里的旧 key 会失效 ⇒ 一并清掉，让用户重选，不静默留一个错答案
  multiAnswerKeys.value = [];
  if (removed && form.qType === 'single') form.answer = '';
}

/** 题型切换：答案形态完全不同，切了就重置答案，避免把上一题型的答案带到新题型 */
function onQTypeChange() {
  form.answer = '';
  multiAnswerKeys.value = [];
  judgeAnswer.value = '';
  if (isChoice(form.qType) && form.options.length < 2) {
    form.options = [
      { key: 'A', text: '' },
      { key: 'B', text: '' }
    ];
  }
}

const rules = {
  content: [{ required: true, message: '题干不能为空', trigger: 'blur' }],
  qType: [{ required: true, message: '请选择题型', trigger: 'change' }]
};

/** 组装提交体：按题型裁剪无关字段，避免把"编辑过又切走"的残留值写进库 */
function buildPayload(): QuestionSaveBo | null {
  const answer = (() => {
    if (form.qType === 'single') return form.answer;
    if (form.qType === 'multi') {
      // 按选项顺序拼，保证 "ABD" 这种顺序稳定（后端注释建议顺序存）
      return form.options.map((o) => o.key).filter((k) => multiAnswerKeys.value.includes(k)).join('');
    }
    if (form.qType === 'judge') return judgeAnswer.value;
    return form.answer;
  })().trim();

  if (!answer) {
    ElMessage.warning(form.qType === 'multi' ? '至少勾选一个正确选项' : '参考答案不能为空');
    return null;
  }
  if (isChoice(form.qType)) {
    const filled = form.options.filter((o) => o.text.trim());
    if (filled.length < 2) {
      ElMessage.warning('选择题至少填 2 个选项内容');
      return null;
    }
    if (form.qType === 'single' && !filled.some((o) => o.key === answer)) {
      ElMessage.warning('正确答案要选一个已填内容的选项');
      return null;
    }
  }

  const body: QuestionSaveBo = {
    qType: form.qType,
    difficulty: form.difficulty || 3,
    content: form.content.trim(),
    answer,
    analysis: form.analysis.trim() || undefined,
    defaultScore: form.defaultScore === null ? undefined : Number(form.defaultScore)
  };
  if (isChoice(form.qType)) {
    body.options = form.options.map((o) => ({ ...o, text: o.text.trim() }));
  }
  if (form.qType === 'program') {
    // ★ 先铺原始配置再覆盖两个可编辑字段：不这么做会把库里已有的 testCases 等冲掉
    const cfg: Record<string, unknown> = { ...(originalJudgeConfig ?? {}) };
    if (form.judgeMode) cfg.judgeMode = form.judgeMode;
    else delete cfg.judgeMode;
    if (form.timeLimitMs !== null) cfg.timeLimitMs = Number(form.timeLimitMs);
    else delete cfg.timeLimitMs;
    body.judgeConfig = Object.keys(cfg).length ? cfg : null;
  }
  return body;
}

async function submitForm() {
  const valid = await formRef.value?.validate?.().catch(() => false);
  if (valid === false) return;
  const payload = buildPayload();
  if (!payload) return;
  saving.value = true;
  try {
    if (editingId.value) {
      await updateQuestion(editingId.value, payload);
      ElMessage.success('已保存');
    } else {
      await createQuestion(courseId.value, payload);
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    await fetchList();
  } catch {
    /* 请求层已弹错误提示 */
  } finally {
    saving.value = false;
  }
}

/* ---------------- 删除 ---------------- */
async function doRemove(row: QuestionVo) {
  if (!canRemove.value) {
    ElMessage.warning('当前账号没有删除题目的权限');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除后各学期同一课程都不可见（题库基于基础课程，不是只影响当前学期）。确认删除「${contentBrief(row.content).slice(0, 20)}…」？`,
      '删除题目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  try {
    await removeQuestion(row.questionId);
    ElMessage.success('已删除');
    // 删的是当前页最后一条时回退一页，避免停在空页
    if (rows.value.length === 1 && query.page > 1) query.page -= 1;
    await fetchList();
  } catch {
    /* 请求层已提示 */
  }
}

onMounted(async () => {
  await loadCourses();
  await fetchList();
});
</script>

<template>
  <div class="page-head">
    <h1>题库管理</h1>
    <div class="actions">
      <el-tag v-if="readOnly" size="small" type="info" effect="plain" style="margin-right: 8px">
        只读：当前账号无题库编辑权限
      </el-tag>
      <el-button v-if="courseId && canAdd" type="primary" @click="openCreate">
        <ZkIcon name="plus" :size="15" style="margin-right: 4px" />新增题目
      </el-button>
    </div>
  </div>

  <div class="toolbar">
    <div class="left">
      <el-button class="tb-icon" :loading="loading" title="刷新列表（保留当前筛选）" @click="fetchList">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="15" />
      </el-button>
      <div class="tb-hint">
        <span class="tb-hint-main">题库挂基础课程</span>
        <span class="tb-hint-sub">与学期无关，换课程即换题目</span>
      </div>
    </div>
    <div class="right">
      <el-select
        v-model="courseId"
        placeholder="选择课程"
        filterable
        :loading="courseLoading"
        class="w-course"
        @change="onCourseChange"
      >
        <el-option v-for="c in courseOptions" :key="c.courseId" :label="c.courseName || c.courseId" :value="String(c.courseId)" />
      </el-select>
      <el-select v-model="query.qType" placeholder="全部题型" clearable class="w-sm" @change="onSearch">
        <el-option v-for="t in Q_TYPES" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-select v-model="query.difficulty" placeholder="全部难度" clearable class="w-sm" @change="onSearch">
        <el-option v-for="d in DIFFICULTY_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
      </el-select>
      <el-input
        v-model="query.keyword"
        placeholder="题干关键词"
        clearable
        class="w-key"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-button class="tb-btn" type="primary" @click="onSearch">
        <ZkIcon name="search" :size="15" style="margin-right: 4px" />搜索
      </el-button>
      <el-button class="tb-btn tb-btn-reset" :disabled="!hasFilter" @click="resetQuery">
        <ZkIcon name="undo-2" :size="15" style="margin-right: 4px" />重置
      </el-button>
    </div>
  </div>

  <div class="card">
    <!-- 卡头：只讲"这块是什么、现在是不是筛选态"，条数统一放到页脚，避免同一个数字出现两次 -->
    <div class="list-head">
      <span class="lh-title">题目列表</span>
      <span class="small muted">{{ hasFilter ? '已按条件筛选' : '显示该课程全部题目' }}</span>
    </div>

    <el-table
      v-loading="loading"
      :data="rows"
      style="width: 100%"
      :row-key="(r: QuestionVo) => r.questionId"
    >
      <el-table-column type="index" label="#" width="48" :index="(i: number) => (query.page - 1) * query.pageSize + i + 1" />
      <el-table-column label="题干" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'q-empty': !String(row.content ?? '').trim() }">{{ contentBrief(row.content) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="题型" width="104">
        <template #default="{ row }">
          <span class="q-badge" :class="`qb-${row.qType}`">{{ qTypeLabel(row.qType) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="难度" width="124">
        <template #default="{ row }">
          <div class="diff" :title="difficultyLabel(row.difficulty)">
            <i
              v-for="i in 5"
              :key="i"
              :class="[{ on: i <= diffLevel(row.difficulty) }, `dl-${diffLevel(row.difficulty)}`]"
            />
            <span class="diff-txt">{{ diffShort(row.difficulty) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="默认分值" width="88" align="right">
        <template #default="{ row }">
          <span v-if="row.defaultScore != null" class="score">{{ row.defaultScore }}<em>分</em></span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <!-- 只显示日期：题库的"创建时间"精确到分没有决策价值，但 16 字符会把 1280 下的题干挤没；
           完整时间挂在 title 上，需要时悬停可看 -->
      <el-table-column label="创建时间" width="118">
        <template #default="{ row }">
          <span class="small muted" :title="row.createTime || ''">{{ (row.createTime || '').slice(0, 10) || '—' }}</span>
        </template>
      </el-table-column>
      <!-- 142 = 三个 30px 文字按钮 + 两道 12px 间距 + 单元格左右 padding；
           给窄了 el-table 会在单元格里出省略号，把「删除」吃掉 -->
      <el-table-column label="操作" class-name="q-op" :width="canEdit || canRemove ? 142 : 76" fixed="right">
        <template #default="{ row }">
          <el-button link size="small" @click="openDetail(row)">查看</el-button>
          <el-button v-if="canEdit" link size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canRemove" link size="small" type="danger" @click="doRemove(row)">删除</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty-block">
          <ZkIcon name="file-text" :size="24" />
          <div class="empty-title">
            {{ !courseId ? '先选一门课程' : loadError ? '数据未取到' : hasFilter ? '当前筛选下没有题目' : '这门课还没有题目' }}
          </div>
          <div v-if="!courseId" class="small muted">题库按课程存放，选好课程后这里会列出它的全部题目。</div>
          <div v-else-if="loadError" class="small muted">{{ loadError }}</div>
          <div v-else-if="hasFilter" class="small muted">题型 / 难度 / 关键词可能把结果排除了，清空条件即可看到全部。</div>
          <div v-else-if="canAdd" class="small muted">点右上角「新增题目」录入第一道题。</div>
          <div v-else class="small muted">这门课还没有题目；当前账号无新增权限，请联系有权限的同事录入。</div>
          <div class="empty-actions">
            <el-button v-if="loadError" size="small" @click="fetchList">重新加载</el-button>
            <el-button v-else-if="hasFilter" size="small" @click="resetQuery">清空筛选</el-button>
            <el-button v-else-if="courseId && canAdd" size="small" type="primary" plain @click="openCreate">新增题目</el-button>
          </div>
        </div>
      </template>
    </el-table>

    <div class="between list-foot">
      <span class="small muted">
        <template v-if="loadError">记录数未取到（加载失败）</template>
        <template v-else>共 {{ total }} 道题{{ hasFilter ? '（已筛选）' : '' }}</template>
      </span>
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        @current-change="fetchList"
        @size-change="onSearch"
      />
    </div>
  </div>

  <!-- 新增 / 编辑 -->
  <el-dialog draggable
    v-model="dialogVisible"
    :title="editingId ? '编辑题目' : '新增题目'"
    width="680px"
    :close-on-click-modal="false"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="86px">
      <el-form-item label="题型" prop="qType">
        <el-radio-group v-model="form.qType" @change="onQTypeChange">
          <el-radio-button v-for="t in Q_TYPES" :key="t.value" :value="t.value">{{ t.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="难度 / 分值">
        <div class="row2">
          <el-select v-model="form.difficulty" style="width: 132px">
            <el-option v-for="d in DIFFICULTY_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
          </el-select>
          <span class="row2-sep">默认分值</span>
          <el-input-number v-model="form.defaultScore" :min="0" :max="100" :step="1" style="width: 120px" />
        </div>
      </el-form-item>

      <el-form-item label="题干" prop="content">
        <el-input v-model="form.content" type="textarea" :rows="4" maxlength="5000" show-word-limit placeholder="题目内容，可换行" />
      </el-form-item>

      <!-- 选择题选项：动态表单，不让人手填 JSON -->
      <el-form-item v-if="isChoice(form.qType)" label="选项">
        <div class="opt-list">
          <div v-for="(o, i) in form.options" :key="i" class="opt-row">
            <span class="opt-key">{{ o.key }}</span>
            <el-input v-model="o.text" placeholder="选项内容" maxlength="500" />
            <el-button link type="danger" :disabled="form.options.length <= 2" @click="removeOption(i)">
              <ZkIcon name="x" :size="14" />
            </el-button>
          </div>
          <el-button link type="primary" :disabled="form.options.length >= 8" @click="addOption">
            <ZkIcon name="plus" :size="13" style="margin-right: 3px" />添加选项（最多 8 个）
          </el-button>
        </div>
      </el-form-item>

      <!-- 答案：形态随题型变 -->
      <el-form-item label="参考答案">
        <template v-if="form.qType === 'single'">
          <!-- 带上选项内容：只看 A/B 得回头核对上面填了什么，容易选错 -->
          <el-radio-group v-model="form.answer" class="ans-group">
            <el-radio v-for="o in form.options" :key="o.key" :value="o.key">
              <span class="ans-label"><b>{{ o.key }}.</b>{{ optBrief(o.text) }}</span>
            </el-radio>
          </el-radio-group>
        </template>
        <template v-else-if="form.qType === 'multi'">
          <el-checkbox-group v-model="multiAnswerKeys" class="ans-group">
            <el-checkbox v-for="o in form.options" :key="o.key" :value="o.key">
              <span class="ans-label"><b>{{ o.key }}.</b>{{ optBrief(o.text) }}</span>
            </el-checkbox>
          </el-checkbox-group>
        </template>
        <template v-else-if="form.qType === 'judge'">
          <el-radio-group v-model="judgeAnswer">
            <el-radio value="true">正确</el-radio>
            <el-radio value="false">错误</el-radio>
          </el-radio-group>
        </template>
        <template v-else>
          <el-input
            v-model="form.answer"
            :type="form.qType === 'program' ? 'textarea' : 'textarea'"
            :rows="form.qType === 'program' ? 4 : 2"
            maxlength="10000"
            :placeholder="form.qType === 'blank' ? '填空答案（多个空可用 | 分隔）' : form.qType === 'program' ? '参考代码' : '参考答案'"
          />
        </template>
      </el-form-item>

      <!-- 编程题判题配置：只有编程题有意义，且全部可选 -->
      <el-form-item v-if="form.qType === 'program'" label="判题配置">
        <div class="judge-cfg">
          <el-select v-model="form.judgeMode" placeholder="判题方式（可不填）" clearable style="width: 180px">
            <el-option label="用例比对 case" value="case" />
            <el-option label="AI 判题 llm" value="llm" />
          </el-select>
          <span class="small muted">时间限制(ms)</span>
          <el-input-number v-model="form.timeLimitMs" :min="0" :max="60000" :step="500" style="width: 140px" />
          <div class="small muted" style="margin-top: 4px; width: 100%">
            用例列表等其余字段不在此处编辑，保存时会原样保留库里已有的配置。
          </div>
        </div>
      </el-form-item>

      <el-form-item label="解析">
        <el-input v-model="form.analysis" type="textarea" :rows="2" maxlength="5000" show-word-limit placeholder="可选" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
    </template>
  </el-dialog>

  <!-- 详情 -->
  <el-dialog draggable v-model="detailVisible" title="题目详情" width="660px">
    <div v-loading="detailLoading" class="detail">
      <template v-if="detail">
        <!-- 一行元信息：题型徽标 + 难度刻度 + 分值 + 创建时间，替代原来「题型　·　难度 X　·　分值」的密集长句 -->
        <div class="detail-meta">
          <span class="q-badge" :class="`qb-${detail.qType}`">{{ qTypeLabel(detail.qType) }}</span>
          <div class="diff" :title="difficultyLabel(detail.difficulty)">
            <i
              v-for="i in 5"
              :key="i"
              :class="[{ on: i <= diffLevel(detail.difficulty) }, `dl-${diffLevel(detail.difficulty)}`]"
            />
            <span class="diff-txt">{{ diffShort(detail.difficulty) }}</span>
          </div>
          <span class="meta-item">默认分值 <b>{{ detail.defaultScore ?? '—' }}</b></span>
          <span class="meta-item">创建于 <b>{{ (detail.createTime || '').slice(0, 16) || '—' }}</b></span>
        </div>

        <div class="sec">
          <div class="sec-k">题干</div>
          <div class="sec-v">{{ detail.content || '—' }}</div>
        </div>

        <div v-if="safeOptions(detail).length" class="sec">
          <div class="sec-k">选项</div>
          <div class="sec-v opt-view">
            <div v-for="o in safeOptions(detail)" :key="o.key" class="opt-view-row">
              <span class="opt-letter">{{ o.key }}</span>
              <span class="opt-text">{{ o.text || '（空）' }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="isChoice(detail.qType)" class="sec">
          <div class="sec-k">选项</div>
          <div class="sec-v muted">库里没有可用选项数据（可能保存时为空或解析失败）</div>
        </div>

        <div class="sec">
          <div class="sec-k">答案</div>
          <div class="sec-v answer-box">{{ detail.answer || '—' }}</div>
        </div>

        <div v-if="detail.analysis" class="sec">
          <div class="sec-k">解析</div>
          <div class="sec-v">{{ detail.analysis }}</div>
        </div>

        <div v-if="detail.judgeConfig" class="sec">
          <div class="sec-k">判题配置</div>
          <div class="sec-v"><pre class="code-block">{{ JSON.stringify(detail.judgeConfig, null, 2) }}</pre></div>
        </div>
      </template>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ---------- 工具栏 ----------
 * 右侧控件固定一档：课程 200 / 题型·难度 120 / 关键词 180 / 搜索·重置 76。
 * 题库页筛选项比别的页多一个「课程」，窄屏必须允许换行，否则整页出横向滚动条。 */
.toolbar {
  flex-wrap: wrap;
  row-gap: 8px;
}
.toolbar .left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.toolbar .right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 8px;
}
.toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}
.toolbar :deep(.tb-icon) {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--r-md, 8px);
  border-color: var(--border-strong, #cbd5e1);
  color: var(--ink-600, #475569);
}
.toolbar :deep(.tb-icon:hover) {
  border-color: var(--brand-400, #46d6ca);
  color: var(--brand-700, #0f766e);
  background: var(--brand-50, #effefb);
}
.toolbar :deep(.tb-btn) {
  height: 32px;
  min-width: 72px;
  padding: 0 12px;
  border-radius: var(--r-md, 8px);
  font-size: 14px;
  box-sizing: border-box;
}
.toolbar :deep(.tb-btn-reset) {
  border-color: var(--border-strong, #cbd5e1);
  color: var(--ink-700, #334155);
}
.toolbar :deep(.tb-btn-reset:hover:not(.is-disabled)) {
  border-color: var(--brand-400, #46d6ca);
  color: var(--brand-700, #0f766e);
  background: var(--brand-50, #effefb);
}
.toolbar :deep(.w-course) {
  width: 176px;
}
.toolbar :deep(.w-sm) {
  width: 112px;
}
.toolbar :deep(.w-key) {
  width: 160px;
}
/* 左侧提示：课程名在上（用户第一眼要知道在看哪门课），口径说明在下，别和按钮挤成一行 */
.tb-hint {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  min-width: 0;
}
.tb-hint-main {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-700, #334155);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-hint-sub {
  font-size: 12px;
  color: var(--ink-400, #94a3b8);
}

/* ---------- 卡片头 / 页脚 ---------- */
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border, #e3eaec);
}
.lh-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink-900, #0f172a);
}
.list-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border, #e3eaec);
}

/* ---------- 表格单元 ---------- */
/* 题型徽标：6 种题型各一色，扫一眼能分出来；未知题型走中性灰而不是跟着变透明 */
.q-badge {
  display: inline-block;
  padding: 1px 9px;
  border-radius: var(--r-full, 9999px);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
}
.qb-single {
  background: var(--brand-50, #effefb);
  color: var(--brand-700, #0f766e);
}
.qb-multi {
  background: #eef2ff;
  color: #4338ca;
}
.qb-judge {
  background: var(--warning-soft, #fef3c7);
  color: var(--warning-strong, #b45309);
}
.qb-blank {
  background: var(--success-soft, #dcfce7);
  color: var(--success-strong, #15803d);
}
.qb-short {
  background: #f5f3ff;
  color: #6d28d9;
}
.qb-program {
  background: #e0f2fe;
  color: #0369a1;
}
.q-badge:not(.qb-single):not(.qb-multi):not(.qb-judge):not(.qb-blank):not(.qb-short):not(.qb-program) {
  background: var(--bg-soft, #f1f5f6);
  color: var(--ink-600, #475569);
}
/* 操作列三个文字按钮必须同排：默认 white-space:normal 会把「删除」挤到第二行，行高直接翻倍 */
:deep(.q-op .cell) {
  white-space: nowrap;
}
/* 空题干用灰斜体标出来，避免和"题目内容就是空白"混淆 */
.q-empty {
  color: var(--ink-400, #94a3b8);
  font-style: italic;
}

/* 难度：5 格刻度 + 短文案。用刻度而不是"3 · 中等"，是为了让整列纵向可比 */
.diff {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.diff i {
  width: 5px;
  height: 11px;
  border-radius: 2px;
  background: var(--border-strong, #cbd5e1);
  opacity: 0.55;
}
.diff i.on {
  opacity: 1;
}
.diff i.on.dl-1,
.diff i.on.dl-2 {
  background: var(--success, #16a34a);
}
.diff i.on.dl-3 {
  background: var(--info, #0ea5a0);
}
.diff i.on.dl-4,
.diff i.on.dl-5 {
  background: var(--warning, #d97706);
}
.diff-txt {
  margin-left: 4px;
  font-size: 12px;
  color: var(--ink-500, #64748b);
}
.score {
  font-weight: 600;
  color: var(--ink-900, #0f172a);
}
.score em {
  margin-left: 2px;
  font-size: 11px;
  font-style: normal;
  font-weight: 500;
  color: var(--ink-400, #94a3b8);
}
/* ---------- 新增/编辑弹窗 ---------- */
.row2 {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row2-sep {
  font-size: 12px;
  color: var(--ink-500, #64748b);
}
.opt-list {
  width: 100%;
}
.opt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  margin: 0 -6px 4px;
  border-radius: var(--r-md, 8px);
}
.opt-row:hover {
  background: var(--bg-subtle, #f8fafb);
}
.opt-key {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--r-sm, 4px);
  background: var(--bg-soft, #f1f5f6);
  color: var(--ink-600, #475569);
  font-size: 12px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
}
/* 选项行尾的删除按钮宽度固定：宽度随内容抖动会让上下两个输入框右边框对不齐 */
.opt-row :deep(.el-button) {
  width: 24px;
  padding: 0;
  flex: none;
}
/* 单选题/多选题的答案列成竖排：选项文字一长，横排会挤成两行还看不全 */
.ans-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.ans-group :deep(.el-radio),
.ans-group :deep(.el-checkbox) {
  margin-right: 0;
  height: auto;
  min-height: 26px;
}
.ans-label {
  display: inline-flex;
  gap: 6px;
  min-width: 0;
  white-space: normal;
  line-height: 1.5;
}
.ans-label b {
  flex: none;
  color: var(--ink-700, #334155);
}
.judge-cfg {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* ---------- 详情弹窗 ----------
 * 改成「元信息一行 + 分节内容」：题干/选项/答案各占一段，长文本有边界框，
 * 不再是一条条灰标签 + 虚线，读长题干时不至于分不清哪段是题干哪段是解析。 */
.detail {
  min-height: 120px;
}
.detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 0 12px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border, #e3eaec);
}
.meta-item {
  font-size: 12px;
  color: var(--ink-500, #64748b);
}
.meta-item b {
  font-weight: 600;
  color: var(--ink-700, #334155);
}
.sec {
  padding: 10px 0;
  border-bottom: 1px dashed var(--border, #e3eaec);
}
.sec:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.sec-k {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-400, #94a3b8);
  margin-bottom: 5px;
}
.sec-v {
  font-size: 14px;
  line-height: 1.7;
  color: var(--ink-900, #0f172a);
  white-space: pre-wrap;
  word-break: break-word;
}
.opt-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  white-space: normal;
}
.opt-view-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.opt-letter {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--r-sm, 4px);
  background: var(--bg-soft, #f1f5f6);
  color: var(--ink-600, #475569);
  font-size: 12px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
}
.opt-text {
  flex: 1;
  min-width: 0;
}
/* 答案是这一屏最该被看到的东西 ⇒ 单独给底色，而不是和题干同一种黑字 */
.answer-box {
  padding: 8px 12px;
  border-radius: var(--r-md, 8px);
  background: var(--brand-50, #effefb);
  border: 1px solid var(--brand-200, #b2f6ea);
  color: var(--brand-800, #115e59);
  font-weight: 600;
}
.code-block {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-soft, #f1f5f6);
  border: 1px solid var(--border, #e3eaec);
  font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-700, #334155);
  overflow: auto;
  max-height: 220px;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  /* 32px 的纵向留白 + 表格自带的最小高度，空态会撑出半屏白；
     收到 20px 并给一个 min-height，空表看着是"这块暂时没内容"，不是"页面没加载完" */
  padding: 20px 16px;
  min-height: 168px;
  justify-content: center;
  color: var(--ink-400, #94a3b8);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #334155);
}
.empty-actions {
  margin-top: 6px;
}
</style>
