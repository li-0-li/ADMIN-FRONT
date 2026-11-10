<script setup lang="ts">
/**
 * G3 · 知识库管理（2026-11-10 派单）
 *
 * 本期硬边界（派单 §二）：后端**没有上传/新增文档端点**（依赖 MinIO，本机未部署）。
 *   ⇒ 只做「查看 + 删除」；上传入口做成**禁用态 + title 说明**，
 *     绝不做一个点了没反应的按钮（验收会把它当 bug）。
 *
 * 数据形态（实测，见 api/admin/knowledge.ts）：
 *   - sources / chunks 都是**裸数组**，没有分页；
 *   - 文档源按 `source_file` 聚合，删源 = 删该文件下全部分块，需要 query `sourceFile`。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { listCourses, type AdminCourseVo } from '@/api/admin/courses';
import {
  indexStatusView,
  listKbChunks,
  listKbSources,
  removeKbChunk,
  removeKbSource,
  type KbChunk,
  type KbSource
} from '@/api/admin/knowledge';

const courseOptions = ref<AdminCourseVo[]>([]);
const courseId = ref('');

const loading = ref(false);
const loadError = ref('');
const sources = ref<KbSource[]>([]);
const chunks = ref<KbChunk[]>([]);

/** 分块按来源过滤（前端过滤：接口返回全量，没有分页参数） */
const sourceFilter = ref('');

const sourceOptions = computed(() => {
  const set = new Set<string>();
  for (const s of sources.value) if (s.sourceFile) set.add(s.sourceFile);
  for (const c of chunks.value) if (c.sourceFile) set.add(c.sourceFile);
  return [...set];
});

const filteredChunks = computed(() =>
  sourceFilter.value ? chunks.value.filter((c) => (c.sourceFile ?? '') === sourceFilter.value) : chunks.value
);

async function loadCourses() {
  try {
    const res = await listCourses({ page: 1, pageSize: 200 });
    courseOptions.value = res?.list ?? [];
    if (!courseId.value && courseOptions.value.length) courseId.value = String(courseOptions.value[0].courseId);
  } catch {
    courseOptions.value = [];
  }
}

async function loadAll() {
  if (!courseId.value) {
    sources.value = [];
    chunks.value = [];
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    // 两个接口都返回裸数组；任一失败就整体标错，避免"一半有数据"看起来像库里就这样
    const [src, chk] = await Promise.all([listKbSources(courseId.value), listKbChunks(courseId.value)]);
    sources.value = Array.isArray(src) ? src : [];
    chunks.value = Array.isArray(chk) ? chk : [];
    // 过滤源已不存在时复位，否则会一直显示空列表
    if (sourceFilter.value && !sourceOptions.value.includes(sourceFilter.value)) sourceFilter.value = '';
  } catch {
    sources.value = [];
    chunks.value = [];
    loadError.value = '知识库数据未取到，可点刷新重试。';
  } finally {
    loading.value = false;
  }
}

function onCourseChange() {
  sourceFilter.value = '';
  void loadAll();
}

