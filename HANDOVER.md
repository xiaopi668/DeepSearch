# DeepSearch 交接文档

> 交付版本：**v1.0.0**　交付日期：**2026-10-23**　项目根目录：`DeepSearch/`
> 预览地址（本机临时）：`http://127.0.0.1:8787`（生产请按第 7 节部署）
> 接口契约：[`docs/API-CONTRACT.md`](docs/API-CONTRACT.md)　部署细节：[`deploy/README.md`](deploy/README.md)

---

## 1. 一页概览

DeepSearch 是一个**可部署到服务器的网页搜索引擎**：页面风格仿 Google，检索结果来自
**DeepSeek 官方 Search API**，支持网页正文抓取与可选的 AI 总结回答。

核心特点：

- **BYOK（访客自带 API Key）**：每个访客在网页「设置」里填自己的 DeepSeek API Key，
  Key 只存在浏览器 `localStorage`，每次请求经本站后端转发给 DeepSeek，**服务端不落盘、不打印、不共享**。
  因此站点运营者不承担 API 费用，也无需在服务器配置任何 Key。
- **普通搜索 / 高级搜索**：普通搜索即输即搜；高级搜索页可图形化选择
  `site:`、排除站点、`lang:`、`after:`/`before:`、精确短语、排除词、结果条数等参数。
- **AI 总结**：Google AI Overview 式卡片，SSE 流式输出、`[编号]` 引用来源；手动/自动两种触发模式。
- **正文阅读**：点击「查看正文」调用 Fetch API，右侧抽屉内渲染 Markdown。
- **Google 风界面**：默认深色 Material Dark，可切换浅色；首页为极简「字标 + 搜索框」布局。
- **工程化**：165 个后端测试、真实 API 端到端脚本、Playwright 截图脚本、Docker/Compose/systemd 部署工件。

---

## 2. 功能清单

| 功能 | 说明 | 主要代码位置 |
| --- | --- | --- |
| 普通搜索 | 一次返回 1–50 条结果，展示标题/站点/日期/摘要/权威度/相关性 | `web/src/components/ResultsView.tsx`、`server/app.mjs` |
| 高级搜索 | 表单组合 DeepSeek 操作符，实时预览 + 128 字符校验，草稿存 sessionStorage | `web/src/components/AdvancedView.tsx`、`web/src/lib/advanced.ts` |
| AI 总结 | 手动/自动、流式、停止、重新生成、usage 显示、引用编号 | `web/src/components/AiSummaryCard.tsx`、`web/src/hooks/useAiSummary.ts`、`server/prompt.mjs` |
| 正文抓取 | 抽屉阅读 Markdown、会话缓存、复制正文 | `web/src/components/FetchDrawer.tsx`、`server/deepseek.mjs` |
| BYOK 设置 | Key/模型/思考模式/条数/主题，存 localStorage | `web/src/components/SettingsModal.tsx`、`web/src/lib/storage.ts` |
| 明暗主题 | 默认深色，右上角切换 + 持久化 | `web/src/styles/global.css`、`web/src/components/ThemeToggle.tsx` |
| 首页 | 顶栏入口 + 白色字标 + 宽搜索框（+ / AI 模式 / 放大镜提交） | `web/src/components/HomeView.tsx`、`SearchBar.tsx` |
| 运维能力 | 健康检查、结构化日志、按 IP 限流、优雅退出、SSE 心跳与断开中止 | `server/index.mjs`、`server/app.mjs` |

---

## 3. 架构与数据流

```
浏览器 (React SPA)
  │  ① 同源请求 /api/*，Authorization: Bearer <访客自己的 DeepSeek Key>
  ▼
Node.js / Express 服务 (server/)
  │  ② 校验参数、限流、脱敏日志，把请求转发到 DeepSeek
  ▼
DeepSeek 官方 API (https://api.deepseek.com)
  ├─ POST /v1/tools/search   搜索
  ├─ POST /v1/tools/fetch    抓取网页 Markdown
  ├─ POST /chat/completions  AI 总结（SSE 流式，deepseek-flash / deepseek-v4-pro）
  └─ GET  /models            校验 Key / 获取模型列表
```

