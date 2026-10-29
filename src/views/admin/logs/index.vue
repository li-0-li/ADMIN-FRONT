<template>
  <div class="page-head">
    <h1>系统日志</h1>
    <div class="actions">
      <button
        class="btn btn-outline"
        :disabled="exporting"
        title="按当前筛选条件导出 CSV（不是导出全部：先改筛选再导出）"
        @click="onExport"
      >
        <ZkIcon name="download" :size="16" style="margin-right: 4px" />{{ exporting ? '导出中…' : '导出日志' }}
      </button>
    </div>
  </div>

  <span class="pilltabs">
    <span class="pill" :class="{ active: tab === 'operation' }" @click="switchTab('operation')">操作日志</span>
    <span class="pill" :class="{ active: tab === 'login' }" @click="switchTab('login')">登录日志</span>
  </span>

  <div class="toolbar mt16">
    <div class="filters">
      <el-input
        v-model="keyword"
        class="f-kw"
        :placeholder="tab === 'operation' ? '操作人（如 T2026003）' : '账号或 IP'"
        clearable
        @keyup.enter="onSearch"
      />
      <el-input
        v-if="tab === 'operation'"
        v-model="moduleName"
        class="f-mod"
        placeholder="模块名（如 智能排课）"
        clearable
        @keyup.enter="onSearch"
      />
      <el-select
        v-if="tab === 'operation'"
        v-model="businessType"
        class="f-sel"
        placeholder="全部类型"
        clearable
      >
        <el-option v-for="o in BUSINESS_TYPES" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="status" class="f-sel" placeholder="全部结果" clearable>
        <el-option label="成功" :value="0" />
        <el-option label="失败" :value="1" />
      </el-select>
      <el-date-picker
        v-model="dateRange"
        class="f-date"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="~"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :shortcuts="DATE_SHORTCUTS"
      />
    </div>
    <div class="right">
      <button class="btn btn-outline" @click="onReset">重置</button>
      <button class="btn btn-primary" @click="onSearch">
        <ZkIcon name="search" :size="14" style="margin-right: 4px" />查询
      </button>
    </div>
  </div>

  <div class="card mt16">
    <div v-loading="loading" class="tbl-wrap">
      <table class="tbl">
        <thead v-if="tab === 'operation'">
          <tr>
            <th style="width: 172px">时间</th>
            <th style="width: 120px">操作人</th>
            <th style="width: 120px">模块</th>
            <th>操作内容</th>
            <th style="width: 150px">IP · 地点</th>
            <th style="width: 110px">结果</th>
          </tr>
        </thead>
        <thead v-else>
          <tr>
            <th style="width: 172px">时间</th>
            <th style="width: 200px">账号</th>
            <th style="width: 180px">IP</th>
            <th>归属地</th>
            <th style="width: 100px">结果</th>
          </tr>
        </thead>

        <tbody v-if="rows.length">
          <tr v-for="r in rows" :key="tab + '-' + r.operId">
            <td class="mono small">{{ r.operTime || '—' }}</td>
            <td>{{ r.operName || '—' }}</td>

            <template v-if="tab === 'operation'">
              <td><span class="badge badge-info">{{ r.title || '—' }}</span></td>
              <!-- 「操作内容」不是后端字段：后端只存 title / businessType / requestMethod / operUrl，
                   原型里「修改账号状态：张同学 → 停用」那种自然语言描述库里没有。这里用三项真实字段拼出，
                   并保留完整 url 在 title 属性里（表格放不下）。 -->
              <td class="content-cell" :title="fullContent(r)">
                {{ contentText(r) || '—' }}
              </td>
              <td class="small muted" :title="locTitle(r)">{{ r.operIp || '—' }} · {{ locText(r) }}</td>
            </template>

            <template v-else>
              <td class="mono small">{{ r.operIp || '—' }}</td>
              <td class="small muted" :title="locTitle(r)">{{ locText(r) }}</td>
            </template>

            <td>
              <span class="badge" :class="r.status === 0 ? 'badge-success' : 'badge-error'">
                {{ r.status === 0 ? '成功' : '失败' }}
              </span>
              <span v-if="tab === 'operation' && r.costTime !== null && r.costTime !== undefined" class="small muted cost">
                {{ r.costTime }} ms
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 失败态与空态必须分开：前者要能看出是接口坏了，后者是「这个筛选下确实没有」 -->
      <div v-if="!loading && loadError" class="empty">
        <span class="empty-icon err"><ZkIcon name="alert-triangle" :size="22" /></span>
        <p class="empty-main">日志读取失败</p>
        <p class="small muted">{{ loadError }}</p>
        <p class="small muted">若反复失败，先确认后端 8080 与数据库隧道 3307 是否都在跑，再点下方重试。</p>
        <button class="btn btn-outline" style="margin-top: 10px" @click="load">
          <ZkIcon name="refresh-cw" :size="14" style="margin-right: 4px" />重试
        </button>
      </div>
      <div v-else-if="!loading && !rows.length" class="empty">
        <span class="empty-icon ok"><ZkIcon name="file-text" :size="22" /></span>
        <p class="empty-main">当前筛选条件下没有日志</p>
        <p class="small muted">可放宽时间范围，或清空关键词后重试。</p>
      </div>
    </div>

    <div class="between log-pager">
      <span class="small muted">{{ countText }}</span>
      <el-pagination
        v-if="total > 0"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="sizes, prev, pager, next, jumper"
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>

  <!-- 口径说明：讲清哪些列是真数据、哪些原型列后端没有，避免验收时被当成缺功能 -->
  <p class="caliber-line">
    <b>口径：</b>
    {{ tab === 'operation'
      ? '「操作内容」由模块名 + 操作类型 + 请求方式 + 请求地址拼成（后端不存自然语言描述）；「结果」判据是 status=0，与 HTTP 状态码无关。'
      : '原型里的「角色」「设备/客户端」两列后端无任何来源（登录日志出参只有账号/IP/归属地/时间/状态），故不展示，不做假列。' }}
    共 {{ total }} 条{{ loadError ? '（上次读取失败，以上为失败前数据）' : '' }}。
  </p>
