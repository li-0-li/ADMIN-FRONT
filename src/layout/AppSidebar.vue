<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';
import { ADMIN_MENUS } from '@/config/menu';
import { useUserStore } from '@/store/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const activePath = computed(() => route.path);

function go(path: string) {
  if (route.path !== path) router.push(path);
}

async function onLogout() {
  await userStore.logout();
  router.replace('/login');
}
</script>

<template>
  <aside class="sidebar">
    <nav class="menu">
      <a
        v-for="item in ADMIN_MENUS"
        :key="item.path"
        class="menu-item"
        :class="{ active: activePath === item.path }"
        href="javascript:void(0)"
        @click="go(item.path)"
      >
        <ZkIcon :name="item.icon" />
        <span>{{ item.title }}</span>
      </a>
    </nav>
    <div class="foot">
      <a class="menu-item" href="javascript:void(0)" @click="onLogout">
        <ZkIcon name="log-out" />
        <span>退出登录</span>
      </a>
    </div>
  </aside>
</template>
