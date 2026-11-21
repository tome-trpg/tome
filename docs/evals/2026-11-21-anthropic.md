# 人工評分：Anthropic 的模型（2026-11-21）

TOME 的維護者用自己的金鑰跑的評測（ADR-0139）。6 組都翻了同一批段落；原本要盲評 6 組，2026-11-21 維護者因為太花時間，改成只評 B 組抽出的 50 段，評分時知道是哪個模型，所以不是盲評。其他 5 組只有自動指標，未經人評；H-2、H-13、H-18 的比較留到 0.1.0 之後。這份只有數字、設定與段落的索引，不含原文與譯文；有同一份 PDF 的人照索引挑得出同樣的段落。分數是一位評審（維護者）的判斷。

## 設定

* TOME 的 commit：915da7ea226408813be4fdacca248e5a374f67cd；Anthropic SDK：0.137.0；種子：48。
* 全部批次，一段一個請求，每段帶前面的文字當上下文；不跑 Pass 0，不用實體卡與全書提要。
* 段落：orc 60 段（document 層的 SHA-256 e7dcb0c92520a18f33ac207d24514314c8b503d7f3da5a4e0167c84652514f03）。
* 段落：cthulhu 40 段（document 層的 SHA-256 fb0bf9de6bd89fe38778853a682e57903931f89d04d8e80b8e06fa126dbc5ab0）。
* 人評的段落：從上面的段落用同一個種子再抽 50 段（orc 30、cthulhu 20），每本書裡照角色分層。

| 組 | 模型 | 思考 | 指令 | 提示的雜湊 | 規則包的雜湊 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A | `claude-haiku-5-5` | 關 | 英文 | orc `f26ae95ab47d`、cthulhu `d2ca60c2af48` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |
| B | `claude-sonnet-5-5` | 關 | 英文 | orc `f26ae95ab47d`、cthulhu `d2ca60c2af48` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |
| C | `claude-sonnet-5-5` | 開（自適應） | 英文 | orc `f26ae95ab47d`、cthulhu `d2ca60c2af48` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |
| D | `claude-sonnet-5-5` | 關 | 中文 | orc `0d64804930b3`、cthulhu `c6a44fb652e3` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |
| E | `claude-opus-5-5` | 低 effort | 英文 | orc `f26ae95ab47d`、cthulhu `d2ca60c2af48` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |
| F | `claude-fable-5-2` | 低 effort | 英文 | orc `f26ae95ab47d`、cthulhu `d2ca60c2af48` | orc `b28ffe60b29d`、cthulhu `beafe2874d0c` |

## 人評：B 組

評分的是維護者，只評 B 組，評分時知道是哪個模型。平均只算評過的段落，沒翻成的段落另列。分數的定義跟評分頁上的同一套：

* 1 分：不能用，意思錯了或讀不通。
* 2 分：要大改才能用。
* 3 分：要小改才能用。
* 4 分：可以直接上桌。
* 5 分：很好，讀起來像原本就用中文寫的。

| 評過 | 平均 | 95% 信賴區間 | 1 分 | 2 分 | 3 分 | 4 分 | 5 分 | 沒翻成 |
| ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 4.48 | 4.31 到 4.65 | 0 | 0 | 3 | 20 | 27 | 0 |

其中 5 段沿用之前盲評（6 組的譯文並排）時評的分數，平均 3.40；45 段這次只看 B 組的譯文評，平均 4.60。

## 自動指標

6 組都翻了上面全部的段落。淘汰是重送後仍沒翻成的段落，淘汰率超過一成的組記為不及格；只報告的問題是 TOME 的驗證只報告、不擋下的問題；輸出的 token 含思考。

| 組 | 人評 | 淘汰率 | 只報告的問題 | 花費（美元） | 輸入 token | 輸出 token |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| A | 未經人評 | 4.0% | 30 | 0.0173 | 249899 | 19146 |
| B | 50 段 | 0.0% | 40 | 0.2927 | 211272 | 16292 |
| C | 未經人評 | 0.0% | 55 | 0.3212 | 213260 | 21586 |
| D | 未經人評 | 0.0% | 36 | 0.3152 | 233432 | 16360 |
| E | 未經人評 | 0.0% | 113 | 0.6076 | 211372 | 18485 |
| F | 未經人評 | 0.0% | 142 | 1.4360 | 211372 | 29528 |

## 評審的一致性

5 段重複出現，5 組分數：完全相同 100.0%，平均差距 0.00，差距在 1 以內 100.0%。

差距在 1 以內的有八成以上。

## Q-8

Q-8 用 050 收尾要用的組 B（claude-sonnet-5-5），只看人評的 50 段：平均 4.48（95% 信賴區間 4.31 到 4.65），淘汰率 0.0%，門檻是平均 4 分以上：達標。