</template>

<script setup lang="ts">
/**
 * 系统日志（/admin/logs）· 乙线 2026-10-29
 * -----------------------------------------------------------------------------
 * 数据源只有一个端点：GET /api/v1/admin/logs（`AdminLogController.java:45`），
 * 两个页签靠 logType 切分支，出参同形 `{list,total,page,pageSize}`（服务端真分页）。
 *
 * 页面职责边界：
 *   - **只读**。没有写接口，也没有「清理日志」动作（后端没提供，不摆假按钮）。
 *   - 导出是**前端按当前筛选重新拉一次**再生成 CSV，不是后端导出端点
 *     （`/api/v1/admin/export` 是报表导出，不吃这些筛选参数）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { listLogs, listLogsForExport } from '@/api/admin/logs';
import type { LogRowVo, LogTab } from './types';

/**
 * 若依 business_type 枚举（框架标准，不随业务漂移，所以可以硬编码）。
 * 实测库里只出现 1/2/3/5/6，但 0/4/7/8/9 是框架定义值，一并列上以免将来新增时显示成数字。
 */
const BUSINESS_TYPES = [
  { value: 0, label: '其它' },
  { value: 1, label: '新增' },
  { value: 2, label: '修改' },
  { value: 3, label: '删除' },
  { value: 4, label: '授权' },
  { value: 5, label: '导出' },
  { value: 6, label: '导入' },
  { value: 7, label: '强退' },
  { value: 8, label: '生成代码' },
  { value: 9, label: '清空数据' }
];

const DATE_SHORTCUTS = [
  {
    text: '最近 7 天',
    value: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      return [start, end];
    }
  },
  {
    text: '最近 30 天',
    value: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 29);
      return [start, end];
    }
  },
  {
    text: '最近 90 天',
    value: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 89);
      return [start, end];
    }
  }
];

