<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { ADMIN_MENUS } from '@/config/menu';
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
      <RouterLink
        v-for="item in ADMIN_MENUS"
        :key="item.path"
        class="menu-item"
        :class="{ active: activePath === item.path }"
        :to="item.path"
      >
        <ZkIcon :name="item.icon" />
        <span>{{ item.title }}</span>
      </RouterLink>
    </nav>
    <div class="foot">
      <button type="button" class="menu-item" @click="onLogout">
        <ZkIcon name="log-out" />
        <span>退出登录</span>
      </button>
    </div>
  </aside>
</template>