- 前端**不直接请求 DeepSeek**（避免 CORS 与 Key 暴露），只访问同源 `/api/*`。
- 后端无数据库、无会话、无文件写入；访客 Key 仅在单次请求生命周期内存在。
- SSE：后端把上游 `data:` 流转换成契约事件（`meta/delta/reasoning/usage/done/error`），
  每 15 秒心跳，客户端断开立即 abort 上游。

详细字段/错误码/SSE 帧格式见 [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md)。

---

## 4. 技术栈

| 层 | 技术 | 版本（交付时） |
| --- | --- | --- |
| 运行时 | Node.js（ESM） | 开发机 24.21；`engines` 要求 ≥ 20.19，建议 22/24 LTS |
| 后端 | Express + compression | express 5.3.x / compression 1.8.x |
| 前端 | React + TypeScript + Vite | react 19.3.1 / TS 7.0.2 / vite 8.3.4 |
| UI/动效 | framer-motion、lucide-react、react-markdown + remark-gfm | 14.3 / 1.59 / 10.1 |
| 测试 | Vitest + Supertest | 5.0.5 / 7.3.1 |
| 浏览器验证 | Playwright（复用本机 Edge，不下载浏览器） | 1.64.1 |
| 包管理 | pnpm（lockfile 已提交） | 11.x |

> 本机开发环境的 node/pnpm 是 DSH 内置运行时（绝对路径调用）；接手方机器只要 PATH 里有
> Node ≥ 20.19 与 pnpm 11，直接使用 `pnpm` 命令即可。

---

## 5. 目录结构

```text
DeepSearch/
├─ server/                    # 后端（纯 ESM JavaScript，无构建步骤）
│  ├─ index.mjs               # 入口：加载 .env、启动 HTTP、优雅退出
│  ├─ app.mjs                 # Express 装配：路由/安全头/SSE/静态托管/错误处理
│  ├─ config.mjs              # 环境变量解析与默认值（零依赖 .env 加载）
│  ├─ deepseek.mjs            # DeepSeek 客户端：超时、重试、SSE 解析、snake→camel
│  ├─ validation.mjs          # 请求参数校验（码点/URL/Key/结果截断）
│  ├─ prompt.mjs              # AI 总结 Prompt 构造（≤12000 字符上下文）
│  ├─ rate-limit.mjs          # 按 IP 滑动窗口限流（search/fetch/ai 三桶）
│  ├─ errors.mjs              # AppError 与上游状态码映射
│  └─ logger.mjs              # 结构化日志，Authorization/Key 脱敏
├─ web/                       # 前端源码（Vite root）
│  ├─ index.html              # 入口 HTML（静态 data-theme="dark" 防白闪）
│  ├─ vite.config.ts          # root=web，构建到 ../dist/web，dev 代理 /api
│  └─ src/                    # components / hooks / lib / styles
├─ tests/                     # Vitest 配置 + 165 个后端测试（全 fake fetch，不花钱）
├─ scripts/
│  ├─ e2e-check.mjs           # 真实 API 冒烟（需 DEEPSEEK_API_KEY，会消耗少量额度）
│  └─ screenshot.mjs          # Playwright 截图（默认驱动本机 Edge）
├─ docs/API-CONTRACT.md       # 前后端接口契约（唯一事实来源）
├─ deploy/                    # systemd unit + 部署指南
├─ Dockerfile / docker-compose.yml / .dockerignore
├─ dist/web/                  # 已构建的前端产物（可直接部署）
├─ screenshots/               # 界面截图（README 引用）
├─ .env.example               # 环境变量模板
├─ pnpm-lock.yaml             # 依赖锁定
└─ README.md / HANDOVER.md
```

