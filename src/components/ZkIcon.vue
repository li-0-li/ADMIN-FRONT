<script setup lang="ts">
import { computed, type Component } from 'vue';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  BadgeCheck,
  Ban,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileText,
  GraduationCap,
  GripVertical,
  History,
  Image as ImageIcon,
  Info,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  Move,
  Pencil,
  Plus,
  Power,
  Presentation,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Table,
  Trash2,
  Undo2,
  Upload,
  UploadCloud,
  User,
  Users,
  Video,
  X,
  Zap
} from 'lucide-vue-next';

/**
 * 原型是用 `<i data-lucide="trash-2">` 这种写法调 lucide 的（CDN UMD）。
 * Vue 里改成白名单组件表：只用到的图标进包，名字口径与原型 data-lucide 完全一致，
 * 便于页面标记直接照抄原型。
 */
const ICONS: Record<string, Component> = {
  activity: Activity,
  'alert-triangle': AlertTriangle,
  'arrow-left': ArrowLeft,
  'arrow-left-right': ArrowLeftRight,
  'badge-check': BadgeCheck,
  ban: Ban,
  'bar-chart-3': BarChart3,
  bell: Bell,
  'book-open': BookOpen,
  'calendar-days': CalendarDays,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  clock: Clock,
  copy: Copy,
  database: Database,
  download: Download,
  'external-link': ExternalLink,
  eye: Eye,
  'file-text': FileText,
  'graduation-cap': GraduationCap,
  'grip-vertical': GripVertical,
  history: History,
  image: ImageIcon,
  info: Info,
  'key-round': KeyRound,
  layers: Layers,
  'layout-dashboard': LayoutDashboard,
  'list-checks': ListChecks,
  'log-out': LogOut,
  mail: Mail,
  'map-pin': MapPin,
  'message-circle': MessageCircle,
  move: Move,
  pencil: Pencil,
  plus: Plus,
  power: Power,
  presentation: Presentation,
  'refresh-cw': RefreshCw,
  search: Search,
  settings: Settings,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  sparkles: Sparkles,
  table: Table,
  'trash-2': Trash2,
  'undo-2': Undo2,
  upload: Upload,
  'upload-cloud': UploadCloud,
  user: User,
  users: Users,
  video: Video,
  x: X,
  zap: Zap
};

const props = withDefaults(defineProps<{ name: string; size?: number | string }>(), { size: 18 });

const icon = computed<Component | null>(() => ICONS[props.name] ?? null);
const px = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <component :is="icon" v-if="icon" class="zk-icon" :size="size" />
  <span v-else class="zk-icon zk-icon--missing" :style="{ width: px, height: px }" :title="`未登记图标：${name}`" />
</template>

<style>
.zk-icon {
  display: inline-block;
  vertical-align: middle;
  flex: none;
}
.zk-icon--missing {
  background: currentColor;
  opacity: 0.12;
  border-radius: 3px;
}
</style>
