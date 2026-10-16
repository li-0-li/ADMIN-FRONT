<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
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
const query = reactive({ page: 1, pageSize: 10, status: '' });

async function fetchList() {
  loading.value = true;
  try {
    const [all, pending] = await Promise.all([
      listCertifications({ page: query.page, pageSize: query.pageSize, status: query.status || undefined }),
      // 顶部「N 门待审核」计数：后端 status=pending 时只取 status in ('pending','reviewing')
      listCertifications({ status: 'pending', page: 1, pageSize: 1 })
    ]);
    rows.value = all?.list ?? [];
    total.value = all?.total ?? 0;
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

onMounted(fetchList);
</script>

<template>
  <div class="page-head">
    <h1>课程审核</h1>
    <div class="actions">
      <span class="badge" :class="pendingTotal > 0 ? 'badge-warning' : 'badge-neutral'">
        {{ pendingTotal }} 门待审核
      </span>
      <button class="btn btn-outline btn-sm" @click="fetchList">
        <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />刷新
      </button>
    </div>
  </div>

  <!-- 待审核课程列表 -->
  <div v-loading="loading" class="card">
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
        <tr v-for="row in rows" :key="row.certId">
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
              暂无认证数据（当前演示库 certification 表为空）
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">共 {{ total }} 条记录</span>
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="prev, pager, next"
        @current-change="fetchList"
      />
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
.link {
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
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
