/**
 * 管理端左侧菜单（12 项）
 * -----------------------------------------------------------------------------
 * 口径直接取自原型 `UI/ui-prototype/assets/shell.js` 里的 MENUS.admin：
 *   标题、图标名（lucide 的 data-lucide 名）与顺序**逐项照抄**，不自行改写。
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
  { path: '/admin/schedule', title: '智能排课', icon: 'calendar-days' },
  { path: '/admin/analytics', title: '全校学情', icon: 'bar-chart-3' },
  { path: '/admin/patrol', title: '课堂巡查', icon: 'list-checks' },
  { path: '/admin/ai', title: 'AI 工作台', icon: 'sparkles' },
  { path: '/admin/basicdata', title: '基础数据', icon: 'database' },
  { path: '/admin/data-upload', title: '师生资料上传', icon: 'upload-cloud' },
  { path: '/admin/monitor', title: '系统监控', icon: 'activity' },
  { path: '/admin/logs', title: '系统日志', icon: 'history' },
  { path: '/admin/config', title: '系统配置', icon: 'settings' }
];

export const BRAND_TITLE = '智能教学辅助平台';
export const BRAND_SHORT = '智课平台';
