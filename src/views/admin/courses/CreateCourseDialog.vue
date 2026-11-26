<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import {
  checkCourseNo,
  checkJoinCode,
  createCourse,
  createOffering,
  nextCourseNo,
  updateCourse,
  updateOfferingScheduleConfig
} from '@/api/admin/courses';
import type { CourseCreateBo } from '@/api/admin/courses';
import { listClasses, listMajors, listTerms } from '@/api/admin/basicdata';
import { listPeriods } from '@/api/admin/periods';
import { getTeachingWeek } from '@/api/admin/config';
import { listUsers } from '@/api/admin/users';
import type { Clazz, Major, Term } from '@/types/admin';
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
 *   排课节奏（周范围 / 每周节次 / 总节次，与智能排课同一组字段；
 *   周跨度即 offering.week_count，不再单列「教学周数」）。
 */

const props = defineProps<{
  /** v-model:visible */
  visible: boolean;
  /** 传入时直接从 step2 开始（详情抽屉「为这门课开课」入口）；hours 用于「按学时算」 */
  startCourse?: { courseId: string; courseName: string; hours?: number | null } | null;
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
/**
 * 第 2 步回第 1 步改基础信息（2026-11-20 业主：「第二步应当可以返回第一步」）。
 * ★ 此时课程已经在 step1 落库，再点「创建」会撞编号 ⇒ 这条路径改为 PUT 更新，
 *   不再 POST。外部入口（props.startCourse）没有第 1 步，不提供返回。
 */
const editingBase = ref(false);
/** 已建课程的原始编号：编号没改就跳过占用预检（自己查自己永远是 40901） */
const originCourseNo = ref('');

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
    editingBase.value = false;
    originCourseNo.value = '';
    courseNoError.value = '';
    joinCodeError.value = '';
    // 每次打开都从「第 1 周起、每周 1 节」起算，避免带上一次填的节奏；
    // 学时不再在这里填（2026-11-19 业主：第 1 步填过就不该在第 2 步再填一遍）。
    schedForm.weekFrom = 1;
    schedForm.lessonsPerWeek = 1;
    void loadMajors();
    void loadPeriodsPerDay();
    void loadTermWeekMax();
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
  ],
  /* 学时是第 1 步的必填项（2026-11-19）：第 2 步的「结束周」由它折算，
     这里不填，第 2 步就只能卡住不给保存，不如在填的时候就拦住。 */
  hours: [
    {
      validator: (_r: unknown, v: number | null, cb: (e?: Error) => void) => {
        if (v == null || Number(v) <= 0) cb(new Error('请填写学时；排课节奏按「学时 ÷ 2 = 节次」折算'));
        else cb();
      },
      trigger: 'blur'
    }
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
  // 从第 2 步返回第 1 步改信息：编号没动就跳过预检（原编号本来就占用着）
  if (editingBase.value && no === originCourseNo.value) {
    courseNoError.value = '';
    return;
  }
  noChecking.value = true;
  try {
    const res = await checkCourseNo('0', no);
    courseNoError.value = res.available
      ? ''
      : `编号 ${no} 已被占用：若上次只完成了第 1 步，这门课其实已经建好（去课程列表补配置即可）；想新建请换号或点「自动生成」`;
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
  const courseNo = baseForm.courseNo.trim().toUpperCase();
  const courseName = baseForm.courseName.trim();
  const payload: CourseCreateBo = {
    ...baseForm,
    courseNo,
    courseName,
    major: baseForm.major?.trim() || undefined,
    courseType: baseForm.courseType || undefined,
    description: baseForm.description?.trim() || undefined
  };

  /* ---- 分支 A：从第 2 步返回改信息（课程已建好）⇒ PUT 更新，不能再 POST ---- */
  if (editingBase.value && created.value) {
    if (courseNo !== originCourseNo.value) {
      try {
        await ElMessageBox.confirm(
          `课程编号将从「${originCourseNo.value}」改为「${courseNo}」。编号变更不影响已开的课与课次，但已打印的课表/通知若引用旧编号需留意。确定修改？`,
          '修改课程编号',
          { confirmButtonText: '确定修改', cancelButtonText: '取消', type: 'warning' }
        );
      } catch {
        return;
      }
    }
    baseSaving.value = true;
    try {
      await updateCourse(created.value.courseId, payload);
      created.value = { ...created.value, courseName, courseNo };
      originCourseNo.value = courseNo;
      editingBase.value = false;
      step.value = 2;
      ElMessage.success(`「${courseName}」基础信息已更新`);
      emit('created');
    } catch {
      /* request.ts 已弹后端原话（40901 编号占用 / 422 校验不过等） */
    } finally {
      baseSaving.value = false;
    }
    return;
  }

  /* ---- 分支 B：首次建课 ⇒ POST ---- */
  baseSaving.value = true;
  try {
    const res = await createCourse(payload);
    created.value = { courseId: res.courseId, courseName, courseNo: res.courseNo };
    originCourseNo.value = String(res.courseNo ?? courseNo).toUpperCase();
    step.value = 2;
    if (res.duplicateName) {
      ElMessage.warning(`基础课程已创建，但同校已有同名课程「${courseName}」，请留意区分`);
    } else {
      ElMessage.success(`基础课程「${courseName}」已创建（${res.courseNo}）`);
    }
    emit('created');
  } catch (err) {
    /* request.ts 已弹后端原话；编号冲突再落到字段下方，避免「弹窗一闪而过、不知道错在哪个字段」 */
    const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? '');
    if (msg.includes('课程编号') || msg.includes('已被占用') || msg.includes('已存在')) {
      courseNoError.value = msg;
    }
  } finally {
    baseSaving.value = false;
  }
}

