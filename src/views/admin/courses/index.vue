<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { deleteCourse, listCourses } from '@/api/admin/courses';
import type { AdminCourseVo } from '@/api/admin/courses';
import { getCertDetail, reviewCertification } from '@/api/admin/certifications';
import { listSchedules } from '@/api/admin/schedules';
import { listTerms } from '@/api/admin/basicdata';
import type { CertDetail } from '@/types/admin';

/**
 * 课程总览（2026-10-29 新增）
 * ============================================================================
 * 定位：**审核已通过的课程**在这里，课程审核页只放待审队列。
 * 两页的边界靠状态字段切：审核通过后后端把 course.status 置为 active（C-15 裁决的副作用），
 * 本页固定查 status=active —— 数据源与审核页完全分离，不需要前端搬数据。
 *
 * ★ 为什么不用 /api/v1/certifications?status=approved 当数据源：
 *   实测（10-29）该接口传 status=rejected 返回的却是 approved 记录 ⇒ status 参数只可靠识别
 *   pending，不能按 approved 精确筛；而且它返回的是"认证聚合行"，没有学期/选课人数/课程代码。
 *   课程列表 C-12 的 status 过滤实测可靠（active 10 / 全集 11），所以本页用它。
 *
 * ★ 认证材料不是本页主数据：C-14 详情按 courseId 取，历史课程可能没有认证记录
 *   （演示库 10 门 active 课里只有 2 门有 approved 认证）⇒ 详情失败只降级成一句说明，
 *   不弹红条、不阻塞列表——这是"可选信息"，不是"页面必需数据"。
 */

const loading = ref(false);
const rows = ref<AdminCourseVo[]>([]);
const total = ref(0);
/** 失败态与空态分开存：接口挂了不能显示成"没有课程"（账号页同款处理） */
const loadError = ref('');
const router = useRouter();
/** scheduleState：排课状态筛选（'' 全部 / 'scheduled' 已排课 / 'unscheduled' 未排课）
 *  见下方 fetchList 的说明：这个条件没法交给后端分页，只能本地筛。 */
const query = reactive({ page: 1, pageSize: 10, keyword: '', semester: '', scheduleState: '' });
/** 排课筛选下的补充说明（例如全量没拉完），空串=无话可说 */
const filterNote = ref('');
/** 是否存在任一筛选条件：决定空态给「清空筛选」还是「去课程审核」 */
const hasFilter = computed(() => !!query.keyword.trim() || !!query.semester || !!query.scheduleState);

const terms = ref<{ termId: number; name: string }[]>([]);
const termOptionsReady = computed(() => terms.value.length > 0);

const STATUS_LABEL: Record<string, string> = { active: '已通过', creating: '创建中' };
const STATUS_BADGE: Record<string, string> = { active: 'badge-success', creating: 'badge-neutral' };
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s ?? '—';
const statusBadge = (s: string) => STATUS_BADGE[s] ?? 'badge-neutral';

/* ---------------- 排课情况（2026-10-29 业主新增列）----------------
 * 课程列表接口（C-12）没有排课字段，只能从课次接口反查：
 *   GET /api/v1/admin/schedules?startDate&endDate&pageSize 一次拉回课次，按 courseId 聚合计数。
 * ★ 三个实测要点（10-29，8080）：
 * 1. 必须走**管理端路径** `/api/v1/admin/schedules`：学生端 `/api/v1/schedules` 按当前登录者过滤，
 *    管理员调它恒返回 0 条（实测 0，差点误判成"全都没排课"）。
 * 2. `startDate`/`endDate` 是**必填**（缺了直接 code=422「startDate 与 endDate 不能为空」）。
 *    "是否排过课"是历史事实、不该受区间限制 ⇒ 给一个足够宽的区间（后端不校验跨度，实测 2000~2100 可拿全量）。
 * 3. 返回里的 `deleted` 默认已排除软删（实测 313 条全为 0）⇒ 放回待排的课次不会误算成"已排课"。
 * 一次拉不完（total > 拉回数）时只统计已拉部分，并把列头标注为统计不全，不假装是全量。
 */
const scheduleCount = ref<Map<string, number>>(new Map());
const scheduleStatsLoading = ref(false);
/** 统计是否成功拿到过。★ 不能只看 Map 是否为空：接口失败时 Map 也是空的，
 *  若此时把"没有记录"当"0 节"，整页课程会全部误报成「未排课」——所以失败一律显示 — */
