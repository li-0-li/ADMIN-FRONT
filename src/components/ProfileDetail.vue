<script setup lang="ts">
/**
 * 师生资料聚合详情（G6 共享组件）
 * -----------------------------------------------------------------------------
 * `/admin/teachers` 与 `/admin/students` 两页共用这一个面板，差异靠 `mode` 区分：
 *   mode='teacher' → 基本信息 + 可授课程 + 授课记录（按学期分组）
 *   mode='student' → 基本信息 + 选课记录（按入学年份分组）
 *
 * ★ 2026-11-20 改口径：**编辑不再走本组件的内联表单**。
 *   原来教师的「编辑」只调 `PUT /teachers/{id}/profile`，而后端该端点只取 `jobTitle`，
 *   姓名/院系/状态填了也被丢弃 —— 看着能编辑，实际只改得动职称；学生干脆没有入口。
 *   现在统一由父组件挂 `PeopleEditDialog`（走 `PUT /admin/users` + 可授课程差异同步），
 *   本组件只负责「展示」并在标题右侧发一个 `edit` 事件。
 *
 * ★ 授课/选课记录必须按 `termCode` **分组**展示，不能平铺（会议口径：
 *   教师「勾选几个学期看过哪些课」、学生「几年上过哪些课」）。当前库里只有一个学期
 *   （`26-27-1`），但分组逻辑按任意学期数实现，补数据后自动生效。
 */
import { computed, ref, watch } from 'vue';
import ZkIcon from '@/components/ZkIcon.vue';
import type { StudentProfile, TeacherProfile, TeacherTaughtCourse } from '@/api/admin/profiles';

const props = defineProps<{
  mode: 'teacher' | 'student';
  userId: string;
  profile: TeacherProfile | StudentProfile | null;
  loading: boolean;
  /** 有没有 `admin:users:edit`；没有就只展示，不给一个点了报 403 的按钮 */
  canEdit?: boolean;
}>();
const emit = defineEmits<{ (e: 'saved'): void; (e: 'edit'): void }>();


const isTeacher = computed(() => props.mode === 'teacher');
const tProfile = computed(() => (props.mode === 'teacher' ? (props.profile as TeacherProfile | null) : null));
const sProfile = computed(() => (props.mode === 'student' ? (props.profile as StudentProfile | null) : null));

const STATUS_LABEL: Record<string, string> = { '0': '正常', '1': '停用' };
function statusText(s?: string | null) {
  if (s === undefined || s === null || s === '') return '—';
  return STATUS_LABEL[String(s)] ?? String(s);
}

/* ---------------- 学期分组 ---------------- */
const termFilter = ref('');

/** 授课记录（教师）/ 选课记录（学生）统一成同一种形状，分组逻辑只写一份 */
interface CourseRow {
  key: string;
  courseName: string;
  /** 分组键：教师 = 学期代码 `26-27-1`；学生 = 入学年份 `2026 年`（后端没给 termCode） */
  termCode: string;
  studentCount?: number | null;
  weekCount?: number | null;
  /** 学生选课的报名状态（enrolled 等）；教师记录没有这个字段 */
  enrollStatus?: string;
  /** 学生选课时间（后端 `enrollTime` 是完整时间戳，表格里只取日期） */
  enrollTime?: string;
}
const COURSE_STATUS: Record<string, string> = { enrolled: '已选课', dropped: '已退课', completed: '已完成' };
const courseRows = computed<CourseRow[]>(() => {
  if (isTeacher.value) {
    return (tProfile.value?.taughtCourses ?? []).map((c: TeacherTaughtCourse, i) => ({
      key: String(c.offeringId ?? c.courseId ?? i),
      courseName: c.courseName || c.courseId || '（未命名课程）',
      termCode: (c.termCode ?? '').trim(),
      studentCount: c.studentCount ?? null,
      weekCount: c.weekCount ?? null
    }));
  }
  // 学生：enrolledCourses 实测字段是 { courseId, courseName, enrollTime, status } —— **没有 termCode**，
  // 所以按 enrollTime 的年份分组（会议口径要的是"几年上过哪些课"，年份正好对得上）
  const list = (sProfile.value?.enrolledCourses ?? []) as Record<string, unknown>[];
  return list.map((c, i) => {
    const enrollTime = String(c.enrollTime ?? '');
    const year = enrollTime.slice(0, 4);
    return {
      key: String(c.offeringId ?? c.courseId ?? i),
      courseName: String(c.courseName ?? c.courseId ?? '（未命名课程）'),
      termCode: year ? `${year} 年` : '',
      studentCount: (c.studentCount as number) ?? null,
      weekCount: (c.weekCount as number) ?? null,
      enrollStatus: String(c.status ?? ''),
      enrollTime: enrollTime ? enrollTime.slice(0, 10) : ''
    };
  });
});