/** 第 2 步 → 第 1 步（只对本次新建流程有效；外部入口没有第 1 步） */
function backToStep1() {
  if (!created.value || props.startCourse) return;
  originCourseNo.value = String(created.value.courseNo ?? baseForm.courseNo ?? '').toUpperCase();
  editingBase.value = true;
  step.value = 1;
}

/** 回第 1 步看了但不想改：直接退回第 2 步（课程已建好，无需任何请求） */
function cancelEditBase() {
  editingBase.value = false;
  step.value = 2;
}

/* ================= step2：开课信息 ================= */

const offerForm = reactive({
  termId: '',
  teacherId: '',
  clazzIds: [] as string[],
  joinCode: ''
});
const offerSaving = ref(false);
const joinChecking = ref(false);
const joinCodeError = ref('');
const terms = ref<Term[]>([]);
const teachers = ref<AdminUserVo[]>([]);
const clazzes = ref<Clazz[]>([]);
const optionsLoading = ref(false);
/** 面向专业（2026-11-19）：改下拉，数据来自基础数据的 major 表；仍允许手填（历史专业名不在表里） */
const majors = ref<Major[]>([]);
const majorsLoading = ref(false);

/** 专业列表：第 1 步就要用，所以打开弹窗即拉，不等进第 2 步 */
async function loadMajors() {
  if (majorsLoading.value) return;
  majorsLoading.value = true;
  try {
    const res = await listMajors({ page: 1, pageSize: 200 });
    majors.value = (res?.list ?? []).filter((m) => m.status !== 'disabled');
  } catch {
    majors.value = [];
  } finally {
    majorsLoading.value = false;
  }
}

/** step2 只在持有课程（step1 成功或外部传入）时可用 */
const canOffer = computed(() => !!created.value?.courseId);
const offerFormRef = ref();

const offerRules = {
  termId: [{ required: true, message: '请选择学期', trigger: 'change' }],
  teacherId: [{ required: true, message: '请选择授课教师', trigger: 'change' }]
};

/* ================= step2 · 排课节奏（2026-11-16 业主：配置要和智能排课那边一样） =================
 * 智能排课的「自动排课」只认 offering 上的这套节奏：week_from / week_count /
 * lessons_per_week / total_lessons（见「已配置 / 未配置排课节奏」两栏的判定）。
 * 以前只能在课程详情里对每条已建配置再点「修改配置」补一遍，配一次要跑两趟；
 * 现在建配置时一并填，POST offerings 成功后立刻 PUT schedule-config，
 * 配完就能直接进智能排课的「已配置」栏。
 * 量纲与详情页一致：1 节次 = 2 学时（50 分钟 × 2 + 10 分钟课间）；total_lessons 存【节次】。
 */
