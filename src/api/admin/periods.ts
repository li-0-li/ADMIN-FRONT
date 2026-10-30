import { request } from '@/api/request';

/**
 * G8 节次列表（后端 2026-10-28 交付，AdminPeriodController）。
 * 契约实测样本见 工作汇报/20261028-后端-G8节次列表接口交付说明.md（8081 实打）。
 *
 * ★ 三个字段名陷阱（都实测过，别按直觉写）：
 * 1. `periodNo` 是 **"1-2" 这类展示串**，不是节次序号；与课次数据 schedule.periodNo
 *    （数字 1-5）对得上的是 `seq`。排课页映射键用 seq，按字面用 periodNo 会全部 miss。
 * 2. `periodId` 是字符串（@JsonFormat(shape=STRING)），19 位大数转 Number 会丢精度 ⇒
 *    原样保留、比较用字符串。本页当前用不到它，声明出来只是防后续误用。
 * 3. `seq` 实测是数字（无引号）；保险起见消费侧仍 Number() 归一。
 */
export interface AdminPeriodVo {
  periodId: string;
  /** 展示串，如 "1-2" / "9-10" */
  periodNo: string;
  /** 展示名，如 "1-2节" / "晚 9-10 节"（晚课命名带"晚"字，页面据此推导 evening 样式） */
  periodName: string;
  /** 节次序号 1-5，与课次数据的 periodNo 字段同域 */
  seq: number;
  /** "HH:mm" */
  startTime: string;
  endTime: string;
}

export interface PageShell<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** page/pageSize 后端可缺省（归一为 1/10）；全量就 5 行，10 足够，不翻页
 *  ★ silent: true（2026-10-30 修 P1-2）：本请求是「接口主源 + 本地兜底」的可降级请求——
 *    旧运行包没有这个端点，回的是 HTTP 200 + code:500「No static resource…」，
 *    解包层会把它当业务失败弹英文 toast，页面级 catch 吞不掉（toast 在更底层已经弹出）。
 *    传 silent 后失败只 throw，由排课页 catch 走本地兜底 + 顶部业务化提示条。 */
export function listPeriods(params?: { page?: number; pageSize?: number }) {
  return request<PageShell<AdminPeriodVo>>({
    url: '/api/v1/admin/periods',
    method: 'get',
    params: { page: 1, pageSize: 10, ...params },
    silent: true
  });
}