## 段落的索引

| 段 | 書 | 角色 | 字元 | 第一個區塊 | 區塊數 | 人評 |
| :--- | :--- | :--- | ---: | :--- | ---: | :--- |
| P001 | orc | paragraph | 22 | `p0000-2645fb` | 1 | 是 |
| P002 | orc | paragraph | 70 | `p0002-7e62ca` | 1 |  |
| P003 | orc | paragraph | 177 | `p0002-4aa958` | 1 |  |
| P004 | orc | paragraph | 272 | `p0003-597575` | 1 | 是 |
| P005 | orc | list_item | 72 | `p0006-a4ed9c` | 1 | 是 |
| P006 | orc | paragraph | 267 | `p0018-f96ed1` | 1 |  |
| P007 | orc | d100-orc:stat_block | 348 | `p0023-0e33a4` | 1 | 是 |
| P008 | orc | paragraph | 49 | `p0028-9dfc2e` | 1 | 是 |
| P009 | orc | paragraph | 281 | `p0029-5efa39` | 1 |  |
| P010 | orc | heading | 18 | `p0037-119289` | 1 |  |
| P011 | orc | heading | 41 | `p0050-bc51e8` | 1 |  |
| P012 | orc | paragraph | 436 | `p0051-3c074d` | 1 | 是 |
| P013 | orc | paragraph | 398 | `p0055-61e16e` | 1 |  |
| P014 | orc | heading | 19 | `p0068-41a814` | 1 |  |
| P015 | orc | list_item | 456 | `p0076-18146a` | 1 | 是 |
| P016 | orc | heading | 10 | `p0080-c80c49` | 1 | 是 |
| P017 | orc | heading | 10 | `p0082-e12f0a` | 1 |  |
| P018 | orc | heading | 25 | `p0087-534336` | 1 | 是 |
| P019 | orc | paragraph | 55 | `p0090-55f880` | 1 |  |
| P020 | orc | paragraph | 47 | `p0090-1f7e5c` | 1 |  |
| P021 | orc | heading | 12 | `p0096-d31cfb` | 1 | 是 |
| P022 | orc | table | 1522 | `p0103-68e583` | 1 |  |
| P023 | orc | heading | 25 | `p0107-aed3fb` | 1 | 是 |
| P024 | orc | heading | 31 | `p0126-d1768a` | 1 | 是 |
| P025 | orc | paragraph | 176 | `p0130-951d7f` | 1 |  |
| P026 | orc | table | 14 | `p0140-225409` | 1 | 是 |
| P027 | orc | heading | 8 | `p0148-68a89d` | 1 |  |
| P028 | orc | paragraph | 317 | `p0151-425179` | 1 |  |
| P029 | orc | heading | 13 | `p0162-3759d8` | 1 | 是 |
| P030 | orc | list_item | 169 | `p0164-62bbc7` | 1 | 是 |
| P031 | orc | paragraph | 58 | `p0164-2fd7d7` | 1 |  |
| P032 | orc | list_item | 641 | `p0166-96748f` | 1 | 是 |
| P033 | orc | paragraph | 498 | `p0170-2c3a12` | 1 |  |
| P034 | orc | paragraph | 598 | `p0173-5961c5` | 1 |  |
| P035 | orc | heading | 7 | `p0175-bd3828` | 1 |  |
| P036 | orc | paragraph | 132 | `p0185-ffb6bb` | 1 | 是 |
| P037 | orc | paragraph | 286 | `p0185-709860` | 1 | 是 |
| P038 | orc | list_item | 76 | `p0188-46b2ab` | 1 |  |
| P039 | orc | list_item | 157 | `p0204-950833` | 1 |  |
| P040 | orc | paragraph | 138 | `p0206-b837bc` | 1 |  |
| P041 | orc | table | 197 | `p0208-16ae8a` | 1 | 是 |
| P042 | orc | list_item | 50 | `p0211-08327a` | 1 |  |
| P043 | orc | list_item | 213 | `p0217-0aceaa` | 1 |  |
| P044 | orc | paragraph | 478 | `p0232-832bc3` | 1 | 是 |
| P045 | orc | list_item | 324 | `p0232-ad4d81` | 1 |  |
| P046 | orc | paragraph | 488 | `p0237-ac6bfb` | 1 |  |
| P047 | orc | paragraph | 461 | `p0249-4c0a43` | 1 |  |
| P048 | orc | list_item | 42 | `p0256-19e5af` | 1 | 是 |
| P049 | orc | paragraph | 489 | `p0258-be9335` | 1 | 是 |
| P050 | orc | footnote | 178 | `p0259-b2cb79` | 1 | 是 |
| P051 | orc | list_item | 113 | `p0261-d70a1e` | 1 |  |
| P052 | orc | paragraph | 207 | `p0263-362776` | 1 | 是 |
| P053 | orc | d100-orc:stat_block | 29 | `p0271-8b048f` | 1 |  |
| P054 | orc | paragraph | 239 | `p0271-eae74f` | 1 | 是 |
| P055 | orc | paragraph | 241 | `p0277-2ff4c1` | 1 | 是 |
| P056 | orc | list_item | 439 | `p0278-0167c9` | 1 | 是 |
| P057 | orc | list_item | 165 | `p0278-cc6e95` | 1 |  |
| P058 | orc | list_item | 114 | `p0282-9e575e` | 1 | 是 |
| P059 | orc | d100-orc:stat_block | 173 | `p0291-daf9ae` | 1 | 是 |
| P060 | orc | caption | 51 | `p0292-cd4dc2` | 1 | 是 |
| P061 | cthulhu | heading | 19 | `p0000-b85f8d` | 1 |  |
| P062 | cthulhu | paragraph | 18 | `p0000-89abdf` | 1 |  |
| P063 | cthulhu | heading | 21 | `p0000-0ddd29` | 1 | 是 |
| P064 | cthulhu | paragraph | 874 | `p0000-2faa81` | 1 | 是 |
| P065 | cthulhu | paragraph | 1055 | `p0001-ccd408` | 1 |  |
| P066 | cthulhu | paragraph | 617 | `p0001-f45ea3` | 1 | 是 |
| P067 | cthulhu | paragraph | 715 | `p0001-19dd30` | 1 |  |
| P068 | cthulhu | paragraph | 1472 | `p0003-9fa635` | 1 | 是 |
| P069 | cthulhu | paragraph | 570 | `p0005-b57994` | 1 | 是 |
| P070 | cthulhu | paragraph | 663 | `p0006-80de90` | 1 |  |
| P071 | cthulhu | paragraph | 422 | `p0006-c0af12` | 1 |  |
| P072 | cthulhu | paragraph | 1273 | `p0006-0d1bd2` | 1 |  |
| P073 | cthulhu | heading | 53 | `p0006-d84549` | 1 | 是 |
| P074 | cthulhu | paragraph | 211 | `p0006-a568a2` | 1 |  |
| P075 | cthulhu | paragraph | 864 | `p0007-d346f9` | 1 |  |
| P076 | cthulhu | paragraph | 718 | `p0007-945819` | 1 |  |
| P077 | cthulhu | heading | 53 | `p0008-d84549` | 1 | 是 |
| P078 | cthulhu | paragraph | 782 | `p0008-1d5be4` | 1 | 是 |
| P079 | cthulhu | paragraph | 607 | `p0008-db9ebe` | 1 |  |
| P080 | cthulhu | paragraph | 747 | `p0008-386cc3` | 1 |  |
| P081 | cthulhu | paragraph | 1286 | `p0010-e3843a` | 1 | 是 |
| P082 | cthulhu | paragraph | 596 | `p0010-7b66c4` | 1 | 是 |
| P083 | cthulhu | paragraph | 150 | `p0011-b951ed` | 1 | 是 |
| P084 | cthulhu | paragraph | 712 | `p0011-1247fe` | 1 |  |
| P085 | cthulhu | paragraph | 387 | `p0011-baf5d9` | 1 |  |
| P086 | cthulhu | paragraph | 903 | `p0011-4c3e80` | 1 | 是 |
| P087 | cthulhu | paragraph | 643 | `p0013-65bf9c` | 1 | 是 |
| P088 | cthulhu | paragraph | 290 | `p0013-0d3ce6` | 1 | 是 |
| P089 | cthulhu | paragraph | 326 | `p0013-2ed043` | 1 | 是 |
| P090 | cthulhu | paragraph | 343 | `p0013-82d7b7` | 1 |  |
| P091 | cthulhu | paragraph | 274 | `p0014-e01792` | 1 |  |
| P092 | cthulhu | paragraph | 305 | `p0015-a92232` | 1 |  |
| P093 | cthulhu | paragraph | 464 | `p0016-902875` | 1 | 是 |
| P094 | cthulhu | paragraph | 708 | `p0017-b2b047` | 1 |  |
| P095 | cthulhu | paragraph | 812 | `p0017-f8e457` | 1 |  |
| P096 | cthulhu | paragraph | 627 | `p0018-43c4b5` | 1 | 是 |
| P097 | cthulhu | paragraph | 827 | `p0018-a4c834` | 1 |  |
| P098 | cthulhu | paragraph | 618 | `p0018-a26eb4` | 1 | 是 |
| P099 | cthulhu | paragraph | 341 | `p0019-ef7488` | 1 | 是 |
| P100 | cthulhu | paragraph | 815 | `p0019-6f43db` | 1 | 是 |
