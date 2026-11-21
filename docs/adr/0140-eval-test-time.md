---
id: ADR-0140
status: accepted
date: 2026-11-21
depends-on: [ADR-0049, ADR-0131, ADR-0139]
---

# ADR-0140：評測測試的時間

## 脈絡

`tests/tools/eval.test.ts`（ADR-0139）有兩個端到端測試在 Windows 的 runner 上貼著 vitest 的 30 秒上限，PR 95（vitest 5.1.0）因此逾時卡住。Manager 讀 CI 的紀錄（Windows；Ubuntu 都過）：

| 測試 | PR 94 | main `47cd1ac` | PR 95（job 136849709628） |
| :--- | ---: | ---: | ---: |
| runs the six variants in batches through the product, one passage per request | 13.7 秒 | 17.3 秒 | 32.6 秒，逾時 |
| walks select, estimate, run, score and report, and carries over a score from the blind round | 18.5 秒 | 26.6 秒 | 32.3 秒，逾時 |

逾時的診斷（ADR-0131 第 14 項）寫機器 CPU 40%、事件迴圈的延遲最多 5.5 秒；逾時後清暫存資料夾報 `EPERM ... syscall: 'rm'`。

執行 session 在維護者的筆電（Windows 11，16 核）上查：

* **時間花在規劃書**。評測工具每規劃一本書（`planBook`）就起一個 worker 跑規則包的正則（`runPatterns`，ADR-0049），每個 worker 從啟動到結束約 130 ms（`--cpu-prof` 量的，大多是 Node 載入模組、去掉型別）；新開的 `book.db` 還要先建單位。「runs the six variants」的分段：工作區 1.1 秒、挑段落 0.8 秒、試算 4.1 秒（6 組 × 2 本，每次約 340 ms）、送出 3.0 秒（每組每本約 250 ms）、重跑 1.9 秒。假供應商的批次本身不慢。
* **兩個測試各把 6 組完整跑一次**。用 `--cpu-prof` 數 worker：「runs the six variants」起了 38 個（挑段落 2、試算 12、送出 12、重跑 12），走完整指令的測試起了 28 個，試算的測試 26 個。6 組 × 2 本 × 每個階段，次數乘起來就多。
* **`EPERM` 是逾時的結果**，跟 ADR-0131 第 12 項同一回事。用 `--testTimeout=3000` 讓「runs the six variants」逾時，就重現 `EPERM`：vitest 不會中止逾時的測試，它還在跑、還開著 `book.db`，`onTestFinished` 的 `rmSync` 刪不掉，Windows 上開著的檔案刪不掉。正常跑完的路徑，`tools/` 的每個 `openBookStore` 都在 `finally` 裡關，測試通過時 `rmSync` 也都刪得掉；沒有沒關的資料庫或伺服器。

## 決定

1. **6 組只在一個測試裡走一次，用一本書**。「runs the six variants」只挑 ORC 那本合成書（8 段），6 組各送一次；「跑過的不再送」只重跑 B 組（每一組走同一段程式）。它不先試算：`runAll` 只拿試算的結果檢查上限與預算、書由它自己複製，所以給一份合成的試算結果，省下 6 次規劃；試算本身由試算的測試驗證。每一組的差別照舊驗證：每個請求剛好一段、C 開自適應思考、D 的前綴是中文指令、B 是英文指令、F 是低 effort、E 每段一個請求、A 重送到上限後淘汰。
2. **試算的測試照舊試算 6 組、2 本書**（各組的估價比較與每本書的請求數），總估價超過上限的檢查只試算 B 組：判斷的是合計與預算，一組就夠。
3. **走完整指令的測試只跑 B 組**。`EvalIo` 加一個測試用的 `variants`，沒給就是 6 組，維護者用的指令不變。指令的接線（挑段落、試算、送出、評分、沿用分數、出報告）一組就看得到；兩本書照舊。
4. **不給單一上限，也不改全域的 `testTimeout`**。改輕之後兩個測試在本機都在 4 秒以內，離 30 秒有餘裕；拉長上限只會遮掉真的變慢（ADR-0131 第 13 項）。
5. **`EPERM` 不另外處理**，理由同 ADR-0131 第 12 項：它跟在逾時後面；吞掉它，以後真的有檔案沒關好，Windows 上就看不到了。
6. **改了什麼、驗證搬到哪裡**：

   | 原本的驗證 | 修改後 |
   | :--- | :--- |
   | 6 組各自的差別（請求一段、思考、指令、effort、淘汰） | 「runs the six variants」，一本書 |
   | E 送 12 個請求、Haiku 超過 12 個 | 同一個測試，一本書是 8 個、超過 8 個 |
   | 跑過的不再送（6 組重跑） | 重跑 B 組 |
   | 6 組的測試先試算 6 組再送出 | 給 `runAll` 一份合成的試算結果；試算由試算的測試、試算接到送出由指令的測試驗證 |
   | 每本書的請求數、各組估價的大小 | 試算的測試，照舊 6 組、2 本書 |
   | 總估價超過上限不送（6 組試算） | 只試算 B 組，`runAll` 照樣拒絕 |
   | 指令走完整流程（6 組） | 只跑 B 組，另外檢查試算只列 B |