const HOURS_PER_PERIOD = 2;

/* 2026-11-16 业主：「按学时算」按钮不要，直接输入总学时就行。
 * 2026-11-19 业主：学时已在第 1 步填过，第 2 步不该再填一遍 ⇒ 这里只读，直接取第 1 步的值。
 * 排课节奏只留两个可填项 —— 起始周 / 每周节次，其余全部派生：
 *   总节次 = 学时 ÷ 2（1 节次 = 50 分钟 × 2 + 10 分钟课间 = 2 学时）
 *   结束周 = 起始周 + ⌈总节次 ÷ 每周节次⌉ − 1
 * 这样不会出现「两个地方填学时、改了一处另一处没跟上」的错配。 */
const schedForm = reactive({
  weekFrom: 1,
  lessonsPerWeek: 1
});

/* 每周节次上限（2026-11-20 业主质疑「上限为什么是 7 节」）：
 * 7 是早期随手拍的数，既没有依据，也和智能排课页的 5 对不上。
 * 真正的物理上限来自排课网格：每天能排的节次数（class_period 启用行数，现网 5 节次/天）
 * × 一周 5 个工作日 = 25 节次/周；超了就是配置了一条排不下的节奏。
 * 接口拿不到节次表时按 5 节次/天兜底，与排课页的兜底网格同口径。
 * 界面上把「每天几节 × 几天」直接写出来，用户可以自己核对，不再是黑盒数字。 */
const WORKDAYS_PER_WEEK = 5;
const periodsPerDay = ref(5);
const maxLessonsPerWeek = computed(() => Math.max(1, periodsPerDay.value * WORKDAYS_PER_WEEK));

async function loadPeriodsPerDay() {
  try {
    const res = await listPeriods({ page: 1, pageSize: 20 });
    const n = (res?.list ?? []).filter((p) => p && p.seq != null).length;
    if (n > 0) periodsPerDay.value = n;
  } catch {
    /* 节次接口不可用：保持 5 节次/天兜底 */
  }
}

/**
 * 学期教学周上界（第几周为止）：`biz_config` teaching.week.from + count − 1，现网 1~18。
 * ★ 2026-11-23：原本派生一律截到硬编码的第 30 周，64 学时 × 每周 1 节 = 32 周被截成 30 周，
 * 配出来的教学班在 18 周的学期里根本排不满（还会带着一条 30 周的窗口去自动排课）。
 * 与智能排课页 `loadCourseWeekWindow` 同口径，读不到就按 18 兜底。
 */
const termWeekMax = ref(18);

async function loadTermWeekMax() {
  try {
    const res = await getTeachingWeek();
    const from = Number(res?.weekFrom ?? 1) || 1;
    const cnt = Number(res?.weekCount ?? termWeekMax.value) || termWeekMax.value;
    termWeekMax.value = from + cnt - 1;
  } catch {
    /* 配置接口不可用：保持 18 兜底 */
  }
}

watch(maxLessonsPerWeek, (m) => {
  if (schedForm.lessonsPerWeek > m) schedForm.lessonsPerWeek = m;
});

/** 课程学时：详情抽屉带进来的，或 step1 刚填的（第 2 步只读展示，用于折算节次与结束周） */
const courseHours = computed<number | null>(() => {
  const h = props.startCourse?.hours ?? baseForm.hours;
  return h == null || h === ('' as unknown) ? null : Number(h);
});

/** 外部入口（详情抽屉「为这门课开课」）进来的课可能没填学时 ⇒ 这里只提示，不给在第 2 步补填 */
const hoursMissing = computed(() => courseHours.value === null || Number(courseHours.value) <= 0);

