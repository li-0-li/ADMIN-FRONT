<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  checkCourseNo,
  checkJoinCode,
  createCourse,
  createOffering,
  nextCourseNo
} from '@/api/admin/courses';
import type { CourseCreateBo } from '@/api/admin/courses';
import { autoArrange } from '@/api/admin/schedules';
import { listClasses, listTerms } from '@/api/admin/basicdata';
import { listUsers } from '@/api/admin/users';
import type { Clazz, Term } from '@/types/admin';
import type { AdminUserVo } from '@/types/admin';

/**
 * 两步建课向导（T-01 · 2026-11-06）
 * ============================================================================
 * step1 基础信息（建课第一步 POST /courses）→ step2 开课信息（建课第二步 POST /offerings）。
 * ★ 两步【各自独立提交】：step1 成功后课程已存在，可以直接关窗
 *   （详情抽屉里随时能再开课）；step2 失败不回滚 step1。
 *
 * - courseNo：「自动生成」按钮调 check-no?mode=next（KC+6 位）；失焦预检 40901
 *   时红字提示并保留输入（request 层 silent，提示由本组件画）。
 * - 同名课只警告不阻断：出参 duplicateName=true 时弹一条可关闭的提示。
 * - step2：term 下拉（GET /terms）、教师下拉（GET /users?roleKey=teacher）、
 *   班级多选（GET /classes）、joinCode 可空（自动 JM+6 位，手填失焦预检）、
 *   weekCount 默认 18（1~30，校验在后端）。
 */

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
  /** 传入时直接从 step2 开始（详情抽屉「为这门课开课」入口） */
  startCourse?: { courseId: string; courseName: string } | null;
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  /** step1 或 step2 成功后触发（父页面刷新列表） */
  (e: 'created'): void;
}>();

const visible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v)
});

/* ================= 步骤状态 ================= */

const step = ref<1 | 2>(1);
/** step1 成功后持有的课程（step2 的归属）；courseNo 可空 —— 外部入口（详情抽屉）只有 id+名称 */
const created = ref<{ courseId: string; courseName: string; courseNo?: string } | null>(null);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    if (props.startCourse) {
      created.value = { ...props.startCourse };
      step.value = 2;
    } else {
      created.value = null;
      step.value = 1;
    }
    courseNoError.value = '';
    joinCodeError.value = '';
  }
);

/* ================= step1：基础课程 ================= */

const COURSE_NO_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const COURSE_TYPE_LABEL: Record<string, string> = {
  required: '必修',
  elective: '选修',
  core: '专业核心',
  public: '公共基础',
  practice: '实验实践',
  general: '通识选修'
};

const baseForm = reactive<CourseCreateBo>({
  courseNo: '',
  courseName: '',
  major: '',
  credit: null,
  hours: null,
  courseType: '',
  description: ''
});
const baseSaving = ref(false);
const noGenerating = ref(false);
const noChecking = ref(false);
/** 编号预检失败红字（40901 / 格式）；空串 = 无错误。★ 失败保输入，不清字段 */
const courseNoError = ref('');
const baseFormRef = ref();

const baseRules = {
  courseNo: [
    { required: true, message: '课程编号不能为空', trigger: 'blur' },
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
        if (!v || COURSE_NO_RE.test(v.trim().toUpperCase())) cb();
        else cb(new Error('2~20 位大写字母/数字/连字符，且以字母或数字开头'));
      },
      trigger: 'blur'
    }
  ],
  courseName: [
    { required: true, message: '课程名称不能为空', trigger: 'blur' },
    { max: 100, message: '课程名称不能超过 100 字', trigger: 'blur' }
  ]
};

/** 自动取号：KC + 6 位流水（后端跳过手工占用的号；取到后仍会失焦预检占位是否被抢） */
async function onGenerateNo() {
  noGenerating.value = true;
  try {
    const res = await nextCourseNo();
    baseForm.courseNo = res.courseNo;
    courseNoError.value = '';
  } catch {
    /* silent 请求：失败红字提示，不打断手填 */
    courseNoError.value = '取号失败，请手填编号';
  } finally {
    noGenerating.value = false;
  }
}

