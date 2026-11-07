// 變異測試（ADR-0063、ADR-0110）。只在 CI 的 `.github/workflows/mutation.yml` 跑，不在本機跑。
// workflow 一個模組一個 job，用 `--mutate` 換成那個模組的檔案；這裡列的是全部，
// `tests/tools/mutation.test.ts` 確認兩邊一致。

/** 六個關鍵模組的 8 個檔案（ADR-0063 第 1 項）。 */
export const MUTATED = [
  // 遮蔽還原
  'src/core/mask.ts',
  // 驗證
  'src/core/verify.ts',
  // 翻譯記憶鍵：檔案小，整個檔案一起跑，不用行號範圍
  'src/core/memory.ts',
  // 預算
  'src/core/budget.ts',
  // 對外出口
  'src/core/egress/gate.ts',
  'src/core/egress/client.ts',
  'src/core/egress/anthropic.ts',
  // 狀態機
  'src/core/state.ts',
];

export default {
  testRunner: 'vitest',
  // vitest-runner 預設用 threads，TOME 的 `npm test` 用 vitest 5 預設的 forks。worker thread 裡改
  // `process.env.TZ` 不會改到 `Date` 的時區，換時區的測試在 UTC 的 CI 上會失敗。照 `npm test` 用 forks（ADR-0110）。
  vitest: { configFile: 'vitest.config.ts', pool: 'forks' },
  mutate: MUTATED,
  coverageAnalysis: 'perTest',
  incremental: false,
  // 等於 GitHub 公開 repo 的 Linux runner 的 CPU 數。
  concurrency: 4,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  // TypeScript 7 沒有 JS 編譯器 API，Stryker 在沙箱裡改寫 tsconfig 的步驟會丟錯。指向不存在的檔案，
  // 那個步驟就跳過。TOME 的 tsconfig 沒有 extends 或 references 指到專案外，不需要改寫（ADR-0110）。
  tsconfigFile: 'stryker-skips-tsconfig-rewrite.json',
  // 門檻是第一次 CI 實測時 6 個模組分數的最低值（對外出口 85.55），無條件捨去到 5 的倍數，
  // 每個模組都用它檢查（ADR-0063 第 3 項、ADR-0110 第 9 項）。high 與 low 只影響報告的顏色。
  thresholds: { high: 80, low: 60, break: 85 },
};
