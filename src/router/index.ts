import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import AppShell from '@/layout/AppShell.vue';
import { ADMIN_MENUS } from '@/config/menu';
import { useUserStore } from '@/store/user';

/**
 * 已实现页面（本轮 3 页）。其余 9 页先挂占位页，路由与菜单一次到位，
 * 后续逐页替换 PAGE_LOADERS 里的一行即可，不动路由结构。
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
  history: createWebHistory(),
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

  return true;
});

router.afterEach(to => {
  const title = (to.meta.title as string | undefined) ?? '';
  document.title = title ? `${title} · 智课平台管理端` : '智课平台管理端';
});

export default router;