const scheduleStatsReady = ref(false);
/** 课次总量超过一次拉取上限 ⇒ 计数是部分统计，列头要说明，不能让用户当全量看 */
const scheduleStatsPartial = ref(false);
const SCHEDULE_WIDE_START = '2000-01-01';
const SCHEDULE_WIDE_END = '2100-12-31';
const SCHEDULE_FETCH_LIMIT = 1000;

async function loadScheduleCounts() {
  scheduleStatsLoading.value = true;
  try {
    const res = await listSchedules({
      startDate: SCHEDULE_WIDE_START,
      endDate: SCHEDULE_WIDE_END,
      page: 1,
      pageSize: SCHEDULE_FETCH_LIMIT
    });
    const list = res?.list ?? [];
    const m = new Map<string, number>();
    for (const c of list) {
      const id = String(c.courseId ?? '');
      if (!id) continue;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    scheduleCount.value = m;
    scheduleStatsPartial.value = (res?.total ?? 0) > list.length;
    scheduleStatsReady.value = true;
  } catch {
    /* 排课情况是附加信息：拉不到就显示 —，不影响课程列表本身（与认证材料同思路） */
    scheduleCount.value = new Map();
    scheduleStatsPartial.value = false;
    scheduleStatsReady.value = false;
  } finally {
    scheduleStatsLoading.value = false;
  }
  // 返回是否拿到：排课状态筛选依赖它，拿不到就不能假装筛过了（否则会筛出空列表冒充"没有未排课的课"）
  return scheduleStatsReady.value;
}

/** 该课程的节次数；null = 统计未拿到（与"0 节/未排课"必须区分开，否则会误报未排课） */
function scheduledCount(courseId: string): number | null {
  if (!scheduleStatsReady.value) return null;
  return scheduleCount.value.get(String(courseId)) ?? 0;
}

async function loadTerms() {
  try {
    // ★ listTerms 的形参必填（BasicDataQuery），不传会类型报错；这里给一页足够用的量
    const res = await listTerms({ page: 1, pageSize: 50 });
    terms.value = (res?.list ?? [])
      .filter(t => t.name)
      .map(t => ({ termId: Number(t.termId ?? 0), name: String(t.name) }));
  } catch {
    /* 学期下拉是辅助筛选，拉不到不影响列表（可按关键词搜）；不打扰用户 */
    terms.value = [];
  }
}

/**
 * 列表取数
 * ----------------------------------------------------------------------------
 * 两种模式，按「有没有启用排课状态筛选」分流：
 *  A. 默认（不按排课筛）：服务端分页，与之前一致——数据量变大后这才是正解。
 *  B. 按排课状态筛：**只能本地筛**。原因是排课节次并不在课程列表接口里，
 *     而是本页用课次接口聚合出来的 Map（见上方排课情况注释）；服务端分页的 total
 *     是"全部 active 课程"的 total，拿它当筛选后的总数会直接把分页器画错。
 *     所以该模式下改为「一次拉回全量 active（受关键词/学期约束）→ 本地过滤 → 本地分页」。
 *     ⚠️ 失效条件：active 课程数超过 SCHEDULE_FILTER_FETCH_LIMIT 时只能筛到已拉部分，
 *     此时页脚会明确写出"仅在已拉取的 N 门内筛选"，不假装是全量结果。
 */
const SCHEDULE_FILTER_FETCH_LIMIT = 500;

async function fetchList() {
  loading.value = true;
  try {
    const base = {
      keyword: query.keyword.trim() || undefined,
      semester: query.semester || undefined,
      status: 'active' as const
    };
    if (query.scheduleState) {
      // 排课统计是筛选的前提：没拿到就没有"已排/未排"这个事实，不能拿空 Map 当"全都没排课"
      if (!scheduleStatsReady.value) {
        await loadScheduleCounts();
      }
      if (!scheduleStatsReady.value) {
        rows.value = [];
        total.value = 0;
        filterNote.value = '';
        loadError.value = '排课情况统计未取到，无法按排课状态筛选。可清空「排课情况」条件，或稍后重试。';
        return;
      }
      const res = await listCourses({ ...base, page: 1, pageSize: SCHEDULE_FILTER_FETCH_LIMIT });
      const all = res?.list ?? [];
      const onlyScheduled = query.scheduleState === 'scheduled';
      const filtered = all.filter((c) => {
        const n = scheduleCount.value.get(String(c.courseId)) ?? 0;
        return onlyScheduled ? n > 0 : n === 0;
      });
      total.value = filtered.length;
      const start = (query.page - 1) * query.pageSize;
      rows.value = filtered.slice(start, start + query.pageSize);
      const serverTotal = res?.total ?? 0;
      filterNote.value =
        serverTotal > all.length
          ? `排课筛选仅在已拉取的 ${all.length} 门课内进行（共 ${serverTotal} 门，超出单次拉取上限 ${SCHEDULE_FILTER_FETCH_LIMIT}）`
          : `按排课情况筛选：${onlyScheduled ? '已排课' : '未排课'} ${filtered.length} 门`;
      loadError.value = '';
      return;
    }
    filterNote.value = '';
    const res = await listCourses({ ...base, page: query.page, pageSize: query.pageSize });
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
    loadError.value = '';
  } catch {
    /* 失败必须清列表 + 归零总数，否则会留着上一次筛选的结果冒充本次结果 */
    rows.value = [];
    total.value = 0;
    filterNote.value = '';
    loadError.value = '课程列表加载失败：没有取到课程数据，可能是网络中断、后端服务未启动或登录状态已过期。';
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  query.page = 1;
  fetchList();
}

function resetQuery() {
  query.keyword = '';
  query.semester = '';
  query.scheduleState = '';
  query.page = 1;
  fetchList();
}

/** 跳排课页并只看这门课。
 *  ★ 排课页（schedule/index.vue:612-624）**已支持** ?course=<courseId> 参数，
 *  它只在"切专业"时才校验并清空 courseId，本跳转不改专业 ⇒ 不会被清掉。不需要改排课页。 */
function goSchedule(row: AdminCourseVo) {
  void router.push({ path: '/admin/schedule', query: { course: String(row.courseId) } });
}

/* ---------------- 详情抽屉 ---------------- */
const detailVisible = ref(false);
const detailCourse = ref<AdminCourseVo | null>(null);
const detail = ref<CertDetail | null>(null);
const detailLoading = ref(false);
/** 认证材料的缺失原因（历史课程没有认证记录是常态，不是错误） */
const detailNote = ref('');

async function openDetail(row: AdminCourseVo) {
  detailCourse.value = row;
  detail.value = null;
  detailNote.value = '';
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getCertDetail(Number(row.courseId));
  } catch {
    detailNote.value = '该课程没有可查的认证材料记录（历史课程或认证数据已归档），课程本身仍可正常使用。';
  } finally {
    detailLoading.value = false;
  }
}

/* ---------------- 删除课程（C-23）----------------
 * 后端语义：软删主记录 + 级联软删课次；但**课程名下还有课次时会拒绝**（要先去排课移除）。
 * 所以失败文案不能写死"删除失败"——把后端给的原因透出来，用户才知道先去排课页处理。
 */
const deleting = ref<string>('');

async function doDelete(row: AdminCourseVo) {
  const ok = await ElMessageBox.confirm(
    `确定删除课程「${row.courseName}」（${row.courseCode}）吗？删除后该课程与其课次记录将不再出现在管理端。若课程名下仍有课次，系统会拒绝删除，需先到「智能排课」移除课次。`,
    '删除课程',
    { type: 'warning', confirmButtonText: '确定删除' }
  ).catch(() => false);
  if (!ok) return;
  deleting.value = row.courseId;
  try {
    await deleteCourse(row.courseId);
    ElMessage.success(`已删除课程「${row.courseName}」`);
    // 删掉最后一条时回退一页，避免停在空页
    if (rows.value.length === 1 && query.page > 1) query.page -= 1;
    await fetchList();
  } catch {
    /* request.ts 已弹后端原话（如"课程下还有课次，请先移除"），这里不重复 */
  } finally {
    deleting.value = '';
  }
}

/* ---------------- 撤销通过（承接原「课程审核」页的重新驳回）----------------
 * 为什么搬到这里：审核页 10-29 起只承载待审队列，已通过的课程不在那儿了，
 * 「重新驳回」这个既有能力必须跟着课程一起移到课程总览，否则撤销通道就断了。
 * 口径与原实现完全一致（双重确认 + 必填原因）；后端 C-15 不校验当前状态可直接驳回，
 * reject 分支会把 course.status 从 active 回退为 certifying ⇒ 本页刷新后该课程消失。
 * certId 只能从 C-14 详情拿（课程列表不含 certId），所以撤销入口放在详情抽屉里。
 */
const revoking = ref(false);

async function revokeApprove() {
  const course = detailCourse.value;
  const cert = detail.value;
  if (!course) return;
  if (!cert?.certId) {
    ElMessage.warning('该课程没有可用的认证记录，无法撤销通过；如需下架请用「删除」');
    return;
  }
  let reason = '';
  try {
    const { value } = await ElMessageBox.prompt(
      '将驳回该课程全部三项认证，教师需修改后重新提审。请输入驳回原因：',
      '撤销通过（驳回）',
      {
        confirmButtonText: '下一步',
        cancelButtonText: '取消',
        inputPlaceholder: '驳回原因（必填）',
        inputValidator: (v: string) => (v && v.trim().length > 0 ? true : '驳回原因不能为空')
      }
    );
    reason = value.trim();
  } catch {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `最终确认：课程「${course.courseName}」将退回「认证中」，已解锁的备课同步收回。确定执行？`,
      '最终确认',
      { type: 'warning', confirmButtonText: '确认驳回', cancelButtonText: '再想想' }
    );
  } catch {
    return;
  }
  revoking.value = true;
  try {
    await reviewCertification(cert.certId, { action: 'reject', rejectReason: reason });
    ElMessage.success(`已撤销通过：课程「${course.courseName}」已退回「认证中」`);
    detailVisible.value = false;
    // 该课程 status 已回退，本页固定查 active ⇒ 重查后自然消失
    await fetchList();
  } catch {
    /* request.ts 已提示后端原话 */
  } finally {
    revoking.value = false;
  }
}

