<script setup lang="ts">
/**
 * 课堂巡查（G4 · 甲线 2026-11-11 首版 → 2026-11-13 计划层转正）
 * ============================================================================
 * 两块内容，数据源互不相干（**别把两块的数字混着说**）：
 *
 * **一、巡查计划**（管理端自建安排）`classroom_patrol_plan`
 *   GET/POST /admin/patrol/plans、PUT/DELETE /admin/patrol/plans/{id}
 *   POST /admin/patrol/records?planId=&content=（multipart，附件落存储）
 *   权限：planList 3357 / planAdd 3358 / planEdit 3359 / planRemove 3360 / recordAdd 3361
 *
 * **二、巡查会话**（教师端开课自动产生，管理端只读）
 *   GET /admin/sessions、GET /sessions/{sessionId}/step-logs
 *   POST /admin/patrol/sessions/export（Excel，权限点 admin:patrol:export）
 *
 * ★ 2026-11-11 首版把计划层写成"后端 0 端点 ⇒ 只做缺口提示"。11-13 复核发现端点、
 *   表、权限点三件都已齐（api-docs 实测 + `show tables like '%patrol%'` 两行 + sys_menu
 *   3357~3361 已授权 role 1/100）⇒ 本次做成真界面，横幅撤掉。
 *   `probePatrolPlans()` 保留为**旧包回退**：万一换来一个不含计划层的包，
 *   计划区自动退回缺口提示而不是满屏红条。
 *
 * ★ 会话层**没有**巡查结论写端点（无 PATCH/PUT）⇒「保存巡查记录」仍是禁用态 + 说明。
 *   结论只能由产生会话的那一端写入，管理端目前只读 —— 这是后端能力边界，不是漏做。
 *
 * ★ 顶部 4 张统计卡的数字来自后端 `total`（按 status 各查一次 pageSize=1），不是前端算的；
 *   也没有"到课率"（会话出参里没有到课字段）⇒ 不做平均到课率这种造假指标。
 *
 * ★ `currentStep` 口径：后端 `classroom_session.current_step_index`，LiveServiceImpl 注释写明
 *   「指向当前进行中的步骤」，即 0 起索引 ⇒ 界面显示 `第 N 步`（N=index+1），悬停可看原始值。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { useUserStore } from '@/store/user';
import {
  createPatrolPlan,
  exportPatrolSessions,
  listPatrolPlans,
  listPatrolSessions,
  listSessionStepLogs,
  probePatrolPlans,
  removePatrolPlan,
  updatePatrolPlan,
  uploadPatrolRecord,
  type PatrolPlanProbe,
  type PatrolPlanVO,
  type PatrolSessionVO,
  type SessionStepLogVO
} from '@/api/admin/patrol';
import { listCoursePool } from '@/api/admin/schedules';
import { listUsers } from '@/api/admin/users';

const userStore = useUserStore();

/* ---------------- 状态字典 ---------------- */
type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral';

const SESSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: '待开始', tone: 'neutral' },
  late_absent: { label: '迟到/缺勤', tone: 'warn' },
  ongoing: { label: '进行中', tone: 'info' },
  ended: { label: '已结束', tone: 'ok' }
};

const PATROL_STATUS: Record<string, { label: string; tone: Tone }> = {
  normal: { label: '正常', tone: 'ok' },
  warning: { label: '需关注', tone: 'warn' },
  problem: { label: '有问题', tone: 'error' }
};

const STEP_STATUS: Record<string, { label: string; tone: Tone }> = {
  done: { label: '已完成', tone: 'ok' },
  doing: { label: '进行中', tone: 'info' },
  todo: { label: '未开始', tone: 'neutral' }
};

/** 计划状态（后端 STATUSES 白名单，新增恒 pending） */
const PLAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待巡查', tone: 'neutral' },
  ongoing: { label: '巡查中', tone: 'info' },
  done: { label: '已完成', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'warn' }
};

/** 步骤类型 → 中文（未知值原样显示，不吞成"未知"） */
const STEP_TYPE: Record<string, string> = {
  sign: '签到',
  talk: '讲解',
  teach: '讲授',
  quiz: '测验',
  homework: '作业'
};

/** 未知枚举值一律原样透出，避免"后端加了新状态、前端显示空白" */
function view(map: Record<string, { label: string; tone: Tone }>, raw?: string | null) {
  const key = String(raw ?? '').trim();
  if (!key) return { label: '—', tone: 'neutral' as Tone };
  return map[key] ?? { label: key, tone: 'warn' as Tone };
}

/* ---------------- 权限门禁 ---------------- */
/** 列表权（3275）：没有它整页数据拿不到，但仍渲染骨架 + 空态说明，不白屏 */
const canList = computed(() => userStore.hasPermi('admin:patrol:list'));
/** 步骤明细是**独立权限点**（3276），不是"随会话"⇒ 单独判，避免点了 403 */
const canSeeSteps = computed(() => userStore.hasPermi('admin:patrol:steplogs'));
/** 计划层 5 个按钮点（3357~3361），逐项判，缺哪个只禁哪个 */
const canPlanList = computed(() => userStore.hasPermi('admin:patrol:planList'));
const canPlanAdd = computed(() => userStore.hasPermi('admin:patrol:planAdd'));
const canPlanEdit = computed(() => userStore.hasPermi('admin:patrol:planEdit'));
const canPlanRemove = computed(() => userStore.hasPermi('admin:patrol:planRemove'));
const canRecordAdd = computed(() => userStore.hasPermi('admin:patrol:recordAdd'));
/**
 * 导出权：`admin:patrol:export`。
 * ★ 实测 `sys_menu` 里**没有这一行**（patrol 前缀下只有 3275/3276/3357~3361）
 *   ⇒ 非超管账号恒为 false。按钮按权限门禁 + 写明"需补菜单"，不假装能导。
 */
const canExport = computed(() => userStore.hasPermi('admin:patrol:export'));

