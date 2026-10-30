import { request } from '@/api/request';
import type { BasicDataQuery, Classroom, Clazz, Major, PageResult, School, Term } from '@/types/admin';

/* ---------------- 学校 ---------------- */
export function listSchools(query: BasicDataQuery) {
  return request<PageResult<School>>({
    url: '/api/v1/admin/schools',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}
export function createSchool(body: School) {
  return request<School>({ url: '/api/v1/admin/schools', method: 'post', data: body });
}
export function updateSchool(body: School) {
  return request<boolean>({ url: `/api/v1/admin/schools/${body.schoolId}`, method: 'put', data: body });
}
/*
 * 删除/更新路径参数用 string：后端主键是 19 位雪花 id，且 10-28 起出参已字符串化
 * （@JsonFormat(STRING)）。历史版本这里写 number 并在页面层 Number(row.id) 强转，
 * 19 位 id 会先被 Number() 截断再拼进 URL，删除永远 404 —— 两边都不许再出现 number。
 */
export function deleteSchool(schoolId: string) {
  return request<boolean>({ url: `/api/v1/admin/schools/${schoolId}`, method: 'delete' });
}

/* ---------------- 专业 ---------------- */
export function listMajors(query: BasicDataQuery) {
  return request<PageResult<Major>>({
    url: '/api/v1/admin/majors',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}
export function createMajor(body: Major) {
  return request<Major>({ url: '/api/v1/admin/majors', method: 'post', data: body });
}
export function updateMajor(body: Major) {
  return request<boolean>({ url: `/api/v1/admin/majors/${body.majorId}`, method: 'put', data: body });
}
export function deleteMajor(majorId: string) {
  return request<boolean>({ url: `/api/v1/admin/majors/${majorId}`, method: 'delete' });
}

/* ---------------- 班级 ---------------- */
export function listClasses(query: BasicDataQuery) {
  return request<PageResult<Clazz>>({
    url: '/api/v1/admin/classes',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}
export function createClazz(body: Clazz) {
  return request<Clazz>({ url: '/api/v1/admin/classes', method: 'post', data: body });
}
export function updateClazz(body: Clazz) {
  return request<boolean>({ url: `/api/v1/admin/classes/${body.clazzId}`, method: 'put', data: body });
}
export function deleteClazz(clazzId: string) {
  return request<boolean>({ url: `/api/v1/admin/classes/${clazzId}`, method: 'delete' });
}

/* ---------------- 学期 ---------------- */
export function listTerms(query: BasicDataQuery) {
  return request<PageResult<Term>>({
    url: '/api/v1/admin/terms',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}
export function createTerm(body: Term) {
  return request<Term>({ url: '/api/v1/admin/terms', method: 'post', data: body });
}
export function updateTerm(body: Term) {
  return request<boolean>({ url: `/api/v1/admin/terms/${body.termId}`, method: 'put', data: body });
}
export function deleteTerm(termId: string) {
  return request<boolean>({ url: `/api/v1/admin/terms/${termId}`, method: 'delete' });
}

/* ---------------- 教室（C-21，2026-10-15） ---------------- */
export function listClassrooms(query: BasicDataQuery) {
  return request<PageResult<Classroom>>({
    url: '/api/v1/admin/classrooms',
    method: 'get',
    params: { page: 1, pageSize: 10, ...query }
  });
}
export function createClassroom(body: Classroom) {
  return request<Classroom>({ url: '/api/v1/admin/classrooms', method: 'post', data: body });
}
export function updateClassroom(body: Classroom) {
  return request<boolean>({ url: `/api/v1/admin/classrooms/${body.classroomId}`, method: 'put', data: body });
}
export function deleteClassroom(classroomId: string) {
  return request<boolean>({ url: `/api/v1/admin/classrooms/${classroomId}`, method: 'delete' });
}
