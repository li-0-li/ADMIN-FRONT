# ============================================================
# 第一阶段：构建（打包）
# 用 Node 18 环境，把源代码编译成 dist 静态文件
# ============================================================
FROM node:18 AS build

# 设置容器内的工作目录
WORKDIR /app

# 先复制依赖清单（package.json / package-lock.json）
# 单独复制是为了利用 Docker 缓存：依赖没变时，npm install 不会重跑
COPY package*.json ./

# 安装依赖
# 用淘宝镜像加速；npm install 会生成 node_modules
RUN npm config set registry https://registry.npmmirror.com && npm install

# 复制项目其余源码（.dockerignore 会排除 node_modules、dist 等）
COPY . .

# 执行打包，生成 dist 目录
# 这一步就是 npm run build，产物在 /app/dist
RUN npm run build


# ============================================================
# 第二阶段：运行（构建最终镜像）
# 用 Nginx 托管第一阶段生成的 dist 静态文件
# ============================================================
FROM nginx:stable

# 把第一阶段构建好的 dist 复制到 Nginx 的网站根目录
# --from=build 表示从上面那个 build 阶段拿文件
COPY --from=build /app/dist /usr/share/nginx/html

# 容器启动时 Nginx 会自动监听 80 端口，对外提供前端页面
