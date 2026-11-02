import { request } from '@/api/request';

/**
 * 系统配置（C-7/C-8）+ 敏感词库（C-9/C-10），对齐 AdminSystemConfigController。
 * 实测（2026-11-02，现役包）：25 个配置键、6 个分组（ai/quota/cert/class/security/system），
 * valueType ∈ boolean/number/string/json；items 行键 configId/configGroup/configKey/
 * configValue/valueType/editable/remark/schoolId/updateTime 全为字符串化出参。
 */

export interface ConfigItem {
  configId: string;
  schoolId: string;
  configGroup: string;
  configKey: string;
  configValue: string;
  valueType?: 'boolean' | 'number' | 'string' | 'json';
  editable?: number;
  remark?: string;
  updateTime?: string;
}

export function listConfigs() {
  return request<{ configs: Record<string, string>; items: ConfigItem[] }>({ url: '/api/v1/admin/configs', method: 'get' });
}

/** 批量写。只发改动过的键，减少无意义审计记录；单键也走这里（configKey/configValue 与批量同端点等价） */
export function updateConfigs(patch: Record<string, string>) {
  return request<boolean>({ url: '/api/v1/admin/configs', method: 'put', data: { configs: patch } });
}

export interface SensitiveWordVo {
  wordId: string;
  word: string;
  category: 'politics' | 'abuse' | 'ad' | 'custom' | string;
  wordLevel: 'high' | 'mid' | 'low' | string;
  handleAction: 'block' | 'replace' | 'audit' | string;
  replaceWord?: string;
  status: number;
}

export function listWords(query: { page?: number; pageSize?: number; keyword?: string; status?: number }) {
  return request<{ list: SensitiveWordVo[]; total: number; page: number; pageSize: number }>({
    url: '/api/v1/admin/sensitive-words',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}

export interface SensitiveWordSaveBody {
  wordId?: string;
  word: string;
  category: string;
  wordLevel: string;
  handleAction: string;
  replaceWord?: string;
  status?: number;
  /** true = 删除该词（后端 SensitiveWordBo.delete 标志位，POST 同端点承担删除） */
  delete?: boolean;
}

/** 新增（无 wordId）/ 更新（带 wordId）/ 删除（wordId + delete:true）三合一 */
export function saveWord(body: SensitiveWordSaveBody) {
  return request<{ wordId?: string; deleted?: boolean }>({ url: '/api/v1/admin/sensitive-words', method: 'post', data: body });
}