---

## 6. 本地开发

```bash
# 环境要求：Node ≥ 20.19、pnpm 11
pnpm install          # 安装依赖（~168 MB node_modules）
pnpm dev              # 后端 :8787 + Vite :5173，浏览器打开 http://localhost:5173
```

- 打开页面 → 右上角「设置」→ 填入自己的 DeepSeek API Key（
  <https://platform.deepseek.com/api_keys> 创建）→「测试连接」→ 保存即可搜索。
- 分开调试：`pnpm dev:api`（:8787）与 `pnpm dev:web`（:5173，已配置 `/api` 代理）。
- 生产模式本地预览：`pnpm build && pnpm start` → <http://127.0.0.1:8787>。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动后端与 Vite 开发服务器 |
| `pnpm build` | 构建前端到 `dist/web` |
| `pnpm start` | 生产启动（读取 `.env`，托管 `dist/web`） |
| `pnpm test` | 后端单元 + 接口测试（fake fetch，不访问真实 API） |
| `pnpm test:watch` | 测试 watch 模式 |
| `pnpm typecheck` | 前端 TypeScript 类型检查 |
| `pnpm e2e` | 真实 API 端到端冒烟（需 `DEEPSEEK_API_KEY`，消耗少量额度） |
| `pnpm screenshot` | Playwright 截图到 `screenshots/`（可注入 Key 自动跑完流程） |

---

## 7. 生产部署（三种方式，任选其一）

完整步骤与命令见 [`deploy/README.md`](deploy/README.md) 与根目录 [`README.md`](README.md)。
此处只列要点：

### 7.1 直接运行（裸机）

```bash
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env      # 按需修改
pnpm start                # 默认 0.0.0.0:8787
```

### 7.2 Docker

```bash
docker build -t deepsearch:1.0.0 .
docker run -d --name deepsearch -p 8787:8787 --env-file .env --restart unless-stopped deepsearch:1.0.0
# 或
docker compose up -d --build
```

镜像为多阶段构建（build 阶段装依赖并构建前端，runtime 阶段只装生产依赖、非 root、内置 HEALTHCHECK）。

### 7.3 systemd

```bash
sudo useradd --system --user-group --home /opt/deepsearch --shell /usr/sbin/nologin deepsearch
sudo mkdir -p /opt/deepsearch /etc/deepsearch
sudo rsync -a --exclude node_modules ./ /opt/deepsearch/
sudo chown -R "$USER":"$USER" /opt/deepsearch
cd /opt/deepsearch && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod
sudo chown -R deepsearch:deepsearch /opt/deepsearch
sudo cp deploy/deepsearch.service /etc/systemd/system/
sudo cp .env.example /etc/deepsearch/deepsearch.env   # 编辑后
sudo systemctl daemon-reload && sudo systemctl enable --now deepsearch
```

> `deploy/deepsearch.service` 默认 `ExecStart=/usr/bin/node`，若 `command -v node` 不是该路径请先修改。

### 7.4 反向代理（必须）

- **必须启用 HTTPS**：访客 Key 随请求头传输，明文 HTTP 会泄露。
- Nginx 代理 `/api/summarize` 必须 `proxy_buffering off`（AI 总结是 SSE），响应头已带
  `X-Accel-Buffering: no`，但 Nginx 仍建议显式关闭缓冲。
- 有可信反代时才设置 `TRUST_PROXY=1`；**直接暴露端口时保持默认 `0`**，否则访客可伪造
  `X-Forwarded-For` 绕过按 IP 限流。

---

## 8. 配置项