const schedPreview = computed(() => {
  const perWeek = Math.max(1, Math.floor(Number(schedForm.lessonsPerWeek) || 1));
  const from = Math.max(1, Math.floor(Number(schedForm.weekFrom) || 1));
  const h = Number(courseHours.value);
  const hours = Number.isFinite(h) && h > 0 ? h : null;
  const periods = hours === null ? null : Math.ceil(hours / HOURS_PER_PERIOD);
  const weeks = periods === null ? null : Math.ceil(periods / perWeek);
  const rawTo = weeks === null ? null : from + weeks - 1;
  const weekTo = rawTo === null ? null : Math.min(rawTo, termWeekMax.value);
  /** 窗口内最多能排的节次 = 周跨度 × 每周节次；小于总节次 ⇒ 这学期排不完 */
  const capacity = weekTo === null ? null : (weekTo - from + 1) * perWeek;
  const shortfall = periods === null || capacity === null ? 0 : Math.max(0, periods - capacity);
  return {
    hours,
    perWeek,
    periods,
    weeks,
    from,
    weekTo,
    spanWeeks: weekTo === null ? null : weekTo - from + 1,
    capacity,
    shortfall,
    /** 算出来的结束周超出本学期教学周边界（会被截断 ⇒ 后段节次排不进去） */
    overflow: rawTo !== null && rawTo > termWeekMax.value
  };
});

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
  // 排课节奏：学时取第 1 步（只读），这里只校验「能不能算出节次与结束周」。
  // 学时为空（外部入口的老课）⇒ 算不出，直接拦住并指路。
  const { hours, periods, weekTo, spanWeeks, perWeek, capacity, shortfall } = schedPreview.value;
  if (hours === null || periods === null || weekTo === null || spanWeeks === null) {
    ElMessage.warning('这门课还没填学时，算不出结束周：请先到「课程管理 → 编辑」补学时');
    return;
  }
  // 节次铺不进本学期：先拦住，否则会存下一条「每周 N 节 × 18 周」根本排不完的配置
  if (shortfall > 0) {
    ElMessage.warning(
      `每周 ${perWeek} 节 × ${spanWeeks} 周（第 ${schedForm.weekFrom}~${weekTo} 周）最多排 ${capacity} 节次，还差 ${shortfall} 节次排不进本学期，请提高每周节次`
    );
    return;
  }
  offerSaving.value = true;
  try {
    const res = await createOffering(created.value.courseId, {
      termId: offerForm.termId,
      teacherId: offerForm.teacherId,
      clazzIds: offerForm.clazzIds.length ? offerForm.clazzIds : undefined,
      joinCode: offerForm.joinCode.trim() ? offerForm.joinCode.trim().toUpperCase() : undefined,
      weekCount: spanWeeks
    });
    // 紧接着把排课节奏写到这条新配置上（PUT schedule-config），
    // 否则智能排课那边它仍算「未配置排课节奏」，还得再回详情补一遍。
    let schedSaved = false;
    try {
      await updateOfferingScheduleConfig(res.offeringId, {
        weekFrom: schedForm.weekFrom,
        weekCount: spanWeeks,
        lessonsPerWeek: schedForm.lessonsPerWeek,
        totalLessons: periods
      });
      schedSaved = true;
    } catch {
      /* request.ts 已弹后端原话；配置本身已落库，不因此回退 */
    }
    ElMessage.success(
      schedSaved
        ? `已保存「${created.value.courseName}」的课程配置（${res.termCode}），加课码 ${res.joinCode}；排课节奏 第 ${schedForm.weekFrom}~${weekTo} 周 · 每周 ${perWeek} 节 · 共 ${periods} 节次（= ${hours} 学时）。排课请到「智能排课」页`
        : `已保存「${created.value.courseName}」的课程配置（${res.termCode}），加课码 ${res.joinCode}；排课节奏未保存，可在课程详情里补`
    );
    // 一门课可以有多条配置（2026-11-23 放开「只允许一条」）：保存即告知父页面刷新，
    // 否则从课程详情点「新增教学班」存完，抽屉里还是旧的那一条，看起来像没保存成功。
    emit('created');
    // 保存即结束直接关窗，不再追问「是否自动排课」——业主 11-16 下午反馈
    // 「点击保存怎么就排课进去了」：配置是配置、排课是排课，两件事分开。
    // 排课只发生在「智能排课」页的显式操作（自动排课 / 手动拖排）。
    close();
  } catch {
    /* request.ts 已弹后端原话（40902/40903/422 等） */
  } finally {
    offerSaving.value = false;
  }
}