const tab = ref<LogTab>('operation');
const keyword = ref('');
const moduleName = ref('');
const businessType = ref<number | null>(null);
const status = ref<number | null>(null);
/** el-date-picker 的 daterange 在 value-format 下给的是 ['YYYY-MM-DD','YYYY-MM-DD'] 或 null */
const dateRange = ref<[string, string] | null>(null);

const page = ref(1);
const pageSize = ref(20);

const rows = ref<LogRowVo[]>([]);
const total = ref(0);
const loading = ref(false);
const exporting = ref(false);
/** 与 loading 分开：失败时要把后端/网络的原因显示出来，不能只说「加载失败」 */
const loadError = ref('');

/**
 * 并发响应只认最后一次。
 * 本页有三个入口会触发 load（切页签、改页码、点查询），后端一次 300ms~1s，
 * 手快时会同时挂两个请求；慢的那个后回来就会把新筛选的结果覆盖成旧口径 ——
 * 屏幕上页码是第 3 页、内容是第 1 页，且不报任何错。学情页踩过同一个坑。
 */
let reqSeq = 0;

const countText = computed(() => {
  if (loading.value) return '正在读取…';
  if (!total.value) return '暂无记录';
  const from = (page.value - 1) * pageSize.value + 1;
  const to = Math.min(page.value * pageSize.value, total.value);
  return `第 ${from}–${to} 条 / 共 ${total.value} 条`;
});

function currentQuery() {
  return {
    tab: tab.value,
    keyword: keyword.value.trim(),
    module: moduleName.value.trim(),
    businessType: businessType.value,
    status: status.value,
    startTime: dateRange.value?.[0] ?? '',
    endTime: dateRange.value?.[1] ?? '',
    page: page.value,
    pageSize: pageSize.value
  };
}

