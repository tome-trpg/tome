---
id: ADR-0110
status: accepted
date: 2026-11-07
depends-on: [ADR-0016, ADR-0043, ADR-0062, ADR-0063, ADR-0077, ADR-0082, ADR-0084, ADR-0099]
amends: [ADR-0063, ADR-0099]
---

# ADR-0110：變異測試的細節

## 脈絡

brief 020 要照 ADR-0063 與 ADR-0099 第 17、18 項加入 Stryker。`@stryker-mutator/core` 10.1.1 在 2026-10-23 19:18 UTC 上架，2026-11-06 19:18 UTC 過了 14 天冷卻期（ADR-0077），npm 上沒有 10.1.0。開工前比對套件與 CI，留下這些沒定的細節：裝哪些套件、弱點怎麼處理、跑哪些檔案、CI 怎麼排程、第一次實測怎麼跑、門檻怎麼定。

2026-11-07 查 npm registry 與套件原始碼，查到下列事實：

* 直接安裝時，37 個間接相依會解析成上架不到 14 天的版本。用 `npm install --before=2026-10-24T11:00:00Z` 就都滿 14 天。
* CI 的 `test` 跑 `npm audit --audit-level=moderate`（ADR-0082）。Stryker 帶進的兩個間接相依有 moderate 弱點，CI 會擋下：
  * `minimatch` 10.2.6：由 core 的 `~10.2.4` 帶進來，GHSA-g3hv-75wg-m249，影響 `>=7.0.0 <11.0.1`。10.x 沒有修補版，第一個修補版是 11.0.1，2026-10-27 上架。
  * `qs` 6.15.1：`typed-rest-client` 2.3.1 釘死這個版本，有 4 個 DoS 類的通報。6.16.1 全部修好，2026-10-14 上架。
* TOME 用的 TypeScript 7.0.2 只有原生的 `tsc`，沒有 JS 編譯器 API。所以 `@stryker-mutator/typescript-checker` 用不了，core 在沙箱裡改寫 tsconfig 的步驟也會丟錯。
* GitHub Actions 的限制（docs.github.com）：
  * 單一 job 最多跑 6 小時。
  * 公開 repo 的 Linux runner 是 4 CPU、16 GB RAM。
  * `workflow_dispatch` 與排程只在 workflow 檔已經在預設分支時才觸發得到。

這些事實與每一項的建議寫在共用筆記 `brief-020-questions.md`。下列決定由維護者在 2026-11-07 從問題介面選定，13 項全部照建議。維護者另外決定：Stryker 只在 CI 跑，不在維護者的電腦上跑，第一次實測也一樣。實作時又決定 `minimatch` 的新相依一起釘版本（第 2 項）。

## 決定

**套件與授權**

1. 修改 ADR-0099 第 18 項的做法：
   * 只加 `@stryker-mutator/core` 與 `@stryker-mutator/vitest-runner`，都釘 10.1.1，放開發相依。
   * 不裝 `@stryker-mutator/typescript-checker`，因為 TypeScript 7 沒有它需要的 API。
   * 用 `--before` 指定 14 天前的時間安裝，間接相依都上架滿 14 天。
2. `package.json` 用限定範圍的 `overrides` 換掉兩個有弱點的間接相依：
   * `typed-rest-client` 底下的 `qs` 換成 6.16.1，已滿冷卻期。
   * `@stryker-mutator/core` 底下的 `minimatch` 換成 11.0.1。照 ADR-0077「安全更新不等」，不受冷卻期限制。它跨了 major，但 Stryker 只用它比對要變異的檔案。
   * `minimatch` 11.0.1 新增的相依 `@isaacs/nonrecursive-glob-match` 一起釘在 1.0.1，當成同一個安全修正的一部分，照樣不受冷卻期限制。這是維護者在實作時決定的。這個套件是同一次修正拆出來的，所有版本都在 2026-10-26 之後才上架，`minimatch` 11.0.1 要求 `^1.0.1`。1.0.1 在 2026-10-27 04:24 UTC 上架，跟 11.0.1 同一天。比對 `dist/esm`：1.0.3 只是效能改動，1.1.0 加了數字範圍的新功能，都跟弱點無關。不指定版本時，npm 會解析到 1.1.0，那時才上架兩天。
   * 新增的 161 個套件版本裡，未滿 14 天的只有 `minimatch` 11.0.1 與 `@isaacs/nonrecursive-glob-match` 1.0.1。兩者的維護者都是 isaacs，授權都是 BlueOak-1.0.0，都沒有安裝腳本。後者沒有相依，npm 的套件資料也沒有 `repository` 欄位。
   * 例外的風險有三項：
     * 兩個版本都上架不久，撤回或遭入侵的版本還沒有時間被發現，正是 ADR-0077 冷卻期要防的情況。
     * `@isaacs/nonrecursive-glob-match` 沒有 `repository` 欄位，無法從 npm 資料對回原始碼的 repo，只能看打包後的內容。
     * `minimatch` 11 不在 Stryker 宣告的 `~10.2.4` 範圍內。

     兩者都只在開發與 CI 時執行，不進 npm 包，也不進主程式行程。
   * 拿掉的條件：Stryker 的新版本把 `minimatch` 的範圍改成包含修補版，或 `minimatch` 10.x 出了修補版時，就拿掉 `minimatch` 與 `@isaacs/nonrecursive-glob-match` 的覆寫。`typed-rest-client` 不再釘死有弱點的 `qs` 時，就拿掉 `qs` 的覆寫。
