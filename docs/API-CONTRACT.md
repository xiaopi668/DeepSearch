# DeepSearch API 契约 v1

前后端唯一约定来源。任何一方要改字段，必须先改本文档并通知对方。

## 0. 总体原则

- 浏览器只与本服务的 `/api/*` 通信，**永远不直接请求 DeepSeek**（避免 CORS 与密钥外泄面）。
- 访客自带 DeepSeek API Key（BYOK）：Key 存在浏览器 `localStorage`，仅通过
  `Authorization: Bearer <key>` 头随每次 `/api/*` 请求发送，服务端只做透传，
  **不落盘、不写日志、不缓存**。
- 所有接口同源，JSON 使用 UTF-8；SSE 接口除外。
- 每个响应都带 `X-Request-Id`；错误响应体统一为：

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "面向用户的中文报错",
    "requestId": "0f1e2d3c-...",
    "upstreamStatus": 401
  }
}
```

`upstreamStatus` 仅在错误来自 DeepSeek 上游时出现。前端不要把 `message` 当作程序逻辑依据，
要按 `code` 分支。

## 1. 鉴权与中间件

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization: Bearer sk-...` | 除 `/api/health` 外必填 | 访客自己的 DeepSeek API Key，服务端转发上游 |
| `X-Access-Token` | 仅当服务端配置了 `ACCESS_TOKEN` 时必填 | 可选站点访问口令（默认关闭） |

缺 Key → `401 missing_api_key`；口令错误 → `403 access_denied`。

服务端需校验 Key 形如 `^sk-[A-Za-z0-9_-]{10,200}$`，不合法直接 401，不发起上游请求。

## 2. 端点

### GET /api/health

无鉴权。用于探活与前端启动探测。

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

### POST /api/validate-key

校验访客 Key 是否可用。服务端请求上游 `GET {base}/models`。

请求体：无（`{}` 亦可）。
成功 `200`：

```json
{
  "ok": true,
  "models": [
    { "id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash", "contextWindow": 1048576 },
    { "id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro", "contextWindow": 1048576 }
  ]
}
```

上游 401 → 本服务 `401 invalid_api_key`；后端要把上游 `models` 精简成上述形状，
缺失字段用 `null`。

### POST /api/search

请求：

```json
{
  "query": "DeepSeek V4 发布",
  "count": 10,
  "needContent": false,
  "oriQuestion": null,
  "localization": null
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `query` | string | 是 | 1–128 个 Unicode 字符（按码点计），不能全空白；保留 `site:` `lang:` 等操作符原文 |
| `count` | integer | 否 | 1–50，默认 10 |
| `needContent` | boolean | 否 | 默认 `false`；为 `true` 时上游返回网页正文，前端只在高级选项开启 |
| `oriQuestion` | string\|null | 否 | 1–128 字符，用户原始问题 |
| `localization` | string\|null | 否 | 本地化 IP，默认不传 |

校验失败 → `400 invalid_request`。

成功 `200`：

```json
{
  "results": [
    {
      "title": "DeepSeek V4 模型发布",
      "url": "https://example.com/a",
      "snippet": "短摘要 100–200 字",
      "summary": "长摘要 600–800 字",
      "content": "",
      "siteName": "Example News",
      "siteIcon": "https://example.com/favicon.ico",
      "date": "2026-06-01T00:00:00+00:00",
      "authority": 3,
      "rerankScore": 2.4
    }
  ],
  "meta": { "query": "DeepSeek V4 发布", "count": 1, "tookMs": 512 }
}
```

上游字段为 snake_case，本服务统一转成 camelCase；`siteName/siteIcon/date` 可能为 `null`；
`authority` 为 -1..4 的整数；`rerankScore` 为 number。搜索无结果返回 `results: []`（200）。

### POST /api/fetch

请求：`{ "url": "https://example.com/article" }`

`url` 必须是 http/https、含 host、长度 ≤ 8192、不能含用户名/密码，否则 `400 invalid_request`。

成功 `200`：

```json
{
  "url": "https://example.com/article",
  "title": "Example article",
  "content": "# Example article\n\n正文 Markdown…",
  "fetchedAt": "2026-10-20T04:00:00.000Z"
}
```

上游 403 → `403 fetch_forbidden`（"该网页被目标站点或安全策略拒绝"）；
上游 404 → `404 fetch_unavailable`（"无法抓取该网页正文"）。

### POST /api/summarize （SSE）

服务端把搜索结果拼成上下文，调用 `POST {base}/chat/completions` 流式生成中文总结。

请求：

```json
{
  "query": "DeepSeek V4 发布",
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "siteName": "…",
      "date": "2026-06-01T00:00:00+00:00",
      "snippet": "…",
      "summary": "…"
    }
  ],
  "model": "deepseek-flash",
  "thinking": false
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `results` | array | 1–15 条；服务端截断 title ≤ 300、url ≤ 8192、siteName ≤ 120、snippet ≤ 500、summary ≤ 2000，总上下文 ≤ 12000 字符 |
| `model` | `"deepseek-flash"` \| `"deepseek-v4-pro"` | 默认 `deepseek-flash` |
| `thinking` | boolean | 默认 `false`（关闭思考，追求首字延迟） |