/* ---------------- 会话列表 ---------------- */
const query = reactive({ status: '', page: 1, pageSize: 20 });
const rows = ref<PatrolSessionVO[]>([]);
const total = ref(0);
const loading = ref(false);
const loadError = ref('');

/** 4 张统计卡：数字全部来自后端 total；失败显示 —，不拿前端条数冒充全量 */
const stats = reactive<Record<string, number | null>>({
  ongoing: null,
  waiting: null,
  late_absent: null,
  ended: null
});

async function loadList() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await listPatrolSessions({ status: query.status, page: query.page, pageSize: query.pageSize });
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
  } catch {
    // 请求层已弹提示；这里只把界面切到"取不到"状态，不留旧数据充数
    rows.value = [];
    total.value = 0;
    loadError.value = '巡查会话没能取到，可点右上角刷新重试。';
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  const keys = ['ongoing', 'waiting', 'late_absent', 'ended'];
  await Promise.all(
    keys.map(async (k) => {
      try {
        const res = await listPatrolSessions({ status: k, page: 1, pageSize: 1 }, { silent: true });
        stats[k] = res?.total ?? 0;
      } catch {
        stats[k] = null;
      }
    })
  );
}

/* ---------------- 计划层：能力探测（旧包回退） ---------------- */
const planProbe = ref<PatrolPlanProbe | null>(null);

/** 计划区可渲染：探测到 ready，或探测本身还没回来（先显示骨架，避免闪一下横幅） */
const planReady = computed(() => planProbe.value === null || planProbe.value === 'ready');

const planBanner = computed(() => {
  switch (planProbe.value) {
    case null:
      return { tone: 'neutral' as Tone, title: '巡查计划', text: '正在探测后端是否已提供巡查计划接口…' };
    case 'forbidden':
      return {
        tone: 'warn' as Tone,
        title: '巡查计划 · 端点在线，但当前账号缺授权',
        text: '缺权限点 admin:patrol:planList（菜单 3357）。这不是接口故障，授权后刷新页面即可生效。'
      };
    default:
      return {
        tone: 'neutral' as Tone,
        title: '巡查计划 · 当前后端包未提供',
        text: '当前包没有 /api/v1/admin/patrol/plans 这组端点。会话巡查不受影响；换到含计划层的包后本区自动出现，无需改前端。'
      };
  }
});

/* ---------------- 计划层：列表 ---------------- */
const planQuery = reactive({ status: '', patrolDate: '', page: 1, pageSize: 10 });
const plans = ref<PatrolPlanVO[]>([]);
const planTotal = ref(0);
const planLoading = ref(false);
const planError = ref('');

const planStatusOptions = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待巡查' },
  { value: 'ongoing', label: '巡查中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' }
];

async function loadPlans() {
  // 旧包/缺授权时不发请求：既省一次必然失败的调用，也避免红条
  if (!planReady.value || !canPlanList.value) {
    plans.value = [];
    planTotal.value = 0;
    return;
  }
  planLoading.value = true;
  planError.value = '';
  try {
    const res = await listPatrolPlans({
      status: planQuery.status,
      patrolDate: planQuery.patrolDate,
      page: planQuery.page,
      pageSize: planQuery.pageSize
    });
    plans.value = res?.list ?? [];
    planTotal.value = res?.total ?? 0;
  } catch {
    plans.value = [];
    planTotal.value = 0;
    planError.value = '巡查计划没能取到，点右上角刷新可重试。';
  } finally {
    planLoading.value = false;
  }
}

function onPlanFilterChange() {
  planQuery.page = 1;
  void loadPlans();
}

function onPlanPageChange(p: number) {
  planQuery.page = p;
  void loadPlans();
}

function onPlanSizeChange(s: number) {
  planQuery.pageSize = s;
  planQuery.page = 1;
  void loadPlans();
}

/* ---------------- 计划层：新建 / 编辑 ---------------- */
const planDialogVisible = ref(false);
/** null = 新建；否则是正在编辑的行 */
const editingPlan = ref<PatrolPlanVO | null>(null);
const planSaving = ref(false);

const planForm = reactive({
  planName: '',
  patrolDate: '',
  periodNo: null as number | null,
  classroom: '',
  courseId: '',
  teacherId: '',
  remark: ''
});

/** 下拉选项：课程池与教师都只在首次打开弹窗时拉一次 */
const courseOptions = ref<Array<{ value: string; label: string }>>([]);
const teacherOptions = ref<Array<{ value: string; label: string }>>([]);
const pickersLoading = ref(false);
let pickersLoaded = false;

async function loadPickers() {
  if (pickersLoaded) return;
  pickersLoaded = true;
  pickersLoading.value = true;
  try {
    // 课程池：与排课页同源（T-01 后教师/人数在 offering 上，这里只要 id + 名称）
    const courses = await listCoursePool();
    courseOptions.value = (courses?.list ?? [])
      .map((c) => ({ value: String(c.courseId), label: c.courseName || String(c.courseId) }))
      .filter((o) => o.value);
  } catch {
    pickersLoaded = false; // 失败允许下次重试
  }
  try {
    // 教师：只列 roleKey=teacher 的账号；听课教师的取值口径与排课页一致
    const res = await listUsers({ roleKey: 'teacher', page: 1, pageSize: 100 });
    teacherOptions.value = (res?.list ?? []).map((u) => ({
      value: String(u.userId),
      label: u.nickName || u.username || String(u.userId)
    }));
  } catch {
    pickersLoaded = false;
  } finally {
    pickersLoading.value = false;
  }
}

function openCreatePlan() {
  if (!canPlanAdd.value) return;
  editingPlan.value = null;
  planForm.planName = '';
  planForm.patrolDate = todayStr();
  planForm.periodNo = null;
  planForm.classroom = '';
  planForm.courseId = '';
  planForm.teacherId = '';
  planForm.remark = '';
  planDialogVisible.value = true;
  void loadPickers();
}

