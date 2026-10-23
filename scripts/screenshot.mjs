/**
 * 用 Playwright 驱动本机已安装的 Microsoft Edge 给页面截图（无需下载浏览器）。
 *
 * 前置：服务已启动（pnpm start，默认 8787），且页面可访问。
 * 用法：
 *   $env:DEEPSEEK_API_KEY = "sk-..."   # 可选：注入到 localStorage，免手动填写
 *   $env:BASE_URL = "http://127.0.0.1:8787"
 *   node scripts/screenshot.mjs
 *
 * 输出：screenshots/01-home.png ... 07-mobile-results.png
 * 脚本对单步失败是容错的：某一步失败会记录并继续，最终以失败数决定退出码。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const QUERY = process.env.E2E_QUERY || 'DeepSeek V4 发布';
const OUT = path.resolve(process.cwd(), 'screenshots');

const failures = [];
const consoleErrors = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    await fn();
    console.log(`[SHOT] ${name} ok`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`[SHOT] ${name} FAILED: ${e.message}`);
  }
}

async function waitFor(fn, { timeout = 20_000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(interval);
  }
  throw new Error(`等待超时: ${label}`);
}

/** 预注入 localStorage：API Key + 设置 + 首次访问标记 */
const initScript = (key) => {
  try {
    if (key) localStorage.setItem('deepsearch:v1:apiKey', key);
    localStorage.setItem(
      'deepsearch:v1:settings',
      JSON.stringify({ model: 'deepseek-flash', thinking: false, aiMode: 'manual', count: 10 }),
    );
    localStorage.setItem('deepsearch:v1:welcomeSeen', '1');
  } catch {
    /* about:blank 等场景忽略 */
  }
};

async function shoot(page, name, { fullPage = false } = {}) {
  await sleep(450); // 等动画落定
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage });
  const stat = await fs.stat(file);
  console.log(`[SHOT] saved ${name} (${Math.round(stat.size / 1024)} KB)`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`BASE=${BASE}  KEY=${KEY ? '已注入' : '未提供（将只截首页）'}  QUERY=${QUERY}`);

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  });
  context.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  await context.addInitScript(initScript, KEY);

  const page = await context.newPage();
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 300)}`));

  await step('首页', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-testid="search-input"]', { timeout: 20_000 });
    await sleep(800);
    await shoot(page, '01-home.png');
  });

  await step('搜索结果', async () => {
    await page.fill('[data-testid="search-input"]', QUERY);
    await page.press('[data-testid="search-input"]', 'Enter');
    await waitFor(() => page.url().includes('/search'), { label: 'URL 跳转到 /search', timeout: 10_000 });
    await waitFor(async () => (await page.locator('[data-testid="result-card"]').count()) > 0, {
      label: '结果卡片出现',
      timeout: 45_000,
    });
    await shoot(page, '02-results.png', { fullPage: true });
  });

  await step('AI 总结', async () => {
    const btn = page.locator('[data-testid="ai-summary-button"]').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await waitFor(
        async () => {
          const text = await page.locator('[data-testid="ai-summary-card"]').innerText().catch(() => '');
          return text.replace(/\s/g, '').length > 120;
        },
        { label: 'AI 总结流式内容', timeout: 60_000 },
      );
      await sleep(1500);
    }
    await shoot(page, '03-ai-summary.png');
  });

  await step('正文抓取抽屉', async () => {
    const btn = page.locator('[data-testid="fetch-button"]').first();
    await btn.click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid="fetch-drawer"]', { timeout: 15_000 });
    await waitFor(
      async () => {
        const text = await page.locator('[data-testid="fetch-drawer"]').innerText().catch(() => '');
        return text.replace(/\s/g, '').length > 300;
      },
      { label: '正文内容加载', timeout: 60_000 },
    );
    await sleep(600);
    await shoot(page, '04-fetch-drawer.png');
    await page.keyboard.press('Escape');
  });

  await step('设置弹窗', async () => {
    await page.click('[data-testid="settings-button"]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10_000 });
    await sleep(500);
    await shoot(page, '05-settings.png');
    await page.keyboard.press('Escape');
  });

  await step('高级搜索页 + 提交', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="advanced-search-link"]', { timeout: 15_000 });
    await page.click('[data-testid="advanced-search-link"]');
    await waitFor(() => page.url().includes('/advanced'), { label: '跳转 /advanced', timeout: 10_000 });
    await page.waitForSelector('[data-testid="advanced-page"]', { timeout: 10_000 });
    await page.fill('[data-testid="advanced-phrases"]', 'DeepSeek V4');
    await page.fill('[data-testid="advanced-sites"]', 'github.com');
    await page.fill('[data-testid="advanced-after"]', '2025-01-01');
    const enChip = page.locator('[data-testid="advanced-lang-en"]');
    if ((await enChip.count()) > 0) await enChip.first().click();
    await sleep(400);
    const previewLocator = page.locator('[data-testid="advanced-preview"]');
    const preview = await previewLocator
      .inputValue()
      .catch(async () => (await previewLocator.innerText()).trim());
    console.log(`[SHOT] advanced query preview = ${JSON.stringify(preview)}`);
    if (!/site:github\.com/.test(preview) || !/lang:en/.test(preview)) {
      throw new Error(`高级搜索 query 组合不正确: ${preview}`);
    }
    // fullPage 截图会把 sticky header/fixed skip-link 画到错误位置，这里用视口截图
    await shoot(page, '12-advanced.png');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);
    await shoot(page, '12-advanced-preview.png');
    await page.click('[data-testid="advanced-submit"]');
    await waitFor(() => page.url().includes('/search'), { label: '提交后进入结果页', timeout: 10_000 });
    console.log(`[SHOT] advanced result url = ${decodeURIComponent(page.url()).slice(0, 320)}`);
    await waitFor(async () => (await page.locator('[data-testid="result-card"]').count()) > 0, {
      label: '高级搜索结果卡片',
      timeout: 45_000,
    });
    await sleep(600);
    await shoot(page, '13-advanced-results.png', { fullPage: true });
  });

  await step('移动端', async () => {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await mobile.addInitScript(initScript, KEY);
    const mp = await mobile.newPage();
    await mp.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await mp.waitForSelector('[data-testid="search-input"]', { timeout: 20_000 });
    await sleep(700);
    await shoot(mp, '06-mobile-home.png');

    await mp.fill('[data-testid="search-input"]', QUERY);
    await mp.press('[data-testid="search-input"]', 'Enter');
    await waitFor(async () => (await mp.locator('[data-testid="result-card"]').count()) > 0, {
      label: '移动端结果卡片',
      timeout: 45_000,
    });
    await sleep(500);
    await shoot(mp, '07-mobile-results.png', { fullPage: true });
    await mobile.close();
  });

  await browser.close();

  console.log('\n================ 截图结果 ================');
  for (const f of failures) console.log(`FAIL ${f}`);
  if (consoleErrors.length) {
    console.log('\n浏览器控制台错误（最多 10 条）：');
    for (const e of consoleErrors.slice(0, 10)) console.log(`  - ${e}`);
  } else {
    console.log('浏览器控制台无错误。');
  }
  console.log(`失败步骤 ${failures.length} 个；截图目录：${OUT}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('未捕获错误：', e);
  process.exitCode = 1;
});
