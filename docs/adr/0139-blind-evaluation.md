---
id: ADR-0139
status: accepted
date: 2026-11-14
depends-on: [ADR-0036, ADR-0041, ADR-0059, ADR-0061, ADR-0065, ADR-0068, ADR-0079, ADR-0099, ADR-0103, ADR-0112, ADR-0130, ADR-0135, ADR-0138]
amends: [ADR-0065]
---

# ADR-0139：盲評

## 脈絡

ADR-0065 定了盲評的做法：約 100 段涵蓋各角色的黃金段落，先用自動指標淘汰，剩下的隨機排序、隱藏模型名稱，由維護者評 1 到 5 分，一次涵蓋模型、思考開關與指令語言，花費上限 30 美元。Q-8 是平均 4 分以上（ADR-0079）。ADR-0130 第 14 項限定黃金段落只用公開 ORC 文件與公有領域文本，第 5 項把「要不要用審定介面打分」留到這個回合，第 22 項列了要問的：自動指標、評審一致性、`docs/evals/` 寫什麼。

幾個前提：

* 主翻譯一律關閉思考，關不掉的用低 effort（`src/core/provider.ts` 的 `thinkingParams`）；指令只有英文（`prompts/translate.md`，ADR-0099 第 27 項）。所以「開思考」與「中文指令」兩組現在跑不起來。
* 供應商檔只有 Fable 5.1；Anthropic 的模型頁在 2026-11-14 把 Fable 5.2 列為最新的模型（Manager 讀到、執行 session 再讀一次）。
* 沒有黃金段落、`docs/evals/` 與跑盲評的工具。The Call of Cthulhu 在維護者的工作區已解析過（ADR-0112 第 4 項），ORC 文件只在 runner 上解析過（ADR-0136）。

開工前的 11 項問題寫在共用筆記 `brief-048-questions.md`，維護者在 2026-11-14 全部照建議選定，第 1 項改用 Manager 修過的版本（第 6 組比 Fable 5.2，不比 Fable 5.1）。實作時的細節寫在 `brief-048-details.md`。

2026-11-21：6 組都跑完、維護者評了一部分之後，覺得 6 組 × 100 段太花時間，改成只評 B 組抽出的 50 段（第 16 項）。

## 決定

**比什麼**

1. **6 組，全部批次、同一組黃金段落**（問題第 1 項）：

   | 組 | 模型 | 思考 | 指令 | 回答的問題 |
   | :--- | :--- | :--- | :--- | :--- |
   | A | Haiku 5.5 | 關 | 英文 | H-2：最便宜的夠不夠上桌 |
   | B | Sonnet 5.5 | 關 | 英文 | M2、M3 用的設定，Q-8 的候選 |
   | C | Sonnet 5.5 | 開（自適應） | 英文 | H-13 |
   | D | Sonnet 5.5 | 關 | 中文 | H-18 |
   | E | Opus 5.5 | 低 effort | 英文 | 貴一級值不值得 |
   | F | Fable 5.2 | 低 effort | 英文 | 最新、最貴的一級 |

   2026-11-21 由第 16 項修改：6 組照樣都跑完，人評只評 B 組，其他 5 組只報自動指標。

2. **供應商檔補上 Fable 5.2，Fable 5.1 留著**（問題第 1 項）。2026-11-14 讀官方的模型頁、價目頁、批次頁、思考與 effort 的頁面（`platform.claude.com/docs`）：
   * 價格（美元／百萬 token）：輸入 8、輸出 40；快取寫入 5 分鐘 10、1 小時 16；快取命中 0.20，是基本輸入價的 0.025 倍（價目頁的註腳，Fable 5.1 也是）。
   * 批次價 4／20，**列在批次的價目表裡**，不是推算（Manager 原本以為要照五折的註腳推算）。
   * 沒有長 prompt 的另一組價格：價目頁寫 Claude 4.6 之後的模型（Haiku 5.5 除外）整個 1M 的上下文都是標準價。
   * 思考：一直開著、關不掉（`disabled` 回 400），`budget_tokens` 回 400；effort 五級都支援，API 的預設是 `high`。所以照 Fable 5.1 設成低 effort、估價的輸出乘 1.5。
   * `fallback.server` 照 Fable 5.1 先填 `true`；維護者跑 `tome provider test` 對過 Models API 的結果寫在第 15 項。
   * 加了模型，供應商檔的雜湊跟著變，估價的指紋包含它，**已確認的估價升級後要重新確認**；改價目時本來就是這樣。

