---
id: ADR-0083
status: accepted
date: 2026-11-01
depends-on: [ADR-0034]
amends: [ADR-0016, ADR-0043]
---

# ADR-0083：憑證庫原生模組的授權例外

## 脈絡

實測 H-14 時查了 `@napi-rs/keyring` 2.1.2 的發佈內容。套件標 MIT，Windows 二進位檔的第三方清單也都在白名單內，或可以選白名單內的授權。但它的 README 寫明 Linux 二進位檔靜態連結 `libdbus`，授權是 `AFL-2.1 OR GPL-2.0-or-later`，不在 LC-1 的白名單內，而且會進主程式行程。`package-lock.json` 看不到二進位檔裡面，所以授權檢查抓不到這一層。

同一份 README 也寫明，Linux 預設在沒有 Secret Service 時會默默退回 kernel keyutils，而 keyutils 只在記憶體裡，重開機就沒了。

## 決定

1. 保留 `@napi-rs/keyring`。白名單不變，只為它的 Linux 二進位檔開一個窄例外。
2. 例外的範圍是 `@napi-rs/keyring-linux-*` 靜態連結的 `libdbus`，TOME 依 `AFL-2.1` 使用，不走 GPL 這條路。
3. TOME 不重新散布這些二進位檔，由 npm 依平台安裝。之後要做單一執行檔或其他會打包二進位檔的發佈方式時，MUST 重新審查。
4. Linux 釘在 Secret Service，不用自動退回。沒有 Secret Service 時回報憑證庫不可用，使用者改用環境變數，這跟 ADR-0034 的做法一致。
5. 授權檢查另外擋下沒審過的原生套件：主程式相依裡帶 `os` 或 `cpu` 限制的套件 MUST 列在 `tools/check-licenses.ts` 的審過清單。
6. 升級 `@napi-rs/keyring` 時 MUST 重看它的第三方授權清單。

## 驗證

<!-- @assert-count target="src/core/secrets.ts" symbol="store: 'secret-service'" expected="1" reason="Linux 不退回只在記憶體裡的 keyutils" -->
<!-- @assert-count target="tools/check-licenses.ts" symbol="REVIEWED_NATIVE" min="2" reason="原生套件要審過才能進主程式" -->
<!-- @assert-count target=".github/workflows/test.yml" symbol="TOME_TEST_NO_KEYRING" min="1" comments="include" reason="Linux 沒有憑證庫時要回報不可用" -->

## 後果

白名單多一個明文例外，每次升級這個套件要多看一份清單。Linux 上沒有桌面環境的機器只能用環境變數。

## 替代方案

**Linux 不載入，只用環境變數**：白名單零例外，但金鑰常駐環境，這是 ADR-0034 否決過的做法；**Linux 改呼叫 `secret-tool`**：獨立行程，白名單零例外，但多一個系統相依與一段要測的程式，參考機器也測不到；都否決。
