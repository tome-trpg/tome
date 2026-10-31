---
id: ADR-0082
status: accepted
date: 2026-11-01
depends-on: [ADR-0014, ADR-0015, ADR-0028, ADR-0034, ADR-0052, ADR-0053, ADR-0059, ADR-0068, ADR-0072, ADR-0073, ADR-0077]
---

# ADR-0082：M0 的工具鏈與 CLI 慣例

## 脈絡

M0 要動手寫第一批程式，白皮書留了幾項沒定：CLI 怎麼解析參數、schema 怎麼寫、用哪版 TypeScript、金鑰的環境變數叫什麼、檔案放哪裡。這些都由維護者在第一個實作回合決定。

## 決定

**工具鏈**

1. CLI 用內建的 `node:util` `parseArgs`，外加一層薄路由，不用 commander。訊息與結束碼完全自己控制。
2. schema 手寫 JSON Schema 2020-12，放根目錄 `schemas/`，它就是真實來源，Python 轉接器也直接讀。驗證用 Ajv 8.20.0。TS 型別另外手寫。
3. TypeScript 用 7.0.2 原生編譯器，`tsc` 建置到 `dist/`，不用打包工具。
4. M0 只用 `tsc` 的 strict 當靜態檢查，不加 linter 與 formatter。之後要加再開 ADR。
5. `npm audit` 在 CI 的門檻是 `moderate`，全部相依都查。
6. 相依授權檢查是 `tools/check-licenses.ts`，直接讀 `package-lock.json` 的 `license` 欄，全部相依含開發相依都要在白名單內，不加新相依。

**命名與版面**

7. 核心函式庫在 `src/core`，CLI 在 `src/cli`，核心不依賴 CLI。
8. 對外出口模組的路徑是 `src/core/egress/`。M0 完全不連網，所以還沒有這個目錄，斷言先排除這條路徑。
9. 訊息放 `src/cli/messages/zh-TW.json`。核心只回傳英文代碼與參數，不放給人看的文字。
10. `tome.yaml` 第一行是 `schema: tome-workspace/1`。`scanner_model`、`translator_model` 在範本先註解掉，M2 才必填。
11. `--json` 的外層是 `{"schema":"tome-cli/1","ok":true,"data":{},"findings":[]}`。

**金鑰**

12. 覆蓋金鑰的環境變數是 `TOME_ANTHROPIC_API_KEY`，不讀 `ANTHROPIC_API_KEY`，避免在沒注意時花到給別的工具用的金鑰。
13. 憑證庫的 service 是 `tome-trpg`，account 是供應商 ID，如 `anthropic`。
14. `tome provider auth set <provider>` 只從隱藏輸入或 stdin 讀金鑰，沒有旗標參數，金鑰才不會留在 shell 歷史。

**行為**

15. `tome init` 拒絕 git repo 內的路徑時回 1；同步資料夾只警告，回 0；已初始化時重跑回 0，不覆蓋。
16. 旗標錯誤、資料庫版本比程式新、檔案壞掉都回 2。
17. `tome doctor`：沒有工作區、沒有金鑰算發現，回 1；uv 沒裝是提示，回 0，因為只有裝引擎才需要；引擎與價目表顯示 M1、M2 才有，不算發現。
18. `book.db`、`series.db` 的第一個遷移只建 `tome_meta` 表，記下資料庫的種類，防止開錯庫。其他表之後的階段才加。

**流程**

19. PR 用 merge commit。spec-harness 的簽章裁決等需要時再設：維護者的簽章金鑰在磁碟上，代理人也能用，這份保護要等 FIDO2 金鑰才有實質意義。
20. spec-harness 加上 git pre-commit hook。回合的分支是 `claude/brief-<編號>-<名稱>`，brief 放 `briefs/`。

**冷卻期的例外**

21. `@spec-family/*` 四個工具不受 ADR-0077 的冷卻期限制。它們是維護者自己的工具，上架才幾天，也沒有更舊的正式版本。

schema 的欄位細節仍是提案（白皮書 §5.2、§5.8），M1 實作時可以調整。`$id` 用 repo 裡的公開路徑，不解析網路。

## 驗證

<!-- @assert-layers target="src" exclude="*.json" order="src/core, src/cli" reason="核心不依賴 CLI（ADR-0028）" -->
<!-- @assert-import-absence target="src" exclude="src/core/store.ts *.json" module="node:sqlite sqlite" reason="只有資料存取層碰 node:sqlite（ADR-0052）" -->
<!-- @assert-import-absence target="src" exclude="src/core/process.ts *.json" module="node:child_process child_process" reason="子行程一律走過濾金鑰的那一個模組（ADR-0034）" -->
<!-- @assert-import-absence target="src" exclude="src/core/secrets.ts *.json" module="@napi-rs/keyring" reason="只有金鑰模組碰憑證庫" -->
<!-- @assert-absence target="src" glob="*.ts" regex="true" symbol="[一-鿿]" reason="訊息集中在資料檔（ADR-0027）" -->
<!-- @assert-absence target="src/core" regex="true" symbol="console\.|process\.std(out|err)" reason="核心不輸出，CLI 才輸出（ADR-0028）" -->
<!-- @assert-present file="schemas/tome-ir-1.schema.json,schemas/tome-pack-1.schema.json,src/cli/messages/zh-TW.json,tools/check-licenses.ts,.github/workflows/test.yml" -->
<!-- @assert-count target=".github/workflows/test.yml" symbol="npm audit --audit-level=moderate" min="1" comments="include" reason="ADR-0068 的 npm audit" -->

## 後果

路由與 help 要自己寫。schema 與 TS 型別要手動同步，測試用同一份範例對兩邊。沒有 linter，風格靠人。

## 替代方案

**commander**：巢狀指令省事，但自帶英文訊息要逐條覆寫；**TypeBox**：型別自動同步，但真實來源變成程式碼；**TypeScript 6.0.3**：之後還要再升一次大版本；**Biome、ESLint**：現在用不到，Biome 最新版也還沒過冷卻期；**讀 `ANTHROPIC_API_KEY`**：可能花到別的金鑰；都否決。
