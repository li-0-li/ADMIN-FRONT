import { request } from '@/api/request';

/** C-23 删除课程：软删主记录 + 级联软删该课程名下全部课次（后端 Service 内做） */
export function deleteCourse(courseId: number) {
  return request<boolean>({ url: `/api/v1/admin/courses/${courseId}`, method: 'delete' });
}