3. **開思考與中文指令只給評測用**（問題第 2 項）：核心的 `PlanOverride` 多一個 `EvalVariant`，只有 `tools/` 會傳：
   * `thinking: 'adaptive'`：只在這次的計畫裡把模型的思考換成自適應思考（送 `thinking: {type: "adaptive"}`），供應商檔與 schema 都不收這個值。思考的 token 沒量過，估價的輸出暫乘 4（`EVAL_THINKING_FACTOR`，提案），讓 30 美元的把關有意義。
   * `instructions`：換掉靜態前綴最前面的指令。中文版是 `tools/eval/translate.zh-TW.md`，執行 session 譯、維護者逐字審過才跑；標籤、屬性與英文的範例句不譯。產品的提示不改；中文指令比較好時，換提示另寫 ADR（提示是快取前綴的一部分，ADR-0036）。
   * `separate`：一段一個請求（見第 6 項）。
   * CLI、`tome.yaml`、`book.yaml` 都碰不到這三個選項。

**黃金段落與翻法**

4. **100 段：ORC 文件 60 段、The Call of Cthulhu 40 段，照角色分層隨機挑，種子固定**（問題第 3 項）。
   * 每個角色先給至少 2 段（那個角色的段落夠的話），剩下的照各角色還能挑的數量比例分，零頭給餘數大的。段落不夠時全部挑。
   * 一段是一組單位（表格、清單的一組，或單獨一段）。不需翻譯的單位與整塊在本機欄位化的數值塊不挑，它們不會送到模型。
   * 工具把挑出來的段落寫成本機的 HTML 給維護者看一次，維護者只剔除解析壞掉的，剔幾個補幾個（同一個種子）。
   * 種子預設 48，報告寫出實際用的種子。
5. **ORC 文件在維護者的電腦上用 `tome add`、`tome extract` 解析一次**（問題第 4 項），050 收尾也用。
6. **照產品的翻法**（問題第 3 項）：同一套提示、風格指南、人設與範例、詞條（ORC 用 `d100-orc`、Cthulhu 用 `generic`）、驗證、重送、帳本、外送紀錄與預算。不跑 Pass 0，不用實體卡與全書提要。實作細節：
   * **一段一個請求，每段帶自己真正的前文**（維護者 2026-11-14 同意）。這跟產品的請求組法不同：產品照閱讀順序把連續的單位併成一個請求（最多 6,000 字元、40 個單位），只有第一個單位的 `<context>` 是書裡的前文，後面的單位靠同一個請求裡前面的單位理解。黃金段落散在全書，照產品的組法併在一起的話，後面的段落拿到的「前文」是別的黃金段落，不是它在書裡的前文。所以評測一段一個請求，用產品同一套 `<context>` 的算法取它自己的前文。代價是靜態前綴（量過 generic 3,461 字元、`d100-orc` 4,038 字元，約 1,400 到 1,700 token）每段送一次，6 組合計約多 $1.2（估算）。評的是模型翻一段的品質；產品裡同一請求的鄰近單位帶來的語境，這次的分數不含。
   * 每組一個工作區，書的 `book.yaml` 與 document 層從維護者的工作區複製過去，`book.db` 各自另開：翻譯記憶不會在組之間共用，維護者的工作區只讀。
   * 送出走 `withRun` 與 `sendInBatches`，只送黃金段落的單位（比照 045 的試翻），不套校準、不開快取。

**淘汰、評分與一致性**

