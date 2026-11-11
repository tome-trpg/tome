import { configDefaults, defineConfig } from 'vitest/config';

// 契約測試要真的金鑰、會花錢，`npm test` 不跑，只有 `npm run test:contract` 跑（ADR-0099 第 26 項、ADR-0109 第 10 項）。
export default defineConfig(({ mode }) => {
  const contract = mode === 'contract';
  return {
    test: {
      include: contract ? ['tests/contract/**/*.test.ts'] : ['tests/**/*.test.ts'],
      exclude: contract ? [...configDefaults.exclude] : [...configDefaults.exclude, 'tests/contract/**'],
      // 用真 worker 與真 PDF 的測試，在忙碌的 CI 上單是啟動就要幾秒。預設的 5 秒是牆鐘，會誤判。
      testTimeout: 30_000,
      // 測試逾時時印一行 CPU、記憶體與事件迴圈的讀數，分得出是測試在忙還是機器停住（ADR-0131）。
      setupFiles: ['tests/setup/timeouts.ts'],
    },
  };
});
