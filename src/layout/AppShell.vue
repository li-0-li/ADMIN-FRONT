<script setup lang="ts">
import AppSidebar from '@/layout/AppSidebar.vue';
import AppTopbar from '@/layout/AppTopbar.vue';
</script>

<template>
  <div class="shell">
    <AppTopbar />
    <AppSidebar />
    <main class="main">
      <router-view />
    </main>
  </div>
</template>
