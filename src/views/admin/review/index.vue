<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { getCertDetail, listCertifications, reviewCertification } from '@/api/admin/certifications';
import type { CertDetail, CertMaterial, CertReviewItem } from '@/types/admin';

const router = useRouter();

/* ---------------- 枚举映射（口径取自后端 SQL，不是猜的） ---------------- */

/** 三重认证状态：后端 selectPendingList 的 case when 聚合结果 */
const CERT_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'badge-warning' },
  approved: { label: '已通过', cls: 'badge-success' },
  rejected: { label: '已驳回', cls: 'badge-error' }
};

/** 列表的 AI 初审结论：后端 ai_result 聚合（manual 优先于 pass） */
const AI_DECISION: Record<string, { label: string; cls: string }> = {
  pass: { label: '建议通过', cls: 'badge-success' },
  manual: { label: '需人工复核', cls: 'badge-warning' },
  none: { label: '—', cls: 'badge-neutral' }
};

/** 详情里单项材料的 AI 结论：后端把 ai_result(pass/reject/manual) 归一成 pass/doubt/none */
const AI_RESULT: Record<string, { label: string; cls: string }> = {
  pass: { label: 'AI 通过', cls: 'badge-success' },
  doubt: { label: 'AI 存疑', cls: 'badge-warning' },
  none: { label: '—', cls: 'badge-neutral' }
};

/** 材料类型 → 图标（与后端 cert_type 归一后的 type 对齐） */
const MATERIAL_ICON: Record<string, string> = { video: 'video', doc: 'file-text', table: 'table' };

const certStatusOf = (s: string) => CERT_STATUS[s] ?? { label: s || '—', cls: 'badge-neutral' };
const aiDecisionOf = (s: string) => AI_DECISION[s] ?? { label: s || '—', cls: 'badge-neutral' };
const aiResultOf = (s: string) => AI_RESULT[s] ?? { label: s || '—', cls: 'badge-neutral' };

/** 已裁决（通过/驳回）的课程只读，不再允许重复裁决 */
const isDecided = (s?: string) => s === 'approved' || s === 'rejected';

/* ---------------- 列表 ---------------- */

const loading = ref(false);
const rows = ref<CertReviewItem[]>([]);
const total = ref(0);
const pendingTotal = ref(0);
const query = reactive({ page: 1, pageSize: 10 });

/* ---------------- 自定义合并式分页器（‹ [页码] / N 页 | 跳转 ›，整框四段，高统一 32px） ---------------- */
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)));
const pageInput = ref(1);
watch(
  () => query.page,
  (p) => { pageInput.value = p; },
  { immediate: true }
);
function goPage(n: number) {
  const target = Math.min(Math.max(1, Math.trunc(n) || 1), pageCount.value);
  if (target === query.page) { pageInput.value = target; return; }
  query.page = target;
  fetchList();
}

/** 搜索：按课程名 / 教师名。后端 C-13 无关键字参数 ⇒ 全量拉回前端过滤（缺口已登记台账）。 */
const keyword = ref('');
const filteredNote = ref('');

function resetSearch() {
  keyword.value = '';
  query.page = 1;
  fetchList();
}

/** 触发新搜索：重置回第 1 页再查，避免停在超出结果范围的页码 */
function doSearch() {
  query.page = 1;
  fetchList();
}

/**
 * 排序：需要人工审核的课程排最上面。
 * 优先级：① 待审核且 AI 需人工复核 → ② 其他待审核 → ③ 已裁决（通过/驳回）沉底；
 * 同组内按提交时间倒序。演示库量级小，配合全量拉回在本地排（后端 C-13 固定按提交时间排序，
 * 改 ORDER BY 需重打 jar 重启，缺口已登记台账）。
 */
const SORT_ORDER: Record<string, number> = { manual: 0, none: 1, pass: 2 };
function sortRows(list: CertReviewItem[]): CertReviewItem[] {
  return [...list].sort((a, b) => {
    const pa = isDecided(a.certStatus) ? 1 : 0;
    const pb = isDecided(b.certStatus) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    if (pa === 0 && a.aiDecision !== b.aiDecision) {
      return (SORT_ORDER[a.aiDecision] ?? 3) - (SORT_ORDER[b.aiDecision] ?? 3);
    }
    return (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '');
  });
}

