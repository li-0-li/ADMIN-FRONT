import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import AppShell from '@/layout/AppShell.vue';
import { ADMIN_MENUS } from '@/config/menu';
import { useUserStore } from '@/store/user';

/**
 * 已实现页面（12 个菜单页中的 6 页）。其余 6 页挂占位页，路由与菜单一次到位，
 * 后续逐页在此表补一行即可，不动路由结构。
 */
const PAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  '/admin/dashboard': () => import('@/views/admin/dashboard/index.vue'),
  '/admin/accounts': () => import('@/views/admin/accounts/index.vue'),
  '/admin/review': () => import('@/views/admin/review/index.vue'),
  '/admin/schedule': () => import('@/views/admin/schedule/index.vue'),
  '/admin/analytics': () => import('@/views/admin/analytics/index.vue'),
  '/admin/basicdata': () => import('@/views/admin/basicdata/index.vue')
};

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
