import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import AppShell from '@/layout/AppShell.vue';
import { ADMIN_MENUS } from '@/config/menu';
import { useUserStore } from '@/store/user';

/**
 * 页面加载器：**按目录自动发现**，不再手工登记（2026-10-28 方案 A，业主批准）。
 * -----------------------------------------------------------------------------
 * 改前是手写的 6 条 import 映射，新增页面必须回来补一行；三线并行时两个人同时补，
 * 后保存的会把先保存的那行**静默覆盖**——页面照常起，只是没登记的那页永远落回占位页，
 * 要等验收才发现。改成目录扫描后，新增一页只需建 `views/admin/<页>/index.vue`，本文件永不再改。
 *
 * 三条约束，改这段之前必须知道：
 * 1) `import.meta.glob` 的路径必须是**相对或绝对路径**，不支持 `@` 别名（它是构建期静态分析，
 *    不走 tsconfig/vite 的 alias 解析）；
 * 2) 默认是**懒加载**（等价于每条都写 `() => import(...)`），仍按页分包，
 *    不会把 12 页打进同一个 chunk；
 * 3) 只匹配 `views/admin/<子目录>/index.vue`，所以同级的 `_Placeholder.vue` 与 `NotAdmin.vue`
 *    不会被纳入——兜底逻辑（下面 `?? PlaceholderPage`）保持不变。
 */
const PAGE_MODULES = import.meta.glob('../views/admin/*/index.vue');

const PAGE_LOADERS: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(PAGE_MODULES).map(
    // 返回值必须显式标成元组：不标的话 TS 会把 `[string, loader]` 推成联合数组，
    // Object.fromEntries 的签名对不上，编译期直接报错。
    ([file, loader]): [string, () => Promise<unknown>] => [
      // '../views/admin/logs/index.vue' → '/admin/logs'
      `/admin/${file.replace('../views/admin/', '').replace('/index.vue', '')}`,
      loader
    ]
  )
);

const PlaceholderPage = () => import('@/views/admin/_Placeholder.vue');

// 注意：回调必须显式标注返回类型。否则 TS 会把对象字面量拿去逐个匹配
// RouteRecordRaw 的联合成员，并因“缺 redirect”把它误判成 RouteRecordRedirect 而报错。
const adminChildren: RouteRecordRaw[] = ADMIN_MENUS.map(
  (item): RouteRecordRaw => ({
    path: item.path.replace('/admin/', ''),
    name: `Admin${item.path.replace('/admin/', '').replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}`,
    component: PAGE_LOADERS[item.path] ?? PlaceholderPage,
    meta: { title: item.title, icon: item.icon, menuPath: item.path }
  })
);

// 角色管理：独立页但刻意不进 ADMIN_MENUS（左侧菜单无此项），
// 入口在账号管理页头部「角色管理」按钮跳入
adminChildren.push({
  path: 'roles',
  name: 'AdminRoles',
  component: () => import('@/views/admin/roles/index.vue'),
  meta: { title: '角色管理', icon: 'shield-check' }
});

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录' }
  },
  {
    // 资源预览：独立全屏页（不套 AppShell），对应原型 pc/resource-preview.html
    path: '/resource-preview',
    name: 'ResourcePreview',
    component: () => import('@/views/ResourcePreview.vue'),
    meta: { title: '资源预览' }
  },
  {
    // 非管理员登录提示页：教师/学生账号登进管理端时落地
    path: '/not-admin',
    name: 'NotAdmin',
    component: () => import('@/views/admin/NotAdmin.vue'),
    meta: { title: '无管理端权限' }
  },
  {
    path: '/admin',
    component: AppShell,
    redirect: '/admin/dashboard',
    children: adminChildren
  },
  {
    path: '/',
    redirect: '/admin/dashboard'
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/admin/dashboard'
  }
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ left: 0, top: 0 })
});

router.beforeEach(async to => {
  const userStore = useUserStore();

  if (to.path === '/login') {
    return userStore.token ? { path: '/admin/dashboard' } : true;
  }

  if (!userStore.token) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  // 刷新后 pinia 是空壳（仅 token 在 localStorage）：补拉用户信息，
  // 身份判定（是否超管）与权限校验 hasPermi 都依赖它。失败则踢回登录。
  if (!userStore.permissions.length) {
    try {
      await userStore.fetchUserInfo();
    } catch {
      userStore.logout();
      return { path: '/login', query: { redirect: to.fullPath } };
    }
  }

  // 非管理员（教师/学生等业务角色）登进管理端：导流提示页，
  // 管理端菜单对他们本就近乎空白。超管（*:*:*）与管理员角色（admin）放行。
  const isAdminAccount =
    userStore.roles.includes('admin') || userStore.permissions.includes('*:*:*');
  if (!isAdminAccount && to.path !== '/not-admin') {
    return { path: '/not-admin' };
  }
  if (isAdminAccount && to.path === '/not-admin') {
    return { path: '/admin/dashboard' };
  }

  return true;
});

router.afterEach(to => {
  const title = (to.meta.title as string | undefined) ?? '';
  document.title = title ? `${title} · 智课平台管理端` : '智课平台管理端';
});

export default router;