async function fetchList() {
  loading.value = true;
  try {
    // 全量拉回（演示库量级小）：搜索态按课程名/教师名过滤；列表态按「需人工审核置顶」排序
    const kw = keyword.value.trim();
    const [all, pending] = await Promise.all([
      listCertifications({ page: 1, pageSize: 500 }),
      // 顶部「N 门待审核」计数：后端 status=pending 时只取 status in ('pending','reviewing')
      listCertifications({ status: 'pending', page: 1, pageSize: 1 })
    ]);
    let list = all?.list ?? [];
    if (kw) {
      const k = kw.toLowerCase();
      list = list.filter(
        (r) =>
          (r.courseName ?? '').toLowerCase().includes(k) ||
          (r.teacherName ?? '').toLowerCase().includes(k)
      );
      filteredNote.value = `按「${kw}」过滤：${list.length} / ${all?.total ?? 0} 条`;
    } else {
      filteredNote.value = '';
    }
    list = sortRows(list);
    total.value = list.length;
    // 本地分页：与底部 mini-pager 共用 query.page/pageSize
    const start = (query.page - 1) * query.pageSize;
    rows.value = list.slice(start, start + query.pageSize);
    pendingTotal.value = pending?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

/* ---------------- 详情 ---------------- */

const detailLoading = ref(false);
const current = ref<CertReviewItem | null>(null);
const detail = ref<CertDetail | null>(null);
const rejectReason = ref('');
const submitting = ref(false);

/** 选中课程并拉详情（★ 出参是 VO 本身，直接读 detail.materials） */
async function openReview(row: CertReviewItem) {
  current.value = row;
  detail.value = null;
  rejectReason.value = '';
  detailLoading.value = true;
  try {
    detail.value = await getCertDetail(row.courseId);
  } finally {
    detailLoading.value = false;
  }
}

/** 详情头部状态：优先用详情返回的，回落到列表行 */
const activeCertStatus = computed(() => detail.value?.certStatus ?? current.value?.certStatus ?? '');

/**
 * 预览三项材料。
 * ★ 后端 previewUrl 是**相对路径**（实测 /upload/cert/...）。若直接 window.open，
 *   浏览器会把它拼到前端自己的域名上 → 命中 SPA fallback → 返回 index.html
 *   → 路由守卫发现已登录 → 跳 /admin/dashboard（表现就是"点预览跳到后台管理页"）。
 *   所以改为跳应用内的资源预览页，由它自己去取资源并按类型渲染。
 */
function preview(m: CertMaterial) {
  router.push({
    path: '/resource-preview',
    query: {
      type: m.type,
      title: m.title,
      sub: m.desc ?? '',
      url: m.previewUrl ?? ''
    }
  });
}

/* ---------------- 裁决 ---------------- */

async function submitReview(action: 'approve' | 'reject') {
  const row = current.value;
  if (!row) return;
  if (action === 'reject' && !rejectReason.value.trim()) {
    ElMessage.warning('驳回必须填写原因');
    return;
  }
  submitting.value = true;
  try {
    const res = await reviewCertification(row.certId, {
      action,
      rejectReason: action === 'reject' ? rejectReason.value.trim() : undefined
    });
    ElMessage.success(
      action === 'approve'
        ? `已通过：课程「${row.courseName}」，状态 ${res?.status ?? 'approved'}`
        : `已驳回：课程「${row.courseName}」`
    );
    rejectReason.value = '';
    await fetchList();
    await openReview(row);
  } finally {
    submitting.value = false;
  }
}

/**
 * 重新驳回：针对**已通过**的课程。双重确认——
 *   第 1 步 ElMessageBox.prompt 填驳回原因（必填校验）；
 *   第 2 步 ElMessageBox.confirm 明确告知后果（退回「认证中」、收回已解锁备课）。
 * 后端 C-15 不校验当前状态可直接驳回；reject 分支会把 course.status 从 active
 * 回退为 certifying（10-16 补丁），课程列表 / 教师备课侧数据同步。
 */
async function reReject() {
  const row = current.value;
  if (!row) return;
  let reason = '';
  try {
    const { value } = await ElMessageBox.prompt(
      '将驳回该课程全部三项认证，教师需修改后重新提审。请输入驳回原因：',
      '重新驳回',
      {
        confirmButtonText: '下一步',
        cancelButtonText: '取消',
        inputPlaceholder: '驳回原因（必填）',
        inputValidator: (v: string) => (v && v.trim().length > 0 ? true : '驳回原因不能为空')
      }
    );
    reason = value.trim();
  } catch {
    return; // 用户取消
  }
  try {
    await ElMessageBox.confirm(
      `最终确认：课程「${row.courseName}」将退回「认证中」，已解锁的备课同步收回。确定执行？`,
      '最终确认',
      { type: 'warning', confirmButtonText: '确认驳回', cancelButtonText: '再想想' }
    );
  } catch {
    return; // 用户取消
  }
  submitting.value = true;
  try {
    await reviewCertification(row.certId, { action: 'reject', rejectReason: reason });
    ElMessage.success(`已重新驳回：课程「${row.courseName}」已退回「认证中」`);
    await fetchList();
    await openReview(row);
  } finally {
    submitting.value = false;
  }
}

onMounted(fetchList);
</script>

<template>
  <div class="page-head">
    <h1>课程审核</h1>
    <div class="actions">
      <span class="badge" :class="pendingTotal > 0 ? 'badge-error' : 'badge-neutral'">
        {{ pendingTotal }} 门待审核
      </span>
      <button class="btn btn-outline btn-sm" :disabled="loading" @click="fetchList">
        <ZkIcon name="refresh-cw" :size="14" :class="{ 'spin-anim': loading }" style="margin-right: 4px" />{{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>
  </div>

  <!-- 待审核课程列表 -->
  <div v-loading="loading" class="card">
    <!-- 关键字搜索：后端 C-13 无关键字参数 ⇒ 搜索态全量拉回前端按课程名/教师名过滤 -->
    <div class="between" style="padding: 12px 16px; border-bottom: 1px solid var(--border)">
      <div class="row" style="gap: 8px">
        <div class="search-unit">
          <ZkIcon name="search" :size="14" class="su-icon" />
          <input
            v-model="keyword"
            class="su-input"
            placeholder="搜索课程名 / 教师名"
            @keyup.enter="doSearch"
          />
          <button v-if="keyword" class="su-clear" title="清空" aria-label="清空搜索" @click="resetSearch">
            <ZkIcon name="x" :size="13" />
          </button>
          <button class="su-btn" @click="doSearch">搜索</button>
        </div>
      </div>
      <span v-if="filteredNote" class="badge badge-neutral">{{ filteredNote }}</span>
    </div>
    <table class="tbl">
      <thead>
        <tr>
          <th>课程</th>
          <th>教师</th>
          <th>提交时间</th>
          <th>三重认证</th>
          <th>AI 初审</th>
          <th style="text-align: right">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.certId"
          :class="{ 'row-active': current?.certId === row.certId }"
        >
          <td style="font-weight: 600; color: var(--ink-900)">{{ row.courseName }}</td>
          <td>{{ row.teacherName || '—' }}</td>
          <td>{{ row.submittedAt || '—' }}</td>
          <td>
            <span class="badge" :class="certStatusOf(row.certStatus).cls">{{ certStatusOf(row.certStatus).label }}</span>
          </td>
          <td>
            <span class="badge" :class="aiDecisionOf(row.aiDecision).cls">{{ aiDecisionOf(row.aiDecision).label }}</span>
          </td>
          <td style="text-align: right">
            <span class="link" @click="openReview(row)">{{ isDecided(row.certStatus) ? '查看' : '进入审核' }}</span>
          </td>
        </tr>
        <tr v-if="!loading && rows.length === 0">
          <td colspan="6">
            <div class="muted small" style="padding: 22px 0; text-align: center">
              {{ filteredNote ? '无匹配结果，试试其他关键字或清空搜索' : '暂无认证数据' }}
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="between page-foot" style="padding: 12px 16px">
      <span class="small muted">共 {{ total }} 条记录</span>
      <div class="mini-pager">
        <button
          class="mp-btn"
          :disabled="query.page <= 1 || loading"
          aria-label="上一页"
          @click="goPage(query.page - 1)"
        >
          <ZkIcon name="chevron-left" :size="14" />
        </button>
        <input
          v-model.number="pageInput"
          class="mp-input"
          type="number"
          min="1"
          :max="pageCount"
          title="输入页码后按回车跳转"
          @keyup.enter="goPage(pageInput)"
        />
        <span class="mp-total">/ {{ pageCount }} 页</span>
        <button class="mp-go" title="跳转到输入的页码" @click="goPage(pageInput)">跳转</button>
        <button
          class="mp-btn"
          :disabled="query.page >= pageCount || loading"
          aria-label="下一页"
          @click="goPage(query.page + 1)"
        >
          <ZkIcon name="chevron-right" :size="14" />
        </button>
      </div>
    </div>
  </div>

  <!-- 审核详情 -->
  <div v-if="current" v-loading="detailLoading" class="card card-pad mt16">
    <div class="between">
      <div class="card-title" style="margin: 0">
        审核详情 · {{ detail?.courseName || current.courseName }}（{{ detail?.teacherName || current.teacherName || '—' }}）
      </div>
      <span class="badge" :class="certStatusOf(activeCertStatus).cls">{{ certStatusOf(activeCertStatus).label }}</span>
    </div>

    <div v-if="detail?.materials?.length" class="grid g3 mt16">
      <div v-for="m in detail.materials" :key="m.materialId" class="m-card">
        <div class="row">
          <span class="icon-box"><ZkIcon :name="MATERIAL_ICON[m.type] ?? 'file-text'" :size="18" /></span>
          <div>
            <div style="font-weight: 600">{{ m.title }}</div>
            <div class="small muted">{{ m.desc || '—' }}</div>
          </div>
        </div>
        <div class="between mt12">
          <span class="badge" :class="aiResultOf(m.aiResult).cls">{{ aiResultOf(m.aiResult).label }}</span>
          <span><button class="btn btn-outline btn-sm" @click="preview(m)">预览</button></span>
        </div>
      </div>
    </div>
    <div v-else class="muted small mt16">该课程暂无认证材料记录。</div>

    <div class="m-card mt16" style="background: var(--brand-50); border-color: var(--brand-200)">
      <div class="row" style="align-items: flex-start">
        <span class="icon-box"><ZkIcon name="sparkles" :size="18" /></span>
        <div>
          <div style="font-weight: 600">AI 初审建议</div>
          <div class="small" style="color: var(--ink-600); margin-top: 4px">
            {{ detail?.aiSuggestion || '（后端暂未给出 AI 初审建议）' }}
          </div>
        </div>
      </div>
    </div>

    <template v-if="!isDecided(activeCertStatus)">
      <div class="field mt16">
        <label>驳回原因（驳回时填写）</label>
        <input v-model="rejectReason" class="input" placeholder="请输入驳回原因，将通知教师修改" />
      </div>
      <div class="row mt8" style="justify-content: flex-end; gap: 10px">
        <button class="btn btn-outline" :disabled="submitting" @click="submitReview('reject')">驳回</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submitReview('approve')">
          逐项通过并解锁备课
        </button>
      </div>
    </template>
    <!-- 已通过 → 可重新驳回（双重确认）；已驳回 → 只读 -->
    <div v-else-if="activeCertStatus === 'approved'" class="m-card mt16" style="background: var(--warning-soft); border-color: var(--warning-soft)">
      <div class="row" style="align-items: flex-start">
        <span class="icon-box"><ZkIcon name="alert-triangle" :size="18" /></span>
        <div>
          <div style="font-weight: 600">该课程已通过审核</div>
          <div class="small" style="color: var(--ink-600); margin-top: 4px">
            如需撤销，可重新驳回：课程将退回「认证中」，已解锁的备课同步收回。
          </div>
        </div>
        <button class="btn btn-outline" style="margin-left: auto" :disabled="submitting" @click="reReject">
          重新驳回
        </button>
      </div>
    </div>
    <div v-else class="muted small mt16">
      该课程已完成审核（{{ certStatusOf(activeCertStatus).label }}），不可重复裁决。
    </div>
  </div>

  <div v-else class="card card-pad mt16">
    <div class="muted small" style="text-align: center; padding: 18px 0">
      请从上方列表选择一门课程，查看三项材料与 AI 初审建议。
    </div>
  </div>
</template>

<style scoped>
/* 刷新反馈：图标旋转 + 「刷新中…」文案切换 + 防连点 */
.spin-anim {
  animation: su-spin 0.8s linear infinite;
}
@keyframes su-spin {
  to {
    transform: rotate(360deg);
  }
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 自定义合并式分页器：‹ [页码] / N 页 › 整合进同一个边框容器 */
.mini-pager {
  display: flex;
  align-items: stretch;
  width: fit-content;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.mini-pager:focus-within {
  border-color: var(--brand-400);
  box-shadow: 0 0 0 3px var(--brand-100);
}
.mp-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--ink-600);
  cursor: pointer;
  padding: 0;
}
.mp-btn:hover:not(:disabled) {
  color: var(--primary-hover);
  background: var(--primary-softer);
}
.mp-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mp-input {
  box-sizing: border-box;
  width: 32px;
  height: 100%;
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  text-align: center;
  font-family: inherit;
  font-size: 13px;
  color: var(--ink-900);
  padding: 0;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}
.mp-input::-webkit-outer-spin-button,
.mp-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.mp-input:focus {
  box-shadow: none;
}
.mp-total {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 400;
  color: var(--ink-600);
  padding: 0 6px 0 2px;
  cursor: default;
  user-select: none;
}
.mp-go {
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--primary-hover);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 12px;
  height: 100%;
}
.mp-go:hover {
  background: var(--primary-softer);
}
.mp-go + .mp-btn {
  border-left: 1px solid var(--border);
}

/* 搜索整体单元：图标 + 输入 + 清空 + 搜索按钮合为一个带边框圆角的控件 */
.search-unit {
  display: flex;
  align-items: stretch;
  width: 300px;
  height: 30px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.search-unit:focus-within {
  border-color: var(--brand-400);
  box-shadow: 0 0 0 3px var(--brand-100);
}
.su-icon {
  align-self: center;
  margin: 0 4px 0 10px;
  color: var(--ink-400);
  flex: none;
}
.su-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--ink-900);
  padding: 0 4px;
}
.su-input::placeholder {
  color: var(--ink-400);
}
.su-clear {
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 2px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-400);
  cursor: pointer;
  padding: 0;
}
.su-clear:hover {
  background: var(--bg-soft);
  color: var(--ink-700);
}
.su-btn {
  flex: none;
  border: none;
  background: var(--primary-soft);
  color: var(--primary-hover);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0 14px;
}
.su-btn:hover {
  background: var(--brand-200);
}

.link {
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}

/* 选中课程高亮：品牌浅底 + 行首左侧色条，与详情卡对应 */
.tbl tbody tr.row-active td {
  background: var(--brand-50);
}
.tbl tbody tr.row-active td:first-child {
  box-shadow: inset 3px 0 0 var(--brand-500);
}

/*
 * 原型 theme.css 里有 `.m-card + .m-card { margin-top: 12px }`（为纵向堆叠场景准备）。
 * 但材料卡是放在 `.grid.g3` 栅格里的，这条规则会给第 2、3 张卡各加 12px 上边距，
 * 导致第 1 张（说课视频）比另外两张高出一截、三栏对不齐。栅格内相邻卡片不需要这个外边距。
 */
.grid > .m-card + .m-card {
  margin-top: 0;
}
</style>
