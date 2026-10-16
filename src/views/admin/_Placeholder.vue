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
      <div class="card-title" style="margin-bottom: 6px">该页尚未接入</div>
      <div class="muted small">本轮先搭骨架、跑通 3 个页面；本页按原型逐个实现时替换即可（路由与菜单已就位）。</div>
      <div class="muted small mt8">
        对应原型：<span class="mono">UI/ui-prototype/pc/</span>
      </div>
    </div>
  </div>
</template>
