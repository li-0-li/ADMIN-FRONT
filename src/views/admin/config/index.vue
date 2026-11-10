<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onBeforeRouteLeave, RouterLink } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { listConfigs, listWords, saveWord, updateConfigs, type ConfigItem, type SensitiveWordVo } from '@/api/admin/config';

/**
 * 系统配置页（/admin/config）：
 * ① 业务配置（biz_config 25 键 × 6 组，valueType 驱动控件形态）——批量保存只发 dirty 键；
 * ② 敏感词库 CRUD（POST 三合一：新增/更新/删除 delete:true）。
 * 诚实口径：组名/键名/控件全部来自后端实测出参，不虚构原型里的「课程级配额表」
 * （后端无该端点，课程级配额只有全局键 ai.course_daily_quota）。
 *
 * 11-03 参考业界设置页惯例（左侧分组导航/搜索/未保存守卫）增强：
 * - 左侧 sticky 分组锚点导航 + 滚动高亮（25 键一屏扫不完，导航是刚需）
 * - 配置搜索（跨 configKey/remark 过滤；设置项过 20 个后搜索是标配）
 * - json 键即时校验徽标（旧版只在保存时报错，编辑时不知道错没错）
 * - editable=0 的键显示「锁定」标（不可操作项必须说明原因，不能只灰掉）
 * - 未保存更改离开守卫（路由离开 ElMessageBox 确认 + beforeunload）
 * - 敏感词关键词搜索接后端（后端 query 本来就收 keyword，旧页只有前端分类过滤）
 */

/* ---------------- 配置加载与编辑 ---------------- */
const loading = ref(false);
const loadError = ref('');
const items = ref<ConfigItem[]>([]);

/** 编辑副本：configKey → 当前输入值（初始=后端值） */
const drafts = reactive<Record<string, string>>({});
const dirtyKeys = computed(() =>
  Object.keys(drafts).filter(k =>
    items.value.some(i => i.configKey === k && String(drafts[k] ?? '').trim() !== String(i.configValue ?? '').trim())
  )
);
const dirtyCount = computed(() => dirtyKeys.value.length);
const saving = ref(false);