7. **自動指標是 TOME 自己的驗證**（問題第 5 項）：重送後還是 `FAILED_QA`（或拒答、個資閘門擋下）的段落淘汰，不給維護者評，每組列出淘汰率；淘汰率超過一成的組整組不評，記成不及格。只報告的問題（機翻腔、過長、代名詞等）評的時候不顯示，評完跟分數一起列。沒有參考譯文，BLEU、chrF、COMET 這類指標用不了。
8. **評分沿用 047 的本機網頁**（問題第 6 項，ADR-0130 第 5 項）：
   * 047 的伺服器拆成兩層：`startLocalServer` 管權杖、`Host` 與 `Origin`、表單、標頭、只聽 `127.0.0.1` 與關閉；頁面只回答權杖之後的路徑。審定網頁與評分頁都掛在它上面，ADR-0138 的斷言照舊成立。
   * 一段一頁：原文顯示一次，各組的譯文每段重新隨機排序、用 A、B、C… 標，不顯示組別；一字不差的譯文只顯示一次，分數算給每一組。按 1 到 5 評，`↑`、`↓` 換一則，Enter 儲存。
     2026-11-21 由第 16 項修改：只評 B 組，一段只顯示原文與 B 的譯文，頁面寫明是哪個模型，不是盲評。
   * **分數的定義**寫在頁面上，也寫進 `docs/evals/` 的報告（ADR-0065 只寫「1 到 5 分」，維護者 2026-11-14 審過這五級）：1 分不能用，意思錯了或讀不通；2 分要大改才能用；3 分要小改才能用；4 分可以直接上桌；5 分很好，讀起來像原本就用中文寫的。照這個定義，Q-8 的「平均 4 分以上」就是平均可以直接上桌。
   * 每段儲存就寫進評測資料夾的 `scores.json`，可以分次評完；組別的對照在 `blind.json`，用作業系統的亂數排，評完出報告時才拿來對。
     2026-11-21 由第 16 項修改：抽樣與分數改存 `sample.json` 與 `sample-scores.json`；`blind.json`、`scores.json` 只讀來沿用 B 已經評過的分數。
   * 跑評測的工具是 `tools/eval.ts`（`select`、`estimate`、`run`、`score`、`report`），不隨套件發佈。
9. **一致性**（問題第 7 項）：隨機挑 10 段，所有組的譯文在後半段、第一次之後再出現一次。報告列出同一則譯文前後兩次分數完全相同的比例、平均差距、差距在 1 以內的比例；後者不到八成，報告標成「不穩定」。
   2026-11-21 由第 16 項修改：照比例改成 5 段，判定照舊。

**結果**

10. **Q-8 用 050 收尾要用的組算**（問題第 8 項），預期是 B。平均只算評過的段落，旁邊列淘汰率，跟 ADR-0130 第 15 項處理 `FAILED_QA` 的方式一致。盲評顯示別組比較好時，050 改用那一組，Q-8 也跟著用它。
    2026-11-21 由第 16 項修改：Q-8 只用 B 組抽出的 50 段判定，沒有別組的人評可以比。
11. **`tome init` 的範本**（ADR-0041 第 3 項）：結果出來後，建議組合改成指向 `docs/evals/` 的結果，字樣先給維護者審。
    2026-11-21 由第 16 項修改：範本照 ADR-0041 第 3 項註明還沒有盲評的比較；字樣看 B 組的結果寫，先給維護者審。
12. **`docs/evals/` 只放數字與可以重現的設定**（問題第 9 項）：每組的平均、分數分布、95% 信賴區間（常態近似）、淘汰率、只報告的問題數、實際花費與 token；一致性；模型、思考、提示與規則包的雜湊、SDK 版本、TOME 的 commit、種子；段落的索引（document 層的 SHA-256、第一個區塊、區塊數、角色、字元數）。不放原文與譯文：ORC 的條款允許散布改作，但要附 ORC 聲明、署名與 Reserved Material 聲明（`systems/d100-orc/LICENSE` 第 III 節）；放了譯文就多一份要守的義務，也不影響「使用者靠這份資料選模型」。譯文與分數的原始檔留在維護者的評測資料夾。
    2026-11-21 由第 16 項修改：分數、分布與信賴區間只有 B 組；其他組只有自動指標，標「未經人評」；段落的索引多一欄標出人評抽中的段落。
13. **流程**（問題第 10、11 項）：維護者用自己的金鑰在自己的電腦上跑，執行 session 只用假供應商寫測試。試算的總估價上限超過 30 美元就不送；送出時每本書的預算是 30 美元減掉已經花的。實作開 PR，維護者在 PR 的分支上跑完，結果補進同一個 PR，比照 046 的 H-15。太花時間時仍維持 6 組、100 段，分次評完。
    2026-11-21 由第 16 項修改：送出照樣是 6 組、100 段；人評改成 B 組 50 段。
14. **估價**（估算，問題檔是以 M2 的 Cthulhu 每段約 $0.0016 為底；加上一段一個請求，F 換成較便宜的 Fable 5.2）：6 組合計約 $3.4 到 $7.6。工具的試算才是準的。實際的試算與花費見第 15 項。

**維護者跑的結果**

