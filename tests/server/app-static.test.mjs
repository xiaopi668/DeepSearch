import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_BUILD_DIR, createTestApp, disposeApp, makeTempDir } from './helpers.mjs';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
});

/** 构造一个临时 dist/web 目录。 */
function createFakeBuild() {
  const dir = makeTempDir('deepsearch-dist-');
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html lang="zh-CN"><body><div id="root">DeepSearch-AI-APP</div></body></html>',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("deepsearch");', 'utf8');
  return dir;
}

describe('静态托管与 SPA 回退（契约 §5，已构建）', () => {
  it('GET / 返回 index.html，深链回退到 index.html', async () => {
    const { app } = createTestApp({ staticDir: createFakeBuild() });
    try {
      const root = await request(app).get('/');
      expect(root.status).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.text).toContain('DeepSearch-AI-APP');
      expect(root.headers['x-request-id']).toBeTruthy();

      for (const pathname of ['/search?q=DeepSeek+V4', '/settings', '/some/deep/link']) {
        const response = await request(app).get(pathname);
        expect(response.status, pathname).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.text).toContain('DeepSearch-AI-APP');
      }
    } finally {
      disposeApp(app);
    }
  });

  it('静态资源正常返回，安全头齐全', async () => {
    const { app } = createTestApp({ staticDir: createFakeBuild() });
    try {
      const asset = await request(app).get('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toContain('deepsearch');
      expect(asset.headers['x-content-type-options']).toBe('nosniff');
      expect(asset.headers['x-frame-options']).toBe('DENY');
      expect(asset.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(asset.headers['content-security-policy']).toContain("script-src 'self'");
    } finally {
      disposeApp(app);
    }
  });

  it('API 优先于静态回退：/api/health 和 /api 404 不受影响', async () => {
    const { app } = createTestApp({ staticDir: createFakeBuild() });
    try {
      const health = await request(app).get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);

      const missingApi = await request(app).get('/api/not-exists');
      expect(missingApi.status).toBe(404);
      expect(missingApi.headers['content-type']).toContain('application/json');
      expect(missingApi.body.error.code).toBe('not_found');
    } finally {
      disposeApp(app);
    }
  });

  it('非 GET 的非 API 请求不会回退到 SPA → 404 JSON', async () => {
    const { app } = createTestApp({ staticDir: createFakeBuild() });
    try {
      const response = await request(app).post('/');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    } finally {
      disposeApp(app);
    }
  });
});

describe('未构建 dist/web（契约 §5）', () => {
  it('GET / 返回 503 中文说明，/api/health 仍可用', async () => {
    const { app } = createTestApp({ staticDir: NO_BUILD_DIR });
    try {
      const root = await request(app).get('/');
      expect(root.status).toBe(503);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.text).toContain('pnpm build');
      expect(root.text).toContain('尚未构建');

      const deepLink = await request(app).get('/search?q=test');
      expect(deepLink.status).toBe(503);

      for (const pathname of ['/api/health', '/api/does-not-exist']) {
        const response = await request(app).get(pathname);
        expect(response.status, pathname).not.toBe(503);
      }

      const health = await request(app).get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
    } finally {
      disposeApp(app);
    }
  });

  it('未构建时非 GET 非 API 请求 → 404 JSON', async () => {
    const { app } = createTestApp({ staticDir: NO_BUILD_DIR });
    try {
      const response = await request(app).post('/anything');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    } finally {
      disposeApp(app);
    }
  });
});
