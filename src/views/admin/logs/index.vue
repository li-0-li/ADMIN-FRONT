<template>
  <div class="page-head">
    <h1>系统日志</h1>
    <div class="actions">
      <button
        class="btn btn-outline"
        :disabled="exporting"
        title="按当前筛选条件导出「全部匹配行」，不是只导当前页；单次上限 2000 条，超出时会明确提示只导出了前 2000 条"
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
          <!-- 整行可点开详情（同 CloudTrail 点事件名看详情）：不额外占一列，也不破坏两个页签
               各自的列数。单元格里的筛选按钮用 .stop 阻止冒泡，否则点它会连带打开抽屉。 -->
          <tr
            v-for="r in rows"
            :key="tab + '-' + r.operId"
            class="log-row"
            title="点击查看这条日志的全部字段"
            @click="detail = r"
          >
            <td class="mono small">
              <div class="t-rel">{{ relTime(r.operTime) }}</div>
              <div class="t-abs" :title="r.operTime">{{ absTime(r.operTime) }}</div>
            </td>

            <template v-if="tab === 'operation'">
              <td>
                <button
                  v-if="r.operName"
                  class="val-link"
                  title="只看这个操作人的记录"
                  @click.stop="filterBy('operName', r.operName)"
                >{{ r.operName }}</button>
                <span v-else>—</span>
              </td>
              <td>
                <button
                  v-if="r.title"
                  class="badge badge-info val-badge"
                  title="只看这个模块的记录"
                  @click.stop="filterBy('title', r.title)"
                >{{ r.title }}</button>
                <span v-else>—</span>
              </td>
              <!-- 「操作内容」不是后端字段：后端只存 title / businessType / requestMethod / operUrl，
                   原型里「修改账号状态：张同学 → 停用」那种自然语言描述库里没有。这里用三项真实字段拼出。 -->
              <td class="content-cell">{{ contentText(r) || '—' }}</td>
              <!-- IP 不做成可点：后端操作日志分支没有 IP 入参，点了只能前端过滤，
                   「共 N 条」会与真实总数对不上，比不能点更误导 -->
              <td class="small muted">{{ r.operIp || '—' }} · {{ locText(r) }}</td>
            </template>

            <template v-else>
              <td>
                <button
                  v-if="r.operName"
                  class="val-link mono"
                  title="只看这个账号的记录"
                  @click.stop="filterBy('keyword', r.operName)"
                >{{ r.operName }}</button>
                <span v-else>—</span>
              </td>
              <td>
                <button
                  v-if="r.operIp"
                  class="val-link mono"
                  title="只看这个 IP 的记录"
                  @click.stop="filterBy('keyword', r.operIp)"
                >{{ r.operIp }}</button>
                <span v-else>—</span>
              </td>
              <td class="small muted">{{ locText(r) }}</td>
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
        <p class="small muted">若反复失败，请点下方重试；仍未恢复请联系系统管理员。</p>
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

  <!-- 屏上只留对使用者有用的信息（总条数 + 怎么用），不摆字段口径解释。
       失败态下整段隐藏：此时表格没有行，而且「共 0 条（以上为失败前数据）」
       会与上方「日志读取失败」自相矛盾（数据已被清空，没有失败前数据）。
       下面三条理由保留在注释里，避免以后被当成漏做而「补」回界面：
       1. 「操作内容」是模块名 + 操作类型 + 请求方式 + 请求地址拼成的，后端不存自然语言描述；
       2. 「结果」只看 status（0 成功 / 非 0 失败），与 HTTP 状态码无关；
       3. 登录日志没有角色、设备字段（出参只有账号/IP/归属地/时间/状态），所以不设这两列。 -->
  <p v-if="!loadError" class="caliber-line">
    共 {{ total }} 条。点任意一行可查看详情；点操作人、模块名（或登录页签的账号、IP）可直接按它筛选。
  </p>

  <!-- 行详情抽屉：对照 CloudTrail 事件详情（给出完整事件记录）与 GitHub 审核日志条目。
       表格放不下的字段（日志 ID、完整请求地址、耗时等）都在这里，不再只靠 title 属性。
       不展示后端字段原值（如 status 的数字、归属地的 `XX XX`）：那是开发者视角，
       使用者只需要「成功 / 失败」和「有没有可用地名」。 -->
  <el-drawer :model-value="!!detail" title="日志详情" size="460px" @close="detail = null">
    <template v-if="detail">
      <dl class="kv">
        <dt>时间</dt>
        <dd class="mono">{{ detail.operTime || '—' }}</dd>

        <dt>日志 ID</dt>
        <dd class="mono">{{ detail.operId || '—' }}</dd>

        <dt>{{ tab === 'operation' ? '操作人' : '账号' }}</dt>
        <dd>{{ detail.operName || '—' }}</dd>

        <template v-if="tab === 'operation'">
          <dt>模块</dt>
          <dd>{{ detail.title || '—' }}</dd>

          <dt>操作类型</dt>
          <dd>{{ btLabel(detail.businessType) || '—' }}</dd>

          <dt>请求方式</dt>
          <dd>{{ detail.requestMethod || '—' }}</dd>

          <dt>请求地址</dt>
          <dd class="mono break">{{ detail.operUrl || '—' }}</dd>

          <dt>耗时</dt>
          <dd>{{ detail.costTime ?? '—' }} ms</dd>
        </template>

        <dt>IP</dt>
        <dd class="mono">{{ detail.operIp || '—' }}</dd>

        <dt>归属地</dt>
        <dd>{{ locText(detail) }}</dd>

        <dt>结果</dt>
        <dd>
          <span class="badge" :class="detail.status === 0 ? 'badge-success' : 'badge-error'">
            {{ detail.status === 0 ? '成功' : '失败' }}
          </span>
        </dd>
      </dl>

      <div class="drawer-actions">
        <button class="btn btn-outline" @click="copyDetail">
          <ZkIcon name="file-text" :size="14" style="margin-right: 4px" />复制为 JSON
        </button>
      </div>
    </template>
  </el-drawer>
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