function openEditPlan(row: PatrolPlanVO) {
  if (!canPlanEdit.value) return;
  editingPlan.value = row;
  planForm.planName = row.planName ?? '';
  planForm.patrolDate = row.patrolDate ?? '';
  planForm.periodNo = row.periodNo ?? null;
  planForm.classroom = row.classroom ?? '';
  planForm.courseId = row.courseId === null || row.courseId === undefined ? '' : String(row.courseId);
  planForm.teacherId = row.teacherId === null || row.teacherId === undefined ? '' : String(row.teacherId);
  planForm.remark = row.remark ?? '';
  planDialogVisible.value = true;
  void loadPickers();
}

/** 今天（本地时区），用于新建弹窗的默认巡查日期 */
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function savePlan() {
  const name = planForm.planName.trim();
  if (!name) {
    ElMessage.warning('计划名称不能为空');
    return;
  }
  if (!planForm.patrolDate) {
    ElMessage.warning('巡查日期不能为空');
    return;
  }
  // ★ 后端必填只有名称 + 日期；节次传了就必须 1~30（它自己在 validate 里判，前端先挡一道）
  if (planForm.periodNo !== null && (planForm.periodNo < 1 || planForm.periodNo > 30)) {
    ElMessage.warning('节次只能是 1~30');
    return;
  }
  const body = {
    planName: name,
    patrolDate: planForm.patrolDate,
    periodNo: planForm.periodNo,
    classroom: planForm.classroom.trim() || null,
    courseId: planForm.courseId || null,
    teacherId: planForm.teacherId || null,
    remark: planForm.remark.trim() || null
  };
  planSaving.value = true;
  try {
    if (editingPlan.value) {
      await updatePatrolPlan(editingPlan.value.planId, body);
      ElMessage.success('计划已更新');
    } else {
      await createPatrolPlan(body);
      ElMessage.success('计划已创建');
      planQuery.page = 1;
    }
    planDialogVisible.value = false;
    await loadPlans();
  } catch {
    /* 请求层已弹具体原因（如 "巡查日期格式非法，应为 yyyy-MM-dd"） */
  } finally {
    planSaving.value = false;
  }
}

/* ---------------- 计划层：状态流转 / 删除 ---------------- */
/**
 * 状态流转。★ 后端 `updatePlan()` 不校验名称/日期，只传 status 即可（实测通过）；
 *   但**不能传空对象**（isEmptyUpdate 会报 "缺少要更新的字段"）。
 */
async function onPlanStatus(row: PatrolPlanVO, status: string) {
  if (!canPlanEdit.value) return;
  const verb = PLAN_STATUS[status]?.label ?? status;
  try {
    await updatePatrolPlan(row.planId, { status });
    ElMessage.success(`已标记为「${verb}」`);
    await loadPlans();
  } catch {
    /* 请求层已提示 */
  }
}

async function onRemovePlan(row: PatrolPlanVO) {
  if (!canPlanRemove.value) return;
  const n = row.records?.length ?? 0;
  try {
    await ElMessageBox.confirm(
      `确认删除计划「${row.planName || '未命名'}」？` +
        (n ? `该计划下 ${n} 条听课记录会保留（后端软删，记录不随计划消失）。` : '删除后不可恢复。'),
      '删除巡查计划',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return; // 用户取消
  }
  try {
    await removePatrolPlan(row.planId);
    ElMessage.success('计划已删除');
    // 删掉当页最后一条时回退一页，避免停在空页
    if (plans.value.length === 1 && planQuery.page > 1) planQuery.page -= 1;
    await loadPlans();
  } catch {
    /* 请求层已提示 */
  }
}

/* ---------------- 听课记录（抽屉：看 + 传） ---------------- */
const recordVisible = ref(false);
const recordPlan = ref<PatrolPlanVO | null>(null);
const recordContent = ref('');
const recordFile = ref<File | null>(null);
const recordSaving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function openRecords(row: PatrolPlanVO) {
  recordPlan.value = row;
  recordContent.value = '';
  recordFile.value = null;
  recordVisible.value = true;
}

function pickFile() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0] ?? null;
  // 后端上限 50MB，前端先挡一道（否则要等上传完才被拒）
  if (f && f.size > 50 * 1024 * 1024) {
    ElMessage.warning('附件超过 50MB 上限');
    input.value = '';
    return;
  }
  recordFile.value = f;
}