/** 失焦预检：撞 40901 / 格式不对时红字保输入（规格 §5.8 同款） */
async function onNoBlur() {
  const no = baseForm.courseNo.trim().toUpperCase();
  if (!no) {
    courseNoError.value = '';
    return;
  }
  if (!COURSE_NO_RE.test(no)) {
    courseNoError.value = '编号格式：2~20 位大写字母/数字/连字符，以字母或数字开头';
    return;
  }
  noChecking.value = true;
  try {
    const res = await checkCourseNo('0', no);
    courseNoError.value = res.available ? '' : `编号 ${no} 已被占用，请更换或重新取号`;
  } catch {
    courseNoError.value = '';
    /* 预检接口挂了不阻断提交：落库还有唯一键双保险，撞键由后端 40901 提示 */
  } finally {
    noChecking.value = false;
  }
}

async function submitBase() {
  try {
    await baseFormRef.value?.validate();
  } catch {
    return;
  }
  if (courseNoError.value) {
    ElMessage.warning('请先解决课程编号的问题再提交');
    return;
  }
  baseSaving.value = true;
  try {
    const res = await createCourse({
      ...baseForm,
      courseNo: baseForm.courseNo.trim().toUpperCase(),
      courseName: baseForm.courseName.trim(),
      major: baseForm.major?.trim() || undefined,
      courseType: baseForm.courseType || undefined,
      description: baseForm.description?.trim() || undefined
    });
    created.value = { courseId: res.courseId, courseName: baseForm.courseName.trim(), courseNo: res.courseNo };
    step.value = 2;
    if (res.duplicateName) {
      ElMessage.warning(`基础课程已创建，但同校已有同名课程「${baseForm.courseName.trim()}」，请留意区分`);
    } else {
      ElMessage.success(`基础课程「${baseForm.courseName.trim()}」已创建（${res.courseNo}）`);
    }
    emit('created');
  } catch {
    /* request.ts 已弹后端原话（40901/42201 等） */
  } finally {
    baseSaving.value = false;
  }
}

/* ================= step2：开课信息 ================= */

const offerForm = reactive({
  termId: '',
  teacherId: '',
  clazzIds: [] as string[],
  joinCode: '',
  weekCount: 18,
  outline: ''
});
const offerSaving = ref(false);
const joinChecking = ref(false);
const joinCodeError = ref('');
const terms = ref<Term[]>([]);
const teachers = ref<AdminUserVo[]>([]);
const clazzes = ref<Clazz[]>([]);
const optionsLoading = ref(false);

/** step2 只在持有课程（step1 成功或外部传入）时可用 */
const canOffer = computed(() => !!created.value?.courseId);
const offerFormRef = ref();

const offerRules = {
  termId: [{ required: true, message: '请选择学期', trigger: 'change' }],
  teacherId: [{ required: true, message: '请选择授课教师', trigger: 'change' }]
};

/** 下拉数据懒加载：进 step2 才拉一次（terms / teachers(roleKey=teacher) / classes） */
async function loadOptions() {
  if (optionsLoading.value) return;
  optionsLoading.value = true;
  const jobs: Promise<void>[] = [
    listTerms({ page: 1, pageSize: 50 })
      .then((res) => {
        terms.value = res?.list ?? [];
      })
      .catch(() => {
        terms.value = [];
      }),
    listUsers({ page: 1, pageSize: 200, roleKey: 'teacher' })
      .then((res) => {
        teachers.value = res?.list ?? [];
      })
      .catch(() => {
        teachers.value = [];
      }),
    listClasses({ page: 1, pageSize: 200 })
      .then((res) => {
        clazzes.value = res?.list ?? [];
      })
      .catch(() => {
        clazzes.value = [];
      })
  ];
  await Promise.all(jobs);
  optionsLoading.value = false;
}

watch(step, (s) => {
  if (s === 2) void loadOptions();
});

/** 手填加课码失焦预检（空 = 自动生成，不预检） */
async function onJoinBlur() {
  const code = offerForm.joinCode.trim().toUpperCase();
  if (!code) {
    joinCodeError.value = '';
    return;
  }
  joinChecking.value = true;
  try {
    const res = await checkJoinCode(code);
    joinCodeError.value = res.available ? '' : `加课码 ${code} 已被使用，请更换或留空自动生成`;
  } catch {
    joinCodeError.value = '';
    /* 预检挂了不阻断：落库有唯一键兜底，撞键由后端 40902 提示 */
  } finally {
    joinChecking.value = false;
  }
}

