<script setup lang="ts">
import { useRoute } from 'vue-router';
import ZkIcon from '@/components/ZkIcon.vue';

const route = useRoute();
</script>

<template>
  <div class="page-head">
    <h1>{{ route.meta.title }}</h1>
  </div>
  <div class="card card-pad">
    <div class="center" style="padding: 30px 0">
      <div class="icon-box lg" style="margin: 0 auto 12px"><ZkIcon name="settings" :size="26" /></div>
      <div class="card-title" style="margin-bottom: 6px">该页尚未实现</div>
      <div class="muted small">12 个菜单页中已落地 6 页，本页在其余 6 页之内（路由与菜单已就位）。按原型建页后，在 <span class="mono">router/index.ts</span> 的 <span class="mono">PAGE_LOADERS</span> 补一行即可。</div>
      <div class="muted small mt8">
        对应原型：<span class="mono">UI/ui-prototype/pc/</span>
      </div>
    </div>
  </div>
</template>
