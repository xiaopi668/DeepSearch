# DeepSearch 部署指南

本文介绍 DeepSearch 后端的两种部署方式：**systemd（裸机 / 云主机）** 与 **Docker Compose**。
两种方式运行的都是同一个 Node.js 服务：监听 `8787`，托管 `dist/web` 前端，并把 `/api/*`
转发到 DeepSeek 官方 API。

> 本应用是 **BYOK（访客自带 Key）** 模式：访客的 DeepSeek API Key 只存在浏览器
> `localStorage`，随请求头转发，服务端不落盘、不打印、不缓存。因此部署时**不需要**
> 也**不应该**在服务器上配置任何 DeepSeek API Key。

---

## 一、前置条件

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.19（建议 24 LTS） | 运行后端 |
| pnpm | 11 | 安装依赖、构建前端 |
| 反向代理 | Nginx / Caddy（可选） | 对外暴露 HTTPS |

构建产物目录：`dist/web`（由 `pnpm build` 生成）。未构建时访问 `/` 会返回 503 提示页，
`/api/health` 仍然可用。

---

## 二、systemd 部署（裸机 / 云主机）

### 1. 创建专用用户与目录

```bash
# 注意：--user-group 会让 Group=deepsearch 存在（service 单元里引用了它）
sudo useradd --system --user-group --home /opt/deepsearch --shell /usr/sbin/nologin deepsearch
sudo mkdir -p /opt/deepsearch
# 上传/解压阶段目录归当前操作者，便于安装依赖与构建
sudo chown "$USER":"$USER" /opt/deepsearch
```

### 2. 上传代码并构建

```bash
# 把仓库内容上传/解压到 /opt/deepsearch（或先 git clone 到临时目录再拷贝）
cd /opt/deepsearch
pnpm install --frozen-lockfile
pnpm build                 # 生成 dist/web
pnpm prune --prod          # 可选：移除 devDependencies，减小体积
sudo chown -R deepsearch:deepsearch /opt/deepsearch
```

### 3. 配置环境变量

```bash
sudo mkdir -p /etc/deepsearch
sudo cp /opt/deepsearch/.env.example /etc/deepsearch/deepsearch.env
sudo chmod 640 /etc/deepsearch/deepsearch.env
sudo chown root:deepsearch /etc/deepsearch/deepsearch.env
sudo editor /etc/deepsearch/deepsearch.env
```

至少确认：

* `PORT=8787`、`HOST=0.0.0.0`（或 `127.0.0.1`，若只由本机反向代理访问）
* **直连暴露时必须保持 `TRUST_PROXY=0`**；只有前面存在可信 Nginx/Caddy 时才设
  `TRUST_PROXY=1`（或更精确的代理网段），否则可伪造 `X-Forwarded-For` 绕过限流。
* 需要给站点加一道访问口令时设置 `ACCESS_TOKEN`（留空 = 关闭）

### 4. 安装并启动服务

> `deploy/deepsearch.service` 默认 `ExecStart=/usr/bin/node`。若 `command -v node`
> 不是这个路径（nvm/官方二进制安装等），先编辑 service 中的该行再安装。

```bash
sudo cp /opt/deepsearch/deploy/deepsearch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepsearch

sudo systemctl status deepsearch
sudo journalctl -u deepsearch -f
curl -s http://127.0.0.1:8787/api/health
```

健康检查返回即部署成功：

```json
{
  "ok": true,
  "name": "deepsearch",
  "version": "1.0.0",
  "features": { "search": true, "fetch": true, "ai": true },
  "auth": { "accessTokenRequired": false },
  "limits": { "count": { "min": 1, "max": 50, "default": 10 } },
  "upstream": "https://api.deepseek.com"
}
```

### 5. 反向代理示例（Nginx）

```nginx
server {
    listen 80;
    server_name search.example.com;

    # SSE（AI 总结）必须关闭代理缓冲，否则前端会收不到流式输出
    location /api/summarize {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy 对应只需 `reverse_proxy 127.0.0.1:8787`（Caddy 默认不缓冲流式响应）。

### 6. 升级与回滚

```bash
sudo systemctl stop deepsearch
# 覆盖 /opt/deepsearch 代码（保留 node_modules 可用 rsync --delete 排除）
cd /opt/deepsearch && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod
sudo systemctl start deepsearch
```

回滚：切换回上一个版本目录 / 发布包后重启服务即可；服务本身不持有状态。

---

## 三、Docker Compose 部署

```bash
# 可选：在项目根目录创建 .env 覆盖 compose 中的默认值
#   ACCESS_TOKEN=your-site-token
#   PORT=8787
docker compose up -d --build

docker compose ps
curl -s http://127.0.0.1:8787/api/health
docker compose logs -f
```

* 镜像使用多阶段构建：build 阶段 `pnpm install --frozen-lockfile && pnpm build`；
  runtime 阶段只安装生产依赖，非 root 用户运行。
* 容器内固定监听 `8787`，宿主机端口由 `PORT` 控制。
* 默认 `TRUST_PROXY=0`；若容器前有可信反向代理，在 `.env` 中设 `TRUST_PROXY=1`。
* `docker-compose.yml` 中所有环境变量都带 `${VAR:-默认值}`，因此**不依赖 .env 必须存在**。
* 健康检查直接请求 `/api/health`。
* 容器前的反向代理同样建议对 `/api/summarize` 关闭缓冲（见上方 Nginx 示例）。

---

## 四、配置项速查

完整说明见项目根目录 `.env.example`，常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 上游地址（可指向代理网关） |
| `SEARCH_TIMEOUT_MS` | `20000` | 搜索超时 |
| `FETCH_TIMEOUT_MS` | `60000` | 网页抓取超时 |
| `CHAT_TIMEOUT_MS` | `120000` | AI 总结流式请求超时 |
| `MAX_BODY_BYTES` | `1mb` | 请求体上限 |
| `SEARCH_RATE_LIMIT_MAX` | `90` | 每 IP 每窗口搜索次数 |
| `FETCH_RATE_LIMIT_MAX` | `30` | 每 IP 每窗口抓取次数 |
| `AI_RATE_LIMIT_MAX` | `20` | 每 IP 每窗口 AI 总结次数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口 |
| `ACCESS_TOKEN` | 空（关闭） | 站点访问口令 |
| `TRUST_PROXY` | `0`（不信任） | 可信反向代理后设 `1`，或填代理网段 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## 五、安全与排障

* **Key 安全**：服务端日志中 `Authorization` / API Key 一律输出为 `***`；
  应用不写任何 Key 到磁盘。请勿在部署脚本、镜像或环境变量里放置访客 Key。
* **限流**：按 IP 滑动窗口，`/api/health` 不参与限流；错误响应为 `429 rate_limited`
  并带 `Retry-After`。反向代理后务必设置 `TRUST_PROXY=1`。
* **静态资源 503**：访问 `/` 返回“前端尚未构建”说明页时，执行 `pnpm build`
  生成 `dist/web` 后重启服务。
* **SSE 不流式**：检查反向代理是否对 `/api/summarize` 开启缓冲；
  响应头已带 `X-Accel-Buffering: no`，Nginx 侧仍需 `proxy_buffering off`。
* **日志**：`journalctl -u deepsearch -f`（systemd）或 `docker compose logs -f`（Docker）。
  日志为单行 JSON，包含 `requestId`、状态码与耗时。
* **优雅退出**：SIGTERM/SIGINT 后停止接收新请求，5 秒后强制退出；
  Docker `stop_grace_period` 默认即可覆盖。