function clearFile() {
  recordFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

/** 人类可读大小（记录列表里显示附件体积） */
function sizeText(n?: number | null) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function submitRecord() {
  const plan = recordPlan.value;
  if (!plan) return;
  const content = recordContent.value.trim();
  if (!content && !recordFile.value) {
    ElMessage.warning('听课纪要与附件至少填其一');
    return;
  }
  recordSaving.value = true;
  try {
    await uploadPatrolRecord(plan.planId, content, recordFile.value);
    ElMessage.success('听课记录已保存');
    recordContent.value = '';
    clearFile();
    await loadPlans();
    // 抽屉里的记录列表跟着刷新（loadPlans 回来的是新行对象，重新对一次 planId）
    const fresh = plans.value.find((p) => String(p.planId) === String(plan.planId));
    if (fresh) recordPlan.value = fresh;
  } catch (e) {
    /*
     * ★ 附件失败的真实原因通常是**后端存储不可用**（本机未部署 MinIO、storage.mode 未切 local），
     *   后端此时回 "附件上传失败，请稍后重试"。这不是前端问题，但只弹原始文案用户会以为是网络。
     *   纯纪要（不带文件）不走存储，能正常保存 —— 这里把区别说清楚。
     */
    const msg = String((e as Error)?.message ?? '');
    if (recordFile.value && /上传失败|保存失败/.test(msg)) {
      ElMessage.warning('纪要可能已保存，但附件没落盘：后端对象存储当前不可用（MinIO 未起 / storage.mode 未设为 local）。');
    }
  } finally {
    recordSaving.value = false;
  }
}

/* ---------------- 导出（会话层 Excel） ---------------- */
const exporting = ref(false);

async function onExport() {
  if (!canExport.value) return;
  exporting.value = true;
  try {
    const blob = await exportPatrolSessions(query.status);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `巡查记录_${todayStr()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ElMessage.success('已导出巡查记录（会话层，含当前状态筛选）');
  } catch {
    /* requestBlob 内部已按 body.message 提示（403 会显示无权限） */
  } finally {
    exporting.value = false;
  }
}

/* ---------------- 步骤明细抽屉 ---------------- */
const drawerOpen = ref(false);
const current = ref<PatrolSessionVO | null>(null);
const stepLogs = ref<SessionStepLogVO[]>([]);
const stepLoading = ref(false);
const stepError = ref('');

async function openSteps(row: PatrolSessionVO) {
  if (!canSeeSteps.value) return;
  current.value = row;
  stepLogs.value = [];
  stepError.value = '';
  drawerOpen.value = true;
  stepLoading.value = true;
  try {
    // silent：403/失败用抽屉内文案说明，不弹红条（403 在这里只可能是授权，不是故障）
    stepLogs.value = await listSessionStepLogs(row.sessionId, { silent: true });
    if (!stepLogs.value.length) stepError.value = '这堂课还没有步骤执行记录（教师端未推进过课堂步骤）。';
  } catch {
    stepLogs.value = [];
    stepError.value = '步骤明细取不到：多半是当前账号缺 admin:patrol:steplogs 授权，也可能是接口异常。';
  } finally {
    stepLoading.value = false;
  }
}

/* 抽屉汇总：只对已有数据求和，不补零、不猜 */
const stepSummary = computed(() => {
  const list = stepLogs.value;
  const planTotal = list.reduce((a, s) => a + (s.planMin ?? 0), 0);
  const actTotal = list.reduce((a, s) => a + (s.actualMin ?? 0), 0);
  const doneN = list.filter((s) => String(s.status ?? '') === 'done').length;
  return {
    count: list.length,
    doneN,
    planTotal,
    actTotal,
    over: actTotal > planTotal ? actTotal - planTotal : 0
  };
});

/** 单步超时判断：实际 > 计划且已完成（进行中的步骤时长还在长，不该标超时） */
function stepOver(s: SessionStepLogVO) {
  const st = String(s.status ?? '');
  return st === 'done' && (s.actualMin ?? 0) > (s.planMin ?? 0);
}

/** 进度条宽度：计划 0 分钟给 0，避免除零出 NaN */
function barWidth(s: SessionStepLogVO) {
  if (String(s.status ?? '') === 'todo') return '0%';
  const plan = s.planMin ?? 0;
  if (!plan) return '0%';
  return `${Math.min(100, Math.round(((s.actualMin ?? 0) / plan) * 100))}%`;
}

/* ---------------- 交互 ---------------- */
function onStatusChange() {
  query.page = 1;
  void loadList();
}

function onPageChange(p: number) {
  query.page = p;
  void loadList();
}

function onSizeChange(s: number) {
  query.pageSize = s;
  query.page = 1;
  void loadList();
}

async function refreshAll() {
  // 探测先跑：计划列表要不要发请求取决于它
  planProbe.value = await probePatrolPlans();
  await Promise.all([loadList(), loadStats(), loadPlans()]);
}

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'ongoing', label: '进行中' },
  { value: 'waiting', label: '待开始' },
  { value: 'late_absent', label: '迟到/缺勤' },
  { value: 'ended', label: '已结束' }
];

onMounted(refreshAll);
</script>

<template>
  <div class="page-head">
    <h1>课堂巡查</h1>
    <div class="actions">
      <el-tooltip v-if="!canPlanAdd" content="当前账号缺 admin:patrol:planAdd 授权（菜单 3358）" placement="bottom">
        <span><el-button disabled><ZkIcon name="calendar-days" :size="15" style="margin-right: 5px" />新建巡查计划</el-button></span>
      </el-tooltip>
      <el-button v-else type="primary" @click="openCreatePlan">
        <ZkIcon name="calendar-days" :size="15" style="margin-right: 5px" />新建巡查计划
      </el-button>

      <el-tooltip
        v-if="!canExport"
        content="当前账号缺 admin:patrol:export 授权 —— 该权限点在 sys_menu 里尚未登记（patrol 下只有 3275/3276/3357~3361），需后端补菜单后才能授出"
        placement="bottom"
      >
        <span><el-button disabled><ZkIcon name="download" :size="15" style="margin-right: 5px" />导出巡查记录</el-button></span>
      </el-tooltip>
      <el-button v-else :loading="exporting" @click="onExport">
        <ZkIcon name="download" :size="15" style="margin-right: 5px" />导出巡查记录
      </el-button>

      <el-button class="tb-icon" :loading="loading || planLoading" title="刷新" @click="refreshAll">
        <ZkIcon v-if="!(loading || planLoading)" name="refresh-cw" :size="15" />
      </el-button>
    </div>
  </div>

  <!-- 概览：数字全部来自后端 total -->
  <div class="grid g4" style="margin-bottom: 16px">
    <div class="card stat">
      <div class="label">进行中课堂</div>
      <div class="num" style="color: var(--brand-600)">{{ stats.ongoing ?? '—' }}</div>
      <div class="trend"><span class="tagx info">实时</span> 可巡查</div>
    </div>
    <div class="card stat">
      <div class="label">待开始</div>
      <div class="num">{{ stats.waiting ?? '—' }}</div>
      <div class="trend small muted">已排课未开课</div>
    </div>
    <div class="card stat">
      <div class="label">迟到 / 缺勤</div>
      <div class="num" style="color: var(--warning, #b45309)">{{ stats.late_absent ?? '—' }}</div>
      <div class="trend small muted">需关注</div>
    </div>
    <div class="card stat">
      <div class="label">已结束</div>
      <div class="num">{{ stats.ended ?? '—' }}</div>
      <div class="trend small muted">可回看步骤执行</div>
    </div>
  </div>

  <!-- ============ 一、巡查计划（管理端自建安排） ============ -->
  <div v-if="!planReady" class="banner-note" :class="planBanner.tone">
    <ZkIcon name="info" :size="15" style="flex: none; margin-top: 1px" />
    <div>
      <b>{{ planBanner.title }}</b>
      <div class="nb-text">{{ planBanner.text }}</div>
    </div>
  </div>

  <div v-else class="card" style="margin-bottom: 16px">
    <div class="card-pad" style="padding-bottom: 0">
      <div class="sec-head">
        <div>
          <span class="sec-title">巡查计划</span>
          <span class="small muted" style="margin-left: 8px">
            共 {{ planTotal }} 条 · 管理端自己排的听课安排；点「听课记录」查看并补录纪要与附件
          </span>
        </div>
        <div class="sec-filters">
          <el-date-picker
            v-model="planQuery.patrolDate"
            type="date"
            placeholder="按巡查日期筛"
            value-format="YYYY-MM-DD"
            clearable
            style="width: 150px"
            @change="onPlanFilterChange"
          />
          <el-select v-model="planQuery.status" placeholder="全部状态" style="width: 130px" @change="onPlanFilterChange">
            <el-option v-for="o in planStatusOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </div>
      </div>
    </div>

    <div v-if="planError" class="banner-err" style="margin: 0 16px 12px">
      <ZkIcon name="alert-triangle" :size="15" style="flex: none; margin-top: 1px" />
      <span>{{ planError }}</span>
    </div>

    <el-table v-loading="planLoading" :data="plans" size="small" style="width: 100%" :row-key="(r: PatrolPlanVO) => String(r.planId)">
      <el-table-column label="计划名称" min-width="170">
        <template #default="{ row }">
          <div class="cell-main">{{ row.planName || '—' }}</div>
          <div v-if="row.remark" class="small muted ellipsis" :title="row.remark">{{ row.remark }}</div>
        </template>
      </el-table-column>
      <el-table-column label="课程 / 教师" min-width="170">
        <template #default="{ row }">
          <div>{{ row.courseName || '—' }}</div>
          <div class="small muted">{{ row.teacherName || '未指定教师' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="教室 / 节次" width="130">
        <template #default="{ row }">
          <div>{{ row.classroom || '—' }}</div>
          <div class="small muted">{{ row.periodNo ? `第 ${row.periodNo} 节` : '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="巡查日期" width="110">
        <template #default="{ row }">{{ row.patrolDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="92">
        <template #default="{ row }">
          <span class="tagx" :class="view(PLAN_STATUS, row.status).tone">{{ view(PLAN_STATUS, row.status).label }}</span>
        </template>
      </el-table-column>
      <el-table-column label="听课记录" width="104" align="center">
        <template #default="{ row }">
          <el-button link size="small" type="primary" @click="openRecords(row)">
            {{ row.records?.length ? `${row.records.length} 条` : '补录' }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="236" fixed="right">
        <template #default="{ row }">
          <el-tooltip v-if="!canPlanEdit" content="缺 admin:patrol:planEdit（菜单 3359）" placement="top">
            <span><el-button link size="small" disabled>编辑</el-button></span>
          </el-tooltip>
          <el-button v-else link size="small" type="primary" @click="openEditPlan(row)">编辑</el-button>

          <el-dropdown v-if="canPlanEdit" trigger="click" style="margin: 0 8px" @command="(c: string) => onPlanStatus(row, c)">
            <el-button link size="small" type="primary">流转<ZkIcon name="chevron-down" :size="12" style="margin-left: 2px" /></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="row.status === 'pending'" command="ongoing">开始巡查</el-dropdown-item>
                <el-dropdown-item v-if="row.status === 'ongoing'" command="done">标记完成</el-dropdown-item>
                <el-dropdown-item v-if="row.status !== 'cancelled'" command="cancelled">取消计划</el-dropdown-item>
                <el-dropdown-item v-if="row.status === 'done' || row.status === 'cancelled'" command="pending">重置为待巡查</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <el-tooltip v-if="!canPlanRemove" content="缺 admin:patrol:planRemove（菜单 3360）" placement="top">
            <span><el-button link size="small" type="danger" disabled>删除</el-button></span>
          </el-tooltip>
          <el-button v-else link size="small" type="danger" @click="onRemovePlan(row)">删除</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty-block">
          <ZkIcon name="calendar-days" :size="26" />
          <div class="empty-title">{{ !canPlanList ? '当前账号没有巡查计划权限' : planQuery.status || planQuery.patrolDate ? '该条件下没有计划' : '还没有巡查计划' }}</div>
          <div class="small muted">
            {{
              !canPlanList
                ? '缺权限点 admin:patrol:planList（菜单 3357），请联系管理员授权。'
                : planQuery.status || planQuery.patrolDate
                  ? '换个状态或日期看看，或清空筛选。'
                  : '点右上角「新建巡查计划」排一次听课安排；计划是管理端自建清单，与下面的巡查会话不是同一份数据。'
            }}
          </div>
        </div>
      </template>
    </el-table>

    <div class="card-pad" style="display: flex; justify-content: flex-end">
      <el-pagination
        :current-page="planQuery.page"
        :page-size="planQuery.pageSize"
        :total="planTotal"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="onPlanPageChange"
        @size-change="onPlanSizeChange"
      />
    </div>
  </div>

  <!-- ============ 二、巡查会话（教师端产生，管理端只读） ============ -->
  <div class="toolbar">
    <div class="left">
      <span class="small muted">
        会话由教师端开课自动产生。点「查看步骤」看该课堂上课模板的步骤执行；巡查结论后端没有写端点，目前只读。
      </span>
    </div>
    <div class="right">
      <el-select v-model="query.status" placeholder="全部状态" style="width: 150px" @change="onStatusChange">
        <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </div>
  </div>

  <div v-if="loadError" class="banner-err">
    <ZkIcon name="alert-triangle" :size="15" style="flex: none; margin-top: 1px" />
    <span>{{ loadError }}</span>
  </div>

  <div class="card">
    <div class="card-pad" style="padding-bottom: 0">
      <div class="sec-head">
        <span class="sec-title">巡查会话</span>
        <span class="small muted">共 {{ total }} 条</span>
      </div>
    </div>
    <el-table v-loading="loading" :data="rows" size="small" style="width: 100%" :row-key="(r: PatrolSessionVO) => String(r.sessionId)">
      <el-table-column label="课程 / 会话" min-width="180">
        <template #default="{ row }">
          <div class="cell-main">{{ row.courseName || '—' }}</div>
          <div class="small muted">#{{ row.sessionId }}</div>
        </template>
      </el-table-column>
      <el-table-column label="教师" width="100">
        <template #default="{ row }">{{ row.teacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="院系" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="small muted">{{ row.deptName || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="教室 / 节次" width="140">
        <template #default="{ row }">
          <div>{{ row.room || '—' }}</div>
          <div class="small muted">{{ row.slot || '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <span class="tagx" :class="view(SESSION_STATUS, row.status).tone">{{ view(SESSION_STATUS, row.status).label }}</span>
        </template>
      </el-table-column>
      <el-table-column label="当前步骤" width="96" align="center">
        <template #default="{ row }">
          <el-tooltip
            v-if="row.currentStep !== null && row.currentStep !== undefined"
            :content="`后端 current_step_index = ${row.currentStep}（指向当前进行中的步骤，0 起）`"
            placement="top"
          >
            <span>第 {{ row.currentStep + 1 }} 步</span>
          </el-tooltip>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="开始时间" width="150">
        <template #default="{ row }">{{ row.actualStartTime || '—' }}</template>
      </el-table-column>
      <el-table-column label="巡查结论" width="110">
        <template #default="{ row }">
          <el-tooltip v-if="row.patrolNote" :content="row.patrolNote" placement="top">
            <span class="tagx" :class="view(PATROL_STATUS, row.patrolStatus).tone">
              {{ view(PATROL_STATUS, row.patrolStatus).label }}
            </span>
          </el-tooltip>
          <span v-else class="tagx" :class="view(PATROL_STATUS, row.patrolStatus).tone">
            {{ view(PATROL_STATUS, row.patrolStatus).label }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-tooltip v-if="!canSeeSteps" content="当前账号缺 admin:patrol:steplogs 授权" placement="left">
            <span><el-button link size="small" disabled>查看步骤</el-button></span>
          </el-tooltip>
          <el-button v-else link size="small" type="primary" @click="openSteps(row)">查看步骤</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty-block">
          <ZkIcon name="list-checks" :size="26" />
          <div class="empty-title">{{ !canList ? '当前账号没有课堂巡查权限' : query.status ? '该状态下没有课堂记录' : '当前没有课堂会话' }}</div>
          <div class="small muted">
            {{
              !canList
                ? '缺权限点 admin:patrol:list（菜单 3275），请联系管理员授权。'
                : query.status
                  ? '换个状态筛选，或清空筛选看全部。'
                  : '会话由教师端开课产生；有课堂开起来后，这里会实时出现可巡查的记录。'
            }}
          </div>
        </div>
      </template>
    </el-table>

    <div class="card-pad" style="display: flex; justify-content: flex-end">
      <el-pagination
        :current-page="query.page"
        :page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>

  <!-- ============ 新建 / 编辑计划 ============ -->
  <el-dialog
    v-model="planDialogVisible"
    :title="editingPlan ? '编辑巡查计划' : '新建巡查计划'"
    width="520"
    :close-on-click-modal="false"
  >
    <el-form label-width="88px" label-position="right">
      <el-form-item label="计划名称" required>
        <el-input v-model="planForm.planName" maxlength="80" show-word-limit placeholder="如：期中教学检查·计科组" />
      </el-form-item>
      <el-form-item label="巡查日期" required>
        <el-date-picker v-model="planForm.patrolDate" type="date" placeholder="选择日期" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="节次">
        <el-input-number v-model="planForm.periodNo" :min="1" :max="30" :controls="false" placeholder="1~30" style="width: 120px" />
        <span class="small muted" style="margin-left: 8px">留空表示不限节次</span>
      </el-form-item>
      <el-form-item label="教室">
        <el-input v-model="planForm.classroom" maxlength="40" placeholder="如：实训楼 A301" />
      </el-form-item>
      <el-form-item label="关联课程">
        <el-select v-model="planForm.courseId" filterable clearable placeholder="可不选" :loading="pickersLoading" style="width: 100%">
          <el-option v-for="o in courseOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="听课教师">
        <el-select v-model="planForm.teacherId" filterable clearable placeholder="可不选" :loading="pickersLoading" style="width: 100%">
          <el-option v-for="o in teacherOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="planForm.remark" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="听课重点、分组安排等" />
      </el-form-item>
    </el-form>
    <div class="form-tip small muted">
      只有「计划名称」和「巡查日期」是后端必填；节次填了就必须 1~30。新建的计划状态恒为「待巡查」，之后用列表里的「流转」改状态。
    </div>
    <template #footer>
      <el-button @click="planDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="planSaving" @click="savePlan">{{ editingPlan ? '保存' : '创建' }}</el-button>
    </template>
  </el-dialog>

  <!-- ============ 听课记录（看 + 传） ============ -->
  <el-drawer v-model="recordVisible" :size="560" :title="`听课记录 · ${recordPlan?.planName || ''}`">
    <div v-if="recordPlan" class="dr-sum">
      <div class="pf-row"><span class="k">计划</span><b>{{ recordPlan.planName || '—' }}</b></div>
      <div class="pf-row">
        <span class="k">课程 / 教师</span>
        <b>{{ recordPlan.courseName || '—' }} · {{ recordPlan.teacherName || '未指定教师' }}</b>
      </div>
      <div class="pf-row">
        <span class="k">时间 / 地点</span>
        <b>{{ recordPlan.patrolDate || '—' }}{{ recordPlan.periodNo ? ` 第 ${recordPlan.periodNo} 节` : '' }} · {{ recordPlan.classroom || '—' }}</b>
      </div>
      <div class="pf-row">
        <span class="k">状态</span>
        <b><span class="tagx" :class="view(PLAN_STATUS, recordPlan.status).tone">{{ view(PLAN_STATUS, recordPlan.status).label }}</span></b>
      </div>
    </div>

    <!-- 已上传的记录 -->
    <div class="sec-head" style="margin-top: 16px">
      <span class="sec-title">已上传 {{ recordPlan?.records?.length ?? 0 }} 条</span>
    </div>
    <div v-if="!recordPlan?.records?.length" class="small muted" style="padding: 8px 0 4px">
      这条计划还没有听课记录。下面可以补录纪要（必填其一）和附件。
    </div>
    <div v-else class="rec-list">
      <div v-for="r in recordPlan.records" :key="String(r.recordId)" class="rec-item">
        <div class="rec-head">
          <b class="small">{{ r.recorderName || '—' }}</b>
          <span class="small muted">{{ r.createTime || '' }}</span>
        </div>
        <div v-if="r.content" class="rec-body">{{ r.content }}</div>
        <div v-if="r.fileName" class="rec-file">
          <ZkIcon name="file-text" :size="13" />
          <a v-if="r.fileUrl" :href="r.fileUrl" target="_blank" rel="noopener">{{ r.fileName }}</a>
          <span v-else>{{ r.fileName }}</span>
          <span class="small muted">{{ sizeText(r.fileSize) }}</span>
          <span v-if="!r.fileUrl" class="small muted">（无预览地址：存储未配置或对象缺失）</span>
        </div>
      </div>
    </div>

    <!-- 补录 -->
    <template v-if="canRecordAdd">
      <div class="sec-head" style="margin-top: 20px"><span class="sec-title">补录一条</span></div>
      <el-input
        v-model="recordContent"
        type="textarea"
        :rows="4"
        maxlength="1000"
        show-word-limit
        placeholder="听课纪要，例如：课堂节奏合理，第三节练习环节学生参与度高；建议增加板书要点。"
      />
      <div class="rec-upload">
        <input ref="fileInput" type="file" style="display: none" @change="onFilePicked" />
        <el-button @click="pickFile"><ZkIcon name="file-text" :size="14" style="margin-right: 4px" />选择附件</el-button>
        <span v-if="recordFile" class="small" style="margin-left: 8px">
          {{ recordFile.name }} <span class="muted">{{ sizeText(recordFile.size) }}</span>
          <el-button link size="small" type="danger" style="margin-left: 4px" @click="clearFile">移除</el-button>
        </span>
        <span v-else class="small muted" style="margin-left: 8px">附件最大 50MB，可不传</span>
      </div>
      <div class="form-tip small muted">
        纪要与附件至少填其一。附件走后端对象存储（MinIO / 本地磁盘降级）—— 存储不可用时附件会失败，纯纪要仍可保存。
      </div>
    </template>
    <div v-else class="banner-note neutral" style="margin-top: 16px">
      <ZkIcon name="shield-check" :size="15" style="flex: none; margin-top: 1px" />
      <div><b>当前账号不能补录听课记录</b><div class="nb-text">缺权限点 admin:patrol:recordAdd（菜单 3361）。</div></div>
    </div>

    <template #footer>
      <div class="dr-foot">
        <el-button @click="recordVisible = false">关闭</el-button>
        <el-button v-if="canRecordAdd" type="primary" :loading="recordSaving" @click="submitRecord">保存记录</el-button>
      </div>
    </template>
  </el-drawer>

  <!-- ============ 步骤执行明细 ============ -->
  <el-drawer v-model="drawerOpen" :size="560" :title="`步骤执行明细 · ${current?.courseName || ''}`">
    <div v-if="current" class="dr-sum">
      <div class="pf-row"><span class="k">课堂</span><b>{{ current.courseName || '—' }} · {{ current.room || '—' }} · {{ current.slot || '—' }}</b></div>
      <div class="pf-row"><span class="k">教师 / 院系</span><b>{{ current.teacherName || '—' }} · {{ current.deptName || '—' }}</b></div>
      <div class="pf-row">
        <span class="k">状态</span>
        <b>{{ view(SESSION_STATUS, current.status).label }}<template v-if="current.actualStartTime"> · 开始于 {{ current.actualStartTime }}</template></b>
      </div>
      <div class="pf-row">
        <span class="k">巡查结论</span>
        <b>
          <span class="tagx" :class="view(PATROL_STATUS, current.patrolStatus).tone">{{ view(PATROL_STATUS, current.patrolStatus).label }}</span>
          <template v-if="current.patrolAt"> · {{ current.patrolAt }}</template>
        </b>
      </div>
      <div v-if="current.patrolNote" class="pf-row"><span class="k">巡查备注</span><b>{{ current.patrolNote }}</b></div>
    </div>

    <el-skeleton v-if="stepLoading" :rows="4" animated style="margin-top: 16px" />

    <div v-else-if="stepError" class="banner-note neutral" style="margin-top: 16px">
      <ZkIcon name="info" :size="15" style="flex: none; margin-top: 1px" />
      <div><b>没有步骤明细可显示</b><div class="nb-text">{{ stepError }}</div></div>
    </div>

    <template v-else>
      <div class="dr-sum" style="margin-top: 12px">
        <div class="pf-row"><span class="k">步骤完成</span><b>{{ stepSummary.doneN }} / {{ stepSummary.count }} 步</b></div>
        <div class="pf-row"><span class="k">计划总时长</span><b>{{ stepSummary.planTotal }} 分钟</b></div>
        <div class="pf-row">
          <span class="k">实际总时长</span>
          <b :style="stepSummary.over ? 'color: var(--warning, #b45309)' : ''">
            {{ stepSummary.actTotal }} 分钟<template v-if="stepSummary.over">（超时 {{ stepSummary.over }} 分钟）</template>
          </b>
        </div>
      </div>

      <div class="tl">
        <div v-for="(s, i) in stepLogs" :key="i" class="tl-item" :class="String(s.status ?? 'todo')">
          <span class="dot"></span>
          <div class="tl-between">
            <div>
              <b class="small">{{ i + 1 }}. {{ s.stepName || '（未命名步骤）' }}</b>
              <span class="tagx" :class="view(STEP_STATUS, s.status).tone" style="margin-left: 6px">
                {{ view(STEP_STATUS, s.status).label }}
              </span>
              <span v-if="s.stepType" class="tagx neutral" style="margin-left: 4px">
                {{ STEP_TYPE[String(s.stepType)] || s.stepType }}
              </span>
            </div>
            <span class="small muted">
              计划 {{ s.planMin ?? '—' }} 分钟 · 实际 {{ s.actualMin ?? '—' }} 分钟
            </span>
          </div>
          <div class="tl-bar-row">
            <div class="mini-bar" :class="stepOver(s) ? 'over' : ''">
              <i :style="{ width: barWidth(s) }"></i>
            </div>
            <span class="small muted">
              {{ String(s.status ?? '') === 'todo' ? '未开始' : stepOver(s) ? `超时 ${(s.actualMin ?? 0) - (s.planMin ?? 0)} 分钟` : '正常' }}
            </span>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="dr-foot">
        <el-tooltip content="会话层没有写端点（无 PATCH/PUT），巡查结论暂时只能看" placement="top">
          <span><el-button disabled>保存巡查记录</el-button></span>
        </el-tooltip>
        <el-button type="primary" @click="drawerOpen = false">关闭</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.sec-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sec-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-800, #1f2937);
}
.cell-main {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-900, #111827);
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tagx {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 18px;
  white-space: nowrap;
}
.tagx.ok {
  background: #ecfdf5;
  color: #047857;
}
.tagx.warn {
  background: #fffbeb;
  color: #b45309;
}
.tagx.error {
  background: #fef2f2;
  color: #b91c1c;
}
.tagx.info {
  background: #eff6ff;
  color: #1d4ed8;
}
.tagx.neutral {
  background: #f3f4f6;
  color: #6b7280;
}
.banner-err {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 14px;
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #991b1b;
  border-radius: var(--r-md, 8px);
  font-size: 12.5px;
}
.banner-note {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 14px;
  border-radius: var(--r-md, 8px);
  font-size: 12.5px;
  line-height: 1.6;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--bg-subtle, #f9fafb);
  color: var(--ink-700, #374151);
}
.banner-note.neutral {
  border-color: var(--border, #e5e7eb);
  background: var(--bg-subtle, #f9fafb);
}
.banner-note.info {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1e40af;
}
.banner-note.warn {
  border-color: #fde68a;
  background: #fffbeb;
  color: #92400e;
}
.nb-text {
  margin-top: 2px;
  color: var(--ink-500, #6b7280);
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
/* 弹窗底部说明 */
.form-tip {
  line-height: 1.6;
  padding: 0 2px;
}
/* 听课记录列表 */
.rec-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rec-item {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--r-md, 8px);
  padding: 8px 10px;
  background: var(--bg-subtle, #f9fafb);
}
.rec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rec-body {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-700, #374151);
  white-space: pre-wrap;
  word-break: break-word;
}
.rec-file {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-600, #4b5563);
}
.rec-file a {
  color: var(--brand-600, #2563eb);
  text-decoration: none;
}
.rec-file a:hover {
  text-decoration: underline;
}
.rec-upload {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 10px 0 6px;
}
/* 抽屉 */
.dr-sum {
  border: 1px solid var(--border, #e5e7eb);
  background: var(--bg-subtle, #f9fafb);
  border-radius: var(--r-md, 8px);
  padding: 4px 14px;
}
.pf-row {
  display: flex;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--border, #eef0f4);
  font-size: 12.5px;
}
.pf-row:last-child {
  border-bottom: 0;
}
.pf-row .k {
  flex: none;
  width: 74px;
  color: var(--ink-400, #9aa3b2);
}
.pf-row b {
  font-weight: 600;
  color: var(--ink-800, #1f2937);
  word-break: break-all;
}
.dr-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
/* 步骤时间轴（照原型 tl / tl-item 口径） */
.tl {
  position: relative;
  padding-left: 22px;
  margin-top: 16px;
}
.tl:before {
  content: '';
  position: absolute;
  left: 6px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--border, #eef0f4);
}
.tl-item {
  position: relative;
  padding: 0 0 16px;
}
.tl-item:last-child {
  padding-bottom: 0;
}
.tl-item .dot {
  position: absolute;
  left: -20px;
  top: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: var(--ink-300, #d1d5db);
}
.tl-item.done .dot {
  background: var(--success, #10b981);
}
.tl-item.doing .dot {
  background: var(--brand-600, #2563eb);
  box-shadow: 0 0 0 4px var(--brand-100, #dbeafe);
}
.tl-item.todo .dot {
  background: var(--ink-300, #d1d5db);
}
.tl-between {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.tl-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.mini-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-soft, #f1f5f9);
  overflow: hidden;
  width: 120px;
  flex: none;
}
.mini-bar i {
  display: block;
  height: 100%;
  background: var(--brand-600, #2563eb);
}
.mini-bar.over i {
  background: var(--warning, #f59e0b);
}
</style>