/** 标题：外部入口（列表点「未配置」/ 抽屉「新增配置」）直接落在第 2 步，
 *  此时并没有在「新建课程」，标题再说新建会让人以为要重复建课。 */
const dialogTitle = computed(() => {
  if (step.value === 1) {
    return editingBase.value
      ? `修改基础信息 ·「${created.value?.courseName ?? baseForm.courseName}」`
      : '新建课程 · 第 1 步（基础信息）';
  }
  if (!created.value) return '新建课程';
  return props.startCourse
    ? `课程配置 ·「${created.value.courseName}」`
    : `新建课程 · 第 2 步（「${created.value.courseName}」课程配置）`;
});

function close() {
  emit('update:visible', false);
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    width="560px"
    :close-on-click-modal="false"
  >
    <!-- 步骤条：两步语义不同（建课 ≠ 开课），用文字标明避免误当成一个表单的两段 -->
    <div class="steps">
      <div class="step" :class="{ on: step >= 1, done: step > 1 }">1 基础课程</div>
      <div class="step-arrow">→</div>
      <div class="step" :class="{ on: step >= 2 }">2 课程配置</div>
      <span class="steps-note">
        {{
          editingBase
            ? '第 1 步已提交，这里保存是更新这门课，不会重复建课'
            : '两步各自独立提交，第 1 步成功后可直接关闭'
        }}
      </span>
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
      </el-form-item>
      <el-form-item label="课程名称" prop="courseName">
        <el-input v-model="baseForm.courseName" placeholder="1~100 字；同名课程允许（会提醒）" />
      </el-form-item>
      <!-- 面向专业（2026-11-19 业主）：从基础数据的专业表里选，不再手敲。
           仍开 allow-create：历史课里的专业名可能不在表内，改名/补录时不能被卡住。 -->
      <el-form-item label="面向专业">
        <el-select
          v-model="baseForm.major"
          placeholder="选择专业（可留空）"
          filterable
          clearable
          allow-create
          default-first-option
          :loading="majorsLoading"
          style="width: 100%"
        >
          <el-option v-for="(m, i) in majors" :key="m.majorId ?? i" :label="m.name ?? ''" :value="m.name ?? ''" />
        </el-select>
      </el-form-item>
      <el-form-item label="学分">
        <el-input-number v-model="baseForm.credit" :min="0" :max="9.9" :step="0.5" :precision="1" style="width: 140px" />
      </el-form-item>
      <el-form-item label="学时" prop="hours">
        <el-input-number v-model="baseForm.hours" :min="1" :max="999" style="width: 140px" />
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
      <!-- 排课节奏：只填 起始周 / 每周节次 / 总学时 三项，节次数与结束周自动派生。
           它同时就是这条配置的教学周数（offering.week_count = 周跨度），
           所以不再单列「教学周数」，也去掉了原来的「按学时算」按钮。 -->
      <el-form-item label="排课节奏">
        <div class="cfg-block">
          <!-- 2 列网格：标签定宽右对齐、数字框同宽左对齐（560px 弹窗里不会折行） -->
          <div class="cfg-grid">
            <div class="cfg-cell">
              <span class="cfg-lab">起始周</span>
              <el-input-number
                v-model="schedForm.weekFrom"
                class="cfg-num"
                :min="1"
                :max="30"
                controls-position="right"
              />
            </div>
            <div class="cfg-cell">
              <span class="cfg-lab">每周节次</span>
              <el-input-number
                v-model="schedForm.lessonsPerWeek"
                class="cfg-num"
                :min="1"
                :max="maxLessonsPerWeek"
                controls-position="right"
              />
            </div>
            <div class="cfg-cell">
              <span class="cfg-lab">学时</span>
              <span class="cfg-auto" :class="{ 'cfg-auto-warn': hoursMissing }">
                <template v-if="!hoursMissing">{{ schedPreview.hours }} 学时</template>
                <template v-else>该课程未填学时</template>
              </span>
            </div>
            <div class="cfg-cell">
              <span class="cfg-lab">结束周</span>
              <span class="cfg-auto">
                <template v-if="schedPreview.weekTo !== null">第 {{ schedPreview.weekTo }} 周</template>
                <span v-else class="muted">待填学时</span>
              </span>
            </div>
          </div>
          <div class="small" :class="hoursMissing || schedPreview.overflow || schedPreview.shortfall > 0 ? 'sched-warn' : 'field-tip'">
            <template v-if="schedPreview.periods !== null">
              {{ schedPreview.hours }} 学时 = {{ schedPreview.periods }} 节次（1 节次 = 2 学时：50 分钟 × 2 + 10
              分钟课间）；每周 {{ schedPreview.perWeek }} 节 ⇒ 第 {{ schedPreview.from }}~{{ schedPreview.weekTo }} 周，共
              {{ schedPreview.spanWeeks }} 教学周<template v-if="schedPreview.overflow">（超出本学期第 {{ termWeekMax }} 周边界，已截到第 {{ termWeekMax }} 周）</template>。<template
                v-if="schedPreview.shortfall > 0"
                >本学期这个窗口最多排 {{ schedPreview.capacity }} 节次，还差 {{ schedPreview.shortfall }} 节次：请提高每周节次（或把起始周提前）。</template>
            </template>
            <template v-else>
              该课程还没填学时，算不出结束周。请到「课程管理 → 编辑」补上学时后，再回来配排课节奏。
            </template>
          </div>
          <div class="field-tip">
            每周节次上限 {{ maxLessonsPerWeek }} 节（每天 {{ periodsPerDay }} 节次 × {{ WORKDAYS_PER_WEEK }} 个工作日）。
            这里只定「第几周开始、每周几节」，结束周按「学时 ÷ 2 ÷ 每周节次」自动算出；
            这段节奏会随配置一起保存，智能排课即可直接自动排这门课。
          </div>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <template v-if="step === 1">
        <el-button v-if="editingBase" @click="cancelEditBase">不修改，返回第 2 步</el-button>
        <el-button v-else @click="close">取消</el-button>
        <el-button type="primary" :loading="baseSaving" @click="submitBase">
          {{ editingBase ? '保存修改（回到第 2 步）' : '创建基础课程（进入第 2 步）' }}
        </el-button>
      </template>
      <template v-else>
        <el-button v-if="!startCourse" class="footer-back" @click="backToStep1">上一步</el-button>
        <el-button @click="close">完成并关闭</el-button>
        <el-button type="primary" :loading="offerSaving" @click="submitOffering">
          <ZkIcon name="plus" :size="14" style="margin-right: 4px" />保存配置
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
/* 第 2 步的「上一步」放左侧，和右侧的「完成并关闭 / 保存配置」分开，
   避免误点到关闭。dialog footer 是 text-align:right 的块，用 float 才是稳的。 */
.footer-back {
  float: left;
  margin-left: 0;
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
/* 排课节奏：2 列定宽网格。
   每个 cell 是「定宽标签 + 等宽数字框」，四行的框左右边缘完全对齐；
   按钮单独占一行、右对齐，不再和输入框挤在同一行折行。 */
.cfg-block {
  width: 100%;
}
.cfg-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  align-items: center;
}
.cfg-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.cfg-lab {
  flex: 0 0 56px;
  font-size: 12px;
  line-height: 1;
  color: var(--text-3, #667085);
  text-align: right;
  white-space: nowrap;
}
.cfg-num {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}
.cfg-actions {
  grid-column: 2;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.cfg-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
/* 只读派生值（结束周）：做成和数字框同宽同高的「假输入框」，
   保证这一列与上面三个可填框左右边缘一致，视觉上仍是整齐的一列。 */
.cfg-auto {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 32px;
  padding: 0 11px;
  border: 1px dashed var(--line, #e4e7ec);
  border-radius: 4px;
  background: var(--fill-1, #f7f8fa);
  font-size: 13px;
  color: var(--text, #344054);
  white-space: nowrap;
  overflow: hidden;
}
/* 学时缺失（外部入口进来的老课）——用警示色，和「待填学时」的灰提示区分开 */
.cfg-auto-warn {
  border-color: var(--warn-300, #f0c36d);
  background: var(--warn-50, #fffaf0);
  color: var(--warn-700, #8a6116);
}
/* 节次数与周跨度对不上时的提示（只提示不阻断，与详情页同口径） */
.sched-warn {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn-700, #8a6116);
}
</style>