onMounted(async () => {
  void loadTerms();
  // 排课统计独立于课程列表：并行拉，谁先回都不影响另一个；失败只让该列显示 —
  void loadScheduleCounts();
  await fetchList();
});
</script>

<template>
  <div class="page-head">
    <h1>课程总览</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="$router.push('/admin/review')">
        <ZkIcon name="badge-check" :size="16" />课程审核
      </a>
    </div>
  </div>

  <div class="toolbar">
    <div class="right" style="gap: 10px">
      <el-input
        v-model="query.keyword"
        placeholder="课程名称 / 课程代码"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-select
        v-model="query.semester"
        placeholder="全部学期"
        clearable
        filterable
        style="width: 160px"
        :disabled="!termOptionsReady"
        @change="onSearch"
      >
        <el-option v-for="t in terms" :key="t.termId" :label="t.name" :value="t.name" />
      </el-select>
      <!-- 排课情况筛选（10-29 新增）：与「排课情况」列同源，都基于课次聚合 -->
      <el-select
        v-model="query.scheduleState"
        placeholder="全部排课情况"
        clearable
        style="width: 140px"
        @change="onSearch"
      >
        <el-option label="已排课" value="scheduled" />
        <el-option label="未排课" value="unscheduled" />
      </el-select>
      <el-button type="primary" @click="onSearch">
        <ZkIcon name="search" :size="15" style="margin-right: 4px" />搜索
      </el-button>
      <!-- 与搜索同款式按钮（改前是 text 按钮，无边框、高度与主按钮不一致，视觉上像贴上去的一行字） -->
      <el-button @click="resetQuery">
        <ZkIcon name="refresh-cw" :size="15" style="margin-right: 4px" />重置
      </el-button>
    </div>
  </div>

  <div class="card">
    <!-- 失败态与空态分开画，理由同账号页：空表这一种视觉不能同时承载"没数据"和"没取到" -->
    <div v-if="loadError" class="load-fail" role="alert">
      <ZkIcon name="alert-triangle" :size="16" />
      <span class="load-fail-text">{{ loadError }}</span>
      <el-button text :loading="loading" @click="fetchList()">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="14" style="margin-right: 4px" />重新加载
      </el-button>
    </div>
    <el-table v-loading="loading" row-key="courseId" :data="rows" style="width: 100%">
      <el-table-column label="课程代码" width="100" prop="courseCode">
        <template #default="{ row }">{{ row.courseCode || '—' }}</template>
      </el-table-column>
      <el-table-column label="课程名称" min-width="170" prop="courseName">
        <template #default="{ row }">
          <div style="font-weight: 600; color: var(--ink-900)">{{ row.courseName }}</div>
        </template>
      </el-table-column>
      <el-table-column label="授课教师" width="110" prop="teacherName">
        <template #default="{ row }">{{ row.teacherName || '—' }}</template>
      </el-table-column>
      <el-table-column label="学期" width="110" prop="semester">
        <template #default="{ row }">{{ row.semester || '—' }}</template>
      </el-table-column>
      <el-table-column label="选课人数" width="90" align="center" prop="studentCount">
        <template #default="{ row }">{{ row.studentCount ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span class="badge" :class="statusBadge(row.status)">{{ statusLabel(row.status) }}</span>
        </template>
      </el-table-column>
      <!-- 排课情况（10-29 新增）：节次数来自课次接口聚合。
           三种状态必须可辨：— = 统计没拿到 / 未排课 = 真的 0 节 / N 节 = 已排 -->
      <el-table-column width="130" align="center">
        <template #header>
          <span :title="scheduleStatsPartial ? '课次总数超出单次拉取上限，此处仅统计已拉取部分' : '按全部课次统计，放回待排的课次不计入'">排课情况</span>
        </template>
        <template #default="{ row }">
          <span v-if="scheduledCount(row.courseId) === null" class="muted small">—</span>
          <!-- 未排课给直达入口：这列最常见的用途就是"挑一门没排的课去排"，
               少了这一步用户还得自己记住课程名再去排课页翻列表 -->
          <div v-else-if="scheduledCount(row.courseId) === 0" class="sched-cell">
            <span class="badge badge-neutral">未排课</span>
            <a class="sched-link" href="javascript:void(0)" @click="goSchedule(row)">去排课</a>
          </div>
          <span v-else class="badge badge-info">{{ scheduledCount(row.courseId) }} 节</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" align="right" class-name="courses-op">
        <template #default="{ row }">
          <el-button text size="small" @click="openDetail(row)">
            <ZkIcon name="eye" :size="14" style="margin-right: 3px" />查看
          </el-button>
          <el-button
            text
            size="small"
            style="color: var(--error)"
            :loading="deleting === row.courseId"
            @click="doDelete(row)"
          >删除</el-button>
        </template>
      </el-table-column>
      <!-- 空态说明"为什么空 + 去哪看"：本页只列已通过课程，用户最容易误以为课程丢了 -->
      <template #empty>
        <div class="empty-block">
          <ZkIcon name="book-open" :size="26" />
          <div class="empty-title">{{ loadError ? '数据未取到' : hasFilter ? '当前筛选条件下没有课程' : '还没有审核通过的课程' }}</div>
          <div v-if="loadError" class="small muted">原因见上方提示条，也可点下方按钮重试。</div>
          <div v-else-if="hasFilter" class="small muted">
            已通过审核的课程可能被关键词/学期/排课情况条件排除了，清空条件即可看到全部。
          </div>
          <div v-else class="small muted">课程在「课程审核」通过后才会出现在这里。</div>
          <!-- 空态给可点的下一步：原来只有一行文字，用户得自己回去找入口/找重置按钮 -->
          <div class="empty-actions">
            <el-button v-if="loadError" size="small" @click="fetchList">
              <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />重新加载
            </el-button>
            <template v-else-if="hasFilter">
              <el-button size="small" @click="resetQuery">
                <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />清空筛选
              </el-button>
            </template>
            <el-button v-else size="small" type="primary" @click="router.push('/admin/review')">
              <ZkIcon name="badge-check" :size="14" style="margin-right: 4px" />去课程审核
            </el-button>
          </div>
        </div>
      </template>
    </el-table>

    <div class="between" style="padding: 12px 16px">
      <span class="small muted">
        <template v-if="loadError">记录数未取到（加载失败）</template>
        <template v-else>共 {{ total }} 门已通过课程</template>
        <!-- 总数口径说明：按排课筛时 total 是本地过滤后的数，与后端 total 不同，必须写明 -->
        <span v-if="filterNote" class="filter-note">{{ filterNote }}</span>
      </span>
      <!-- layout 必须含 sizes：改前只写 prev/pager/next，`:page-sizes` 虽然配了但选择器压根不渲染，
           用户无法改每页条数（属于"配了参数却没生效"的静默缺陷） -->
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

  <!-- 详情抽屉：课程基本信息 + 认证材料（材料缺失只降级说明，不当错误） -->
  <el-drawer v-model="detailVisible" :title="detailCourse?.courseName ?? '课程详情'" size="460px">
    <div v-if="detailCourse" class="stack" style="gap: 14px">
      <div class="pf-grid">
        <div class="pf-row"><span class="k">课程代码</span><span>{{ detailCourse.courseCode || '—' }}</span></div>
        <div class="pf-row"><span class="k">授课教师</span><span>{{ detailCourse.teacherName || '—' }}</span></div>
        <div class="pf-row"><span class="k">学期</span><span>{{ detailCourse.semester || '—' }}</span></div>
        <div class="pf-row"><span class="k">选课人数</span><span>{{ detailCourse.studentCount ?? 0 }}</span></div>
        <div class="pf-row">
          <span class="k">状态</span>
          <span class="badge" :class="statusBadge(detailCourse.status)">{{ statusLabel(detailCourse.status) }}</span>
        </div>
        <div class="pf-row">
          <span class="k">排课情况</span>
          <span>
            <template v-if="scheduledCount(detailCourse.courseId) === null">—</template>
            <template v-else-if="scheduledCount(detailCourse.courseId) === 0">未排课</template>
            <template v-else>已排 {{ scheduledCount(detailCourse.courseId) }} 节</template>
          </span>
        </div>
      </div>

      <div>
        <div class="section-title">认证材料</div>
        <div v-loading="detailLoading">
          <template v-if="detail">
            <!-- C-14 出参只有 certStatus + aiSuggestion（没有逐材料的 aiDecision，那在 materials[].aiResult） -->
            <div class="small muted" style="margin-bottom: 8px">
              审核结论：{{ detail.certStatus === 'approved' ? '已通过' : detail.certStatus === 'rejected' ? '已驳回' : detail.certStatus || '—' }}
              <span v-if="detail.aiSuggestion">　AI 初审：{{ detail.aiSuggestion }}</span>
            </div>
            <div v-if="(detail.materials ?? []).length" class="stack" style="gap: 8px">
              <div v-for="m in detail.materials" :key="m.materialId" class="material-row">
                <ZkIcon :name="m.type === 'video' ? 'video' : m.type === 'doc' ? 'file-text' : 'table'" :size="15" />
                <div>
                  <div style="font-weight: 600">{{ m.title || m.type }}</div>
                  <div v-if="m.desc" class="small muted">{{ m.desc }}</div>
                </div>
              </div>
            </div>
            <div v-else class="small muted">该课程认证记录下没有材料明细。</div>
          </template>
          <div v-else-if="!detailLoading" class="small muted">{{ detailNote || '无认证材料记录' }}</div>
        </div>
      </div>
    </div>
    <template #footer>
      <!-- 只在确认该课程确实处于已通过状态时给撤销入口，避免对没有认证记录的历史课误点 -->
      <el-button
        v-if="detail?.certStatus === 'approved'"
        type="warning"
        plain
        :loading="revoking"
        @click="revokeApprove"
      >撤销通过（驳回）</el-button>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
