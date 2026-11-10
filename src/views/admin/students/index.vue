<script setup lang="ts">
/**
 * G6 · 学生管理（2026-11-10 派单）
 * 学生**只读**：后端只有 `GET /students/{id}/profile`，没有 PUT。
 * 页面不提供编辑入口（不是禁用态糊弄），并在面板里直接写明「本期只读」的原因。
 */
import PeopleManager from '@/components/PeopleManager.vue';
</script>

<template>
  <PeopleManager mode="student" />
</template>
