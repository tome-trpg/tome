---
id: ADR-0031
status: accepted
date: 2026-11-01
---

# ADR-0031：供應商實作順序

## 脈絡

第一個切片不必同時做完三種協定。要先把 Batch 與拒答流程做穩，這方面 Anthropic 的文件最完整。這不代表翻譯品質已經驗證過更好（H-2）。

## 決定

1. 第一個切片先接 Anthropic。
2. 第二步接 OpenAI 相容協定，順帶涵蓋 OpenAI、OpenRouter、DeepSeek。
3. 第三步接 Gemini。

## 後果

早期只能用一家測試，跨模型盲評要等第二步。

## 替代方案

**OpenRouter 先**：一把金鑰能測多家，但多一層轉發，快取較難量；**Gemini 先**：快取文件有不一致；**OpenAI 先**：Batch 能否命中快取沒寫清楚；都否決。