/* 失败提示条与空态块：与账号页同款视觉（同类语义在不同页应长得一样） */
.load-fail {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--danger-100, #fbe3e1);
  background: var(--danger-50, #fef6f5);
  color: var(--danger-600, #d54941);
  font-size: 13px;
}
.load-fail-text {
  flex: 1;
  min-width: 0;
  line-height: 1.6;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  color: var(--ink-400, #9aa3b2);
  line-height: 1.7;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #3a4256);
}
/* 空态里的下一步按钮：与说明文字留出距离，避免和正文黏在一起 */
.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 操作列两个文字按钮必须同排。列收窄后（1280 下要腾出排课列的位置）
   默认 white-space:normal 会把「删除」挤到第二行，行高直接翻倍。 */
:deep(.courses-op .cell) {
  white-space: nowrap;
}
/* 未排课单元格：徽标 + 直达链接并排 */
.sched-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.sched-link {
  font-size: 12.5px;
  color: var(--brand-600, #2563eb);
  text-decoration: none;
  white-space: nowrap;
}
.sched-link:hover {
  text-decoration: underline;
}
/* 页脚的总数口径说明：换行显示，不挤掉右侧分页器 */
.filter-note {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--ink-400, #9aa3b2);
}
.pf-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-100, #f6f7fa);
}
.pf-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.pf-row .k {
  color: var(--ink-400, #9aa3b2);
  flex: none;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-700, #3a4256);
  margin-bottom: 8px;
}
.material-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line, #eceef3);
  border-radius: 8px;
  font-size: 13px;
}
</style>