3. 照 ADR-0099 第 17 項，`tools/check-licenses.ts` 的開發相依放行清單加上 BlueOak-1.0.0 與 CC-BY-4.0，主程式的白名單不變。

**範圍與設定**

4. 六個模組對應 8 個檔案：
   * 遮蔽還原：`mask.ts`
   * 驗證：`verify.ts`
   * 翻譯記憶鍵：`memory.ts`
   * 預算：`budget.ts`
   * 對外出口：`egress/gate.ts`、`client.ts`、`anthropic.ts`
   * 狀態機：`state.ts`

   `memory.ts` 整個檔案一起跑，不用行號範圍：行號一改，範圍就會對錯。
5. 設定檔是根目錄的 `stryker.config.mjs`：
   * `coverageAnalysis: 'perTest'`、不用增量模式、並行數 4。
   * 報告用 HTML、JSON 與文字，放 `reports/mutation/`。
   * `tsconfigFile` 指向不存在的檔名，跳過改寫 tsconfig 的步驟。TOME 的 tsconfig 沒有 `extends` 或 `references` 指到專案外，不需要改寫。
   * vitest 的 `pool` 設成 `forks`，跟 `npm test` 一樣。這是第一次在 PR 上跑時發現的：
     * vitest-runner 預設用 `threads`，worker thread 裡改 `process.env.TZ` 不會改到 `Date` 的時區。
     * ADR-0107 第 29 項換時區的那個測試，因此在 UTC 的 CI 上失敗。6 個 job 都在一開始的完整測試停下，還沒開始變異，每個 job 也只有這個測試失敗。
     * 在本機只跑這一個測試重現過：`TZ=UTC` 時，`--pool threads` 失敗，`--pool forks` 通過。

     不在 workflow 設 `TZ`：設成跟測試相同的時區，換時區沒生效也會通過，遮掉這個測試要檢查的事。不改測試：要動 019 的測試，範圍比較大。
   * `.gitignore` 加 `.stryker-tmp/` 與 `reports/`。

**CI**

6. 修改 ADR-0063 第 2 項的做法：新增 `.github/workflows/mutation.yml`，這是這個回合唯一可以改的 workflow 檔，維護者裁定 `.github/` 底下其他檔案照樣受保護。
   * 觸發：每週日 18:00 UTC 的排程、`workflow_dispatch`，以及只在改到 `stryker.config.mjs` 或這個 workflow 時才跑的 `pull_request`。
   * 只跑 `ubuntu-24.04`。一個模組一個 job，共 6 個，用 matrix 同時跑。
   * `timeout-minutes` 150。
   * 每個 job 上傳 HTML 與 JSON 報告當 artifact，保留 30 天。
   * 不設成必要檢查。
   * `actions/upload-artifact` 釘在 v7.0.2 的 commit，2026-10-07 上架，已過 Action 的 7 天冷卻期（ADR-0082）。
7. 第一次實測在 brief 020 的 PR 上，靠 `pull_request` 跑：
   * 先不設 `break` 門檻。
   * 維護者看過分數定門檻之後，在封存之前加進設定，再跑一次確認過得了。
   * 這個 `pull_request` 觸發留著，以後改設定或 workflow 時都會跑一次。
8. 執行時間用本機的參考數字估。那是在維護者的電腦上、跟 Docling 搶 CPU 時量的，只當參考，沒有跑完：
   * 798 個變異，15 個 test runner，約 38 分鐘測完 739 個，換算每個變異約 0.77 個 runner 分鐘。
   * 最長的「驗證」job 有 354 個變異，估計約 70 分鐘。
   * 實際時間由第一次 CI 實測決定。

**門檻、存活的變異與執行方式**

9. 修改 ADR-0063 第 3 項的做法：門檻用 Stryker 的 `thresholds.break`，值是第一次 CI 實測時 6 個模組分數的最低值，無條件捨去到 5 的倍數，每個模組都用這個數字檢查。`high` 與 `low` 用 Stryker 的預設 80 與 60，只影響報告的顏色。
10. 這個回合不改 `src/`，也不為了殺掉存活的變異補測試。存活與逾時的數量寫進這份 ADR，只寫數字。要不要補測試另開回合，由維護者看報告決定。
11. `package.json` 不加 `npm run mutation`。workflow 直接執行 `npx --no-install @stryker-mutator/core run`，CONTRIBUTING 與白皮書寫明只在 CI 跑。
12. CHANGELOG 不寫：這是開發工具，使用者看不到。