15. 維護者在 PR 94 的分支上跑（2026-11-14 起）。下面是已經有的結果；B 組的分數、一致性與 Q-8 等評完補上。
    * `tome provider test`：五個模型（含 `claude-fable-5-2`）都是「金鑰可用，供應商回報的資料與 TOME 的模型資料一致」，Fable 5.2 的 `fallback.server: true` 對上了，供應商檔不用改（**已量測**）。
    * ORC 文件在維護者的電腦上解析：303 頁、7,150 個區塊、11 章，區塊數跟 H-15 在 runner 上的相同（兩邊都是 docling 2.140）；第 1 頁有版權頁的區塊（**已量測**）。
    * 挑段落：100 段（ORC 60、Cthulhu 40），維護者沒有剔除。
    * 試算：A $0.01–0.02、B $0.28–0.46、C $0.50–0.81、D $0.21–0.35、E $0.63–1.03、F $1.27–2.06，合計 $2.91–4.73，比第 14 項的估算低。
    * 送出：6 組都跑完，共花費 $2.99，在試算的範圍內（**已量測**）。A（Haiku 5.5）兩本書都多了兩輪重送（ORC 60→7→4 個請求、Cthulhu 40→6→1 個）；C 的 Cthulhu、D 的 ORC 各多一個請求，其他一批完成；E 的 ORC 那批等了 8 分鐘。每組的淘汰率、只報告的問題與 token 寫在 `docs/evals/` 的報告。
    * 還沒有：B 組 50 段的分數、一致性、Q-8，範本的字樣。H-2、H-13、H-18 這次沒有人評的比較（第 16 項）。

**2026-11-21 的範圍修改**

16. **人評只評 B 組，抽 50 段**（維護者 2026-11-21 決定，理由是 6 組 × 100 段太花時間）：
    * 6 組照樣都跑完（第 15 項）；人評只評 B 組（Sonnet 5.5、關思考、英文指令），它是 050 收尾要用的組。
    * 從挑好的 100 段用同一個種子再抽 50 段，照原本的比例：ORC 30、Cthulhu 20。書裡照角色分層，規則跟第 4 項同一套（每個角色至少 2 段，剩下照比例）。抽中哪幾段只看段落與種子，跟之前評過哪幾段無關。
    * 之前的盲評裡 B 已經有分數的段落，抽中了就沿用那個分數，算進 50 段。報告分開列沿用與新評的段數與平均：盲評時同一段有幾則譯文並排，這次只看一則，評分的情境不同。
    * 一段只顯示原文與 B 的譯文。只評一組就談不上盲評，評分頁與報告都寫明維護者知道是哪個模型。
    * 重複題照比例改成 5 段，先從這次新評的段落挑，前後兩次都在同一種頁面上評；判定照第 9 項。
    * Q-8 只用 B 組的 50 段判定。50 段的 95% 信賴區間約 ±0.25（**估算**：假設分數的標準差約 0.9）。
    * 其他 5 組（A、C、D、E、F）只報自動指標：淘汰率、只報告的問題、花費與 token，標「未經人評」。H-2、H-13、H-18 的比較留到 0.1.0 之後。
    * 評分順序照樣用作業系統的亂數排；抽樣用固定的種子，可以重現。

## 驗證

