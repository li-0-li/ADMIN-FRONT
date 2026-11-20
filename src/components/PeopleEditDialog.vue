<script setup lang="ts">
/**
 * 师生「编辑资料」弹窗（教师管理 / 学生管理两页共用）
 * ---------------------------------------------------------------------------
 * 为什么不用 ProfileDetail 原来的内联编辑：那个走 `PUT /teachers/{id}/profile`，
 * 后端只取 `jobTitle`，其余字段被丢弃 —— 改姓名/院系/状态点了也是白改。
 * 统一改走账号接口 `PUT /api/v1/admin/users`（UserSaveBo），它才是这些字段的正主：
 *   nickName / phone / email / userNo / remark / deptId / clazzId / roleKeys
 *
 * 两页差异（控件与布局相同，只是维度不同）：
 *   教师 → 院系（deptId，若依院系树本校子树）+ 职称（走 profile 端点）+ 可授课程
 *   学生 → 学院（deptId，同一个 sys_dept.dept_id）+ 班级（clazzId，后端以班级为准反推学校/专业）
 *
 * ★ 学生「学院」为什么要单独给一个下拉（2026-11-20 业主口径）：
 *   学生的学院原本只能由班级间接决定（clazz.dept_id）。未分班的学生就完全没有学院，
 *   转院系也只能靠「先换班」这一个动作。后端 `PUT /admin/users` 本身吃 `deptId`，
 *   且 `fillDeptFromClazz()` 只在**没传 deptId** 时才用班级兜底（显式传值一律尊重调用方），
 *   所以前端可以放心独立写它。代价是要自己守住一致性：
 *     - 选班级 ⇒ 自动把学院回填成该班级的 dept_id（后端不会替你校）；
 *     - 改学院但班级仍挂在别的院系 ⇒ 保存前拦下来，否则落库就是「人在计科院、班在软件学院」。
 *
 * ★ 三条实测口径（2026-11-20，运行包 app-admin-66a5cb0c）：
 *  1. `clazzId` 传了才写，**传 null 表示「不修改」** ⇒ 学生班级只能换绑，无法清空。
 *     所以班级下拉不做 clearable，避免给出一个点了没用的 ✕。
 *  2. `POST /teachers/{id}/capabilities` 是 **INSERT IGNORE 追加**，不是整组覆盖
 *     （源码 AdminCapabilityServiceImpl#grant 注释与实现一致）。取消勾选必须逐条
 *     `DELETE /capabilities/{capabilityId}`，所以保存前要先拿到原资格列表算差集。
 *  3. `GET /teachers/{id}/capabilities` 返回的是 **对象数组**（capabilityId/courseId/…），
 *     不是课程 id 字符串数组 —— 旧封装按 string[] 声明，账号页据此回显会得到
 *     "[object Object]"。这里按真实结构读，并同步修了封装与账号页的用法。
 *
 * 权限：整个弹窗由 `admin:users:edit` 控制入口；可授课程区额外要求
 * `admin:capabilities:list` + `admin:capabilities:add` + `admin:capabilities:remove`。
 */
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { listDeptTree, updateUser, type DeptNodeVo } from '@/api/admin/users';
import { listClasses } from '@/api/admin/basicdata';
import { listCourses, type AdminCourseVo } from '@/api/admin/courses';
import {
  getTeacherCapabilities,
  revokeTeacherCapability,
  saveTeacherCapabilities,
  type TeacherCapabilityVo
} from '@/api/admin/capabilities';
import { getTeacherProfile, updateTeacherProfile } from '@/api/admin/profiles';
import { useUserStore } from '@/store/user';
import type { AdminUserVo, Clazz, UserSaveBo } from '@/types/admin';

const props = defineProps<{
  modelValue: boolean;
  mode: 'teacher' | 'student';
  user: AdminUserVo | null;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved'): void;
}>();