async function load() {
  const seq = ++reqSeq;
  loading.value = true;
  loadError.value = '';
  try {
    const res = await listLogs(currentQuery());
    if (seq !== reqSeq) return;
    rows.value = res?.list ?? [];
    total.value = res?.total ?? 0;
    /**
     * 页码越界自愈：日志是「最新在前」，新日志不断插入会让第 N 页在翻页途中越过末尾，
     * 后端此时返回空 list 但 total 不为 0 —— 不纠正的话用户会停在一个永远空白的页上，
     * 而且以为是没数据。
     */
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value));
    if (page.value > maxPage) {
      page.value = maxPage;
      await load();
    }
  } catch (e) {
    if (seq !== reqSeq) return;
    loadError.value = e instanceof Error ? e.message : String(e);
    rows.value = [];
    total.value = 0;
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

/**
 * 切页签：清掉只属于操作日志的筛选（模块 / 类型）。
 * 不清的话，从「操作日志·模块=智能排课」切到登录日志，那两个值会被后端忽略，
 * 但用户看着输入框还在，会以为登录日志里也筛了模块 —— 实际没筛，结果数对不上。
 * keyword 也清：操作日志里它是操作人，登录日志里它是账号/IP，语义不同。
 */
function switchTab(t: LogTab) {
  if (tab.value === t) return;
  tab.value = t;
  keyword.value = '';
  moduleName.value = '';
  businessType.value = null;
  page.value = 1;
  load();
}

function onSearch() {
  page.value = 1;
  load();
}

function onReset() {
  keyword.value = '';
  moduleName.value = '';
  businessType.value = null;
  status.value = null;
  dateRange.value = null;
  page.value = 1;
  load();
}

function onPageChange(p: number) {
  page.value = p;
  load();
}

function onSizeChange(s: number) {
  pageSize.value = s;
  /** 改每页条数必须回第 1 页：否则 20 条/页第 5 页切到 100 条/页会落在一个不存在的页上 */
  page.value = 1;
  load();
}

function btLabel(v: number | null) {
  if (v === null || v === undefined) return '';
  return BUSINESS_TYPES.find(o => o.value === v)?.label ?? `类型 ${v}`;
}

function fullContent(r: LogRowVo) {
  return [btLabel(r.businessType), r.requestMethod, r.operUrl].filter(Boolean).join(' · ');
}

function contentText(r: LogRowVo) {
  const t = fullContent(r);
  return t.length > 64 ? `${t.slice(0, 64)}…` : t;
}

/**
 * 归属地显示：库里有一批 `XX XX`（实测登录日志 1095 条里 59 条），是若依 IP 库解析失败时
 * 落库的占位值，不是真实地名。直接显示等于把一坨脏数据摆给用户看（而且很长，会把列撑宽），
 * 所以屏上显示「—」，原始值放到 title 里说明 —— 既不美化数据，也不让人以为是页面没取到。
 */
function locText(r: LogRowVo) {
  const v = (r.operLocation || '').trim();
  if (!v || v === 'XX XX') return '—';
  return v;
}

function locTitle(r: LogRowVo) {
  const v = (r.operLocation || '').trim();
  if (!v) return '后端未返回操作地点';
  if (v === 'XX XX') return '后端存的原始值是「XX XX」，是 IP 归属地解析失败的占位值，不是真实地名';
  return v;
}

/* ---------------- 导出 ---------------- */

/** CSV 公式注入防护：单元格以 = + - @ 或制表/回车开头时 Excel 会当公式执行，前置单引号阻断 */
function csvCell(v: unknown) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(list: LogRowVo[]) {
  const head =
    tab.value === 'operation'
      ? ['时间', '操作人', '模块', '操作类型', '请求方式', '请求地址', 'IP', '操作地点', '结果', '耗时(ms)']
      : ['时间', '账号', 'IP', '归属地', '结果'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of list) {
    const row =
      tab.value === 'operation'
        ? [
            r.operTime,
            r.operName,
            r.title,
            btLabel(r.businessType),
            r.requestMethod,
            r.operUrl,
            r.operIp,
            r.operLocation,
            r.status === 0 ? '成功' : '失败',
            r.costTime
          ]
        : [r.operTime, r.operName, r.operIp, r.operLocation, r.status === 0 ? '成功' : '失败'];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

function download(name: string, text: string) {
  /** BOM：不加的话 Excel 打开中文表头是乱码 */
  const blob = new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function onExport() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const res = await listLogsForExport(currentQuery());
    const list = res?.list ?? [];
    if (!list.length) {
      ElMessage.warning('当前筛选条件下没有可导出的日志');
      return;
    }
    const all = res?.total ?? list.length;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    download(`系统日志-${tab.value === 'operation' ? '操作日志' : '登录日志'}-${stamp}.csv`, buildCsv(list));
    /**
     * 导出上限必须说出来：后端 pageSize 无上限校验，导出走 2000 条一次拉，
     * 超出时只导出了前 2000 条。不提示的话，用户会拿一份少了一截的日志去做审计。
     */
    if (all > list.length) ElMessage.warning(`共 ${all} 条，本次只导出前 ${list.length} 条，请缩小时间范围分批导出`);
    else ElMessage.success(`已导出 ${list.length} 条`);
  } catch (e) {
    ElMessage.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.f-kw {
  width: 200px;
}
.f-mod {
  width: 190px;
}
.f-sel {
  width: 132px;
}
.f-date {
  width: 260px;
}
.tbl-wrap {
  overflow-x: auto;
}
.mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}
.content-cell {
  color: var(--ink-700);
  word-break: break-all;
}
.cost {
  margin-left: 6px;
  white-space: nowrap;
}
/* 分页条：与表体用上边线分开，表格自带横向滚动，不共用滚动区 */
.log-pager {
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 10px;
}
.empty {
  text-align: center;
  padding: 44px 20px;
}
.empty-icon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  background: var(--bg-subtle);
  color: var(--ink-500);
}
.empty-icon.ok {
  background: var(--success-soft, #e8f5ec);
  color: var(--success);
}
.empty-icon.err {
  background: var(--error-soft, #fdeaea);
  color: var(--error);
}
.empty-main {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700);
  margin: 0 0 4px;
}
.caliber-line {
  margin: 12px 2px 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-500);
}
</style>
