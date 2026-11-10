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
  if (!courseId.value) {
    ElMessage.warning('先选一门课程，题目要挂在课程下');
    return;
  }
  editingId.value = '';
  resetForm();
  dialogVisible.value = true;
}

async function openEdit(row: QuestionVo) {
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
      <el-button v-if="courseId" type="primary" @click="openCreate">
        <ZkIcon name="plus" :size="15" style="margin-right: 4px" />新增题目
      </el-button>
    </div>
  </div>

  <div class="toolbar">
    <div class="left">
      <el-button class="tb-icon" :loading="loading" title="刷新列表（保留当前筛选）" @click="fetchList">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="15" />
      </el-button>
      <span class="small muted">题库挂基础课程，与学期无关</span>
    </div>
    <div class="right" style="gap: 10px">
      <el-select
        v-model="courseId"
        placeholder="选择课程"
        filterable
        :loading="courseLoading"
        style="width: 220px"
        @change="onCourseChange"
      >
        <el-option v-for="c in courseOptions" :key="c.courseId" :label="c.courseName || c.courseId" :value="String(c.courseId)" />
      </el-select>
      <el-select v-model="query.qType" placeholder="全部题型" clearable style="width: 120px" @change="onSearch">
        <el-option v-for="t in Q_TYPES" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-select v-model="query.difficulty" placeholder="全部难度" clearable style="width: 120px" @change="onSearch">
        <el-option v-for="d in DIFFICULTY_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
      </el-select>
      <el-input
        v-model="query.keyword"
        placeholder="题干关键词"
        clearable
        style="width: 180px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-button @click="onSearch">搜索</el-button>
      <el-button v-if="hasFilter" link @click="resetQuery">清空条件</el-button>
    </div>
  </div>

  <div class="card card-pad">
    <el-table
      v-loading="loading"
      :data="rows"
      size="small"
      style="width: 100%"
      :row-key="(r: QuestionVo) => r.questionId"
    >
      <el-table-column label="题干" min-width="320" show-overflow-tooltip>
        <template #default="{ row }">{{ contentBrief(row.content) }}</template>
      </el-table-column>
      <el-table-column label="题型" width="96">
        <template #default="{ row }">
          <span class="q-tag">{{ qTypeLabel(row.qType) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="难度" width="100">
        <template #default="{ row }">{{ difficultyLabel(row.difficulty) }}</template>
      </el-table-column>
      <el-table-column label="默认分值" width="92" align="right">
        <template #default="{ row }">{{ row.defaultScore ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ row.createTime || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link size="small" @click="openDetail(row)">查看</el-button>
          <el-button link size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link size="small" type="danger" @click="doRemove(row)">删除</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty-block">
          <ZkIcon name="file-text" :size="26" />
          <div class="empty-title">
            {{ !courseId ? '先选一门课程' : loadError ? '数据未取到' : hasFilter ? '当前筛选下没有题目' : '这门课还没有题目' }}
          </div>
          <div v-if="!courseId" class="small muted">题库按课程存放，选好课程后这里会列出它的全部题目。</div>
          <div v-else-if="loadError" class="small muted">{{ loadError }}</div>
          <div v-else-if="hasFilter" class="small muted">题型 / 难度 / 关键词可能把结果排除了，清空条件即可看到全部。</div>
          <div v-else class="small muted">点右上角「新增题目」录入第一道题。</div>
          <div class="empty-actions">
            <el-button v-if="loadError" size="small" @click="fetchList">重新加载</el-button>
            <el-button v-else-if="hasFilter" size="small" @click="resetQuery">清空筛选</el-button>
            <el-button v-else-if="courseId" size="small" @click="openCreate">新增题目</el-button>
          </div>
        </div>
      </template>
    </el-table>

    <div class="pager">
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
  <el-dialog
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
        <el-select v-model="form.difficulty" style="width: 130px">
          <el-option v-for="d in DIFFICULTY_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
        </el-select>
        <span class="small muted" style="margin: 0 8px">默认分值</span>
        <el-input-number v-model="form.defaultScore" :min="0" :max="100" :step="1" style="width: 110px" />
      </el-form-item>

      <el-form-item label="题干" prop="content">
        <el-input v-model="form.content" type="textarea" :rows="3" maxlength="5000" show-word-limit placeholder="题目内容" />
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
          <el-radio-group v-model="form.answer">
            <el-radio v-for="o in form.options" :key="o.key" :value="o.key">{{ o.key }}</el-radio>
          </el-radio-group>
        </template>
        <template v-else-if="form.qType === 'multi'">
          <el-checkbox-group v-model="multiAnswerKeys">
            <el-checkbox v-for="o in form.options" :key="o.key" :value="o.key">{{ o.key }}</el-checkbox>
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
  <el-dialog v-model="detailVisible" title="题目详情" width="640px">
    <div v-loading="detailLoading">
      <template v-if="detail">
        <div class="detail-row">
          <span class="detail-k">题型</span>
          <span>{{ qTypeLabel(detail.qType) }}　·　难度 {{ difficultyLabel(detail.difficulty) }}　·　默认分值 {{ detail.defaultScore ?? '—' }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-k">题干</span>
          <span class="detail-v">{{ detail.content }}</span>
        </div>
        <div v-if="safeOptions(detail).length" class="detail-row">
          <span class="detail-k">选项</span>
          <span class="detail-v">
            <div v-for="o in safeOptions(detail)" :key="o.key">{{ o.key }}. {{ o.text }}</div>
          </span>
        </div>
        <div v-else-if="isChoice(detail.qType)" class="detail-row">
          <span class="detail-k">选项</span>
          <span class="detail-v muted">库里没有可用选项数据（可能保存时为空或解析失败）</span>
        </div>
        <div class="detail-row">
          <span class="detail-k">答案</span>
          <span class="detail-v">{{ detail.answer || '—' }}</span>
        </div>
        <div v-if="detail.analysis" class="detail-row">
          <span class="detail-k">解析</span>
          <span class="detail-v">{{ detail.analysis }}</span>
        </div>
        <div v-if="detail.judgeConfig" class="detail-row">
          <span class="detail-k">判题配置</span>
          <span class="detail-v mono">{{ JSON.stringify(detail.judgeConfig) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-k">创建时间</span>
          <span>{{ detail.createTime || '—' }}</span>
        </div>
      </template>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.q-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--brand-50, #eef2ff);
  color: var(--brand-700, #4338ca);
  font-size: 12px;
  line-height: 18px;
}
.opt-list {
  width: 100%;
}
.opt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.opt-key {
  width: 20px;
  text-align: center;
  font-weight: 700;
  color: var(--ink-500, #6b7280);
}
.judge-cfg {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-row {
  display: flex;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--border, #eef0f4);
  font-size: 13px;
}
.detail-row:last-child {
  border-bottom: none;
}
.detail-k {
  width: 72px;
  flex: none;
  color: var(--ink-400, #9aa3b2);
}
.detail-v {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  color: var(--ink-400, #9aa3b2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #374151);
}
.empty-actions {
  margin-top: 4px;
}
.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}
</style>
