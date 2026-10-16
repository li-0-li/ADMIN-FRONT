<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { apiCaptcha } from '@/api/auth';
import ZkIcon from '@/components/ZkIcon.vue';
import { useUserStore } from '@/store/user';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

/** 身份：本工程是管理端前端，仅「管理员」可登录；另两个身份保留视觉、点了给明确说明 */
const role = ref<'admin' | 'teacher' | 'student'>('admin');
const ROLE_ITEMS = [
  { key: 'admin', label: '管理员', desc: '后台管理', icon: 'shield-check' },
  { key: 'teacher', label: '老师', desc: '教学工作台', icon: 'presentation' },
  { key: 'student', label: '学生', desc: '学习中心', icon: 'graduation-cap' }
] as const;

/** 登录方式：密码登录已通后端；验证码登录后端未提供，按缺口处理 */
const mode = ref<'pwd' | 'mail' | 'phone'>('pwd');

const form = reactive({ username: '', password: '', code: '' });
const captcha = reactive({ enabled: false, uuid: '', img: '' });
const loading = ref(false);

const hint = computed(() =>
  role.value === 'admin' ? '以管理员身份登录，进入管理后台' : '本工程为管理端前端，仅支持管理员登录'
);

function pickRole(key: 'admin' | 'teacher' | 'student') {
  role.value = key;
  if (key !== 'admin') ElMessage.info('本工程是管理端前端，只提供管理员登录入口');
}

async function loadCaptcha() {
  try {
    const res = await apiCaptcha();
    captcha.enabled = Boolean(res.captchaEnabled);
    captcha.uuid = String(res.uuid ?? '');
    captcha.img = String(res.img ?? '');
  } catch {
    captcha.enabled = false;
  }
}

onMounted(loadCaptcha);