/* ---------------- 记录表的展示口径 ---------------- */
/** 周数列只在真有数据时出现：库里 weekCount 基本都是 null，硬留一列「—」比不长更难看 */
const hasWeek = computed(() => courseRows.value.some((r) => r.weekCount !== null && r.weekCount !== undefined));
/** 教师记录里的学生数合计（真实数据求和，不是编的） */
const totalStudents = computed(() =>
  isTeacher.value ? courseRows.value.reduce((s, r) => s + (r.studentCount ?? 0), 0) : 0
);
/** 表格列模板：教师(有周数)=课程/周数/学生；教师(无周数)=课程/学生；学生=课程/选课时间/状态 */
const recBoxClass = computed(() => ({
  'rec-3col': isTeacher.value && hasWeek.value,
  'rec-stu': !isTeacher.value
}));

const termOptions = computed(() => {
  const set = new Set<string>();
  for (const r of courseRows.value) if (r.termCode) set.add(r.termCode);
  return [...set].sort((a, b) => b.localeCompare(a));
});

/** 按学期分组（termFilter 为空 = 全部学期）；组内保持后端原顺序 */
const groupedCourses = computed(() => {
  const rows = courseRows.value.filter((r) => !termFilter.value || r.termCode === termFilter.value);
  const map = new Map<string, CourseRow[]>();
  for (const r of rows) {
    const k = r.termCode || '未标学期';
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([term, list]) => ({ term, list }));
});

// 切人时把学期筛选复位，否则上一个人的学期条件会挡住新人的记录
watch(() => props.userId, () => { termFilter.value = ''; });
</script>