所有配置走环境变量或项目根目录 `.env`（`.env` 已被 `.gitignore` 忽略，不会进包）。
完整注释见 [`.env.example`](.env.example)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址；反代后建议 `HOST=127.0.0.1` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 上游地址（可指向自建代理网关） |
| `SEARCH_TIMEOUT_MS` | 20000 | 搜索上游超时 |
| `FETCH_TIMEOUT_MS` | 60000 | 抓取上游超时 |
| `CHAT_TIMEOUT_MS` | 120000 | AI 总结流式超时 |
| `MAX_BODY_BYTES` | `1mb` | 请求体上限 |
| `RATE_LIMIT_WINDOW_MS` | 60000 | 限流窗口 |
| `SEARCH_RATE_LIMIT_MAX` / `FETCH_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_MAX` | 90 / 30 / 20 | 每 IP 每窗口次数 |
| `ACCESS_TOKEN` | 空（关闭） | 可选站点访问口令（页面会要求输入） |
| `TRUST_PROXY` | `0` | 可信反代后设 `1`（或代理网段） |
| `LOG_LEVEL` | `info` | debug / info / warn / error |

**服务端不需要配置 DeepSeek API Key。**

---

## 9. 密钥与安全

- **访客 Key 生命周期**：浏览器 localStorage → 请求头 `Authorization: Bearer ...` → 后端读取后
  直接转发上游 → 请求结束即释放。不写文件、不写日志（logger 对 `sk-` 与鉴权字段脱敏）。
- **不要把 Key 写入** `.env`、代码、Docker 镜像或部署脚本；项目内没有任何 Key。
- **HTTPS 必须**；建议反代层同时加 HSTS。
- **可选访问口令** `ACCESS_TOKEN`：开启后非 `/api/health` 的接口需带
  `X-Access-Token`，前端设置里出现口令输入框；默认关闭。
- **限流**：按 IP 滑动窗口，search/fetch/ai 三桶独立；`/api/health` 不限流。
  上游 429/5xx 自动重试（search/fetch 最多 2 次，尊重 `Retry-After`；AI 流不重试）。
