<script setup lang="ts">
/**
 * 师生资料聚合详情（G6 共享组件）
 * -----------------------------------------------------------------------------
 * `/admin/teachers` 与 `/admin/students` 两页共用这一个面板，差异靠 `mode` 区分：
 *   mode='teacher' → 基本资料可编辑（PUT /teachers/{id}/profile）
 *   mode='student' → **纯只读**（后端没有 PUT 端点，不许给编辑入口，否则用户点了必然 404）
 *
 * ★ 授课/选课记录必须按 `termCode` **分组**展示，不能平铺（会议口径：
 *   教师「勾选几个学期看过哪些课」、学生「几年上过哪些课」）。当前库里只有一个学期
 *   （`26-27-1`），但分组逻辑按任意学期数实现，补数据后自动生效。
 *
 * ★ 教师保存当前 100% 失败（后端 `biz_user_ext.user_role` 缺失，见 api/admin/profiles.ts 注释）。
 *   组件不隐藏保存按钮（那是掩耳盗铃），而是在失败时给出可读原因 + 顶部持久提示条，
 *   并明确「已报后端线」，避免用户反复点。
 */
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  updateTeacherProfile,
  type StudentProfile,
  type TeacherProfile,
  type TeacherTaughtCourse
} from '@/api/admin/profiles';

const props = defineProps<{
  mode: 'teacher' | 'student';
  userId: string;
  profile: TeacherProfile | StudentProfile | null;
  loading: boolean;
}>();
const emit = defineEmits<{ (e: 'saved'): void }>();

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
      enrollStatus: String(c.status ?? '')
    };
  });
});

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

/* ---------------- 教师编辑 ---------------- */
const editing = ref(false);
const saving = ref(false);
const editForm = reactive({ nickName: '', deptName: '', jobTitle: '', status: '0' });
/** 后端缺陷一旦命中就记住：顶部挂持久提示，避免用户反复点保存反复失败 */
const backendBroken = ref('');

function startEdit() {
  const p = tProfile.value;
  if (!p) return;
  editForm.nickName = p.nickName ?? '';
  editForm.deptName = p.deptName ?? '';
  editForm.jobTitle = p.jobTitle ?? '';
  editForm.status = String(p.status ?? '0');
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
}