const GROUP_TITLES: Record<string, string> = {
  ai: 'AI 能力配置',
  quota: '调用配额',
  cert: '认证参数（三重认证）',
  class: '课堂参数',
  security: '安全策略',
  system: '系统杂项'
};
const groupOrder = ['ai', 'quota', 'cert', 'class', 'security', 'system'];
const groups = computed(() => {
  const map = new Map<string, ConfigItem[]>();
  items.value.forEach(i => {
    const g = i.configGroup || 'other';
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(i);
  });
  return [...map.entries()]
    .sort((a, b) => {
      const ia = groupOrder.indexOf(a[0]), ib = groupOrder.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
});

/* ---------------- 配置搜索（跨 configKey / remark） ---------------- */
const configSearch = ref('');
const filteredGroups = computed(() => {
  const q = configSearch.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value
    .map(([g, list]) => [g, list.filter(i => (i.configKey ?? '').toLowerCase().includes(q) || (i.remark ?? '').toLowerCase().includes(q))] as [string, ConfigItem[]])
    .filter(([, list]) => list.length > 0);
});
const searchHitCount = computed(() => filteredGroups.value.reduce((n, [, list]) => n + list.length, 0));

/* ---------------- json 键即时校验（编辑时就该知道对不对，而不是保存才报） ---------------- */
function jsonInvalid(item: ConfigItem): boolean {
  if (item.valueType !== 'json') return false;
  const v = String(drafts[item.configKey] ?? '').trim();
  if (!v) return false;
  try {
    JSON.parse(v);
    return false;
  } catch {
    return true;
  }
}

async function fetchConfigs() {
  loading.value = true;
  loadError.value = '';
  try {
    const r = await listConfigs();
    items.value = r?.items ?? [];
    Object.keys(drafts).forEach(k => delete drafts[k]);
    items.value.forEach(i => { drafts[i.configKey] = i.configValue; });
  } catch {
    loadError.value = '配置读取失败，请刷新重试';
  } finally {
    loading.value = false;
  }
}

/** json 键保存前做可解析校验：坏 JSON 写进去会让读端解析炸 */
function validateValue(item: ConfigItem, v: string): string | null {
  if (item.valueType === 'json' && v.trim()) {
    try {
      JSON.parse(v);
    } catch {
      return `${item.configKey} 不是合法 JSON，请修正后再保存`;
    }
  }
  return null;
}

async function saveAll() {
  if (!dirtyCount.value) return;
  const patch: Record<string, string> = {};
  for (const k of dirtyKeys.value) {
    const item = items.value.find(i => i.configKey === k)!;
    const err = validateValue(item, drafts[k]);
    if (err) {
      ElMessage.warning(err);
      return;
    }
    patch[k] = drafts[k];
  }
  saving.value = true;
  try {
    await updateConfigs(patch);
    ElMessage.success(`已保存 ${Object.keys(patch).length} 项配置（写入操作日志）`);
    fetchConfigs();
  } finally {
    saving.value = false;
  }
}

function discardAll() {
  items.value.forEach(i => { drafts[i.configKey] = i.configValue; });
  ElMessage.info('已放弃未保存的修改');
}

/* ---------------- 敏感词库 ---------------- */
const wordsLoading = ref(false);
const words = ref<SensitiveWordVo[]>([]);
const wordTotal = ref(0);
const wordQuery = reactive({ page: 1, pageSize: 10, keyword: '' });
/** 后端查询只收 keyword/status；category 是前端过滤 */
const categoryFilter = ref('');
const CATEGORY_TEXT: Record<string, string> = { politics: '涉政', abuse: '辱骂', ad: '广告', custom: '自定义' };
const LEVEL_TEXT: Record<string, string> = { high: '高', mid: '中', low: '低' };
const HANDLE_TEXT: Record<string, string> = { block: '拦截', replace: '替换', audit: '人工审核' };

const visibleWords = computed(() => (categoryFilter.value ? words.value.filter(w => w.category === categoryFilter.value) : words.value));

async function fetchWords() {
  wordsLoading.value = true;
  try {
    const r = await listWords({ ...wordQuery });
    words.value = r?.list ?? [];
    wordTotal.value = r?.total ?? 0;
  } finally {
    wordsLoading.value = false;
  }
}

const wordFormVisible = ref(false);
const wordFormMode = ref<'create' | 'edit'>('create');
const wordSaving = ref(false);
const wordForm = reactive({ wordId: '', word: '', category: 'custom', wordLevel: 'mid', handleAction: 'replace', replaceWord: '***', status: 1 });

function openWordCreate() {
  wordFormMode.value = 'create';
  Object.assign(wordForm, { wordId: '', word: '', category: 'custom', wordLevel: 'mid', handleAction: 'replace', replaceWord: '***', status: 1 });
  wordFormVisible.value = true;
}
function openWordEdit(row: SensitiveWordVo) {
  wordFormMode.value = 'edit';
  Object.assign(wordForm, {
    wordId: row.wordId,
    word: row.word,
    category: row.category,
    wordLevel: row.wordLevel,
    handleAction: row.handleAction,
    replaceWord: row.replaceWord || '***',
    status: row.status
  });
  wordFormVisible.value = true;
}

async function submitWord() {
  if (!wordForm.word.trim()) {
    ElMessage.warning('命中词不能为空');
    return;
  }
  if (wordForm.handleAction === 'replace' && !wordForm.replaceWord.trim()) {
    ElMessage.warning('处置为「替换」时替换文本不能为空');
    return;
  }
  wordSaving.value = true;
  try {
    await saveWord({
      wordId: wordFormMode.value === 'edit' ? wordForm.wordId : undefined,
      word: wordForm.word.trim(),
      category: wordForm.category,
      wordLevel: wordForm.wordLevel,
      handleAction: wordForm.handleAction,
      replaceWord: wordForm.replaceWord,
      status: wordForm.status
    });
    ElMessage.success(wordFormMode.value === 'create' ? '已新增敏感词' : '已保存');
    wordFormVisible.value = false;
    fetchWords();
  } finally {
    wordSaving.value = false;
  }
}

async function toggleWordStatus(row: SensitiveWordVo) {
  const next = row.status === 1 ? 0 : 1;
  await saveWord({ ...row, status: next });
  ElMessage.success(next === 1 ? '已启用' : '已停用');
  fetchWords();
}

async function removeWord(row: SensitiveWordVo) {
  await ElMessageBox.confirm(`确定要删除敏感词「${row.word}」吗？删除后立即生效。`, '删除', { type: 'warning', confirmButtonText: '删除' });
  await saveWord({ wordId: row.wordId, word: row.word, category: row.category, wordLevel: row.wordLevel, handleAction: row.handleAction, delete: true });
  ElMessage.success('已删除');
  fetchWords();
}

/* ---------------- 敏感词关键词搜索（后端 query 本就收 keyword，350ms 防抖） ---------------- */
const wordSearchInput = ref('');
let wordSearchTimer: number | undefined;
watch(wordSearchInput, v => {
  if (wordSearchTimer !== undefined) window.clearTimeout(wordSearchTimer);
  wordSearchTimer = window.setTimeout(() => {
    wordQuery.keyword = v.trim();
    wordQuery.page = 1;
    fetchWords();
  }, 350);
});

/* ---------------- 左侧分组锚点导航 + 滚动高亮 ---------------- */
const WORDS_SECTION_ID = 'cfg-g-words';
const navItems = computed(() => [
  ...filteredGroups.value.map(([g, list]) => ({ id: `cfg-g-${g}`, label: GROUP_TITLES[g] ?? g, count: list.length })),
  { id: WORDS_SECTION_ID, label: '敏感词库', count: wordTotal.value }
]);
const activeSection = ref('');
function onScrollSpy() {
  // 双列网格里同一行的两张卡 top 相同（实测 security/system 同为 0）⇒ 取「最后一个越线」会错拿右列。
  // 规则：越线（top≤120）者中取 top 最大者；并列（同行）取左列（offsetLeft 小者）。
  let best: { id: string; top: number; left: number } | null = null;
  for (const item of navItems.value) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top > 120) continue;
    if (!best || rect.top > best.top + 1 || (Math.abs(rect.top - best.top) <= 1 && rect.left < best.left)) {
      best = { id: item.id, top: rect.top, left: rect.left };
    }
  }
  activeSection.value = best?.id ?? navItems.value[0]?.id ?? '';
}
function jumpTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 未保存更改离开守卫 ----------------
 * 业界设置页标配（FormDirtyIndicator / NavigationGuard 模式）：
 * 路由离开用 ElMessageBox 确认（可取消），浏览器刷新/关页用 beforeunload 原生拦截。 */