const userStore = useUserStore();
const isTeacher = computed(() => props.mode === 'teacher');
const canEditCaps = computed(
  () =>
    userStore.hasPermi('admin:capabilities:list') &&
    userStore.hasPermi('admin:capabilities:add') &&
    userStore.hasPermi('admin:capabilities:remove')
);

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
});

/* ---------------- 表单 ---------------- */
const formRef = ref<FormInstance>();
const form = reactive({
  nickName: '',
  userNo: '',
  phone: '',
  email: '',
  /** 教师：所属院系；学生：所属学院（都是 sys_user.dept_id） */
  deptId: '' as string,
  /** 学生：所属班级（clazz.clazz_id）；空串 = 该学生未分班 */
  clazzId: '' as string,
  /** 教师职称（biz_user_ext.job_title，走 profile 端点） */
  jobTitle: '',
  remark: ''
});

const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const rules: FormRules = {
  nickName: [{ required: true, message: '姓名为必填', trigger: 'blur' }],
  userNo: [{ required: true, message: isTeacherProd() ? '工号为必填' : '学号为必填', trigger: 'blur' }],
  email: [{ pattern: EMAIL_RE, message: '邮箱格式不正确', trigger: 'blur' }],
  phone: [{ pattern: PHONE_RE, message: '手机号格式不正确', trigger: 'blur' }]
};
/** rules 在 setup 期间求值一次，这里用函数读最新的 mode 文案 */
function isTeacherProd() {
  return props.mode === 'teacher';
}

/* ---------------- 候选：院系 / 班级 / 课程 ---------------- */
const deptOptions = ref<{ id: string; name: string }[]>([]);
/** 班级候选带 deptId：学生页要按「学院」过滤，并在选班后反填学院 */
const clazzOptions = ref<{ id: string; name: string; deptId: string }[]>([]);
const courseOptions = ref<AdminCourseVo[]>([]);
/** 候选取不到时置灰下拉并在浮层底部说明，不静默给空下拉（会被读成「库里没有」） */
const deptFailed = ref(false);
const clazzFailed = ref(false);
const courseFailed = ref(false);

