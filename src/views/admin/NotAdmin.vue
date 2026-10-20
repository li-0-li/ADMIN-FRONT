<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store/user';

const router = useRouter();
const userStore = useUserStore();

const roleText = computed(() => {
  const roles = userStore.roles ?? [];
  if (roles.includes('teacher')) return '教师';
  if (roles.includes('student')) return '学生';
  return roles.length ? roles.join('、') : '无管理端权限';
});

const targetText = computed(() => {
  const roles = userStore.roles ?? [];
  if (roles.includes('teacher')) return '教师端（教师小程序 / 教师 PC）';
  if (roles.includes('student')) return '学生端（学生小程序 / 学生 PC）';
  return '对应的业务端';
});

async function goLogout() {
  await userStore.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="na-wrap">
    <div class="na-card">
      <div class="na-icon">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <h2 class="na-title">该账号不是管理端账号</h2>
      <p class="na-text">
        当前登录的角色是「{{ roleText }}」，管理端仅供管理员使用。<br />
        请前往{{ targetText }}登录使用。
      </p>
      <el-button type="primary" @click="goLogout">退出登录</el-button>
      <p class="na-tip">如认为角色分配有误，请联系超级管理员在「账号管理」中调整。</p>
    </div>
  </div>
</template>

<style scoped>
.na-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-soft, #f5f6f8);
}
.na-card {
  width: 420px;
  padding: 44px 40px 32px;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 6px 28px rgb(0 0 0 / 7%);
  text-align: center;
}
.na-icon {
  width: 72px;
  height: 72px;
  margin: 0 auto 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand, #3b6cf5);
  background: rgb(59 108 245 / 9%);
}
.na-title {
  margin: 0 0 12px;
  font-size: 19px;
}
.na-text {
  margin: 0 0 24px;
  line-height: 1.9;
  color: var(--ink-500, #6b7280);
  font-size: 14px;
}
.na-tip {
  margin: 18px 0 0;
  font-size: 12px;
  color: var(--ink-400, #9ca3af);
}
</style>
