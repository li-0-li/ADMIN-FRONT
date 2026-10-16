<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';

/**
 * 资源预览页（对应原型 pc/resource-preview.html）。
 *
 * 为什么要有这一页：后端 `previewUrl` 返回的是**相对路径**。
 * 若直接 window.open()，浏览器会把它拼到前端自己的域名上 → 命中 SPA fallback
 * → 返回 index.html → 路由守卫发现已登录 → 跳 /admin/dashboard。
 * 表现就是"点预览跳到了后台管理页"。所以预览必须在应用内自己渲染。
 *
 * ★ 渲染方式必须由**响应回来的真实 Content-Type** 决定，不能只看素材类型：
 *   .xlsx 这类格式浏览器无法内联渲染（会转成下载），按类型塞进 iframe 只会得到一块空白。
 *
 * 入参全部走 query（不依赖列表页内存状态，刷新/分享链接都能复现）。
 */

const route = useRoute();
const router = useRouter();

const type = computed(() => String(route.query.type ?? 'doc'));
const title = computed(() => String(route.query.title ?? '未命名资源'));
const sub = computed(() => String(route.query.sub ?? ''));
/** 后端给的原始地址（保持原样展示，便于排查） */
const rawUrl = computed(() => String(route.query.url ?? ''));

/** 相对路径必须以**当前站点**为基解析，否则会被 SPA 路由当成页面吃掉 */
const absoluteUrl = computed(() => {
  if (!rawUrl.value) return '';
  try {
    return new URL(rawUrl.value, window.location.origin).href;
  } catch {
    return rawUrl.value;
  }
});

/** 下载时用的文件名（从地址末段取，解码 %XX） */
const downloadName = computed(() => {
  const seg = rawUrl.value.split('/').pop() || 'download';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
});

const TYPE_META: Record<string, { icon: string; label: string }> = {
  video: { icon: 'video', label: '视频' },
  doc: { icon: 'file-text', label: '文档' },
  table: { icon: 'table', label: '表格' },
  image: { icon: 'image', label: '图片' },
  quiz: { icon: 'list-checks', label: '题库' }
};
const meta = computed(() => TYPE_META[type.value] ?? { icon: 'file-text', label: '资源' });

/* ---------------- 可用性探测 ---------------- */

type ProbeState = 'checking' | 'ok' | 'fail';
const probe = ref<ProbeState>('checking');
const httpStatus = ref<number | null>(null);
const contentType = ref('');
const backendMsg = ref('');
const textBody = ref('');

/**
 * 用**不带令牌**的请求探测。
 * <video> / <iframe> 这类内联标签本身就带不上 Authorization 头，
 * 所以"能不能在页面里放出来"只能以无令牌请求的结论为准。
 */
async function runProbe() {
  if (!rawUrl.value) {
    probe.value = 'fail';
    backendMsg.value = '后端未返回预览地址（play_url 与 file_url 均为空）';
    return;
  }
  probe.value = 'checking';
  httpStatus.value = null;
  contentType.value = '';
  backendMsg.value = '';
  textBody.value = '';
  try {
    const res = await fetch(absoluteUrl.value, { headers: { Accept: '*/*' } });
    httpStatus.value = res.status;
    const ct = res.headers.get('content-type') ?? '';
    contentType.value = ct;
    const lower = ct.toLowerCase();
    if (lower.includes('json')) {
      const body = (await res.json().catch(() => null)) as { msg?: string; message?: string } | null;
      backendMsg.value = String(body?.msg ?? body?.message ?? '');
    } else if (lower.startsWith('text/')) {
      textBody.value = (await res.text().catch(() => '')).slice(0, 20000);
    } else if (!res.ok) {
      backendMsg.value = `HTTP ${res.status}`;
    }
    // 只有"请求成功 + 不是 JSON + 不是 HTML"才算真拿到了文件
    probe.value = res.ok && !lower.includes('json') && !lower.includes('html') ? 'ok' : 'fail';
  } catch (e) {
    probe.value = 'fail';
    backendMsg.value = e instanceof Error ? e.message : String(e);
  }
}

