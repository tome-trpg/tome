---
id: ADR-0062
status: accepted
date: 2026-11-01
depends-on: [ADR-0015]
---

# ADR-0062：測試策略

## 脈絡

公開 repo 的 CI 不能放金鑰，外部 PR 也可能動到工作流程。參考機器是 Windows，路徑、工作區位置、憑證庫都要在上面測。

## 決定

1. 用 vitest 與 fast-check。
2. CI 跑 Windows 與 Ubuntu。
3. CI 用假供應商，腳本化拒答、漏佔位符、批次過期、429。
4. CI MUST NOT 放任何 API 金鑰。
5. 真 API 的小額契約測試幾個月手動跑一次。

## 後果

假供應商可能跟現實脫節，靠契約測試補。

## 替代方案

**CI 也打真 API**：每次花錢，還要在公開 repo 放金鑰；**只跑 Windows**：其他平台沒有保障；**加 macOS**：沒有人實際在用；都否決。
