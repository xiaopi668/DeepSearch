/**
 * Vitest 配置：node 环境，只跑 tests/server 下的测试。
 * 所有测试使用 fake fetch / stub client，绝不访问真实 DeepSeek。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.mjs'],
    exclude: ['node_modules/**', 'web/**', 'dist/**'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
