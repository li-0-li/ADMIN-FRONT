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
 * ★ 后端**没有**上传/新增文档端点（依赖 MinIO，本机未部署）⇒ 页面只做查看 + 删除，
 *   上传入口是禁用态并写明原因，不做点了没反应的假按钮。
 */

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