async function submitOffering() {
  if (!created.value) return;
  try {
    await offerFormRef.value?.validate();
  } catch {
    return;
  }
  if (joinCodeError.value) {
    ElMessage.warning('请先解决加课码的问题再提交');
    return;
  }
  offerSaving.value = true;
  try {
    const res = await createOffering(created.value.courseId, {
      termId: offerForm.termId,
      teacherId: offerForm.teacherId,
      clazzIds: offerForm.clazzIds.length ? offerForm.clazzIds : undefined,
      joinCode: offerForm.joinCode.trim() ? offerForm.joinCode.trim().toUpperCase() : undefined,
      weekCount: offerForm.weekCount,
      outline: offerForm.outline.trim() || undefined
    });
    ElMessage.success(
      `已为「${created.value.courseName}」开课（${res.termCode}），加课码 ${res.joinCode}`
    );
    // 开课成功：清 step2 表单，允许继续为同一门课开第二个学期/班级组合
    offerForm.termId = '';
    offerForm.teacherId = '';
    offerForm.clazzIds = [];
    offerForm.joinCode = '';
    offerForm.weekCount = 18;
    offerForm.outline = '';
    joinCodeError.value = '';
    emit('created');
    // B-7 / 会议 A3（2026-11-10 接线）：开课成功后询问是否立即自动排课。
    // ★ auto-arrange 失败不影响开课结果（开课已落库，仅提示可去排课页手动处理）；
    //   排课成功则关窗并引导去智能排课页查看。业主拍板「新增的课给他重新排一次」。
    try {
      await ElMessageBox.confirm(
        `「${created.value.courseName}」已开课（${res.termCode}）。是否立即按教学周自动排课？`,
        '自动排课',
        { confirmButtonText: '立即排课', cancelButtonText: '暂不，手动排', type: 'info' }
      );
    } catch {
      return; // 用户选「暂不」：保持弹窗可继续开下一门
    }
    try {
      await autoArrange({ offeringId: res.offeringId });
      ElMessage.success('自动排课完成，可到「智能排课」页查看与微调');
      close();
    } catch {
      /* request.ts 已弹后端原话；开课不受影响 */
      ElMessage.warning('开课已保存，但自动排课未完成——可到「智能排课」页手动排课');
    }
  } catch {
    /* request.ts 已弹后端原话（40902/40903/422 等） */
  } finally {
    offerSaving.value = false;
  }
}