/** 按真实 Content-Type 决定内联渲染方式；浏览器放不了的返回 unsupported（改为下载） */
const renderKind = computed(() => {
  const ct = contentType.value.toLowerCase();
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('image/')) return 'image';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.startsWith('text/')) return 'text';
  return 'unsupported';
});

/** 不支持内联预览时的说明 */
const unsupportedHint = computed(() => {
  const ext = (downloadName.value.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') return 'Excel 工作簿（.xlsx/.xls）浏览器不能内联渲染，请下载后用 Excel / WPS 打开。';
  if (ext === 'docx' || ext === 'doc') return 'Word 文档（.docx/.doc）浏览器不能内联渲染，请下载后打开。';
  if (!ext) return `该格式（${contentType.value || '未知'}）不支持在浏览器内预览。`;
  return `该格式（.${ext}）不支持在浏览器内预览，请下载后打开。`;
});

/** 把后端原始报错翻成人话，并指向真正的责任方（不掩盖、不猜） */
const failReason = computed(() => {
  const m = backendMsg.value;
  if (!m) return '请求未返回可用的文件内容。';
  if (/No static resource/i.test(m)) {
    return '后端没有为这个路径提供静态资源：若依只映射 /profile/**（=D:/ruoyi/uploadPath/），没有映射该前缀。需后端补映射或改用正确前缀。';
  }
  if (httpStatus.value === 401 || /认证失败|Unauthorized/.test(m)) {
    return '该路径需要登录令牌才能访问，而 video / iframe 这类内联标签无法携带 Authorization 头。';
  }
  if (httpStatus.value === 404) return '后端未找到该文件。';
  return m;
});

/* ---------------- 操作 ---------------- */

function goBack() {
  if (window.history.length > 1) router.back();
  else router.push('/admin/review');
}

function openInNewTab() {
  if (absoluteUrl.value) window.open(absoluteUrl.value, '_blank', 'noopener');
}

function download() {
  if (!absoluteUrl.value) return;
  const a = document.createElement('a');
  a.href = absoluteUrl.value;
  a.download = downloadName.value;
  document.body.appendChild(a);
  a.click();
  a.remove();
  ElMessage.success(`已开始下载 ${downloadName.value}`);
}

async function copyUrl() {
  if (!rawUrl.value) return;
  try {
    await navigator.clipboard.writeText(rawUrl.value);
    ElMessage.success('原始地址已复制');
  } catch {
    ElMessage.warning('复制失败，请手动选中下方地址复制');
  }
}

onMounted(runProbe);
// 同页切换素材（query 变化）时重新探测
watch(() => route.query.url, () => runProbe());
</script>

<template>
  <div class="rp">
    <header class="rp-top">
      <span class="rp-back" @click="goBack"><ZkIcon name="chevron-left" :size="16" />返回</span>
      <span class="badge badge-info"><ZkIcon :name="meta.icon" :size="13" />{{ meta.label }}</span>
      <span class="rp-title">{{ title }}</span>
      <span v-if="sub" class="rp-sub">{{ sub }}</span>
      <div class="rp-actions">
        <button class="btn btn-outline btn-sm" :disabled="!absoluteUrl" @click="download">
          <ZkIcon name="download" :size="14" />下载
        </button>
        <button class="btn btn-outline btn-sm" @click="copyUrl"><ZkIcon name="copy" :size="14" />复制地址</button>
        <button class="btn btn-outline btn-sm" :disabled="!absoluteUrl" @click="openInNewTab">
          <ZkIcon name="external-link" :size="14" />新窗口打开
        </button>
      </div>
    </header>

    <div class="rp-stage">
      <!-- 探测中 -->
      <div v-if="probe === 'checking'" class="card card-pad rp-center">
        <div class="muted small">正在读取资源…</div>
      </div>

      <!-- 拿到真文件：按真实 Content-Type 内联渲染 -->
      <template v-else-if="probe === 'ok'">
        <video v-if="renderKind === 'video'" class="rp-media rp-video" :src="absoluteUrl" controls autoplay playsinline />
        <audio v-else-if="renderKind === 'audio'" class="rp-media" :src="absoluteUrl" controls />
        <img v-else-if="renderKind === 'image'" class="rp-media" :src="absoluteUrl" :alt="title" />
        <iframe v-else-if="renderKind === 'pdf'" class="rp-media rp-frame" :src="absoluteUrl" :title="title" />
        <pre v-else-if="renderKind === 'text'" class="rp-media rp-text">{{ textBody }}</pre>

        <!-- 浏览器放不了的格式：不摆空白 iframe，直接给下载 -->
        <div v-else class="card card-pad">
          <div class="row" style="align-items: flex-start">
            <span class="icon-box"><ZkIcon :name="meta.icon" :size="20" /></span>
            <div style="flex: 1">
              <div class="rp-fail-title">{{ title }}</div>
              <div class="small" style="color: var(--ink-600); margin-top: 6px">{{ unsupportedHint }}</div>
              <div class="small muted mt8">
                Content-Type：<span class="mono">{{ contentType }}</span>
              </div>
            </div>
          </div>
          <div class="row mt16" style="justify-content: flex-end; gap: 10px">
            <button class="btn btn-outline" @click="copyUrl">复制地址</button>
            <button class="btn btn-primary" @click="download"><ZkIcon name="download" :size="14" />下载文件</button>
          </div>
        </div>
      </template>

      <!-- 拿不到：如实说明 + 给出可执行的下一步 -->
      <div v-else class="card card-pad rp-fail">
        <div class="row" style="align-items: flex-start">
          <span class="icon-box" style="background: var(--warning-soft); color: var(--warning)">
            <ZkIcon name="alert-triangle" :size="20" />
          </span>
          <div style="flex: 1">
            <div class="rp-fail-title">资源暂不可用</div>
            <div class="small" style="color: var(--ink-600); margin-top: 6px">{{ failReason }}</div>
          </div>
        </div>

        <table class="tbl mt16">
          <tbody>
            <tr>
              <td style="width: 132px; color: var(--ink-500)">后端返回的地址</td>
              <td><span class="mono">{{ rawUrl || '（空）' }}</span></td>
            </tr>
            <tr>
              <td style="color: var(--ink-500)">实际请求地址</td>
              <td><span class="mono">{{ absoluteUrl || '（空）' }}</span></td>
            </tr>
            <tr>
              <td style="color: var(--ink-500)">HTTP 状态</td>
              <td>{{ httpStatus ?? '—' }}</td>
            </tr>
            <tr>
              <td style="color: var(--ink-500)">Content-Type</td>
              <td><span class="mono">{{ contentType || '—' }}</span></td>
            </tr>
            <tr>
              <td style="color: var(--ink-500)">后端消息</td>
              <td>{{ backendMsg || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="row mt16" style="justify-content: flex-end; gap: 10px">
          <button class="btn btn-outline" @click="copyUrl">复制地址</button>
          <button class="btn btn-primary" @click="runProbe"><ZkIcon name="refresh-cw" :size="14" />重试</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 视觉沿用原型 pc/resource-preview.html 的 rp-* 记号（theme.css 里没有这些类） */
.rp {
  min-height: 100vh;
  background: var(--bg-subtle);
  font-family: var(--font-sans);
}

.rp-top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 22px;
  background: #fff;
  border-bottom: 1px solid var(--border);
}

.rp-back {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-600);
  font-weight: 600;
  font-size: 14px;
}

.rp-back:hover {
  color: var(--brand-700);
}

.rp-title {
  font-weight: 700;
  font-size: 16px;
}

.rp-sub {
  color: var(--ink-400);
  font-size: 12.5px;
}

.rp-actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
}

.rp-stage {
  max-width: 920px;
  margin: 26px auto;
  padding: 0 16px;
}

.rp-center {
  text-align: center;
}

.rp-media {
  display: block;
  width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.rp-video {
  aspect-ratio: 16 / 9;
  background: #0f172a;
}

.rp-frame {
  height: 620px;
}

.rp-text {
  margin: 0;
  padding: 18px 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-700);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 620px;
}

.rp-fail-title {
  font-weight: 700;
  font-size: 15px;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  word-break: break-all;
}
</style>