- **安全头**：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY`、CSP、
  API 响应 `Cache-Control: no-store`。
- **XSS**：Markdown 用 react-markdown 默认安全渲染，未启用 raw HTML；外链图片带
  `referrerPolicy="no-referrer"`。

---

## 10. 费用与配额

- 费用由**访客自己的 DeepSeek 账户**承担；站点运营者无需充值（BYOK）。
- Search / Fetch：**每 1000 次成功请求 5 元**；失败请求、空结果、超时不计费。
- AI 总结：按 `deepseek-flash` / `deepseek-v4-pro` token 计费（见 DeepSeek 官方价格页，
  空闲时段约为高峰半价）；一次总结通常几百 tokens。
- 上游 QPS 限制：Search 100 QPS、Fetch 25 QPS（账号级）；本站按 IP 限流远低于该值。
- ⚠️ 注意：DeepSeek 公告称 2026-11-01 起对 Harness/Claude Code/Codex 中的服务端
  Search/Fetch 调用开始计费；本项目是直接调用公开 API，按其公开价格计费。

---

## 11. 测试与验证

### 11.1 交付时验证记录（2026-10-23）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 后端测试 | `pnpm test` | 13 个测试文件 / **165 个用例全绿**（全 fake fetch，不花钱） |
| 前端类型检查 | `pnpm typecheck` | 通过（exit 0） |
| 前端构建 | `pnpm build` | 通过，产物 `dist/web`（JS ~598 KB / gzip ~186 KB） |
| 真实 API 端到端 | `DEEPSEEK_API_KEY=... pnpm e2e` | **7/7 通过**：health → 校验 Key → 搜索 → 抓取 → AI SSE → SPA → 缺 Key 401 |
| 浏览器验证 | `pnpm screenshot` | 首页/结果/AI/抽屉/设置/高级搜索/移动端截图，控制台零错误；并实测主题切换、AI 模式持久化、放大镜提交、`/advanced` 深链 |
| 独立安全审计 | 人工 + 只读 QA | 无硬编码密钥；无 XSS/SSRF 路径；CSP 兼容；错误不泄露堆栈；修复 2 个 P1 |

> 真实 API 验证会消耗少量额度（几次 Search/Fetch + 一次 AI 总结，合计约几分钱）。

### 11.2 接手后建议先跑

```bash
pnpm install --frozen-lockfile
pnpm test                 # 应 165 passed
pnpm typecheck && pnpm build
pnpm start                # 打开 http://127.0.0.1:8787，设置自己的 Key 试搜索
```

---

## 12. 运维手册

| 场景 | 操作 |
| --- | --- |
| 健康检查 | `GET /api/health`（Docker HEALTHCHECK 已内置） |
| 查看日志 | systemd：`journalctl -u deepsearch -f`；Docker：`docker compose logs -f`；裸机：stdout JSON |
| 重启 | `systemctl restart deepsearch` / `docker compose restart` |
| 升级 | 替换代码 → `pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod` → 重启 |
| 回滚 | 切回上一版本目录/镜像后重启（服务无状态，无数据迁移） |
| 静态资源 503 | 访问 `/` 显示「前端尚未构建」→ 执行 `pnpm build` |
| AI 总结不流式 | 检查反代是否对 `/api/summarize` 开启 buffering；Nginx 需 `proxy_buffering off` |
| 401 | 访客 Key 无效/过期/未填 → 页面「去设置」 |
| 402 | 访客 DeepSeek 账户余额不足 |
| 429 | 本地 IP 限流或上游 QPS 超限；等待 `Retry-After` 秒或调大限流配置 |
| 端口占用 | 启动日志报 `EADDRINUSE`，换 `PORT` 或停掉旧进程 |

启动日志示例（单行 JSON，含 requestId/耗时，无 Key）：

```json
{"level":"info","msg":"DeepSearch 服务已启动","host":"0.0.0.0","port":8787,"upstream":"https://api.deepseek.com","accessTokenRequired":false,"staticReady":true}
```

优雅退出：SIGTERM/SIGINT 后停止接收新请求，最多 5 秒强制退出；SSE 连接会中止上游。

---

## 13. 已知限制与后续建议

| 编号 | 限制 | 影响 | 建议 |
| --- | --- | --- | --- |
| L1 | 本机无 Docker CLI，**Dockerfile 未实际 build** | 服务器首次构建可能需要微调 | 在有 Docker 的机器执行一次 `docker build` 验证；逻辑已按多阶段审查 |
| L2 | 前端为单个 JS chunk（~598 KB / gzip ~186 KB） | 首屏加载略慢 | 可对 Markdown/高级搜索做路由级 `import()` 拆包 |
| L3 | 限流在鉴权之后 | 无 Key 的 401 请求不消耗限流额度 | 如需更强防刷，可在 body 解析前加一层全局 IP 限流 |
| L4 | 无数据库/账号体系 | 设置、历史、Key 都在各自浏览器 | 需要多端同步/团队共享时再引入 |
| L5 | 搜索 API 不支持分页偏移 | 单次最多 50 条，无法「下一页」 | 需更全结果时提示用户细化 query |
| L6 | 高级搜索组合受 DeepSeek query 128 字符限制 | 极多条件时无法提交 | 页面已实时校验并禁用提交 |
| L7 | 界面仅中文 | 无 i18n | 需要国际化时抽 `messages` 字典 |
| L8 | Windows 外部 TerminateProcess 不触发 SIGTERM handler | 仅影响 Windows 强制结束进程 | Linux/Docker/systemd 正常 |

---

## 14. 二次开发指引

| 想改什么 | 改哪里 |
| --- | --- |
| 主题颜色（深/浅） | `web/src/styles/global.css` 顶部 CSS 变量：`:root`、`html[data-theme='dark']`、`html[data-theme='light']`（纯黑背景可把 `--bg` 改 `#000`） |
| 首页布局/顶栏 | `web/src/components/HomeView.tsx`、`web/src/components/SearchBar.tsx` |
| 高级搜索字段/语法组合 | `web/src/lib/advanced.ts`（纯函数，可加单测）+ `web/src/components/AdvancedView.tsx` |
| AI 总结 Prompt | `server/prompt.mjs`（注意总上下文 ≤12000 字符） |
| 模型列表 | 后端 `server/validation.mjs` 的 `SUPPORTED_MODELS` + 前端设置项 |
| 新增/修改 API 字段 | 先改 `docs/API-CONTRACT.md` → 后端映射 `server/deepseek.mjs`/`app.mjs` → 前端 `web/src/lib/types.ts`、`api.ts` |
| 调整限流/超时 | `.env`（`RATE_LIMIT_*`、`*_TIMEOUT_MS`），默认值见 `server/config.mjs` |
| 加测试 | `tests/server/*.test.mjs`（全 fake fetch，勿访问真实 API） |