<template>
  <div class="profile-panel">
    <el-skeleton v-if="loading" :rows="6" animated />

    <template v-else-if="!profile">
      <div class="empty-block">
        <ZkIcon :name="isTeacher ? 'graduation-cap' : 'user'" :size="26" />
        <div class="empty-title">{{ isTeacher ? '从左侧选择一位教师' : '从左侧选择一位学生' }}</div>
        <div class="small muted">选中后这里显示资料、可授课程与授课记录。</div>
      </div>
    </template>

    <template v-else>
      <!-- ① 基本信息 -->
      <section class="sec">
        <div class="sec-head">
          <span class="sec-title">基本信息</span>
          <el-button v-if="props.canEdit" size="small" @click="emit('edit')">
            <ZkIcon name="pencil" :size="13" style="margin-right: 4px" />编辑资料
          </el-button>
          <span v-else class="small muted">无编辑权限</span>
        </div>

        <div class="kv-grid">
          <div class="kv"><span class="k">姓名</span><span class="v">{{ profile.nickName || '—' }}</span></div>
          <div class="kv"><span class="k">账号</span><span class="v mono">{{ profile.userName || '—' }}</span></div>
          <div v-if="isTeacher" class="kv"><span class="k">院系</span><span class="v">{{ tProfile?.deptName || '—' }}</span></div>
          <div v-if="isTeacher" class="kv"><span class="k">职称</span><span class="v">{{ tProfile?.jobTitle || '—' }}</span></div>
          <div v-if="!isTeacher" class="kv"><span class="k">班级</span><span class="v">{{ sProfile?.className || '未绑定班级' }}</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">{{ statusText(profile.status) }}</span></div>
        </div>
      </section>

      <!-- ② 教师可授课程 -->
      <section v-if="isTeacher" class="sec">
        <div class="sec-head"><span class="sec-title">可授课程</span></div>
        <div v-if="(tProfile?.capabilities ?? []).length" class="chip-list">
          <span v-for="(c, i) in tProfile?.capabilities ?? []" :key="i" class="chip">
            {{ (c as Record<string, unknown>).courseName ?? (c as Record<string, unknown>).name ?? '—' }}
          </span>
        </div>
        <div v-else class="small muted">还没有登记可授课程（接口返回空数组）。</div>
      </section>

      <!-- ③ 授课 / 选课记录（按学期分组） -->
      <section class="sec sec-rec">
        <div class="sec-head">
          <span class="sec-title">{{ isTeacher ? '授课记录' : '选课记录' }}</span>
          <div class="sec-tools">
            <span v-if="courseRows.length" class="small muted">
              {{ courseRows.length }} 门<template v-if="totalStudents"> · {{ totalStudents }} 名学生</template>
            </span>
            <el-select
              v-if="termOptions.length"
              v-model="termFilter"
              :placeholder="isTeacher ? '全部学期' : '全部年份'"
              clearable
              size="small"
              style="width: 150px"
            >
              <el-option v-for="t in termOptions" :key="t" :label="t" :value="t" />
            </el-select>
          </div>
        </div>

        <!-- 记录区做成占满剩余高度的表格：字段横向铺开（原来一列小字贴在左边，
             右边 700 多像素全空），不足一屏时由「已显示全部」收尾，不再是一片裸白 -->
        <div class="rec-box" :class="recBoxClass">
          <div class="rec-head">
            <span>{{ isTeacher ? '课程' : '课程' }}</span>
            <span v-if="isTeacher && hasWeek" class="num">周数</span>
            <span v-if="isTeacher" class="num">学生</span>
            <template v-else>
              <span class="num">选课时间</span>
              <span class="num">状态</span>
            </template>
          </div>

          <div class="rec-body">
            <template v-if="groupedCourses.length">
              <div v-for="g in groupedCourses" :key="g.term" class="rec-group">
                <div class="rec-group-head">
                  <ZkIcon name="calendar-days" :size="13" />
                  <span class="term-name">{{ g.term }}</span>
                  <span class="small muted">{{ g.list.length }} 门</span>
                </div>
                <div v-for="c in g.list" :key="c.key" class="rec-row">
                  <span class="rec-course" :title="c.courseName">{{ c.courseName }}</span>
                  <template v-if="isTeacher">
                    <span v-if="hasWeek" class="num muted">{{ c.weekCount ? `${c.weekCount} 周` : '—' }}</span>
                    <span class="num">{{ c.studentCount === null || c.studentCount === undefined ? '—' : `${c.studentCount} 人` }}</span>
                  </template>
                  <template v-else>
                    <span class="num muted">{{ c.enrollTime || '—' }}</span>
                    <span class="num">
                      <em v-if="c.enrollStatus" class="st-tag">{{ COURSE_STATUS[c.enrollStatus] ?? c.enrollStatus }}</em>
                      <span v-else class="muted">—</span>
                    </span>
                  </template>
                </div>
              </div>
              <div class="rec-end">已显示全部 {{ courseRows.length }} 条记录</div>
            </template>

            <div v-else class="rec-empty">
              <ZkIcon name="calendar-days" :size="22" />
              <span>{{ termFilter ? '该学期没有记录，清掉上方筛选看全部' : (isTeacher ? '还没有授课记录' : '还没有选课记录') }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.profile-panel {
  min-height: 240px;
  /* 外层详情卡已与左列表等高 ⇒ 这里撑满剩余高度：内容不足时的留白落在卡内（有边框收口），
     flex-shrink:0 保证内容超长时不被压扁，而是交给卡自身的滚动条。 */
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}
.sec {
  padding: 4px 0 14px;
  border-bottom: 1px dashed var(--border, #eef0f4);
  margin-bottom: 14px;
}
.sec:last-child {
  border-bottom: none;
  margin-bottom: 0;
}
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
.kv-grid {
  display: grid;
  /* 原来固定 2 列 ⇒ 卡片有 1000+ 像素宽时，「姓名」和「账号」之间被拉开 500 像素空白。
     改成按可用宽度自动铺列：字段「标签+值」始终贴在一起，整行铺满，不再有大段横向留白。 */
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 8px 20px;
}
.kv {
  display: flex;
  gap: 10px;
  font-size: 13px;
}
.kv .k {
  width: 52px;
  flex: none;
  color: var(--ink-400, #9aa3b2);
}
.kv .v {
  color: var(--ink-800, #1f2937);
}
.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--brand-50, #eef2ff);
  color: var(--brand-700, #4338ca);
  font-size: 12px;
}
/* ---------------- 记录表 ---------------- */
/* 撑满卡片剩余高度：表格框一直画到卡片底，视觉上「这块是记录列表」，
   而不是内容结束后剩一大片裸白 */
.sec-rec {
  flex: 1;
  min-height: 190px;
  display: flex;
  flex-direction: column;
  padding-bottom: 0;
}
.sec-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rec-box {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, #e8ecf2);
  border-radius: var(--r-md, 10px);
  overflow: hidden;
  background: #fff;
  /* 列模板：教师(有周数)=课程/周数/学生；教师(无周数)=课程/学生；学生=课程/选课时间/状态 */
  --rec-cols: 1fr 96px;
}
.rec-box.rec-3col {
  --rec-cols: 1fr 92px 96px;
}
.rec-box.rec-stu {
  --rec-cols: 1fr 130px 90px;
}
.rec-head {
  display: grid;
  grid-template-columns: var(--rec-cols);
  gap: 12px;
  padding: 8px 12px;
  background: var(--bg-soft, #f7f9fc);
  border-bottom: 1px solid var(--border, #e8ecf2);
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
.rec-head .num {
  text-align: right;
}
.rec-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.rec-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  background: #fbfcfe;
  border-bottom: 1px dashed var(--border, #eef0f4);
  color: var(--ink-500, #6b7280);
}
.rec-row {
  display: grid;
  grid-template-columns: var(--rec-cols);
  gap: 12px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid #f1f4f9;
  font-size: 13px;
}
.rec-row:hover {
  background: var(--ink-50, #f8fafc);
}
.rec-course {
  color: var(--ink-800, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rec-row .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 记录不足一屏时收尾：把「已显示全部」居中放在剩余空白里，让空白成为空态的一部分 */
.rec-end {
  margin: auto 0;
  padding: 14px 12px 18px;
  text-align: center;
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
.rec-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  font-size: 12.5px;
  color: var(--ink-400, #9aa3b2);
}
.term-name {
  font-weight: 700;
  font-size: 12.5px;
  color: var(--ink-700, #374151);
}
.st-tag {
  font-style: normal;
  padding: 0 6px;
  border-radius: 999px;
  background: #ecfdf5;
  color: #047857;
  font-size: 11px;
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 16px;
  /* 没选中人时垂直居中，而不是贴在卡片顶部留一大片空 */
  margin: auto 0;
  color: var(--ink-400, #9aa3b2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #374151);
}
</style>