function close() {
  emit('update:visible', false);
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="step === 1 ? '新建课程 · 第 1 步（基础信息）' : created ? `新建课程 · 第 2 步（为「${created.courseName}」开课）` : '新建课程'"
    width="560px"
    :close-on-click-modal="false"
  >
    <!-- 步骤条：两步语义不同（建课 ≠ 开课），用文字标明避免误当成一个表单的两段 -->
    <div class="steps">
      <div class="step" :class="{ on: step >= 1, done: step > 1 }">1 基础课程</div>
      <div class="step-arrow">→</div>
      <div class="step" :class="{ on: step >= 2 }">2 开课</div>
      <span class="steps-note">两步各自独立提交，第 1 步成功后可直接关闭</span>
    </div>

    <!-- ============ step1 基础信息 ============ -->
    <el-form
      v-if="step === 1"
      ref="baseFormRef"
      :model="baseForm"
      :rules="baseRules"
      label-width="92px"
      @submit.prevent
    >
      <el-form-item label="课程编号" prop="courseNo">
        <div class="inline-row">
          <el-input
            v-model="baseForm.courseNo"
            placeholder="如 KC000123 或校内自有编号"
            style="flex: 1"
            @blur="onNoBlur"
          />
          <el-button :loading="noGenerating" @click="onGenerateNo">自动生成</el-button>
        </div>
        <div v-if="courseNoError" class="field-error">{{ courseNoError }}</div>
        <div v-else class="field-tip">校内唯一，大小写不敏感；保存后统一转为大写</div>
      </el-form-item>
      <el-form-item label="课程名称" prop="courseName">
        <el-input v-model="baseForm.courseName" placeholder="1~100 字；同名课程允许（会提醒）" />
      </el-form-item>
      <el-form-item label="面向专业">
        <el-input v-model="baseForm.major" placeholder="可空" />
      </el-form-item>
      <el-form-item label="学分">
        <el-input-number v-model="baseForm.credit" :min="0" :max="9.9" :step="0.5" :precision="1" style="width: 140px" />
      </el-form-item>
      <el-form-item label="学时">
        <el-input-number v-model="baseForm.hours" :min="0" :max="999" style="width: 140px" />
      </el-form-item>
      <el-form-item label="课程类型">
        <el-select v-model="baseForm.courseType" placeholder="可空" clearable style="width: 200px">
          <el-option v-for="(label, key) in COURSE_TYPE_LABEL" :key="key" :label="label" :value="key" />
        </el-select>
      </el-form-item>
      <el-form-item label="课程简介">
        <el-input v-model="baseForm.description" type="textarea" :rows="3" placeholder="可空" />
      </el-form-item>
    </el-form>

    <!-- ============ step2 开课信息 ============ -->
    <el-form
      v-else-if="canOffer"
      ref="offerFormRef"
      :model="offerForm"
      :rules="offerRules"
      label-width="92px"
      v-loading="optionsLoading"
      @submit.prevent
    >
      <el-form-item label="学期" prop="termId">
        <el-select v-model="offerForm.termId" placeholder="选择学期" filterable style="width: 100%">
          <el-option
            v-for="t in terms"
            :key="t.termId"
            :label="t.name ? `${t.name}（${t.code ?? ''}）` : String(t.code ?? t.termId)"
            :value="String(t.termId)"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="授课教师" prop="teacherId">
        <el-select v-model="offerForm.teacherId" placeholder="选择教师" filterable style="width: 100%">
          <el-option
            v-for="u in teachers"
            :key="u.userId"
            :label="`${u.nickName}（${u.username}）`"
            :value="String(u.userId)"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="上课班级">
        <el-select v-model="offerForm.clazzIds" placeholder="可多选；不选 = 不绑班级" multiple filterable clearable style="width: 100%">
          <el-option
            v-for="c in clazzes"
            :key="c.clazzId"
            :label="`${c.clazzName}（${c.clazzCode}）`"
            :value="String(c.clazzId)"
            :disabled="c.status !== 'active'"
          />
        </el-select>
        <div class="field-tip">已停用班级不可选；包含停用/跨校班级提交会被拒绝（不会自动剔除）</div>
      </el-form-item>
      <el-form-item label="加课码">
        <el-input
          v-model="offerForm.joinCode"
          placeholder="留空自动生成（JM + 6 位）"
          @blur="onJoinBlur"
        />
        <div v-if="joinCodeError" class="field-error">{{ joinCodeError }}</div>
        <div v-else class="field-tip">学生凭加课码加入；2~20 位大写字母/数字/连字符</div>
      </el-form-item>
      <el-form-item label="教学周数">
        <el-input-number v-model="offerForm.weekCount" :min="1" :max="30" style="width: 140px" />
        <span class="field-tip" style="margin-left: 8px">默认 18，1~30</span>
      </el-form-item>
      <el-form-item label="教学大纲">
        <el-input v-model="offerForm.outline" type="textarea" :rows="3" placeholder="本学期大纲，可空" />
      </el-form-item>
    </el-form>

    <template #footer>
      <template v-if="step === 1">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="baseSaving" @click="submitBase">
          创建基础课程（进入第 2 步）
        </el-button>
      </template>
      <template v-else>
        <el-button @click="close">完成并关闭</el-button>
        <el-button type="primary" :loading="offerSaving" @click="submitOffering">
          <ZkIcon name="plus" :size="14" style="margin-right: 4px" />开课
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.steps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  font-size: 13px;
}
.step {
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--border, #e2e8f0);
  color: var(--ink-400, #9aa3b2);
}
.step.on {
  border-color: var(--brand-400, #7aa7f8);
  color: var(--brand-600, #2563eb);
  background: var(--brand-50, #eff6ff);
}
.step.done {
  color: var(--success-600, #16a34a);
  border-color: var(--success-200, #bbf7d0);
}
.step-arrow {
  color: var(--ink-300, #cbd5e1);
}
.steps-note {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
.inline-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.field-error {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  color: var(--danger-600, #d54941);
}
.field-tip {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
</style>