**不放進 020 的**

13. 下列事項不放進這個回合：
    * 增量模式與跨次執行的快取。
    * 六個模組以外的檔案。
    * 在 Windows 跑變異測試。
    * 為了殺掉存活的變異補測試。

## 驗證

<!-- @assert-present file="stryker.config.mjs,.github/workflows/mutation.yml,tests/tools/mutation.test.ts" -->
<!-- @assert-count target="package.json" regex="true" symbol="@stryker-mutator/core.: .10\.1\.1" expected="1" comments="include" reason="第 1 項：Stryker 釘 10.1.1" -->
<!-- @assert-count target="package.json" regex="true" symbol="@stryker-mutator/vitest-runner.: .10\.1\.1" expected="1" comments="include" reason="第 1 項：vitest-runner 釘 10.1.1" -->
<!-- @assert-absence target="package.json" symbol="typescript-checker" comments="include" reason="第 1 項：TypeScript 7 沒有它需要的 API" -->
<!-- @assert-count target="package.json" regex="true" symbol=".qs.: .6\.16\.1" expected="1" comments="include" reason="第 2 項：qs 換成修補版" -->
<!-- @assert-count target="package.json" regex="true" symbol=".\..: .11\.0\.1" expected="1" comments="include" reason="第 2 項：minimatch 換成修補版" -->
<!-- @assert-count target="package.json" regex="true" symbol="@isaacs/nonrecursive-glob-match.: .1\.0\.1" expected="1" comments="include" reason="第 2 項：minimatch 的新相依釘在同一次修正的版本" -->
<!-- @assert-count target="tools/check-licenses.ts" symbol="new Set(['0BSD', 'BlueOak-1.0.0', 'CC-BY-4.0'])" expected="1" reason="第 3 項：開發相依多放行兩種授權" -->
<!-- @assert-count target="stryker.config.mjs" symbol="tsconfigFile: 'stryker-skips-tsconfig-rewrite.json'" expected="1" comments="include" reason="第 5 項：跳過改寫 tsconfig" -->
<!-- @assert-count target="stryker.config.mjs" symbol="pool: 'forks'" expected="1" comments="include" reason="第 5 項：跟 npm test 一樣用 forks" -->
<!-- @assert-count target=".github/workflows/mutation.yml" symbol="cron: '0 18 * * 0'" expected="1" comments="include" reason="第 6 項：每週排程" -->
<!-- @assert-count target=".github/workflows/mutation.yml" symbol="timeout-minutes: 150" expected="1" comments="include" reason="第 6 項：job 的時限" -->
<!-- @assert-absence target="package.json" regex="true" symbol=".mutation.:" comments="include" reason="第 11 項：不加 npm run mutation" -->

## 後果

變異測試每週在 CI 跑一次，改到設定時也會跑。分數低於門檻時 job 失敗，報告保留 30 天。

開發相依多了兩個覆寫，Stryker 升版時要一起看。`minimatch` 11 不在 Stryker 宣告的範圍內，Stryker 比對檔案的行為若有變化，CI 上的變異數會不同。在 Windows 上跑的情況沒有驗證。

## 替代方案

否決了下列做法：

* **CI 的 `npm audit` 改成 `--omit=dev`**：要改 ADR-0082 的門檻，開發相依的弱點就看不到了。
* **Stryker 另外放一個 lockfile**：根目錄的 audit 不會查到它，Dependabot 也要另外設定。
* **等 Stryker 修**：時間不確定。
* **用 `inPlace: true`**：本機跑到一半被中斷時，原始檔會留著變異過的內容。
* **所有模組在一個 job 裡跑**：估計要 2.6 小時，離 6 小時的時限比較近，也看不出單一模組的分數。
* **在回合分支上暫時加 `push` 觸發**：要多兩個 commit，拿掉之前每次推送都跑一輪。
* **先合併、再用 `workflow_dispatch` 跑**：020 合併時還沒有門檻。
* **每個模組各自一個門檻**：要維護 6 個數字。
* **這個回合就補測試**：範圍變大，也要等實測之後才知道要補什麼。
* **加 `npm run mutation`**：容易在本機誤用。
* **在維護者的電腦上跑第一次實測**：會占用所有 CPU，跟維護者的工作搶資源。

## Open Questions

- [ ] 第一次 CI 實測的分數、存活與逾時數、每個 job 的時間，實測後補進這份 ADR。
- [ ] `minimatch` 11.0.1 與 `@isaacs/nonrecursive-glob-match` 1.0.1 未滿冷卻期就用了：要等 Stryker 改掉 `minimatch` 的範圍，或 `minimatch` 10.x 出修補版，才拿掉覆寫（第 2 項）。
