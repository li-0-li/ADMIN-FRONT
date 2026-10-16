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
export function deleteSchool(schoolId: number) {
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
export function deleteMajor(majorId: number) {
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
export function deleteClazz(clazzId: number) {
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
export function deleteTerm(termId: number) {
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
export function deleteClassroom(classroomId: number) {
  return request<boolean>({ url: `/api/v1/admin/classrooms/${classroomId}`, method: 'delete' });
}