onBeforeRouteLeave(async () => {
  if (!dirtyCount.value) return true;
  try {
    await ElMessageBox.confirm(
      `有 ${dirtyCount.value} 项配置改动未保存，离开将丢失这些改动。`,
      '未保存的更改',
      { type: 'warning', confirmButtonText: '放弃更改并离开', cancelButtonText: '留在本页' }
    );
    return true;
  } catch {
    return false;
  }
});
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirtyCount.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}

onMounted(() => {
  fetchConfigs();
  fetchWords();
  window.addEventListener('scroll', onScrollSpy, { passive: true });
  window.addEventListener('beforeunload', onBeforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('scroll', onScrollSpy);
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (wordSearchTimer !== undefined) window.clearTimeout(wordSearchTimer);
});
</script>

<template>
  <div class="page-head">
    <h1>系统配置</h1>
    <div class="actions">
      <el-button :disabled="!dirtyCount" @click="discardAll">放弃更改</el-button>
      <el-button type="primary" :loading="saving" :disabled="!dirtyCount" @click="saveAll">
        <ZkIcon name="save" :size="15" style="margin-right: 4px" />保存全部配置{{ dirtyCount ? `（${dirtyCount} 项改动）` : '' }}
      </el-button>
    </div>
  </div>

  <div v-if="loadError" class="ids-warn">{{ loadError }}</div>

  <!-- 搜索工具条：设置项过 20 个后搜索是标配；命中数可见，空态即「没有匹配项」而非空白 -->
  <div class="cfg-toolbar">
    <el-input v-model="configSearch" clearable placeholder="搜索配置键或说明（如 ai. / 配额）" style="width: 300px" />
    <span v-if="configSearch.trim()" class="small muted">命中 {{ searchHitCount }} 项配置（跨键名与说明匹配）</span>
    <span v-else class="small muted">共 {{ items.length }} 项配置 · {{ groups.length }} 组 · 改动后点右上「保存全部」一次提交</span>
  </div>

  <div class="cfg-layout">
    <!-- 左侧分组导航：sticky + 滚动高亮；≤1100px 隐藏（窄屏还给内容让宽度） -->
    <aside class="cfg-nav" aria-label="配置分组导航">
      <button
        v-for="n in navItems"
        :key="n.id"
        type="button"
        class="cfg-nav-item"
        :class="{ active: activeSection === n.id }"
        @click="jumpTo(n.id)"
      >
        <span class="cfg-nav-label">{{ n.label }}</span>
        <span class="cfg-nav-count">{{ n.count }}</span>
      </button>
    </aside>

    <div v-loading="loading" class="cfg-main">
      <div class="grid g2">
        <div v-for="[g, list] in filteredGroups" :id="`cfg-g-${g}`" :key="g" class="card card-pad cfg-section">
          <div class="card-title">{{ GROUP_TITLES[g] ?? g }}<span class="small muted" style="margin-left: 8px; font-weight: 400">{{ list.length }} 项</span></div>
      <div v-for="i in list" :key="i.configKey" class="cfg-row">
        <div class="cfg-info">
          <div class="cfg-key">
            {{ i.remark || i.configKey }}
            <el-tag v-if="i.configGroup === 'ai' && i.configKey === 'ai.provider'" size="small" type="success" effect="plain" class="cfg-tag">主模型</el-tag>
            <!-- 锁定项必须说明原因，不能只灰掉：title + 徽标双重提示 -->
            <span v-if="i.editable === 0" class="badge badge-neutral" title="系统锁定项：由部署配置统一管理，页面只读">锁定</span>
            <!-- json 即时校验：编辑时就显示合法/非法，不用等保存报错 -->
            <span v-if="jsonInvalid(i)" class="badge badge-error" title="当前内容不是合法 JSON">非法 JSON</span>
          </div>
          <div class="small muted">{{ i.configKey }}<span v-if="i.updateTime"> · 更新于 {{ i.updateTime }}</span></div>
        </div>
        <div class="cfg-value">
          <el-switch
            v-if="i.valueType === 'boolean'"
            v-model="drafts[i.configKey]"
            active-value="true"
            inactive-value="false"
            :disabled="i.editable === 0"
          />
          <el-input-number
            v-else-if="i.valueType === 'number'"
            :model-value="(drafts[i.configKey] as unknown as number)"
            :controls="false"
            style="width: 120px"
            :disabled="i.editable === 0"
            @update:model-value="(v: number | null) => (drafts[i.configKey] = v === null || v === undefined ? '' : String(v))"
          />
          <el-input
            v-else-if="i.valueType === 'json'"
            v-model="drafts[i.configKey]"
            type="textarea"
            :rows="3"
            style="width: 300px"
            :disabled="i.editable === 0"
          />
          <el-input v-else v-model="drafts[i.configKey]" style="width: 200px" :disabled="i.editable === 0" />
        </div>
      </div>
    </div>

    <!-- 敏感词库（C-9/C-10） -->
    <div :id="WORDS_SECTION_ID" class="card card-pad cfg-wide">
      <div class="between">
        <div class="card-title">敏感词库<span class="small muted" style="margin-left: 8px; font-weight: 400">命中后按处置策略作用于聊天/作业文本</span></div>
        <div class="toolbar-right">
          <el-input v-model="wordSearchInput" clearable placeholder="搜索命中词…" style="width: 150px" size="small" />
          <el-select v-model="categoryFilter" style="width: 120px" @change="() => {}">
            <el-option label="全部分类" value="" />
            <el-option v-for="(t, k) in CATEGORY_TEXT" :key="k" :label="t" :value="k" />
          </el-select>
          <el-button type="primary" plain size="small" @click="openWordCreate">
            <ZkIcon name="plus" :size="14" style="margin-right: 4px" />新增敏感词
          </el-button>
        </div>
      </div>
      <el-table v-loading="wordsLoading" :data="visibleWords" style="width: 100%">
        <el-table-column type="index" label="#" width="52" align="center" />
        <el-table-column prop="word" label="命中词" min-width="120" />
        <el-table-column label="分类" width="90">
          <template #default="{ row }"><span class="badge badge-info">{{ CATEGORY_TEXT[row.category] ?? row.category }}</span></template>
        </el-table-column>
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <span class="badge" :class="row.wordLevel === 'high' ? 'badge-error' : row.wordLevel === 'mid' ? 'badge-warning' : 'badge-neutral'">{{ LEVEL_TEXT[row.wordLevel] ?? row.wordLevel }}</span>
          </template>
        </el-table-column>
        <el-table-column label="处置" width="90">
          <template #default="{ row }">{{ HANDLE_TEXT[row.handleAction] ?? row.handleAction }}</template>
        </el-table-column>
        <el-table-column prop="replaceWord" label="替换文本" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span class="badge" :class="row.status === 1 ? 'badge-success' : 'badge-neutral'">{{ row.status === 1 ? '启用' : '停用' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" align="right" fixed="right">
          <template #default="{ row }">
            <el-button text size="small" @click="openWordEdit(row)">编辑</el-button>
            <el-button text size="small" @click="toggleWordStatus(row)">{{ row.status === 1 ? '停用' : '启用' }}</el-button>
            <el-button text size="small" style="color: var(--error)" @click="removeWord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="muted small" style="padding: 18px 0">暂无敏感词</div></template>
      </el-table>
      <div class="between" style="padding: 12px 0 0">
        <span class="small muted">共 {{ wordTotal }} 条</span>
        <el-pagination
          v-model:current-page="wordQuery.page"
          v-model:page-size="wordQuery.pageSize"
          :total="wordTotal"
          :page-sizes="[10, 20, 50]"
          layout="prev, pager, next"
          @current-change="fetchWords"
        />
      </div>
    </div>

    <!-- 审计说明（静态：变更由 @Log 写入 sys_oper_log，系统日志页可见） -->
    <div class="card card-pad">
      <div class="card-title">配置变更审计</div>
      <div class="small muted">
        本页所有配置与敏感词变更均写入操作日志（操作人 / 时间 / 变更前后值），可在
        <RouterLink class="name-link" to="/admin/logs">系统日志</RouterLink>
        页按操作日志类型查看，满足管理端审计要求。批量保存只提交有改动的键，未改动的项不产生审计记录。
      </div>
    </div>
      </div>
    </div>
  </div>

  <el-dialog v-model="wordFormVisible" :title="wordFormMode === 'create' ? '新增敏感词' : '编辑敏感词'" width="460px">
    <el-form label-width="88px" label-position="left">
      <el-form-item label="命中词" required>
        <el-input v-model="wordForm.word" placeholder="将被检测的文本片段" />
      </el-form-item>
      <el-form-item label="分类">
        <el-select v-model="wordForm.category" style="width: 100%">
          <el-option v-for="(t, k) in CATEGORY_TEXT" :key="k" :label="t" :value="k" />
        </el-select>
      </el-form-item>
      <el-form-item label="级别">
        <el-select v-model="wordForm.wordLevel" style="width: 100%">
          <el-option v-for="(t, k) in LEVEL_TEXT" :key="k" :label="t" :value="k" />
        </el-select>
      </el-form-item>
      <el-form-item label="处置">
        <el-select v-model="wordForm.handleAction" style="width: 100%">
          <el-option v-for="(t, k) in HANDLE_TEXT" :key="k" :label="t" :value="k" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="wordForm.handleAction === 'replace'" label="替换文本" required>
        <el-input v-model="wordForm.replaceWord" />
      </el-form-item>
      <el-form-item label="状态">
        <el-switch v-model="wordForm.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="停用" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="wordFormVisible = false">取消</el-button>
      <el-button type="primary" :loading="wordSaving" @click="submitWord">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 编号 68 同款：EP 分页器「当前页」两层规则叠加 = brand-600 字压 brand-600 底（1.0 隐形）。
   本页同样覆盖为 --brand-700 底 + 白字（5.48:1 AA）。全局修属共享样式批次，另行派单。 */
:deep(.el-pagination .el-pager li.is-active) {
  background-color: var(--brand-700);
  color: #fff;
}

/* 旧包/读取失败警示条（与基础数据页同款视觉） */
.ids-warn {
  border: 1px solid var(--warning);
  background: var(--warning-soft);
  color: var(--warning-strong);
  border-radius: var(--r-lg);
  padding: 10px 16px;
  font-size: 13px;
  margin-bottom: 16px;
}

/* 配置行：左侧键名说明 + 右侧控件，valueType 决定控件形态。
   1024 视口下双列网格每列仅 ~350px，控件写死宽度会撑破列（实测整页溢出 31px）⇒
   允许换行 + 所有控件 max-width 限到列宽内 */
.cfg-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
  flex-wrap: wrap;
}
.cfg-value :deep(.el-input),
.cfg-value :deep(.el-input-number),
.cfg-value :deep(.el-textarea),
.cfg-value :deep(.el-switch) {
  max-width: 100%;
}
.cfg-row:last-child {
  border-bottom: none;
}
.cfg-info {
  min-width: 0;
}
.cfg-key {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-900);
  display: flex;
  align-items: center;
  gap: 6px;
}
.cfg-tag {
  flex: none;
}
.cfg-value {
  flex: none;
  text-align: right;
}

/* 敏感词卡跨两列。⚠️ 必须限宽：表格 min-content（列宽合计 ~822px）在 1024 视口会把
   grid 卡撑到 1055px 造成整页横向溢出；overflow hidden 后由 el-table 自身滚动条接管 */
.cfg-wide {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 锚点落点避开吸附页头（约 76px）+ 余量 */
.cfg-section,
.cfg-wide {
  scroll-margin-top: 88px;
}

/* ---------------- 11-03 增强：搜索工具条 + 左侧分组导航 ---------------- */
.cfg-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
/* 左导航 + 主内容两栏；≤1100px 收掉导航（窄屏优先保内容宽度，与全站 1024 断点策略一致） */
.cfg-layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.cfg-nav {
  position: sticky;
  top: 76px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg-surface, #fff);
}
.cfg-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: none;
  background: transparent;
  border-radius: var(--r-md, 8px);
  padding: 7px 10px;
  font-size: 13px;
  color: var(--ink-700, #444);
  cursor: pointer;
  text-align: left;
}
.cfg-nav-item:hover {
  background: var(--bg-soft, #f5f7f8);
}
.cfg-nav-item.active {
  background: var(--brand-100, #e8f0fe);
  color: var(--brand-700, #1d4ed8);
  font-weight: 600;
}
.cfg-nav-count {
  flex: none;
  font-size: 12px;
  color: var(--ink-400, #999);
}
.cfg-nav-item.active .cfg-nav-count {
  color: var(--brand-700, #1d4ed8);
}
@media (max-width: 1100px) {
  .cfg-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .cfg-nav {
    display: none;
  }
}
</style>