7. **本機的量測**（Windows 11、16 核，只跑這個測試檔、暖機後；修改前跑一次，修改後取三次的中位數；**已量測**）：

   | 測試 | 修改前 | 修改後 | worker 數（前 → 後） |
   | :--- | ---: | ---: | ---: |
   | runs the six variants… | 7.7 秒 | 2.4 秒 | 38 → 8 |
   | walks select, estimate, run, score and report… | 7.1 秒 | 1.8 秒 | 28 → 8 |
   | estimates each variant the way it will be sent… | 4.0 秒 | 2.9 秒 | 26 → 16 |
   | 整個測試檔 | 21.3 秒 | 10.9 秒 | |

   worker 數用 `--cpu-prof` 數 `pattern-worker` 的 profile。秒數在這台機器上一次差到 1 秒，看趨勢就好。

8. **Windows runner 上的秒數**（CI 的 `test (windows-2025)`，從 job 的日誌讀；**已量測**）：

   | 測試 | main `47cd1ac` | PR 98 `1b2bb27`（只改輕，6 組照樣先試算） |
   | :--- | ---: | ---: |
   | runs the six variants… | 17.3 秒 | 9.7 秒 |
   | walks select, estimate, run, score and report… | 26.6 秒 | 5.8 秒 |
   | estimates each variant… | 6.3 秒 | 6.3 秒 |
   | copies the books out of the workspace… | 2.7 秒 | 3.0 秒 |
   | 整個測試檔 | 53.0 秒 | 24.8 秒 |

   Ubuntu 上同一個檔從 11.2 秒降到 6.7 秒。6 組的測試不先試算（第 1 項）是在 `1b2bb27` 之後改的，那一版在 Windows 上的秒數，CI 跑完後補在這裡。PR 95 上（vitest 5.1.0）兩個測試比 main 慢將近一倍，照這個比例，9.7 秒的版本約 18 秒，所以再把試算拿掉（**估算**）。

## 驗證

<!-- @assert-count target="vitest.config.ts" symbol="testTimeout: 30_000," expected="1" reason="第 4 項：全域的上限不改" -->
<!-- @assert-count target="tests/tools/eval.test.ts" symbol="const ONLY_B = VARIANTS.filter(({ code }) => code === 'B');" expected="1" reason="第 1 到 3 項：6 組只在一個測試裡走" -->
<!-- @assert-count target="tools/eval.ts" symbol="const specs = io.variants ?? VARIANTS;" expected="1" reason="第 3 項：測試才給 variants，預設 6 組" -->

## 後果

評測工具的測試檔在 Windows runner 上從 53 秒降到 25 秒，兩個慢的測試離上限有餘裕，PR 95 可以重新跑。6 組的完整流程只剩一個測試、一本書；6 組 × 2 本書合在一起的路徑，只有試算的測試走（送出不走）。`EvalIo` 多一個測試用的欄位。

## 替代方案

* **給這兩個測試單一上限（例如 60 秒）**：最省事，但 PR 95 上已經到 32 秒，再變慢一次又會碰到；也遮掉了重複規劃的浪費。
* **重用跑正則的 worker**：每次規劃都省下 worker 的啟動，產品也受益，但動到 ADR-0049 的隔離做法，不在這個回合；見 Open Questions。
* **兩個測試共用一個工作區（`beforeAll`）**：省下合成書的建立（約 1 秒），但測試之間會互相影響，暫存資料夾的清理也要另外處理。
* **把兩個測試合成一個**：少走一次挑段落與試算，但單一測試更長，正是要避免的。

## Open Questions

- [ ] 產品每次規劃書也起一個跑正則的 worker（維護者的筆電上每個約 130 ms）。對使用者每個指令只多一點時間，要不要重用 worker 另外決定。
