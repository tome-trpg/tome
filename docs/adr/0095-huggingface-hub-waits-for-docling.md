---
id: ADR-0095
status: accepted
date: 2026-11-01
depends-on: [ADR-0077, ADR-0085, ADR-0087, ADR-0094]
amends: [ADR-0077, ADR-0094]
---

# ADR-0095：huggingface-hub 的 major 等 Docling 放寬

## 脈絡

ADR-0087 量到 Dependabot 提 `huggingface-hub` 2.1.1 會失敗，因為 Docling 2.140.0 這條相依限制 `<2`，當時判定屬於正常。2026-11-01 再跑一次，`uv` 的工作同樣失敗，留下紅色的檢查。Docling 放寬之前每次都會這樣，真正的失敗反而容易被忽略。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 修改 ADR-0077 第 1 項：`huggingface-hub` 的 major 不走 Dependabot，minor 與 patch 照常更新。
2. `.github/dependabot.yml` 的 `uv` 用 `ignore` 擋下這個套件的 major 更新。
3. 升到允許 `huggingface-hub` 2 的 Docling 時，這個 `ignore` MUST 拿掉。
4. ADR-0094 的第二條斷言改成至少一筆，因為 `ignore` 不只一項了。

## 驗證

<!-- @assert-count target=".github/dependabot.yml" symbol="dependency-name: huggingface-hub" expected="1" reason="第 2 項：huggingface-hub 的 major 等 Docling 放寬" -->

## 後果

Dependabot 不會再提醒 `huggingface-hub` 的新 major，要靠升 Docling 時檢查第 3 項。

## 替代方案

**維持現狀**：`uv` 的工作每次都失敗一次，紅色的檢查變成常態；**現在升 Docling**：要重做 ADR-0085 的量測與授權審查，目前沒有需求；都否決。
