<script setup lang="ts">
/**
 * G6 · 教师管理（2026-11-10 派单）
 * 页面本体只有一句：把共用骨架设成 teacher 模式。
 * 教师**可读可写**（PUT /api/v1/admin/teachers/{id}/profile，当前后端有缺陷，见 api/admin/profiles.ts）。
 */
import PeopleManager from '@/components/PeopleManager.vue';
</script>

<template>
  <PeopleManager mode="teacher" />
</template>
