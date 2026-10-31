import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 用真 worker 與真 PDF 的測試，在忙碌的 CI 上單是啟動就要幾秒。預設的 5 秒是牆鐘，會誤判。
    testTimeout: 30_000,
  },
});
