import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { apiGetInfo, apiLogin, apiLogout, type LoginPayload } from '@/api/auth';
import { TOKEN_KEY } from '@/api/request';

const NICK_KEY = 'zk_admin_nick';

export const useUserStore = defineStore('user', () => {
  const token = ref<string>(localStorage.getItem(TOKEN_KEY) ?? '');
  const username = ref<string>('');
  const nickName = ref<string>(localStorage.getItem(NICK_KEY) ?? '');
  const roles = ref<string[]>([]);
  const permissions = ref<string[]>([]);

  const isLogin = computed(() => token.value.length > 0);

  /** 按权限标识判断（若依口径：超管硬编码 *:*:*） */
  function hasPermi(perm: string) {
    if (!perm) return true;
    return permissions.value.includes('*:*:*') || permissions.value.includes(perm);
  }

  function setToken(value: string) {
    token.value = value;
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function fetchUserInfo() {
    const res = await apiGetInfo();
    if (res.code !== 200) {
      throw new Error(String(res.msg ?? '获取用户信息失败'));
    }
    roles.value = (res.roles as string[] | undefined) ?? [];
    permissions.value = (res.permissions as string[] | undefined) ?? [];
    const user = (res.user ?? {}) as Record<string, unknown>;
    username.value = String(user.userName ?? '');
    nickName.value = String(user.nickName ?? username.value);
    if (nickName.value) localStorage.setItem(NICK_KEY, nickName.value);
  }

  async function login(payload: LoginPayload) {
    const res = await apiLogin(payload);
    if (res.code !== 200 || !res.token) {
      throw new Error(String(res.msg ?? '登录失败'));
    }
    setToken(String(res.token));
    await fetchUserInfo();
  }

  function logout() {
    apiLogout();
    setToken('');
    username.value = '';
    nickName.value = '';
    roles.value = [];
    permissions.value = [];
  }

  return { token, username, nickName, roles, permissions, isLogin, hasPermi, setToken, fetchUserInfo, login, logout };
});
