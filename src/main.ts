import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

// 样式顺序有讲究：
//   1) EP 自身样式
//   2) 原型 theme.css（设计 token + .card/.btn/.tbl 等类名）
//   3) ep-bridge（把原型 token 映射进 EP 变量）—— 必须在 EP 之后才能覆盖
import 'element-plus/dist/index.css';
import '@/styles/theme.css';
import '@/styles/ep-bridge.scss';

import App from './App.vue';
import router from './router';
import ZkDialog from '@/components/ZkDialog';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

// 覆盖 EP 全局注册的 ElDialog，补「关闭后拖拽复位」。
// ★ 必须放在 app.use(ElementPlus) 之后，否则会被 install 时注册的原组件盖掉。
//   模板里的 <el-dialog> 会解析到全局 ElDialog，因此全站弹窗自动生效，新增弹窗无需再加任何属性。
app.component('ElDialog', ZkDialog);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as never);
}

app.mount('#app');
