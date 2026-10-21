<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import ZkIcon from '@/components/ZkIcon.vue';
import { BRAND_TITLE } from '@/config/menu';
import { useUserStore } from '@/store/user';
import { apiUpdatePwd } from '@/api/auth';

const userStore = useUserStore();

const displayName = computed(() => userStore.nickName || userStore.username || '管理员');
const initial = computed(() => displayName.value.slice(0, 1) || '管');

/** 消息中心：后端尚未提供对应接口，按缺口提示处理（不做假数据） */
function notImplemented(label: string) {
  ElMessage.info(`${label}：后端暂未提供接口（当前按缺口处理，未接入假数据）`);
}

/* ---------------- 修改密码（当前登录用户本人，所有账号通用） ---------------- */

const pwdVisible = ref(false);
const pwdFormRef = ref<FormInstance>();
const pwdSubmitting = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });

const pwdRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 8, max: 20, message: '新密码长度 8 ~ 20 位', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value && (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value))) {
          callback(new Error('新密码须同时包含字母和数字'));
        } else if (value && value.includes(' ')) {
          callback(new Error('新密码不能包含空格'));
        } else {
          callback();
        }
      },
      trigger: 'blur'
    }
  ],
  confirm: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value !== pwdForm.newPassword) callback(new Error('两次输入的新密码不一致'));
        else callback();
      },
      trigger: 'blur'
    }
  ]
};

function openPwdDialog() {
  pwdForm.oldPassword = '';
  pwdForm.newPassword = '';
  pwdForm.confirm = '';
  pwdVisible.value = true;
}

async function submitPwd() {
  const form = pwdFormRef.value;
  if (!form) return;
  const ok = await form.validate().catch(() => false);
  if (!ok) return;
  pwdSubmitting.value = true;
  try {
    await apiUpdatePwd(pwdForm.oldPassword, pwdForm.newPassword);
  } finally {
    pwdSubmitting.value = false;
  }
  pwdVisible.value = false;
  await ElMessageBox.alert('密码已修改，请使用新密码重新登录。', '修改成功', {
    type: 'success',
    confirmButtonText: '重新登录'
  });
  // 改密后强制重新登录（清 token 走登录页）；跟随部署 base，防子路径下跳到根 /login
  userStore.logout();
  location.href = import.meta.env.BASE_URL + 'login';
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
    <el-dropdown trigger="click" @command="(cmd: string) => (cmd === 'pwd' ? openPwdDialog() : notImplemented('个人资料'))">
      <div class="user" style="cursor: pointer" title="账号菜单">
        <span class="avatar sm">{{ initial }}</span>
        <span>{{ displayName }}</span>
      </div>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="pwd">
            <ZkIcon name="key-round" :size="14" style="margin-right: 4px" />修改密码
          </el-dropdown-item>
          <el-dropdown-item command="profile">个人资料</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="pwdVisible" title="修改密码" width="420px" :close-on-click-modal="false">
      <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="90px" @submit.prevent>
        <el-form-item label="原密码" prop="oldPassword">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入当前密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="6 ~ 20 位" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirm">
          <el-input v-model="pwdForm.confirm" type="password" show-password placeholder="再次输入新密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdSubmitting" @click="submitPwd">确认修改</el-button>
      </template>
    </el-dialog>
  </header>
</template>
