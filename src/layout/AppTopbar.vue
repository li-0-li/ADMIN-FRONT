<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { BRAND_TITLE } from '@/config/menu';
import { useUserStore } from '@/store/user';

const userStore = useUserStore();

const displayName = computed(() => userStore.nickName || userStore.username || '管理员');
const initial = computed(() => displayName.value.slice(0, 1) || '管');

/** 消息中心 / 个人资料：后端尚未提供对应接口，按缺口提示处理（不做假数据） */
function notImplemented(label: string) {
  ElMessage.info(`${label}：后端暂未提供接口（当前按缺口处理，未接入假数据）`);
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo"><ZkIcon name="graduation-cap" :size="18" /></span>
      <span>{{ BRAND_TITLE }}</span>
    </div>
    <div class="spacer" />
    <button class="icon-btn" title="消息通知" @click="notImplemented('消息中心')">
      <ZkIcon name="bell" :size="18" />
      <span class="dot" />
    </button>
    <div class="user" style="cursor: pointer" title="个人资料" @click="notImplemented('个人资料')">
      <span class="avatar sm">{{ initial }}</span>
      <span>{{ displayName }}</span>
    </div>
  </header>
</template>
