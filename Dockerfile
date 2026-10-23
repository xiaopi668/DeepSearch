# syntax=docker/dockerfile:1
# ============================================================================
# DeepSearch 生产镜像（多阶段构建）
#   构建阶段：node:24-alpine + pnpm 11，安装依赖并构建 web/ → dist/web
#   运行阶段：仅生产依赖 + server/ + dist/web，非 root 运行
# ============================================================================

# ----------------------------- 构建阶段 -------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# pnpm 11（仓库通过 pnpm-workspace.yaml 配置构建脚本白名单）
RUN npm install -g pnpm@11

# 先拷贝依赖清单，最大程度复用 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 前端源码（.dockerignore 中不能排除 web/）
COPY web ./web
RUN pnpm build

# ----------------------------- 运行阶段 -------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app
RUN npm install -g pnpm@11

# 只安装生产依赖；pnpm 11 的构建脚本白名单在 pnpm-workspace.yaml，
# 运行时依赖不需要执行安装脚本，加 --ignore-scripts 更安全
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 后端源码与前端构建产物
COPY server ./server
COPY --from=build /app/dist ./dist

# 非 root 用户运行
RUN addgroup -S deepsearch \
    && adduser -S -H -G deepsearch -s /sbin/nologin deepsearch \
    && chown -R deepsearch:deepsearch /app

USER deepsearch
EXPOSE 8787

# 容器健康检查：直接请求 /api/health（不依赖 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 注意：请勿在此处传 --env-file 或写入 API Key —— 本应用为 BYOK，Key 只来自访客请求头
CMD ["node", "server/index.mjs"]
