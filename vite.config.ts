import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

/**
 * `/login` 既是前端路由、又是后端接口，两者路径同名。
 * 若不加区分地代理，浏览器直接访问 / 刷新页面（Accept: text/html 的 GET）
 * 会被转发到后端，拿到 `{"msg":"Request method 'GET' is not supported","code":500}`。
 * 所以：HTML 页面导航交给 Vite 的 SPA fallback，只代理 XHR/fetch。
 */
const bypassHtmlNavigation = (req: { method?: string; headers: Record<string, unknown> }) => {
  const accept = String(req.headers?.accept ?? '');
  if (req.method === 'GET' && accept.includes('text/html')) return '/index.html';
  return null;
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8080';
  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host: '127.0.0.1',
      port: Number(env.VITE_APP_PORT || 5180),
      strictPort: true,
      proxy: {
        // ① 项目模块：48 个管理端端点都在 /api/v1/** 下，直接转发，不改写路径
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          bypass: bypassHtmlNavigation
        },
        // ② 若依原生端点：**不带 /api 前缀**（实测确认），必须单独代理，
        //    否则请求会打到 Vite 自己身上（SPA fallback 对 POST 无效 → 404）
        '/login': { target: proxyTarget, changeOrigin: true, bypass: bypassHtmlNavigation },
        '/logout': { target: proxyTarget, changeOrigin: true, bypass: bypassHtmlNavigation },
        '/getInfo': { target: proxyTarget, changeOrigin: true, bypass: bypassHtmlNavigation },
        '/captchaImage': { target: proxyTarget, changeOrigin: true, bypass: bypassHtmlNavigation },
        '/register': { target: proxyTarget, changeOrigin: true, bypass: bypassHtmlNavigation },
        // ③ 上传文件的静态资源前缀。这几个**绝不能加 bypassHtmlNavigation**：
        //    浏览器加载 iframe / video 时会带 Accept: text/html，一旦 bypass 就会
        //    被交回 SPA fallback、拿到 index.html，文件反而打不开。
        //    /profile/** 是若依标准映射（= ruoyi.profile 目录），/files/** 是学生端的映射；
        //    /upload/** 当前后端**没有任何模块映射**，放进来是为了让错误暴露成后端真实响应，
        //    而不是被 SPA fallback 吞成一个"看起来正常"的页面（见资源预览页的排查表）。
        '/profile': { target: proxyTarget, changeOrigin: true },
        '/files': { target: proxyTarget, changeOrigin: true },
        '/upload': { target: proxyTarget, changeOrigin: true }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
