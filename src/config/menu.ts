/**
 * 管理端左侧菜单（11 项）
 * -----------------------------------------------------------------------------
 * 前 10 项口径取自原型 `UI/ui-prototype/assets/shell.js` 里的 MENUS.admin：
 *   标题、图标名（lucide 的 data-lucide 名）与顺序**逐项照抄**，不自行改写。
 *   原型原有 12 项，其中第 8 项「AI 工作台」已于 2026-11-09 会议 #22 摘除，
 *   「师生资料上传」已于 2026-11-10 摘除（会议 #19：师生资料并入学生管理/教师管理，
 *   原文 [20720]「师生资料上传不需要了」；资料查看随 G6 师生独立页落地）。
 * 第 12 项「课程总览」是 2026-10-29 业主新增需求（课程审核通过后从审核页移到该页），
 *   原型里没有对应项，故按同风格补齐：紧邻「课程审核」之后，图标 book-open。
 * ★ 2026-11-09 会议 #22：菜单 13 项 → 12 项、仪表盘快捷入口 9 → 8 个。
 * ★ 2026-11-10：摘「师生资料上传」→ 11 项（会议 #19）。
 *   路由侧本就没有 /admin/ai（grep 0 命中），无需动 router。
 * 后端目前没有菜单下发接口（整合后端无 /system/menu/getRouters），
 * 所以这是前端的静态菜单源，路由表由它生成。
 */
export interface AdminMenuItem {
  path: string;
  title: string;
  icon: string;
}

export const ADMIN_MENUS: AdminMenuItem[] = [
  { path: '/admin/dashboard', title: '后台管理', icon: 'layout-dashboard' },
  { path: '/admin/accounts', title: '账号管理', icon: 'users' },
  { path: '/admin/review', title: '课程审核', icon: 'badge-check' },
  { path: '/admin/courses', title: '课程总览', icon: 'book-open' },
  { path: '/admin/schedule', title: '智能排课', icon: 'calendar-days' },
  { path: '/admin/analytics', title: '全校学情', icon: 'bar-chart-3' },
  { path: '/admin/patrol', title: '课堂巡查', icon: 'list-checks' },
  { path: '/admin/basicdata', title: '基础数据', icon: 'database' },
  { path: '/admin/monitor', title: '系统监控', icon: 'activity' },
  { path: '/admin/logs', title: '系统日志', icon: 'history' },
  { path: '/admin/config', title: '系统配置', icon: 'settings' }
];

export const BRAND_TITLE = '智能教学辅助平台';
export const BRAND_SHORT = '智课平台';