<!-- @assert-count target="providers/anthropic.yaml" symbol="- id: claude-fable-5-2" expected="1" reason="第 2 項：補上 Fable 5.2" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="- id: claude-fable-5-1" expected="1" reason="第 2 項：Fable 5.1 留著" -->
<!-- @assert-absence target="schemas" symbol="adaptive" reason="第 3 項：供應商檔與 schema 不收自適應思考" -->
<!-- @assert-absence target="src/cli" regex="true" symbol="\b(variant|separate|instructions)\s*:|'adaptive'" reason="第 3 項：CLI 碰不到評測用的選項" -->
<!-- @assert-count target="src/core/request.ts" symbol="variant.thinking === undefined ? found : { ...found, thinking: { mode: variant.thinking, output_factor: EVAL_THINKING_FACTOR } };" expected="1" reason="第 3 項：開思考只換這次計畫裡的模型" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const EVAL_THINKING_FACTOR = 4;" expected="1" reason="第 3 項：思考的輸出倍數是提案" -->
<!-- @assert-count target="src/core/request.ts" symbol="if (groupChapter !== chapter || full || separate) flush();" expected="1" reason="第 6 項：一段一個請求" -->
<!-- @assert-count target="tools/eval-run.ts" symbol="export const BUDGET_USD = 30;" expected="1" reason="第 13 項：總估價超過 30 美元就不送" -->
<!-- @assert-count target="tools/eval-run.ts" symbol="export const Q8_VARIANT = 'B';" expected="1" reason="第 10 項：Q-8 用 050 要用的組" -->
<!-- @assert-count target="tools/eval-score.ts" symbol="export const DROP_RATE = 0.1;" expected="1" reason="第 7 項：淘汰率超過一成的組不評" -->
<!-- @assert-count target="tools/eval-score.ts" symbol="export const REPEATS = 5;" expected="1" reason="第 9、16 項：重複題照比例改成 5 段" -->
<!-- @assert-count target="tools/eval.ts" symbol="const SAMPLE = { orc: 30, cthulhu: 20 } as const;" expected="1" reason="第 16 項：人評從 100 段照比例抽 50 段" -->
<!-- @assert-count target="tools/eval-score.ts" symbol="  code: string = Q8_VARIANT," expected="1" reason="第 16 項：人評只評 Q-8 用的那一組" -->
<!-- @assert-count target="tools/eval-report.ts" symbol="export const STABLE_WITHIN = 0.8;" expected="1" reason="第 9 項：差距在 1 以內不到八成標成不穩定" -->
<!-- @assert-count target="tools/eval.ts" symbol="const QUOTAS = { orc: 60, cthulhu: 40 } as const;" expected="1" reason="第 4 項：ORC 60 段、Cthulhu 40 段" -->
<!-- @assert-count target="tools/eval-select.ts" symbol="export const ROLE_FLOOR = 2;" expected="1" reason="第 4 項：每個角色至少 2 段" -->
<!-- @assert-absence target="tools" glob="eval*.ts" regex="true" symbol="\b(fetch|localStorage|sessionStorage|indexedDB)\b" reason="第 8 項：評分頁不連網、不存東西" -->
<!-- @assert-import-absence target="tools/eval.ts,tools/eval-run.ts,tools/eval-score.ts,tools/eval-select.ts,tools/eval-report.ts" module="node:http node:https node:net http https net" reason="第 8 項：評分頁用 047 的伺服器，不另寫一個" -->

測試只用合成的書與假供應商（`tests/tools/eval.test.ts`、`tests/core/eval-variant.test.ts`、`tests/core/provider.test.ts`、`tests/cli/review-web.test.ts`），不連外、不花錢。

## 後果

維護者能在自己的電腦上一次跑完 6 組、分次評完，結果只把數字放進 repo。開思考與中文指令的比較不必改使用者的設定與 schema。代價：一段一個請求比產品多送一些前綴；評分頁沿用 047 的伺服器，伺服器多拆了一層；`tools/` 的程式不在 `mutation-lines` 的範圍（那個 workflow 只收 `src/`），只靠單元測試。只有一位評審，結果帶個人偏好（ADR-0065）。

2026-11-21 改成只評 B 組 50 段之後：要評的譯文從最多約 660 則（100 段 × 6 組加上重複題）減到最多 55 則，Q-8 照樣有答案；但 H-2、H-13、H-18 只有自動指標，沒有人評的比較。B 的分數不是盲評，評審知道模型，可能偏高或偏低；50 段的信賴區間比 100 段寬。

## 替代方案

* **只比 4 個模型**：少評兩組，但 H-13、H-18 沒有答案，要另寫 ADR 改 ADR-0065 第 3 項。
* **黃金段落併成請求**：前綴少送，但後面的段落拿到別的段落當前文。
* **開思考寫進供應商檔**：使用者也能開，但要改 schema，還要補沒量過的估價倍數。
* **評分表用 YAML 或 CSV**、**評測做成正式指令 `tome eval`**、**`tools/` 另寫伺服器**：見問題第 6 項。
* **淘汰的段落算 1 分**：比較嚴，但跟 ADR-0130 第 15 項的覆蓋率算法不一致。
* **`docs/evals/` 放原文與譯文**：讀者看得到譯文，但要附 ORC 的聲明、登記雜湊。
* **照原計畫評 6 組 100 段**（2026-11-21 否決）：H-2、H-13、H-18 有人評的答案，但維護者評了一部分就覺得太花時間。
* **B 組評 100 段**：信賴區間窄一些，但時間是 50 段的兩倍，Q-8 用 50 段就判得出來。

## Open Questions

- [ ] 維護者評完 B 組的 50 段，第 15 項補上分數、一致性與 Q-8。
- [ ] H-2、H-13、H-18 的人評比較，0.1.0 之後再排。
- [ ] 開思考的輸出倍數 4 是提案，報告列出 C 組的 token 後再定要不要改。