async function submitEdit() {
  if (!editForm.nickName.trim()) {
    ElMessage.warning('昵称不能为空');
    return;
  }
  saving.value = true;
  try {
    await updateTeacherProfile(props.userId, {
      nickName: editForm.nickName.trim(),
      deptName: editForm.deptName.trim() || null,
      jobTitle: editForm.jobTitle.trim() || null,
      status: editForm.status
    });
    ElMessage.success('已保存');
    editing.value = false;
    backendBroken.value = '';
    emit('saved');
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (/user_role|doesn't have a default value/i.test(msg)) {
      backendBroken.value = '保存失败：后端更新教师资料的 SQL 没带 biz_user_ext.user_role（NOT NULL 无默认值），属后端缺陷，前端无法绕过。已记入回报，待后端修复后此按钮即可用。';
      ElMessage.error('保存失败：后端接口缺陷（user_role 缺失），详见面板顶部提示');
    } else {
      backendBroken.value = '';
      ElMessage.error(`保存失败：${msg.slice(0, 100) || '未知错误'}`);
    }
  } finally {
    saving.value = false;
  }
}
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
      <!-- 后端缺陷提示（命中过一次就一直显示，直到保存成功） -->
      <div v-if="backendBroken" class="banner-warn">
        <ZkIcon name="alert-triangle" :size="15" style="flex: none; margin-top: 1px" />
        <span>{{ backendBroken }}</span>
      </div>

      <!-- ① 基本信息 -->
      <section class="sec">
        <div class="sec-head">
          <span class="sec-title">基本信息</span>
          <template v-if="isTeacher">
            <template v-if="!editing">
              <el-button size="small" @click="startEdit">
                <ZkIcon name="pencil" :size="13" style="margin-right: 4px" />编辑
              </el-button>
            </template>
            <template v-else>
              <el-button size="small" :disabled="saving" @click="cancelEdit">取消</el-button>
              <el-button size="small" type="primary" :loading="saving" @click="submitEdit">保存</el-button>
            </template>
          </template>
          <!-- 学生只读：后端没有 PUT 端点。这里给一句说明而不是禁用按钮，
               免得用户以为"功能坏了"。 -->
          <span v-else class="small muted">学生资料本期只读（后端未提供编辑端点）</span>
        </div>

        <div v-if="!editing" class="kv-grid">
          <div class="kv"><span class="k">姓名</span><span class="v">{{ profile.nickName || '—' }}</span></div>
          <div class="kv"><span class="k">账号</span><span class="v mono">{{ profile.userName || '—' }}</span></div>
          <div v-if="isTeacher" class="kv"><span class="k">院系</span><span class="v">{{ tProfile?.deptName || '—' }}</span></div>
          <div v-if="isTeacher" class="kv"><span class="k">职称</span><span class="v">{{ tProfile?.jobTitle || '—' }}</span></div>
          <div v-if="!isTeacher" class="kv"><span class="k">班级</span><span class="v">{{ sProfile?.className || '未绑定班级' }}</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">{{ statusText(profile.status) }}</span></div>
        </div>

        <div v-else class="edit-grid">
          <div class="edit-item">
            <span class="k">姓名</span>
            <el-input v-model="editForm.nickName" maxlength="30" style="width: 180px" />
          </div>
          <div class="edit-item">
            <span class="k">院系</span>
            <el-input v-model="editForm.deptName" maxlength="50" placeholder="可留空" style="width: 200px" />
          </div>
          <div class="edit-item">
            <span class="k">职称</span>
            <el-input v-model="editForm.jobTitle" maxlength="32" placeholder="如 副教授" style="width: 180px" />
          </div>
          <div class="edit-item">
            <span class="k">状态</span>
            <el-select v-model="editForm.status" style="width: 120px">
              <el-option label="正常" value="0" />
              <el-option label="停用" value="1" />
            </el-select>
          </div>
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
      <section class="sec">
        <div class="sec-head">
          <span class="sec-title">{{ isTeacher ? '授课记录' : '选课记录' }}</span>
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

        <div v-if="!groupedCourses.length" class="small muted">
          {{ isTeacher ? '本学期还没有授课记录。' : '还没有选课记录。' }}
        </div>

        <div v-for="g in groupedCourses" :key="g.term" class="term-group">
          <div class="term-head">
            <ZkIcon name="calendar-days" :size="13" />
            <span class="term-name">{{ g.term }}</span>
            <span class="small muted">{{ g.list.length }} 门</span>
          </div>
          <div class="course-list">
            <div v-for="c in g.list" :key="c.key" class="course-item">
              <span class="course-name">{{ c.courseName }}</span>
              <span class="course-meta">
                <template v-if="c.enrollStatus">　<em class="st-tag">{{ COURSE_STATUS[c.enrollStatus] ?? c.enrollStatus }}</em></template>
                <template v-if="c.studentCount !== null">　{{ c.studentCount }} 人</template>
                <template v-if="c.weekCount">　·　{{ c.weekCount }} 周</template>
              </span>
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
}
.banner-warn {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 14px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #92400e;
  border-radius: var(--r-md, 8px);
  font-size: 12.5px;
  line-height: 1.7;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
.edit-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
}
.edit-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.edit-item .k {
  width: 40px;
  color: var(--ink-400, #9aa3b2);
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
.term-group + .term-group {
  margin-top: 12px;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--ink-500, #6b7280);
}
.term-name {
  font-weight: 700;
  font-size: 12.5px;
  color: var(--ink-700, #374151);
}
.course-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 19px;
}
.course-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.course-name {
  color: var(--ink-800, #1f2937);
}
.course-meta {
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
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
  color: var(--ink-400, #9aa3b2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-700, #374151);
}
</style>
