import { request } from '@/api/request';

/**
 * 题库管理（G2）—— `AdminQuestionController`，5 条端点。
 *
 * ★ 2026-11-10 实测（现役包 a9c6a6e，课程 900001）：
 *   GET 列表返回分页壳 `{ list, total, page, pageSize }`；
 *   GET 详情 / POST 返回 `data` 直接是题目对象 / 裸 questionId（不是对象）；
 *   PUT / DELETE 返回 `data: true`。
 *
 * ★ 题库挂**基础课程**（`course.target_classes` 那套口径），不挂学期——
 *   会议 [23760]「题库和本学期没关系」。所以这里的 courseId 一定来自基础课程列表，
 *   不是"某学期的开课记录 id"。
 */

/** 题型枚举（来源后端 `QuestionCreateBo.qType` 注释，不是自己编的） */
export const Q_TYPES = [
  { value: 'single', label: '单选题' },
  { value: 'multi', label: '多选题' },
  { value: 'judge', label: '判断题' },
  { value: 'blank', label: '填空题' },
  { value: 'short', label: '简答题' },
  { value: 'program', label: '编程题' }
] as const;

export type QType = (typeof Q_TYPES)[number]['value'];

/** 题型 → 中文（列表里显示用；未知值原样返回，不吞成"未知题型"掩盖脏数据） */
export function qTypeLabel(t?: string | null): string {
  return Q_TYPES.find((x) => x.value === t)?.label ?? String(t ?? '—');
}

/** 难度 1~5 的中文口径（后端只约束区间，语义按 1 最易 / 5 最难） */
export const DIFFICULTY_OPTIONS = [
  { value: 1, label: '1 · 很易' },
  { value: 2, label: '2 · 较易' },
  { value: 3, label: '3 · 中等' },
  { value: 4, label: '4 · 较难' },
  { value: 5, label: '5 · 很难' }
];

export function difficultyLabel(d?: number | null): string {
  return DIFFICULTY_OPTIONS.find((x) => x.value === d)?.label ?? (d ? String(d) : '—');
}

/**
 * 选项元素。后端 `QuestionCreateBo.options` 是 `List<Map<String,Object>>`，
 * 注释写明"结构以 assignment.paper 与前端作答结构对齐后为准，本接口不做强校验"。
 * 实测库里就是 `{key:"A", text:"..."}` —— 这里按实测的**最小公共结构**声明，
 * 并留 `[k: string]: unknown` 兜住后端将来加的字段（如 image），编辑回存时不丢。
 */
export interface QuestionOption {
  key: string;
  text: string;
  [k: string]: unknown;
}

export interface QuestionVo {
  /** 19 位雪花主键，后端按字符串下发（实测 `"997017"` 带引号）⇒ 全程不 Number() */
  questionId: string;
  courseId: string;
  qType: string;
  difficulty?: number | null;
  content: string;
  /**
   * 选择题选项。★ 非选择题实测为 `null`（不是 `[]`），
   * 且后端解析失败时会**降级成 null**（列是 json 类型，脏数据不抛错）⇒ 前端必须容错。
   */
  options?: QuestionOption[] | null;
  answer: string;
  analysis?: string | null;
  /**
   * 判分配置（json 对象）。★ 与派单文档的措辞有出入：派单写「judge_config（判断题配置）」，
   * 但后端 `QuestionCreateBo` 注释明确它是**编程题的判题方式**
   * （`{judgeMode:"case", testCases:[...], timeLimitMs:2000}`），判断题的答案就在 `answer` 里。
   * 本页按后端口径实现：只有编程题给这块可选配置。
   */
  judgeConfig?: Record<string, unknown> | null;
  kpId?: string | null;
  defaultScore?: number | null;
  createTime?: string;
}

export interface QuestionQuery {
  page?: number;
  pageSize?: number;
  qType?: string;
  difficulty?: number | string;
  /** 知识点 id。★ 当前页面未提供该筛选项：库里 kpId 全为 null、也没有知识点查询接口，
   *  给了下拉也没选项。参数通道先留着，接口补齐后加个 select 即可。 */
  kpId?: string;
  keyword?: string;
}

/** 新增/编辑入参（courseId 在路径里，不进 body——实测 POST 就是这么做成功的） */
export interface QuestionSaveBo {
  qType: string;
  difficulty?: number;
  content: string;
  options?: QuestionOption[];
  answer: string;
  analysis?: string;
  judgeConfig?: Record<string, unknown> | null;
  kpId?: string | null;
  defaultScore?: number | null;
}

export interface QuestionPage {
  list: QuestionVo[];
  total: number;
  page: number;
  pageSize: number;
}

/** 某门课的题目分页 */
export function listQuestions(courseId: string, query: QuestionQuery = {}) {
  return request<QuestionPage>({
    url: `/api/v1/admin/courses/${courseId}/questions`,
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}

/** 题目详情 */
export function getQuestion(questionId: string) {
  return request<QuestionVo>({ url: `/api/v1/admin/questions/${questionId}`, method: 'get' });
}

/** 新增（返回新 questionId，后端给的是裸 id 不是对象） */
export function createQuestion(courseId: string, body: QuestionSaveBo) {
  return request<string>({
    url: `/api/v1/admin/courses/${courseId}/questions`,
    method: 'post',
    data: body
  });
}

/** 编辑（questionId 在路径，body 与新增同构、不含 courseId） */
export function updateQuestion(questionId: string, body: QuestionSaveBo) {
  return request<boolean>({
    url: `/api/v1/admin/questions/${questionId}`,
    method: 'put',
    data: body
  });
}

/** 软删（实测 `data: true`；题库基于基础课程，删掉后各学期同课程都看不到） */
export function removeQuestion(questionId: string) {
  return request<boolean>({ url: `/api/v1/admin/questions/${questionId}`, method: 'delete' });
}