async function onLogin() {
  if (role.value !== 'admin') {
    ElMessage.warning('请先切换到「管理员」身份');
    return;
  }
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入账号与密码');
    return;
  }
  if (captcha.enabled && !form.code.trim()) {
    ElMessage.warning('请输入图形验证码');
    return;
  }
  loading.value = true;
  try {
    await userStore.login({
      username: form.username.trim(),
      password: form.password,
      code: form.code.trim(),
      uuid: captcha.uuid
    });
    ElMessage.success('登录成功');
    const redirect = (route.query.redirect as string | undefined) ?? '/admin/dashboard';
    router.replace(redirect);
  } catch (error) {
    ElMessage.error((error as Error)?.message ?? '登录失败');
    if (captcha.enabled) {
      form.code = '';
      loadCaptcha();
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-hero">
        <div class="cap">
          <span style="display: inline-flex; gap: 18px">
            <ZkIcon name="book-open" :size="34" />
            <ZkIcon name="graduation-cap" :size="40" />
            <ZkIcon name="message-circle" :size="34" />
          </span>
        </div>
        <h3>智能教学，高效协同</h3>
        <p>覆盖教、学、管、评全场景</p>
      </div>

      <div class="auth-form">
        <h2>欢迎回来</h2>
        <p class="sub">{{ hint }}</p>

        <div class="mtab-wrap">
          <span class="pilltabs">
            <span class="pill" :class="{ active: mode === 'pwd' }" @click="mode = 'pwd'">密码登录</span>
            <span class="pill" :class="{ active: mode === 'mail' }" @click="mode = 'mail'">邮箱验证码登录</span>
            <span class="pill" :class="{ active: mode === 'phone' }" @click="mode = 'phone'">手机验证码登录</span>
          </span>
        </div>

        <div class="role-tabs">
          <div
            v-for="item in ROLE_ITEMS"
            :key="item.key"
            class="role-tab"
            :class="{ active: role === item.key }"
            @click="pickRole(item.key)"
          >
            <span class="dot"><ZkIcon name="check" :size="11" /></span>
            <span class="ric"><ZkIcon :name="item.icon" :size="19" /></span>
            <span>{{ item.label }}</span>
            <span class="rdesc">{{ item.desc }}</span>
          </div>
        </div>

        <template v-if="mode === 'pwd'">
          <div class="field">
            <label>账号</label>
            <input v-model="form.username" class="input" placeholder="学号 / 工号 / 手机号 / 邮箱" @keyup.enter="onLogin" />
          </div>
          <div class="field">
            <label>密码</label>
            <input v-model="form.password" class="input" type="password" placeholder="请输入密码" @keyup.enter="onLogin" />
          </div>
          <div v-if="captcha.enabled" class="field">
            <label>图形验证码</label>
            <div class="row" style="gap: 10px">
              <input v-model="form.code" class="input" placeholder="输入右侧 4 位字符" maxlength="6" style="flex: 1" />
              <img
                v-if="captcha.img"
                :src="captcha.img"
                title="点击刷新验证码"
                style="height: 40px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; flex: none"
                @click="loadCaptcha"
              />
            </div>
          </div>
          <div class="between">
            <label class="chk"><input type="checkbox" /> 记住我</label>
            <a href="javascript:void(0)" @click="ElMessage.info('找回密码：后端暂未提供接口')">忘记密码？</a>
          </div>
        </template>

        <div v-else class="bind-note">
          <ZkIcon name="shield-check" :size="14" />
          <span>
            该登录方式后端暂未提供接口（当前接口清单里只有账号密码登录 / 注册 / 图形验证码），
            按缺口处理，未接假数据。
          </span>
        </div>

        <button class="btn btn-primary btn-block" style="padding: 12px" :disabled="loading" @click="onLogin">
          {{ loading ? '登录中…' : '登 录' }}
        </button>

        <details class="demo">
          <summary>本地演示账号（点击展开）</summary>
          <div class="demo-body">
            <div><code>admin</code> / <code>admin123</code> — 系统管理员</div>
            <div><code>demo_teacher</code> / <code>admin123</code> — 教师</div>
            <div><code>demo_stu01</code> / <code>admin123</code> — 学生</div>
            <div class="muted" style="margin-top: 6px">账号来自本地演示库；本端只放行管理员。</div>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.role-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 2px 0 12px;
}
.role-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 13px 6px 11px;
  border: 1.5px solid var(--border);
  border-radius: var(--r-lg);
  background: #fff;
  cursor: pointer;
  transition: all 0.15s ease;
  color: var(--ink-600);
  font-size: 13px;
  font-weight: 600;
  user-select: none;
}
.role-tab .ric {
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-soft);
  color: var(--ink-500);
  transition: all 0.15s ease;
}
.role-tab:hover {
  border-color: var(--brand-300);
  color: var(--brand-700);
}
.role-tab.active {
  border-color: var(--primary);
  background: var(--primary-softer);
  color: var(--brand-700);
}
.role-tab.active .ric {
  background: var(--primary);
  color: #fff;
  box-shadow: var(--sh-1);
}
.role-tab .rdesc {
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-400);
}
.role-tab.active .rdesc {
  color: var(--brand-600);
}
.role-tab .dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: none;
  align-items: center;
  justify-content: center;
}
.role-tab.active .dot {
  display: flex;
}
.mtab-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 18px;
}
.bind-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--ink-500);
  background: var(--bg-subtle);
  border: 1px dashed var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 14px;
  line-height: 1.65;
}
.bind-note svg {
  margin-top: 2px;
  color: var(--brand-600);
}
.demo {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.demo > summary {
  padding: 9px 12px;
  font-size: 12px;
  color: var(--ink-500);
  cursor: pointer;
  background: var(--bg-subtle);
  list-style: none;
}
.demo > summary::-webkit-details-marker {
  display: none;
}
.demo-body {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--ink-600);
  line-height: 1.9;
}
.demo-body code {
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11.5px;
}
</style>
