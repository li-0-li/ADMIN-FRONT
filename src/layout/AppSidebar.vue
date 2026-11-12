<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { ADMIN_MENU_GROUPS } from '@/config/menu';
import { useUserStore } from '@/store/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const activePath = computed(() => route.path);

async function onLogout() {
  await userStore.logout();
  router.replace('/login');
}
</script>

<template>
  <aside class="sidebar">
    <nav class="menu">
      <!-- 分组只为阅读服务：组标题不参与路由，点不动，也不显示数量 -->
      <div v-for="g in ADMIN_MENU_GROUPS" :key="g.title" class="menu-group">
        <div class="menu-group-title">{{ g.title }}</div>
        <RouterLink
          v-for="item in g.items"
          :key="item.path"
          class="menu-item"
          :class="{ active: activePath === item.path }"
          :to="item.path"
        >
          <ZkIcon :name="item.icon" />
          <span>{{ item.title }}</span>
        </RouterLink>
      </div>
    </nav>
    <div class="foot">
      <button type="button" class="menu-item" @click="onLogout">
        <ZkIcon name="log-out" />
        <span>退出登录</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* 分组样式写在本组件内、不走 src/styles（那是共享禁改区）。
   分段滚动：窗口变矮时 14 项 + 5 组标题会超出侧栏高度，必须能滚。 */
.menu {
  overflow-y: auto;
  overflow-x: hidden;
}
.menu-group + .menu-group {
  margin-top: 2px;
}
.menu-group-title {
  padding: 10px 12px 3px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
  letter-spacing: 0.4px;
  color: var(--ink-400);
  user-select: none;
}
.menu-group:first-child .menu-group-title {
  padding-top: 2px;
}
</style>