/* ---------------- 删除 ---------------- */
async function doRemoveSource(s: KbSource) {
  try {
    await ElMessageBox.confirm(
      `将删除「${s.sourceFile}」下的全部 ${s.chunkCount} 个分块，删除后不可恢复（需要重新上传并重建索引）。确认删除？`,
      '删除文档源',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  try {
    const n = await removeKbSource(courseId.value, s.sourceFile);
    ElMessage.success(`已删除文档源（${typeof n === 'number' ? n : s.chunkCount} 个分块）`);
    await loadAll();
  } catch {
    /* 请求层已提示 */
  }
}

async function doRemoveChunk(c: KbChunk) {
  try {
    await ElMessageBox.confirm(
      `确认删除第 ${c.chunkIndex + 1} 个分块？删除后不可恢复，后续问答不会再检索到这段内容。`,
      '删除分块',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  try {
    await removeKbChunk(c.chunkId);
    ElMessage.success('已删除分块');
    await loadAll();
  } catch {
    /* 请求层已提示 */
  }
}

function contentBrief(s?: string | null) {
  return (s ?? '').replace(/\s+/g, ' ').trim() || '（空内容）';
}

const isEmpty = computed(() => !loading.value && !loadError.value && !sources.value.length && !chunks.value.length);

onMounted(async () => {
  await loadCourses();
  await loadAll();
});
</script>

<template>
  <div class="page-head">
    <h1>知识库管理</h1>
    <div class="actions">
      <!-- 上传：后端没有端点，做禁用态并说明原因（派单 §二要求） -->
      <el-tooltip content="上传待后端补端点（依赖 MinIO，当前本机未部署）" placement="bottom">
        <span>
          <el-button disabled>
            <ZkIcon name="upload" :size="15" style="margin-right: 5px" />上传文档
          </el-button>
        </span>
      </el-tooltip>
      <el-button class="tb-icon" :loading="loading" title="刷新" @click="loadAll">
        <ZkIcon v-if="!loading" name="refresh-cw" :size="15" />
      </el-button>
    </div>
  </div>

  <div class="toolbar">
    <div class="left">
      <span class="small muted">知识库按课程存放；本期只能查看与删除，上传待后端补齐。</span>
    </div>
    <div class="right" style="gap: 10px">
      <el-select v-model="courseId" placeholder="选择课程" filterable style="width: 220px" @change="onCourseChange">
        <el-option v-for="c in courseOptions" :key="c.courseId" :label="c.courseName || c.courseId" :value="String(c.courseId)" />
      </el-select>
      <el-select
        v-model="sourceFilter"
        placeholder="全部文档源"
        clearable
        filterable
        style="width: 200px"
      >
        <el-option v-for="s in sourceOptions" :key="s" :label="s" :value="s" />
      </el-select>
    </div>
  </div>

  <div v-if="loadError" class="banner-err">
    <ZkIcon name="alert-triangle" :size="15" style="flex: none; margin-top: 1px" />
    <span>{{ loadError }}</span>
  </div>

  <!-- 文档源 -->
  <div class="card card-pad" style="margin-bottom: 14px">
    <div class="sec-head">
      <span class="sec-title">文档源</span>
      <span class="small muted">{{ sources.length }} 个文件</span>
    </div>
    <el-skeleton v-if="loading" :rows="2" animated />
    <div v-else-if="!sources.length" class="empty-inline">
      {{ isEmpty ? '这门课的知识库还是空的（没有文档源）。上传端点待后端补齐后，这里会列出已入库文件。' : '没有文档源。' }}
    </div>
    <div v-else class="src-list">
      <div v-for="s in sources" :key="s.sourceFile" class="src-item">
        <div class="src-main">
          <div class="src-name">
            <ZkIcon name="file-text" :size="14" />
            <span>{{ s.sourceFile }}</span>
          </div>
          <div class="src-meta small muted">
            {{ s.chunkCount }} 个分块
            <template v-if="s.tokenCount">　·　{{ s.tokenCount }} tokens</template>
            <template v-if="s.lastIndexedAt">　·　索引于 {{ String(s.lastIndexedAt).replace('T', ' ') }}</template>
          </div>
        </div>
        <span class="idx-tag" :class="indexStatusView(s.indexStatus).tone">{{ indexStatusView(s.indexStatus).label }}</span>
        <el-button link size="small" type="danger" @click="doRemoveSource(s)">删除</el-button>
      </div>
    </div>
  </div>

  <!-- 分块 -->
  <div class="card card-pad">
    <div class="sec-head">
      <span class="sec-title">分块</span>
      <span class="small muted">
        {{ filteredChunks.length }} 条{{ sourceFilter ? `（全部 ${chunks.length} 条）` : '' }}
      </span>
    </div>
    <el-table
      v-loading="loading"
      :data="filteredChunks"
      size="small"
      max-height="460"
      style="width: 100%"
      :row-key="(r: KbChunk) => String(r.chunkId)"
    >
      <el-table-column label="#" width="56" align="center">
        <template #default="{ row }">{{ row.chunkIndex + 1 }}</template>
      </el-table-column>
      <el-table-column label="来源文件" width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ row.sourceFile || '—' }}</template>
      </el-table-column>
      <el-table-column label="内容" min-width="320" show-overflow-tooltip>
        <template #default="{ row }">{{ contentBrief(row.content) }}</template>
      </el-table-column>
      <el-table-column label="tokens" width="80" align="right">
        <template #default="{ row }">{{ row.tokenCount ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="索引状态" width="96">
        <template #default="{ row }">
          <span class="idx-tag" :class="indexStatusView(row.indexStatus).tone">{{ indexStatusView(row.indexStatus).label }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="150">
        <template #default="{ row }">{{ row.createTime || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-button link size="small" type="danger" @click="doRemoveChunk(row)">删除</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div class="empty-block">
          <ZkIcon name="layers" :size="26" />
          <div class="empty-title">
            {{ !courseId ? '先选一门课程' : sourceFilter ? '该文档源下没有分块' : '这门课还没有分块' }}
          </div>
          <div class="small muted">
            {{ !courseId ? '知识库按课程存放。' : sourceFilter ? '换个文档源，或清空筛选。' : '分块由文档上传后自动切分，后端上传端点未提供，所以这里为空是正常的。' }}
          </div>
        </div>
      </template>
    </el-table>
  </div>
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
.src-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.src-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border, #eef0f4);
  border-radius: var(--r-md, 8px);
}
.src-main {
  flex: 1;
  min-width: 0;
}
.src-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-800, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src-meta {
  margin-top: 2px;
}
.idx-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 18px;
}
.idx-tag.ok {
  background: #ecfdf5;
  color: #047857;
}
.idx-tag.warn {
  background: #fffbeb;
  color: #b45309;
}
.idx-tag.error {
  background: #fef2f2;
  color: #b91c1c;
}
.empty-inline {
  padding: 10px 2px;
  font-size: 12.5px;
  color: var(--ink-400, #9aa3b2);
  line-height: 1.7;
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
</style>
