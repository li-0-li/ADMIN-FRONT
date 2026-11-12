/**
 * 管理端左侧菜单（14 项 / 5 组）
 * -----------------------------------------------------------------------------
 * 前 10 项口径取自原型 `UI/ui-prototype/assets/shell.js` 里的 MENUS.admin：
 *   标题、图标名（lucide 的 data-lucide 名）与顺序**逐项照抄**，不自行改写。
 *   原型原有 12 项，其中第 8 项「AI 工作台」已于 2026-11-09 会议 #22 摘除，
 *   「师生资料上传」已于 2026-11-10 摘除（会议 #19：师生资料并入学生管理/教师管理，
 *   原文 [20720]「师生资料上传不需要了」；资料查看随 G6 师生独立页落地）。
 * 第 12 项「课程总览」是 2026-10-29 业主新增需求（课程审核通过后从审核页移到该页），
 *   原型里没有对应项，故按同风格补齐：紧邻「课程审核」之后，图标 book-open。
 * ★ 2026-11-09 会议 #22：菜单 13 项 → 12 项、仪表盘快捷入口 9 → 8 个。
 * ★ 2026-11-10：摘「师生资料上传」→ 11 项（会议 #19）；再拆「教师管理 / 学生管理」+「题库 / 知识库」
 *   并摘「课程审核」，最终 14 项（本行口径以「实测数组长度」为准，勿再凭记忆写）
 *   路由侧本就没有 /admin/ai（grep 0 命中），无需动 router。
 * 后端目前没有菜单下发接口（整合后端无 /system/menu/getRouters），
 * 所以这是前端的静态菜单源，路由表由它生成。
 *
 * ★ 2026-11-12：菜单加「分组标题」（甲/乙两线实测：教师端 14 项也是平铺无分组，
 *   但管理端 14 项在 224px 侧栏里已连成一片、找一页要靠扫读）。
 *   分组**只为阅读服务**，不动 path / title / icon / 顺序：
 *   - 路由仍由 ADMIN_MENUS.map 生成 ⇒ 加 group 字段对 router 零影响；
 *   - 首页快捷入口仍 filter ADMIN_MENUS ⇒ 不受影响；
 *   - ADMIN_MENU_GROUPS 按数组**首次出现顺序**聚合，组内顺序＝数组顺序，
 *     所以「想调组顺序」= 调整数组里该组第一项的位置，不需要另维护一张组表。
 */
export interface AdminMenuItem {
  path: string;
  title: string;
  icon: string;
  /** 左侧栏分组标题。仅影响导航展示，不参与路由/权限 */
  group: string;
}

export const ADMIN_MENUS: AdminMenuItem[] = [
  { path: '/admin/dashboard', title: '后台管理', icon: 'layout-dashboard', group: '概览' },

  { path: '/admin/accounts', title: '账号管理', icon: 'users', group: '人员与账号' },
  // ★ 2026-11-10：师生从「账号管理」里拆出独立页（会议 #19 口径：师生资料并入教师管理/学生管理）。
  //   两页共享同一套详情组件，但菜单各自独立——教师可写、学生只读，混成一项会让权限语义含糊。
  { path: '/admin/teachers', title: '教师管理', icon: 'graduation-cap', group: '人员与账号' },
  { path: '/admin/students', title: '学生管理', icon: 'user', group: '人员与账号' },

  // ★ 2026-11-10 P-3：「课程审核」页退役——认证审核并入课程总览详情抽屉「认证材料」区
  //   （待审课程就地 通过/驳回），菜单与路由随之摘除，review 页目录删除。
  { path: '/admin/courses', title: '课程总览', icon: 'book-open', group: '教学资源' },
  // ★ 2026-11-10：题库 / 知识库都挂在基础课程上（不挂学期），所以紧邻课程总览。
  { path: '/admin/questions', title: '题库管理', icon: 'file-text', group: '教学资源' },
  { path: '/admin/knowledge', title: '知识库管理', icon: 'layers', group: '教学资源' },
  { path: '/admin/schedule', title: '智能排课', icon: 'calendar-days', group: '教学资源' },

  { path: '/admin/analytics', title: '全校学情', icon: 'bar-chart-3', group: '学情与巡查' },
  { path: '/admin/patrol', title: '课堂巡查', icon: 'list-checks', group: '学情与巡查' },

  { path: '/admin/basicdata', title: '基础数据', icon: 'database', group: '系统' },
  { path: '/admin/monitor', title: '系统监控', icon: 'activity', group: '系统' },
  { path: '/admin/logs', title: '系统日志', icon: 'history', group: '系统' },
  { path: '/admin/config', title: '系统配置', icon: 'settings', group: '系统' }
];

export interface AdminMenuGroup {
  title: string;
  items: AdminMenuItem[];
}

/** 按 group 首次出现顺序聚合。组内顺序＝ADMIN_MENUS 顺序，不额外维护映射表 */
export const ADMIN_MENU_GROUPS: AdminMenuGroup[] = ADMIN_MENUS.reduce<AdminMenuGroup[]>(
  (groups, item) => {
    const hit = groups.find(g => g.title === item.group);
    if (hit) hit.items.push(item);
    else groups.push({ title: item.group, items: [item] });
    return groups;
  },
  []
);

export const BRAND_TITLE = '智能教学辅助平台';
export const BRAND_SHORT = '智课平台';