契约变更流程：**先改 `docs/API-CONTRACT.md` 再改代码**，前后端以契约为准。

---

## 15. 交接清单

### 15.1 已交付

- [x] 完整源码：`server/`、`web/`、`tests/`、`scripts/`、`docs/`、`deploy/`
- [x] 依赖锁文件 `pnpm-lock.yaml`、`pnpm-workspace.yaml`
- [x] 已构建前端产物 `dist/web/`（可直接由 Node 服务托管）
- [x] 部署工件：`Dockerfile`、`docker-compose.yml`、`deploy/deepsearch.service`、`.dockerignore`
- [x] 配置模板 `.env.example`、`.gitignore`
- [x] 文档：`README.md`、本交接文档、`docs/API-CONTRACT.md`、`deploy/README.md`
- [x] 界面截图 `screenshots/`（README 引用，可用 `pnpm screenshot` 重新生成）
- [x] 测试与验证脚本：`pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm e2e` / `pnpm screenshot`

### 15.2 包内**不包含**

- `node_modules/`（约 168 MB，接手后 `pnpm install` 安装）
- 任何真实 API Key、服务器账号/密码、域名证书、`.env`
- Git 历史（当前目录未初始化 git）

### 15.3 接手方需要完成

- [ ] 安装 Node ≥ 20.19 与 pnpm 11，执行 `pnpm install --frozen-lockfile`
- [ ] 注册/准备 DeepSeek API 平台账号（用于自测；最终访客各自带 Key）
- [ ] 准备服务器与 HTTPS 域名（Nginx/Caddy），按第 7 节部署
- [ ] 决定是否开启 `ACCESS_TOKEN`、调整限流阈值
- [ ] 首次在有 Docker 的环境执行一次 `docker build` 验证（L1）
- [ ] 替换本文件第 16 节的联系人信息

---

## 16. 联系人

| 角色 | 姓名/团队 | 联系方式 |
| --- | --- | --- |
| 项目负责人 | 待填 | 待填 |
| 前端维护 | 待填 | 待填 |
| 后端/运维 | 待填 | 待填 |

---

## 17. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-20 | 初版：后端代理（search/fetch/chat SSE、限流、安全头）、React 前端、164 测试、Docker/systemd 部署工件、接口契约 |
| 2026-10-21 | 新增明暗主题（默认 Material Dark）与主题持久化；标题抽屉去重；真实 API 联调通过 |
| 2026-10-22 | 新增普通/高级搜索（`/advanced` 表单化 site:/lang:/after:/before:/短语/排除词）；首页按 Google 深色参考图复刻；移除计费外链 |
| 2026-10-23 | 首页极简（删除搜索按钮/说明/Key 提示/最近搜索/页脚，仅留字标+搜索框，增加放大镜提交）；打包交付 v1.0.0 与本交接文档 |
| 2026-10-23 | 修复：上游 200 但响应体非法 JSON 时，错误响应不再携带 `upstreamStatus: 200`（契约 §3）；新增客户端与接口层回归测试，测试数 164 → 165 |
