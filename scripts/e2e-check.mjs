/**
 * 端到端冒烟测试：直接打真实 DeepSeek API（会产生少量费用）。
 *
 * 用法（PowerShell）：
 *   $env:DEEPSEEK_API_KEY = "sk-..."
 *   $env:BASE_URL = "http://127.0.0.1:8787"   # 可选
 *   node scripts/e2e-check.mjs
 *
 * 覆盖：/api/health → /api/validate-key → /api/search → /api/fetch → /api/summarize(SSE)
 *      → 静态页面 → 未带 Key 的 401。
 * 任何一步失败都会以非 0 退出码结束。
 */
import process from 'node:process';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const QUERY = process.env.E2E_QUERY || 'DeepSeek V4 发布';
const results = [];
let failed = 0;

const mask = (k) => (k ? `${k.slice(0, 5)}***${k.slice(-4)}` : '(none)');

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` :: ${detail}` : ''}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function callApi(path, { method = 'POST', body, key = KEY, timeoutMs = 90_000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 交给调用方判断 */
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  if (!KEY) {
    console.error('缺少 DEEPSEEK_API_KEY 环境变量，无法进行真实 API 冒烟测试。');
    process.exit(2);
  }
  console.log(`BASE=${BASE}  KEY=${mask(KEY)}  QUERY=${JSON.stringify(QUERY)}\n`);

  // 0. 服务可达性
  try {
    const health = await callApi('/api/health', { method: 'GET' });
    assert(health.status === 200, `health status ${health.status}`);
    assert(health.json?.ok === true, 'health.ok !== true');
    assert(health.json?.features?.search === true, 'features.search missing');
    record('GET /api/health', true, JSON.stringify(health.json?.features));
  } catch (e) {
    record('GET /api/health', false, e.message);
    console.error('服务未启动或不可达，后续步骤跳过。请先运行 `pnpm start`。');
    return finish();
  }

  // 1. 校验 Key
  let models = [];
  try {
    const r = await callApi('/api/validate-key', { body: {} });
    assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    models = r.json?.models ?? [];
    assert(Array.isArray(models) && models.length > 0, 'models 为空');
    record('POST /api/validate-key', true, models.map((m) => m.id).join(','));
  } catch (e) {
    record('POST /api/validate-key', false, e.message);
  }

  // 2. 搜索
  let firstUrl = '';
  let searched = [];
  try {
    const r = await callApi('/api/search', { body: { query: QUERY, count: 5 } });
    assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 300)}`);
    searched = r.json?.results ?? [];
    assert(Array.isArray(searched), 'results 不是数组');
    assert(searched.length > 0, 'results 为空（可能上游网络问题）');
    const item = searched[0];
    assert(typeof item.title === 'string' && item.title, 'title 缺失');
    assert(/^https?:\/\//.test(item.url || ''), 'url 非法');
    assert(typeof item.snippet === 'string' && item.snippet.length > 0, 'snippet 缺失');
    assert(typeof item.rerankScore === 'number', 'rerankScore 缺失（应为 camelCase）');
    assert(item.siteName === null || typeof item.siteName === 'string', 'siteName 类型错误');
    assert(Number.isInteger(item.authority), 'authority 类型错误');
    assert(!('rerank_score' in item), '仍是 snake_case 字段，未按契约转换');
    firstUrl = item.url;
    record('POST /api/search', true, `${searched.length} 条，首条 ${JSON.stringify(item.title).slice(0, 40)}…`);
  } catch (e) {
    record('POST /api/search', false, e.message);
  }

  // 3. 抓取正文
  if (firstUrl) {
    try {
      const r = await callApi('/api/fetch', { body: { url: firstUrl } });
      assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 300)}`);
      assert(typeof r.json?.title === 'string', 'title 缺失');
      assert(typeof r.json?.content === 'string' && r.json.content.length > 50, 'content 太短');
      record('POST /api/fetch', true, `${r.json.content.length} 字符`);
    } catch (e) {
      record('POST /api/fetch', false, e.message);
    }
  } else {
    record('POST /api/fetch', false, '无可用 URL，跳过');
  }

  // 4. AI 总结（SSE）
  try {
    const payloadResults = searched.slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      siteName: r.siteName,
      date: r.date,
      snippet: r.snippet,
      summary: r.summary,
    }));
    assert(payloadResults.length > 0, '没有搜索结果可用于总结');
    const res = await fetch(`${BASE}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ query: QUERY, results: payloadResults, model: 'deepseek-flash', thinking: false }),
      signal: AbortSignal.timeout(120_000),
    });
    assert(res.status === 200, `status ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    assert(ctype.includes('text/event-stream'), `content-type=${ctype}`);
    assert(res.body, '没有响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    const events = [];
    let done = false;
    while (!done) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        const event = eventLine.slice(6).trim();
        events.push(event);
        let data = null;
        try {
          data = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        if (event === 'delta' && typeof data?.text === 'string') answer += data.text;
        if (event === 'error') throw new Error(`SSE error: ${data?.code} ${data?.message}`);
        if (event === 'done') done = true;
      }
    }
    reader.cancel().catch(() => {});
    assert(answer.replace(/\s/g, '').length > 30, `总结内容过短：${JSON.stringify(answer.slice(0, 80))}`);
    record('POST /api/summarize (SSE)', true, `${answer.length} 字符，事件=${[...new Set(events)].join('/')}`);
  } catch (e) {
    record('POST /api/summarize (SSE)', false, e.message);
  }

  // 5. 静态页面
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(15_000) });
    const html = await res.text();
    assert(res.status === 200, `status ${res.status}`);
    assert(/<div id="root">|<div id="root"\/>/.test(html), 'index.html 缺少 #root');
    assert(/<script[^>]+src=/.test(html), 'index.html 缺少入口脚本');
    record('GET / (SPA)', true, `${html.length} 字节`);
  } catch (e) {
    record('GET / (SPA)', false, e.message);
  }

  // 6. 未带 Key 必须 401
  try {
    const r = await callApi('/api/search', { body: { query: 'test' }, key: '' });
    assert(r.status === 401, `期望 401，实际 ${r.status}`);
    assert(r.json?.error?.code === 'missing_api_key', `error.code=${r.json?.error?.code}`);
    assert(typeof r.json?.error?.requestId === 'string', 'requestId 缺失');
    record('缺少 Key → 401', true, r.json.error.code);
  } catch (e) {
    record('缺少 Key → 401', false, e.message);
  }

  return finish();
}

function finish() {
  console.log('\n================ 结果汇总 ================');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n通过 ${results.length - failed}/${results.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('未捕获错误：', e);
  process.exitCode = 1;
});
