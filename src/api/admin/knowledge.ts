import { request } from '@/api/request';

/**
 * 知识库管理（G3）—— `AdminKnowledgeController`，4 条端点，2026-11-10 全部实测。
 *
 * ★ 与派单文档的偏差（以实测为准）：
 *  - 两个 GET 返回的是**裸数组**（`data: [...]`），不是分页壳 ⇒ 没有 page/pageSize；
 *  - `DELETE .../kb/sources` **必须带 query 参数 `sourceFile`**（不带会 500：
 *    `Required request parameter 'sourceFile' ... is not present`）。
 *    ★ 文件名含中文/空格时必须 `encodeURIComponent`，否则 Tomcat 直接 400（实测踩到）；
 *  - `DELETE .../kb/chunks/{chunkId}` 返回 `data: true`，`DELETE .../kb/sources` 返回
 *    `data: <删除的 chunk 条数>`（实测 1）。
 *
 * ★ 2026-11-13 更正一条旧结论：原写「后端**没有**上传端点」。实测 api-docs 里
 *   `POST /api/v1/admin/courses/{courseId}/kb/docs` **在线**（`AdminKnowledgeController.uploadDoc`，
 *   权限点 `admin:kb:upload`），dispatcher 能进到业务层 —— 早先看到的"Content-Type 错误"
 *   是因为用 JSON 发的，不是端点不存在。所以上传按钮**已解禁**，见 `uploadKbDoc()`。
 *
 * ★ 但**存储可能不可用**：附件/文档落 MinIO（`storage.mode=auto` 时没配 endpoint 才降级本地盘）。
 *   本机实测该端点回 `{"msg":"文件保存失败","code":500}` ⇒ 抽取↔分块都过了，卡在 `storage.upload()`。
 *   这是**环境问题**（MinIO 没起 / storage.mode 没切 local），不是接口坏、也不是前端没传对。
 */

/** 上传支持的扩展名（后端 KbDocumentParser.SUPPORTED_EXTENSIONS，传别的不等到上传完就被拒） */
export const KB_UPLOAD_ACCEPT = '.txt,.md,.docx,.pdf';
/** 后端 MAX_FILE_BYTES 同口径：前端先挡一道，省一次白传 */
export const KB_MAX_BYTES = 20 * 1024 * 1024;

/** 上传结果：{docId?, chunks?, sourceFile?} —— 字段随后端实现走，前端只用得到"成功/条数" */
export interface KbUploadResult {
  resourceId?: string | number;
  docId?: string | number;
  sourceFile?: string | null;
  chunkCount?: number | null;
  chunks?: number | null;
}

/** 文档源（接口按 `source_file` 聚合出的行） */
export interface KbSource {
  sourceFile: string;
  chunkCount: number;
  tokenCount?: number | null;
  /** ready / pending / failed；聚合口径由后端决定（实测两条 chunk 都是 ready，源上仍可能给 failed） */
  indexStatus?: string | null;
  /** 后端给的排序权重，越大越靠后（实测 failed 的源 statusRank=4） */
  statusRank?: number | null;
  lastIndexedAt?: string | null;
}

/** 单个分块 */
export interface KbChunk {
  /** ★ 实测是**数字**（自增小整数 1、2），不像题库 questionId 那样是字符串；
   *  类型留 number | string，调用方一律 String() 归一后再比较/拼 URL */
  chunkId: number | string;
  courseId?: string | null;
  sourceFile?: string | null;
  content: string;
  chunkIndex: number;
  tokenCount?: number | null;
  indexStatus?: string | null;
  createTime?: string | null;
}

/** 索引状态 → 中文 + 颜色语义（未知值原样显示，不吞成"未知"） */
export const INDEX_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'error' }> = {
  ready: { label: '已入库', tone: 'ok' },
  indexed: { label: '已入库', tone: 'ok' },
  pending: { label: '待处理', tone: 'warn' },
  indexing: { label: '处理中', tone: 'warn' },
  failed: { label: '失败', tone: 'error' }
};

export function indexStatusView(s?: string | null) {
  const key = String(s ?? '').trim();
  return INDEX_STATUS[key] ?? { label: key || '—', tone: 'warn' as const };
}

export function listKbSources(courseId: string) {
  return request<KbSource[]>({ url: `/api/v1/admin/courses/${courseId}/kb/sources`, method: 'get' });
}

export function listKbChunks(courseId: string) {
  return request<KbChunk[]>({ url: `/api/v1/admin/courses/${courseId}/kb/chunks`, method: 'get' });
}

/** 删整个文档源（该文件下的全部分块）。★ sourceFile 必须 URL 编码，中文名不编码会被 Tomcat 打 400。 */
export function removeKbSource(courseId: string, sourceFile: string) {
  return request<number>({
    url: `/api/v1/admin/courses/${courseId}/kb/sources`,
    method: 'delete',
    params: { sourceFile }
  });
}

/** 删单个分块 */
export function removeKbChunk(chunkId: number | string) {
  return request<boolean>({ url: `/api/v1/admin/kb/chunks/${String(chunkId)}`, method: 'delete' });
}

/**
 * A16 上传知识库文档（multipart）。后端同步抽文本 + 分块，返回时 sources/chunks 立刻可查。
 * ★ 参数名必须是 `file`（`@RequestParam("file")`），改成别的后端直接 400。
 * ★ 支持 txt / md / docx / pdf；**同名文档后端会拒绝**（"该课程已存在同名文档…先删除旧文档"），
 *   所以这里不覆盖、不重试，把后端的原话透给用户。
 * ★ 存储不可用时后端回 `文件保存失败`（不是 404、不是 Content-Type 错）——
 *   调用方要按"环境问题"提示，别让用户以为是网络。
 */
export function uploadKbDoc(courseId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return request<KbUploadResult>({
    url: `/api/v1/admin/courses/${courseId}/kb/docs`,
    method: 'post',
    data: form,
    // 大文件（20MB）抽文本 + 分块要时间，默认超时不够
    timeout: 120000
  });
}
