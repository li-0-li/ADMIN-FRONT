<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  checkCourseNo,
  updateCourse
} from '@/api/admin/courses';
import type { CourseCreateBo } from '@/api/admin/courses';

/**
 * 编辑课程基础信息（T01-3 · 2026-11-18）
 * ============================================================================
 * 接口 PUT /api/v1/admin/courses/{courseId}（权限 admin:courses:edit，菜单 3372）
 * 后端早就有了，前端一直没接入口 —— 本组件就是那个缺口。
 *
 * 编辑口径（与后端 AdminCourseServiceImpl#updateCourse 对齐）：
 * - 可改：课程编号 / 名称 / 面向专业 / 学分 / 学时 / 课程类型 / 简介；
 * - 不可改：学期 / 教师 / 班级（开课属性，在「课程配置」里；编辑接口无 PUT 版，
 *   已派单 20261116-开课记录编辑接口）；
 * - courseNo 变更走二次确认（不影响已开课记录与课次，但校内外引用它显示）；
 * - 编号失焦预检（check-no mode=check，silent，红字自己画，与建课向导同款）；
 * - 后端校验：编号 ^[A-Z0-9][A-Z0-9-]{1,19}$、名称 1~100、学分 0~9.9 一位小数。
 */

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
  /** 待编辑课程（详情抽屉的 detailData 或列表行；description 只有详情 VO 带） */
  course: {
    courseId: string;
    courseNo: string;
    courseName: string;
    major?: string | null;
    credit?: number | null;
    hours?: number | null;
    courseType?: string | null;
    description?: string | null;
  } | null;
}>();

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  /** 保存成功后触发（父页面刷新列表与抽屉） */
  (e: 'saved'): void;
}>();

const visible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v)
});

const COURSE_NO_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const COURSE_TYPE_LABEL: Record<string, string> = {
  required: '必修',
  elective: '选修',
  core: '专业核心',
  public: '公共基础',
  practice: '实验实践',
  general: '通识选修'
};

const form = reactive<CourseCreateBo>({
  courseNo: '',
  courseName: '',
  major: '',
  credit: null,
  hours: null,
  courseType: '',
  description: ''
});
/** 打开时的原始编号：判断「编号是否被改动」用 */
const originNo = ref('');
const saving = ref(false);
const noChecking = ref(false);
/** 编号预检失败红字（40901 / 格式）；空串 = 无错误。失败保输入 */
const courseNoError = ref('');
const formRef = ref();

watch(
  () => props.visible,
  (v) => {
    if (!v || !props.course) return;
    originNo.value = String(props.course.courseNo ?? '').toUpperCase();
    form.courseNo = originNo.value;
    form.courseName = props.course.courseName ?? '';
    form.major = props.course.major ?? '';
    form.credit = props.course.credit ?? null;
    form.hours = props.course.hours ?? null;
    form.courseType = props.course.courseType ?? '';
    form.description = props.course.description ?? '';
    courseNoError.value = '';
  }
);

const rules = {
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

/** 失焦预检：撞 40901 / 格式不对时红字保输入（与建课向导同款） */
async function onNoBlur() {
  const no = form.courseNo.trim().toUpperCase();
  if (!no) {
    courseNoError.value = '';
    return;
  }
  if (!COURSE_NO_RE.test(no)) {
    courseNoError.value = '编号格式：2~20 位大写字母/数字/连字符，以字母或数字开头';
    return;
  }
  // 没改动就跳过预检（原编号本来就占用着，自己查自己永远 40901）
  if (no === originNo.value) {
    courseNoError.value = '';
    return;
  }
  noChecking.value = true;
  try {
    const res = await checkCourseNo('0', no);
    courseNoError.value = res.available ? '' : `编号 ${no} 已被占用，请更换`;
  } catch {
    courseNoError.value = '';
    /* 预检接口挂了不阻断提交：落库还有唯一键双保险，撞键由后端 40901 提示 */
  } finally {
    noChecking.value = false;
  }
}

async function submit() {
  if (!props.course) return;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (courseNoError.value) {
    ElMessage.warning('请先解决课程编号的问题再提交');
    return;
  }
  const newNo = form.courseNo.trim().toUpperCase();
  // 编号变更二次确认（API 注释约定：「不影响已开的课」要说清）
  if (newNo !== originNo.value) {
    try {
      await ElMessageBox.confirm(
        `课程编号将从「${originNo.value}」改为「${newNo}」。编号变更不影响已开课记录与课次，但已打印的课表/通知若引用旧编号需留意。确定修改？`,
        '修改课程编号',
        { confirmButtonText: '确定修改', cancelButtonText: '取消', type: 'warning' }
      );
    } catch {
      return;
    }
  }
  saving.value = true;
  try {
    await updateCourse(props.course.courseId, {
      ...form,
      courseNo: newNo,
      courseName: form.courseName.trim(),
      major: form.major?.trim() || undefined,
      courseType: form.courseType || undefined,
      description: form.description?.trim() || undefined
    });
    ElMessage.success(`课程「${form.courseName.trim()}」基础信息已保存`);
    emit('saved');
    visible.value = false;
  } catch {
    /* request.ts 已弹后端原话（40901 编号占用 / 422 校验不过等） */
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="编辑课程基础信息"
    width="560px"
    :close-on-click-modal="false"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px" @submit.prevent>
      <el-form-item label="课程编号" prop="courseNo">
        <el-input v-model="form.courseNo" placeholder="校内唯一，保存后统一转为大写" @blur="onNoBlur" />
        <div v-if="courseNoError" class="field-error">{{ courseNoError }}</div>
        <div v-else class="field-tip">
          改编号会二次确认；不影响已开课记录与课次
        </div>
      </el-form-item>
      <el-form-item label="课程名称" prop="courseName">
        <el-input v-model="form.courseName" placeholder="1~100 字" />
      </el-form-item>
      <el-form-item label="面向专业">
        <el-input v-model="form.major" placeholder="可空" />
      </el-form-item>
      <el-form-item label="学分">
        <el-input-number v-model="form.credit" :min="0" :max="9.9" :step="0.5" :precision="1" style="width: 140px" />
      </el-form-item>
      <el-form-item label="学时">
        <el-input-number v-model="form.hours" :min="0" :max="999" style="width: 140px" />
      </el-form-item>
      <el-form-item label="课程类型">
        <el-select v-model="form.courseType" placeholder="可空" clearable style="width: 200px">
          <el-option v-for="(label, key) in COURSE_TYPE_LABEL" :key="key" :label="label" :value="key" />
        </el-select>
      </el-form-item>
      <el-form-item label="课程简介">
        <el-input v-model="form.description" type="textarea" :rows="3" placeholder="可空" />
      </el-form-item>
      <el-form-item label="开课信息">
        <span class="field-tip">学期 / 教师 / 班级 / 排课节奏属「课程配置」，在详情抽屉的开课记录区块里改</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
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
