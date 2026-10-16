<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { getDashboardSummary, listCourses } from '@/api/admin/dashboard';
import type { DashboardSummary } from '@/types/admin';
import { ADMIN_MENUS } from '@/config/menu';

const router = useRouter();

const summary = ref<DashboardSummary | null>(null);
const courses = ref<Record<string, unknown>[]>([]);
const loading = ref(true);

/** 快捷入口：取菜单里的 8 项（与原型快捷入口的 8 个按钮一致） */
const SHORTCUT_PATHS = [
  '/admin/accounts',
  '/admin/ai',
  '/admin/review',
  '/admin/analytics',
  '/admin/patrol',
  '/admin/basicdata',
  '/admin/monitor',
  '/admin/logs',
  '/admin/config'
];
const shortcuts = ADMIN_MENUS.filter(m => SHORTCUT_PATHS.includes(m.path));

const STATS = [
  { key: 'totalCourses', label: '总课程', icon: 'database' },
  { key: 'activeStudents', label: '在教学生', icon: 'users' },
  { key: 'teacherCount', label: '教师数', icon: 'presentation' },
  { key: 'pendingHomework', label: '待批改作业', icon: 'list-checks' }
] as const;

function statValue(key: string) {
  const v = summary.value?.[key as keyof DashboardSummary];
  return v === undefined || v === null ? '—' : String(v);
}

/** 课程状态枚举 → 中文（实测后端取值：active / archived / certifying） */
const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'badge-info' },
  certifying: { label: '认证中', cls: 'badge-warning' },
  archived: { label: '已归档', cls: 'badge-neutral' },
  pending: { label: '待发布', cls: 'badge-neutral' },
  closed: { label: '已结课', cls: 'badge-neutral' },
  draft: { label: '草稿', cls: 'badge-neutral' }
};

function statusOf(row: Record<string, unknown>) {
  const key = String(row.status ?? '');
  return STATUS_TEXT[key] ?? { label: key || '—', cls: 'badge-neutral' };
}

onMounted(async () => {
  // ★ 两个请求**各自兜底**，绝不用 Promise.all 绑死 —— 此前 courses 打死路径把 summary
  //   连坐成整个 Promise.all reject ⇒ 四张统计卡全「—」+ 每次登录控制台报错。
  try {
    summary.value = await getDashboardSummary();
  } catch {
    /* 已在请求层提示，卡片保持「—」 */
  }
  try {
    const c = await listCourses({ page: 1, pageSize: 5 });
    courses.value = c?.list ?? [];
  } catch {
    courses.value = [];
  }
  loading.value = false;
});
</script>

<template>
  <div class="page-head">
    <h1>后台管理</h1>
    <div class="actions">
      <a class="btn btn-outline" href="javascript:void(0)" @click="router.push('/admin/schedule')">
        <ZkIcon name="calendar-days" :size="16" />智能排课
      </a>
    </div>
  </div>

  <div class="grid g4">
    <div v-for="s in STATS" :key="s.key" class="card stat">
      <div class="label">{{ s.label }}</div>
      <div class="num">
        <span v-if="loading">…</span>
        <span v-else>{{ statValue(s.key) }}</span>
      </div>
    </div>
  </div>

  <div class="grid mt16" style="grid-template-columns: 2fr 1fr">
    <div class="card">
      <div class="card-pad" style="padding-bottom: 0">
        <div class="card-title">最近课程</div>
      </div>
      <table class="tbl">
        <thead>
          <tr><th>课程</th><th>教师</th><th>状态</th><th>学生数</th></tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="4" class="muted">加载中…</td></tr>
          <tr v-else-if="courses.length === 0">
            <td colspan="4" class="muted">没有课程数据</td>
          </tr>
          <tr v-for="c in courses" v-else :key="String(c.courseId)">
            <td>{{ c.courseName ?? '—' }}</td>
            <td>{{ c.teacherName ?? '—' }}</td>
            <td><span class="badge" :class="statusOf(c).cls">{{ statusOf(c).label }}</span></td>
            <td>{{ c.studentCount ?? 0 }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card card-pad">
      <div class="card-title">快捷入口</div>
      <div class="stack" style="gap: 10px">
        <a
          v-for="m in shortcuts"
          :key="m.path"
          class="btn btn-outline btn-block"
          href="javascript:void(0)"
          style="justify-content: flex-start"
          @click="router.push(m.path)"
        >
          <ZkIcon :name="m.icon" :size="16" />{{ m.title }}
        </a>
      </div>
    </div>
  </div>
</template>
