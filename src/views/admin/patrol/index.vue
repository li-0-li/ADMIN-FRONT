<script setup lang="ts">
/**
 * 课堂巡查（T1 · 2026-11-11 甲线）
 * ============================================================================
 * 两层结构，按「能力探测」切换（与排课页的旧包回退同一套模式）：
 *
 * **第一层 · 巡查会话**（现役 8080 包已支持，接真数据）
 *   - GET /api/v1/admin/sessions?status=&page=&pageSize=  → 分页信封
 *   - GET /api/v1/sessions/{sessionId}/step-logs          → **裸数组**
 *
 * **第二层 · 巡查计划**（当前包 0 端点 ⇒ 只做缺口提示，不造界面）
 *   探测三态见 api/admin/patrol.ts 的 probePatrolPlans()。
 *
 * ★ 本期刻意**没做**的三件事，都是因为后端没有对应能力（不是漏做）：
 *   1. 「保存巡查记录」——会话层没有写端点（无 PATCH/PUT），按钮禁用 + 说明；
 *   2. 「导出巡查记录」——没有导出端点，且列表分页、前端只能导出当前页，会造成
 *      「导出了全量」的误解 ⇒ 同样禁用态；
 *   3. 「进入巡查（只读直播）」——原型里的入口在后端无对应接口，不做好看的假按钮。
 *
 * ★ 顶部 4 张统计卡的数字来自后端 `total`（按 status 各查一次 pageSize=1），不是前端算的、
 *   也没有"到课率"（会话出参里没有到课字段）⇒ 不做平均到课率这种造假指标。
 *
 * ★ `currentStep` 口径：后端 `classroom_session.current_step_index`，LiveServiceImpl 注释写明
 *   「指向当前进行中的步骤」，即 0 起索引 ⇒ 界面显示 `第 N 步`（N=index+1），
 *   鼠标悬停可看到原始值，口径可追溯。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import ZkIcon from '@/components/ZkIcon.vue';
import { useUserStore } from '@/store/user';
import {
  listPatrolSessions,
  listSessionStepLogs,
  probePatrolPlans,
  type PatrolPlanProbe,
  type PatrolSessionVO,
  type SessionStepLogVO
} from '@/api/admin/patrol';

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
/** 列表权（菜单 3275）：没有它整页数据拿不到，但仍渲染骨架 + 空态说明，不白屏 */
const canList = computed(() => userStore.hasPermi('admin:patrol:list'));
/** 步骤明细是**独立权限点**（菜单 3276），不是"随会话"⇒ 单独判，避免点了 403 */
const canSeeSteps = computed(() => userStore.hasPermi('admin:patrol:steplogs'));

/* ---------------- 列表 ---------------- */
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

/* ---------------- 计划层探测 ---------------- */
const planProbe = ref<PatrolPlanProbe | null>(null);

const planBanner = computed(() => {
  switch (planProbe.value) {
    case null:
      return { tone: 'neutral' as Tone, title: '巡查计划', text: '正在探测后端是否已提供巡查计划接口…' };
    case 'absent':
      return {
        tone: 'neutral' as Tone,
        title: '巡查计划 · 后端未提供（本版不显示计划管理区）',
        text: '当前后端包没有 /api/v1/admin/patrol/plans 这 5 个端点（权限菜单 3357~3364 在库里也是 0 行）。会话巡查不受影响；计划管理等后端上线、权限授予后再接。'
      };
    case 'forbidden':
      return {
        tone: 'warn' as Tone,
        title: '巡查计划 · 端点在线，但当前账号缺授权',
        text: '缺权限点 admin:patrol:planList（sys_menu 3357~3364 尚未授予本角色）。这不是接口故障，授权后刷新页面即可生效。'
      };
    default:
      return {
        tone: 'info' as Tone,
        title: '巡查计划 · 端点已在线',
        text: '后端已提供计划接口，但本版（T1）只交付会话巡查，计划管理界面尚未实现，故此处不渲染列表。'
      };
  }
});

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
  await Promise.all([loadList(), loadStats(), probePatrolPlans().then((p) => (planProbe.value = p))]);
}

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'ongoing', label: '进行中' },
  { value: 'waiting', label: '待开始' },
  { value: 'late_absent', label: '迟到/缺勤' },
  { value: 'ended', label: '已结束' }
];

const isEmpty = computed(() => !loading.value && !loadError.value && !rows.value.length);

onMounted(refreshAll);
</script>

<template>
  <div class="page-head">
    <h1>课堂巡查</h1>
    <div class="actions">
      <el-tooltip content="后端未提供导出端点（会话层只有查询）" placement="bottom">
        <span>
          <el-button disabled>
            <ZkIcon name="download" :size="15" style="margin-right: 5px" />导出巡查记录
          </el-button>
        </span>
      </el-tooltip>
      <el-button class="tb-icon" :loading="loading" title="刷新" @click="refreshAll">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="15" />
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

  <div class="toolbar">
    <div class="left">
      <span class="small muted">
        点「查看步骤」可看该课堂上课模板的步骤执行情况。巡查结论目前只能看（后端没有写端点）。
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

  <!-- 第二层：计划区缺口提示（按探测三态给准确文案，不做假界面） -->
  <div class="banner-note" :class="planBanner.tone">
    <ZkIcon name="info" :size="15" style="flex: none; margin-top: 1px" />
    <div>
      <b>{{ planBanner.title }}</b>
      <div class="nb-text">{{ planBanner.text }}</div>
    </div>
  </div>

  <!-- 会话列表 -->
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

  <!-- 步骤执行明细 -->
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