/** 院系候选 = 若依院系树里「本校根子树」的节点（与账号管理、师生筛选同一口径） */
const ROOT_DEPT_ID = '200';
/** 本校根节点 id（`deptOptionsOf` 算出后写入）：挂在根节点上等于「没有具体院系/学院」 */
let rootDeptId = ROOT_DEPT_ID;
function deptOptionsOf(list: DeptNodeVo[]) {
  const self = list.find((d) => String(d.deptId) === ROOT_DEPT_ID);
  const chain = (self?.ancestors ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== '0');
  const rootId = chain.length ? chain[0] : ROOT_DEPT_ID;
  rootDeptId = rootId;
  const under = list.filter((d) => {
    const id = String(d.deptId);
    // ★ 排除根节点本身：学校根不是「院系」，把它列进下拉会让人把学生挂到学校上，
    //   那等于没归属到任何学院（院系筛选、按院系统计都会漏人）
    if (id === rootId) return false;
    return (d.ancestors ?? '').split(',').map((s) => s.trim()).includes(rootId);
  });
  // 只有根节点、还没建任何下属部门时退回根节点，避免下拉直接空掉
  const picked = under.length ? under : list.filter((d) => String(d.deptId) === rootId);
  return picked
    .map((d) => ({ id: String(d.deptId), name: d.deptName }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

async function loadDepts() {
  try {
    const res = await listDeptTree();
    deptOptions.value = res.ok ? deptOptionsOf(res.list) : [];
    deptFailed.value = deptOptions.value.length === 0;
  } catch {
    deptFailed.value = true;
  }
}

async function loadClazzes() {
  try {
    // 一次取 500 条（本校班级量级远低于此），学院筛选在前端做：换学院不必再打一次接口
    const res = await listClasses({ page: 1, pageSize: 500 });
    clazzOptions.value = (res.list ?? []).map((c: Clazz) => ({
      id: String(c.clazzId ?? ''),
      name: c.clazzName || c.clazzCode || String(c.clazzId ?? ''),
      deptId: c.deptId ? String(c.deptId) : ''
    }));
    clazzFailed.value = clazzOptions.value.length === 0;
  } catch {
    clazzFailed.value = true;
  }
}

/** 学生页：班级候选按已选学院过滤；班级自身没登记院系时不过滤掉（宁可多给，不要凭空消失） */
const clazzChoices = computed(() => {
  const d = form.deptId;
  if (!d) return clazzOptions.value;
  return clazzOptions.value.filter((c) => !c.deptId || c.deptId === d);
});

/** 选班级后把学院反填成班级所属院系（后端不会替我们校验这两者是否一致） */
function syncDeptFromClazz() {
  if (isTeacher.value || !form.clazzId) return;
  const c = clazzOptions.value.find((x) => x.id === form.clazzId);
  if (c?.deptId && c.deptId !== form.deptId) form.deptId = c.deptId;
}

/** 学院与在册班级所属院系不一致：即时提示（保存时同样会拦，这里只是别让人填完才看见） */
const clazzMismatch = computed(() => {
  if (isTeacher.value || !form.clazzId || !form.deptId) return false;
  const c = clazzOptions.value.find((x) => x.id === form.clazzId);
  return !!c?.deptId && c.deptId !== form.deptId;
});

async function loadCourses() {
  try {
    const res = await listCourses({ page: 1, pageSize: 500 });
    courseOptions.value = res.list ?? [];
    courseFailed.value = courseOptions.value.length === 0;
  } catch {
    courseFailed.value = true;
  }
}

/* ---------------- 可授课程（差异同步） ---------------- */
/** 打开时的原始资格快照：用来算「新增」「撤销」两个差集 */
const origCaps = ref<TeacherCapabilityVo[]>([]);
const capSelected = ref<string[]>([]);
const origJobTitle = ref('');
const loading = ref(false);
const saving = ref(false);

/** 课程名查表：资格接口自带 courseName，课程列表也有，优先用资格自带的 */
const courseNameOf = (id: string) => {
  const hit = origCaps.value.find((c) => String(c.courseId) === id);
  if (hit?.courseName) return hit.courseName;
  return courseOptions.value.find((c) => String(c.courseId) === id)?.courseName ?? id;
};

/** 打开时装载：先用列表行的值回显（列表已有 userId/nickName/userNo/... ），再补详情侧字段 */
async function hydrate() {
  const u = props.user;
  if (!u) return;
  form.nickName = u.nickName ?? '';
  form.userNo = u.userNo ?? '';
  form.phone = u.phone ?? '';
  form.email = u.email ?? '';
  form.deptId = u.deptId ? String(u.deptId) : '';
  // ★ 列表 VO 的 clazzName 恒为 null（后端没把 class_name 带回），但 clazzId 是准的
  form.clazzId = u.clazzId ? String(u.clazzId) : '';
  form.jobTitle = '';
  form.remark = u.remark ?? '';
  origCaps.value = [];
  capSelected.value = [];
  origJobTitle.value = '';
  formRef.value?.clearValidate();

  loading.value = true;
  const jobs: Promise<unknown>[] = [];
  if (isTeacher.value) {
    jobs.push(
      getTeacherProfile(String(u.userId))
        .then((p) => {
          form.jobTitle = p?.jobTitle ?? '';
          origJobTitle.value = p?.jobTitle ?? '';
        })
        .catch(() => {})
    );
    if (canEditCaps.value) {
      jobs.push(loadCourses());
      jobs.push(
        getTeacherCapabilities(String(u.userId))
          .then((list) => {
            const arr = Array.isArray(list) ? list : [];
            origCaps.value = arr.filter((c) => c && c.courseId != null);
            capSelected.value = origCaps.value.map((c) => String(c.courseId));
          })
          .catch(() => {
            // 读不到原资格时**禁止**写：此时「差集」会把全部选中的当新增、
            // 把用户取消的当撤销，但原集合未知 ⇒ 可能误删。置空并提示重开。
            origCaps.value = [];
            capSelected.value = [];
            ElMessage.warning('可授课程读取失败，本次未加载原资格；重开后如仍失败请先检查权限');
          })
      );
    }
    jobs.push(loadDepts());
  } else {
    jobs.push(loadClazzes());
    jobs.push(loadDepts());
  }
  await Promise.all(jobs);
  // 候选到手后校正回显：挂在「学校根节点」上的账号等于没有具体院系/学院，
  // 下拉里也没有这个选项 ⇒ 一律按未选处理（不改就不下发，原值保持不动）
  if (form.deptId && form.deptId === rootDeptId) form.deptId = '';
  // 班级候选到手后再补一次反填：打开瞬间 watch 触发时候选还是空的，拿不到 deptId
  syncDeptFromClazz();
  loading.value = false;
}

/** 用户在界面上换班 ⇒ 立刻把学院跟着改（避免「改了班、学院还留着旧院系」） */
watch(
  () => form.clazzId,
  () => syncDeptFromClazz()
);

watch(
  () => props.modelValue,
  (v) => {
    if (v) void hydrate();
  }
);

/* ---------------- 保存 ---------------- */
async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok || !props.user) return;

  /* 学生：学院与班级必须是同一个院系。后端两个字段各写各的（deptId 直接落 sys_user.dept_id，
   * clazzId 只推导 school/major），不会替我们校这个一致性 ⇒ 必须在前端拦住，
   * 否则会落出「人在计科院、班在软件学院」这种谁也解释不清的学籍。 */
  if (!isTeacher.value && form.clazzId && form.deptId) {
    const c = clazzOptions.value.find((x) => x.id === form.clazzId);
    if (c?.deptId && c.deptId !== form.deptId) {
      const nameOf = (id: string) => deptOptions.value.find((d) => d.id === id)?.name ?? id;
      ElMessage.warning(
        `「${c.name}」属于${nameOf(c.deptId)}，与所选学院「${nameOf(form.deptId)}」不一致。` +
          `请改选本学院的班级，或把学院改回${nameOf(c.deptId)}`
      );
      return;
    }
  }

  const uid = String(props.user.userId);
  saving.value = true;
  try {
    const payload: UserSaveBo = {
      userId: uid,
      // 登录账号：后端强校验「师生账号 == 学号/工号」，这里原样带回，不提供修改
      username: props.user.username,
      nickName: form.nickName.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      userNo: form.userNo.trim(),
      remark: form.remark.trim(),
      // ★ 角色必须原样带回：学生列表接口不下发 roleKeys（教师下发），
      //   缺省时按当前页角色兜底，避免后端把角色解析成空。
      roleKeys:
        props.user.roleKeys?.length
          ? [...props.user.roleKeys]
          : [isTeacher.value ? 'teacher' : 'student']
    };
    // 学院 / 院系两页都写同一个字段（sys_user.dept_id）。空值不发 = 保持原值；
    // 学生传空时后端还会按班级兜底（fillDeptFromClazz），不会把 dept_id 落成 NULL。
    if (form.deptId) payload.deptId = form.deptId;
    if (!isTeacher.value && form.clazzId) {
      // ★ 只在有值时发：clazzId=null 在后端是「不修改」，发空值既清不掉班、又白写一次
      payload.clazzId = form.clazzId;
    }

    await updateUser(payload);
  } catch {
    // request.ts 已把后端原话弹出来，这里不再叠一层
    saving.value = false;
    return;
  }

  // 以下两步是「附加项」：基本信息已经落库，失败要如实说清楚，不能笼统报「保存失败」
  const extraFails: string[] = [];

  if (isTeacher.value && form.jobTitle.trim() !== origJobTitle.value.trim()) {
    try {
      await updateTeacherProfile(uid, { jobTitle: form.jobTitle.trim() || null });
    } catch {
      extraFails.push('职称');
    }
  }

  if (isTeacher.value && canEditCaps.value) {
    const before = new Set(origCaps.value.map((c) => String(c.courseId)));
    const after = new Set(capSelected.value.map(String));
    const toAdd = [...after].filter((id) => !before.has(id));
    const toRemove = origCaps.value.filter((c) => !after.has(String(c.courseId)));
    /* ★ 2026-11-20 实测的后端缺陷，必须在动手前拦住：
     *   `teacher_course_capability` 有唯一键 `uk_teacher_course(teacher_id, course_id)`，
     *   而 DELETE 是**软删**（`deleted=1`，行仍占着唯一键），POST 走 `INSERT IGNORE` ⇒
     *   一旦撤销过某门资格，这门课对该教师就**再也加不回来**（新增返回 0，静默不报错）。
     *   这是后端要修的问题（唯一键应带 deleted，或 POST 改 UPSERT 复活软删行）；
     *   前端能做的是：撤销前明确二次确认，别让用户在不知情时永久毁掉一条资格。 */
    if (toRemove.length) {
      const names = toRemove.map((c) => courseNameOf(String(c.courseId))).join('、');
      const go = await ElMessageBox.confirm(
        `将撤销 ${toRemove.length} 门可授课程：${names}。\n\n` +
          '注意：当前后端撤销后无法再次授予（已知缺陷，新增会被静默跳过），' +
          '除非先修后端或由管理员改库，否则这门课该教师以后都排不了。',
        '确认撤销可授课程',
        { type: 'warning', confirmButtonText: '仍然撤销', cancelButtonText: '取消' }
      ).catch(() => false);
      if (!go) {
        saving.value = false;
        return;
      }
    }
    if (toAdd.length) {
      try {
        await saveTeacherCapabilities(uid, toAdd);
      } catch {
        extraFails.push('可授课程（新增）');
      }
    }
    for (const c of toRemove) {
      try {
        await revokeTeacherCapability(String(c.capabilityId));
      } catch {
        extraFails.push(`可授课程（撤销「${courseNameOf(String(c.courseId))}」）`);
      }
    }
  }

  saving.value = false;
  if (extraFails.length) {
    ElMessage.warning(`基本信息已保存；以下未成功：${[...new Set(extraFails)].join('、')}`);
  } else {
    ElMessage.success('已保存');
  }
  visible.value = false;
  emit('saved');
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="isTeacher ? '编辑教师资料' : '编辑学生资料'"
    width="640px"
    :close-on-click-modal="false"
    append-to-body
    destroy-on-close
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="76px" v-loading="loading">
      <div class="grid2">
        <el-form-item label="姓名" prop="nickName">
          <el-input v-model="form.nickName" maxlength="30" placeholder="真实姓名" />
        </el-form-item>
        <el-form-item :label="isTeacher ? '工号' : '学号'" prop="userNo">
          <el-input v-model="form.userNo" maxlength="32" :placeholder="isTeacher ? '如 T2025001' : '如 2025001'" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" maxlength="11" placeholder="选填" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" maxlength="64" placeholder="选填" />
        </el-form-item>

        <!-- 教师 = 院系 + 职称；学生 = 班级。两页位置相同，只换一个维度 -->
        <template v-if="isTeacher">
          <el-form-item label="院系">
            <el-select
              v-model="form.deptId"
              filterable
              :disabled="deptFailed"
              placeholder="未入院系"
              style="width: 100%"
            >
              <el-option v-for="o in deptOptions" :key="o.id" :label="o.name" :value="o.id" />
              <template v-if="deptFailed" #footer>
                <div class="opt-tip">院系候选取不到，可稍后重试或改由基础数据维护</div>
              </template>
            </el-select>
          </el-form-item>
          <el-form-item label="职称">
            <el-input v-model="form.jobTitle" maxlength="32" placeholder="如 副教授" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="学院">
            <el-select
              v-model="form.deptId"
              filterable
              :disabled="deptFailed"
              placeholder="未入学院"
              style="width: 100%"
            >
              <el-option v-for="o in deptOptions" :key="o.id" :label="o.name" :value="o.id" />
              <template v-if="deptFailed" #footer>
                <div class="opt-tip">院系候选取不到，可稍后重试或改由基础数据维护</div>
              </template>
            </el-select>
          </el-form-item>
          <el-form-item label="班级">
            <!-- 不做 clearable：后端 clazzId 传空是「不修改」，给了 ✕ 也清不掉，属于假操作 -->
            <el-select
              v-model="form.clazzId"
              filterable
              :disabled="clazzFailed || (!!form.deptId && !clazzChoices.length)"
              :placeholder="form.clazzId ? '选择班级' : '未分班'"
              style="width: 100%"
            >
              <el-option v-for="o in clazzChoices" :key="o.id" :label="o.name" :value="o.id" />
              <template v-if="clazzFailed" #footer>
                <div class="opt-tip">班级候选取不到，可稍后重试或改由基础数据维护</div>
              </template>
              <template v-else-if="form.deptId && !clazzChoices.length" #footer>
                <div class="opt-tip">该学院下还没有班级，可先到基础数据里建班</div>
              </template>
            </el-select>
          </el-form-item>
          <div class="hint-cell full" :class="{ warn: clazzMismatch }">
            <template v-if="clazzMismatch">学院与当前班级所属院系不一致，保存会被拦下：请改选本学院的班级，或把学院改回原院系。</template>
            <template v-else>选班级会自动带出班级所属学院；学院与班级须同属一个院系。学校 / 专业由班级自动推导，本期不支持把学生改成「无班级」。</template>
          </div>
        </template>

        <el-form-item label="备注" class="full">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="选填" />
        </el-form-item>
      </div>

      <!-- 可授课程：只有教师有，且要有相应权限 -->
      <el-form-item v-if="isTeacher && canEditCaps" label="可授课程" class="cap-item">
        <el-select
          v-model="capSelected"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="4"
          :disabled="courseFailed"
          placeholder="未登记可授课程"
          style="width: 100%"
        >
          <el-option v-for="c in courseOptions" :key="c.courseId" :label="c.courseName" :value="String(c.courseId)">
            <span class="opt-name">{{ c.courseName }}</span>
            <span class="opt-no mono">{{ c.courseNo }}</span>
          </el-option>
          <template v-if="courseFailed" #footer>
            <div class="opt-tip">课程候选取不到，可授课程本次不可改</div>
          </template>
        </el-select>
      </el-form-item>
      <div v-if="isTeacher && canEditCaps" class="cap-hint">
        勾选即新增资格，取消勾选即<strong>撤销</strong>（保存时会二次确认）。资格是智能排课挑选教师的依据；
        <span class="warn">撤销后当前后端无法再加回来，非必要别取消。</span>
      </div>
      <div v-else-if="isTeacher" class="cap-hint muted">无「可授课程」维护权限，本次只改基本信息。</div>
    </el-form>

    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 18px;
}
.grid2 .full {
  grid-column: 1 / -1;
}
/* 与输入框同高的说明格，避免学生页右侧空一格 */
.hint-cell {
  display: flex;
  align-items: center;
  padding-bottom: 18px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-400, #9aa3b2);
}
/* 整行说明：跨两列，不再占一个输入位，所以去掉与输入框对齐的底部留白 */
.hint-cell.full {
  grid-column: 1 / -1;
  padding-bottom: 0;
  margin: -2px 0 14px;
}
.cap-item {
  margin-top: 2px;
}
.cap-hint {
  margin: 0 0 4px 76px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-400, #9aa3b2);
}
.opt-tip {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--ink-400, #9aa3b2);
}
.opt-name {
  margin-right: 8px;
}
.opt-no {
  float: right;
  font-size: 11.5px;
  color: var(--ink-400, #9aa3b2);
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.muted {
  color: var(--ink-400, #9aa3b2);
}
.warn {
  color: #b45309;
}
</style>
