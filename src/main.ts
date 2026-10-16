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

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as never);
}

app.mount('#app');