请求校验通过后立刻返回 `200`，头：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
Connection: keep-alive
X-Accel-Buffering: no
```

SSE 事件帧格式（`event: <name>\ndata: <json>\n\n`）：

```
event: meta
data: {"model":"deepseek-flash","requestId":"…"}

event: reasoning
data: {"text":"…"}          // 仅 thinking=true 时可能出现

event: delta
data: {"text":"增量文本"}

event: usage
data: {"promptTokens":812,"completionTokens":156,"totalTokens":968}

event: done
data: {"finishReason":"stop"}

event: error
data: {"code":"insufficient_balance","message":"DeepSeek 账户余额不足"}
```

- 每 15 秒发送注释心跳 `: ping\n\n`，防止中间层断流。
- 上游开始输出后不再重试；中断只能以 `error` 事件收尾。
- 客户端断开（HTTP 响应 `res` 的 `close` 事件；不能用 `req.on('close')`，请求体读完后它就会触发）
  → 立刻 `AbortController.abort()` 上游请求。
- `finishReason` ∈ `stop | length | content_filter | tool_calls | insufficient_system_resource | aborted`。

## 3. 上游错误映射

| 上游 | 本服务 HTTP | code | 前端文案方向 |
| --- | --- | --- | --- |
| 400 | 400 | `invalid_request` | 请求参数不合法（透传上游 message） |
| 401 | 401 | `invalid_api_key` | Key 无效，去设置里检查 |
| 402 | 402 | `insufficient_balance` | 账户余额不足 |
| 403 (fetch) | 403 | `fetch_forbidden` | 网页被拒绝抓取 |
| 404 (fetch) | 404 | `fetch_unavailable` | 网页正文抓取失败 |
| 408 / 5xx | 502 | `upstream_error` | DeepSeek 暂时不可用，请重试 |
| 429 | 429 | `rate_limited` | 请求太频繁，稍后再试（带 `Retry-After`，单位秒） |
| 连接超时 | 504 | `upstream_timeout` | 上游超时 |
| 网络错误 | 502 | `upstream_unreachable` | 无法连接 DeepSeek |
| —（本服务自身） | 413 | `invalid_request` | 请求体超过 `MAX_BODY_BYTES` |

补充：上游返回 HTTP 200 但响应体不是合法 JSON 时，按 `502 upstream_error` 处理，
且不携带 `upstreamStatus`（避免把 200 写进"上游错误"语义）。

**重试策略**：search / fetch / validate-key 对 408、429、5xx 最多重试 2 次，
指数退避 500ms → 1200ms + 随机抖动，尊重上游 `Retry-After`（上限 10s）。
chat（SSE）不重试。

## 4. 限流

按访客 IP 滑动窗口（配置见 `.env.example`），超限返回 `429 rate_limited`，
`Retry-After` 为剩余秒数。`/api/health` 不参与限流。

## 5. 静态资源与 SPA 回退

- 生产模式：服务端托管 `dist/web`。
- 所有非 `/api/*` 的 GET 请求回退到 `dist/web/index.html`（支持 `/search?q=...` 深链）。
- 开发模式：Vite `5173` 开发服务器代理 `/api` 到 `8787`。
- 未构建时访问 `/` 返回 503 + 说明（"请先 pnpm build"），不影响 `/api/health`。

## 6. AI 总结 Prompt 约定（服务端 prompt.mjs 实现）

System：

> 你是一个中文搜索助手。基于给定的搜索结果（编号 [1]…[n]）回答用户问题。
> 要求：① 先给 2–3 句直接结论；② 再用 Markdown 要点补充关键事实，使用 `[编号]` 标注来源；
> ③ 只依据给定结果，不编造；信息不足或来源冲突时明确说明；
> ④ 不要输出"根据搜索结果"之类的废话开头；⑤ 总长度 300–500 字，语言与问题一致。

User：`问题：<query>\n\n搜索结果：\n[1] 标题：…\n站点：…\n时间：…\n摘要：…\n…`

请求参数：`stream: true, thinking: {type:"disabled|enabled"}, reasoning_effort`（若 thinking 开启则
`reasoning_effort: "low"`），`max_tokens: 1200`，不传 `temperature`（思考模式不生效）。

## 7. 安全约定

- 服务端日志中 Authorization/Key 一律 `***`；不实现任何把 Key 写文件的代码。
- API 响应统一 `Cache-Control: no-store`。
- 静态响应加安全头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、
  `X-Frame-Options: DENY`、基础 CSP（`script-src 'self'`，`style-src 'self' 'unsafe-inline'`，
  `img-src 'self' data: https:`，`connect-src 'self'`）。
- 请求体 JSON 上限 `MAX_BODY_BYTES`（默认 1 MB）。
- 优雅退出：SIGTERM/SIGINT 停止接收新请求，5 秒后强制退出。