/**
 * 时间快捷选项。原先只有「最近 7/30/90 天」，排查当天事故时最常用的是「今天」——
 * 选 7 天等于把 6 天的无关记录也拉进来。CloudTrail 的预设粒度更细
 * （30 分钟 / 1 小时 / 12 小时 / 1 天），这里是教务场景，按天取更贴切。
 */
const dayStart = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

const DATE_SHORTCUTS = [
  { text: '今天', value: () => [dayStart(0), new Date()] },
  { text: '昨天', value: () => [dayStart(-1), dayStart(-1)] },
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
 * 数据新鲜度。日志是「最新在前」，不标时刻的话，用户看着一屏昨天的记录
 * 分不清是「这段时间真的没有新操作」还是「页面根本没重新查」。
 */
const loadedAt = ref('');
/**
 * 行详情抽屉。参照 GitHub 审核日志与 AWS CloudTrail 事件历史：两者都不把关键信息塞进
 * 单元格的 title 属性，而是点开看完整记录（CloudTrail 甚至给出 JSON 载荷）。
 * 我们只有 11 个字段，抽屉够用；用 title 属性时触屏设备根本看不到，长 URL 也读不全。
 */
const detail = ref<LogRowVo | null>(null);

/**
 * 并发响应只认最后一次。
 * 本页有三个入口会触发 load（切页签、改页码、点查询），后端一次 300ms~1s，
 * 手快时会同时挂两个请求；慢的那个后回来就会把新筛选的结果覆盖成旧口径 ——
 * 屏幕上页码是第 3 页、内容是第 1 页，且不报任何错。学情页踩过同一个坑。
 */
let reqSeq = 0;

const countText = computed(() => {
  if (loading.value) return '正在读取…';
  /**
   * 失败时说「暂无记录」是错的：total 被清成 0 只是因为我们放弃了这次读取，
   * 不代表库里没有记录。上方失败卡已经讲明原因，这里留空，别让两句话互相打架。
   */
  if (loadError.value) return '';
  if (!total.value) return '暂无记录';
  const from = (page.value - 1) * pageSize.value + 1;
  const to = Math.min(page.value * pageSize.value, total.value);
  return `第 ${from}–${to} 条 / 共 ${total.value} 条${loadedAt.value ? ` · 截至 ${loadedAt.value}` : ''}`;
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
    loadedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
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
 * 所以屏上显示「—」。不再用 title 解释原始值：那是给开发者看的，不是给使用者看的，
 * 使用者只需要知道「这里没有可用的地名」。（同一原因，抽屉里也不显示原始值。）
 */
function locText(r: LogRowVo) {
  const v = (r.operLocation || '').trim();
  if (!v || v === 'XX XX') return '—';
  return v;
}

/* ---------------- 时间显示 ---------------- */

/**
 * 相对时间。日志页的通行做法是「多久以前」与「精确时刻」**并置**（Datadog / Sentry /
 * CloudTrail 都如此）：排查时先用相对时间定位范围，写事故记录时再抄精确时刻。
 * 只给绝对时间要心算，只给相对时间又没法写进报告。
 */
function relTime(t: string) {
  if (!t) return '—';
  /** 后端给 `yyyy-MM-dd HH:mm:ss`。空格分隔的写法 Safari 解析为 Invalid Date，必须换成 T */
  const ms = Date.parse(t.replace(' ', 'T'));
  if (Number.isNaN(ms)) return t;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  /** 超过一周只说「几天前」没有意义，退化成日期 */
  return t.slice(5, 10);
}

/** 精确时刻：一周内只补时分秒（日期已由相对时间表达），超过一周给完整日期时间 */
function absTime(t: string) {
  if (!t) return '';
  const ms = Date.parse(t.replace(' ', 'T'));
  if (Number.isNaN(ms)) return '';
  return Date.now() - ms < 7 * 86_400_000 ? t.slice(11) : t;
}

/* ---------------- 点单元格直接筛选 ---------------- */

/**
 * 参照 CloudTrail「按属性筛选」和 GitHub 的 actor / action 限定符：最快的排查路径是从
 * 当前这一行钻进去，而不是回到上面重新手打一遍。
 *
 * ⚠️ 只能点后端真支持的参数，不能为了「看起来能点」做前端过滤：
 *   - 操作日志分支只认 title / operName / businessType / status / 时间窗，**没有 IP 参数**
 *     （`AdminAuditLogMapper.xml:33-52`）⇒ 操作人的 IP 不做成可点，否则筛完「共 N 条」
 *     是这一页的 N，与真实总数对不上，比不能点更误导。
 *   - 登录日志的 keyword 同时 like user_name 与 ipaddr（`:72-75`）⇒ 账号和 IP 都可点。
 */
function filterBy(kind: 'operName' | 'title' | 'keyword', value: string) {
  if (!value) return;
  keyword.value = '';
  moduleName.value = '';
  businessType.value = null;
  if (kind === 'operName') keyword.value = value;
  else if (kind === 'title') moduleName.value = value;
  else keyword.value = value;
  /** 保留结果与时间窗：从「失败」里点某个人，语义是「这个人的失败记录」 */
  page.value = 1;
  load();
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

/**
 * 复制为 JSON（对齐 CloudTrail 详情页给「事件记录」载荷的做法）。
 * 只复制**后端真实返回的字段**，不额外塞页面推导出来的东西（如相对时间），
 * 否则黏到工单里的东西和接口出参对不上，别人复核时会以为后端多了字段。
 * clipboard API 只在 https / localhost 可用，失败要明说，不能静默。
 */
async function copyDetail() {
  if (!detail.value) return;
  const json = JSON.stringify(detail.value, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    ElMessage.success('已复制这条日志的 JSON');
  } catch {
    ElMessage.warning('浏览器不允许写剪贴板（需 https 或 localhost），可在抽屉里手动选中复制');
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
/**
 * 给表格一个下限，让窄屏时由 .tbl-wrap 横向滚动，而不是把列压扁。
 * 实测（1600/1280/1100/900 四个宽度）：页面本身从不横向溢出（docScrollWidth == clientWidth），
 * 所以 .tbl-wrap 的 overflow-x:auto 一直没机会生效，表格被一路压缩 ——
 * 「操作内容」列在 1100px 只剩 131px、900px 只剩 46px，内容变成竖条无法阅读。
 * 六个固定列合计 672px，给弹性列留 368px ⇒ 1040px。
 */
.tbl {
  min-width: 1040px;
}
.mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}
.content-cell {
  color: var(--ink-700);
  word-break: break-all;
}
/* 整行可点开详情 ⇒ 必须给出可点的视觉信号，否则没人会去点 */
.log-row {
  cursor: pointer;
}
.log-row:hover {
  background: var(--bg-subtle);
}
.t-rel {
  font-weight: 500;
  color: var(--ink-700);
}
.t-abs {
  font-size: 11px;
  color: var(--ink-500);
  margin-top: 2px;
}
/* 单元格内的「点一下就按它筛」按钮：视觉上要像值本身，不能像按钮 */
.val-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--brand-700);
  cursor: pointer;
  text-align: left;
}
.val-link:hover {
  text-decoration: underline;
}
.val-badge {
  border: none;
  cursor: pointer;
  font: inherit;
}
.val-badge:hover {
  filter: brightness(0.96);
}
/* 详情抽屉的键值表 */
.kv {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px 14px;
  margin: 0;
  font-size: 13px;
  align-items: baseline;
}
.kv dt {
  color: var(--ink-500);
  font-size: 12px;
}
.kv dd {
  margin: 0;
  color: var(--ink-700);
  word-break: break-all;
}
.drawer-actions {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
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
