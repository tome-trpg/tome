---
id: ADR-0032
status: accepted
date: 2026-11-01
depends-on: [ADR-0015]
---

# ADR-0032：用官方 SDK，不用抽象層

## 脈絡

Batch 與顯式快取正好是抽象層會漏的地方，LiteLLM 2026-03 又發生供應鏈事件。主程式是 TypeScript，三家都有官方 SDK（[佐證 §1.10](../research/2026-10-31-landscape.md#110-第-4-輪補充)）。

## 決定

1. 只做三種連線協定：Anthropic Messages、OpenAI 相容、Gemini。
2. 分別用 `@anthropic-ai/sdk`、`openai`、`@google/genai`。
3. 不用 LiteLLM 這類抽象層。

## 後果

多幾個相依，`@google/genai` 較重，版本要釘死。

## 替代方案

**自己用 fetch 寫**：零相依，但三家的 Batch、上傳、錯誤都要自己維護；否決。
