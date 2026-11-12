# TOME

TOME (TRPG Omnilingual Markdown Engine) is a command-line tool that runs locally. It parses tabletop RPG books that the user owns and translates them into Traditional Chinese with the user's own LLM API key.

[繁體中文](README.md)

> [!IMPORTANT]
> **Status: in development, not yet released.** TOME can parse a book, translate it, and write the result as an Obsidian vault you can read, but npm still holds only a placeholder version with no code. See [Development status](#development-status) for the state of each feature.

## Overview

General-purpose PDF translators are not designed for tabletop RPG books. Common problems include:

* Two-column and sidebar layouts scramble the reading order.
* Dice notation such as `1D100` or numeric values change during translation, which breaks the rules.
* A single character or proper noun ends up with several translations across the book.

TOME is designed to solve these problems and to produce translations that can be used directly in play.

## Features

The following features are design goals. See [Development status](#development-status) for what is implemented.

| Feature | Description |
| :--- | :--- |
| Local parsing | PDFs and page images are processed locally and never leave the user's computer. Only masked text is sent out. |
| Dice and number protection | Dice notation and formulas are masked before translation, and numbers are checked afterwards by a verification step that uses no tokens. |
| Consistent terminology | Proper nouns are extracted before translation, and the high-impact ones are reviewed by a person before translation starts. |
| Cost control | The cost is estimated locally before translation starts. A budget limit is required, and work stops when it is reached. |
| Resuming after interruption | The process can be interrupted at any time. Paragraphs that passed verification are not charged again. |
| Obsidian compatibility | The output is Obsidian-compatible Markdown, and edits made in Obsidian can be imported back into TOME. |
| No telemetry | TOME collects no usage statistics and does not check for updates automatically. It connects to the network in only two cases: calling the LLM APIs the user configures, and downloading files when a parsing engine is installed. |

## Development status

| Feature | Commands | Status |
| :--- | :--- | :--- |
| Workspace setup and environment checks | `tome init`, `tome doctor` | Implemented |
| API key setup | `tome provider auth set` | Implemented |
| Models and prices | `tome provider list` | Implemented: no network and no API key needed; the list is not a recommendation |
| Key and model data check | `tome provider test` | Implemented: queries model data only and spends no tokens |
| Book registration and PDF probing | `tome add`, `tome probe` | Implemented, and suggests a rule pack from the data that packs declare |
| Rule pack management | `tome system new`, `list`, `lint`, `test` | Implemented, with the built-in `generic` pack |
| Parsing engine management | `tome engine add`, `list`, `remove` | Implemented |
| Page parsing | `tome extract` | Implemented: native text pages are handed to a parsing engine, assembled into a document, and checked for lost characters |
| Proper-noun extraction | `tome scan-terms` | Implemented: picks out proper nouns locally and asks a model to propose translations, with an estimate to confirm before anything is sent. The quality of the proposals is not verified yet |
| Term review | `tome glossary review`, `tome glossary import` | Implemented: lock or reject proposals in a local review file, or import your own translations from CSV |
| Cost estimate | `tome estimate`, `tome translate --dry-run` | Implemented: runs locally with no network; the ratios are not calibrated yet |
| Translation | `tome translate`, `tome batch status`, `collect`, `cancel` | Implemented: sends in batches by default, or one request at a time with `--realtime`. Run against the real API on a public-domain short story and most of one rulebook, in both batch and real-time mode, with one model only |
| Translation re-verification | `tome verify` | Implemented; spends no tokens |
| Side-by-side review | `tome preview` | Implemented; stays on this machine |
| Output | `tome assemble` | Implemented: writes the translation and a delivery report as an Obsidian vault, with no network |
| Reading edits back | `tome sync` | Implemented: stores the passages edited in the vault as human translations |
| Delivery report numbers | `tome report` | Implemented: prints counts only, with no network |
| Progress and spending | `tome status` | Implemented: reads local data only, with no network |
| Run it through | `tome run` | Implemented: runs from parsing to output and stops where a cost or the terms need your confirmation |
| Delete and back up | `tome purge`, `tome backup` | Implemented: lists what it will delete and deletes only after you confirm |

## Out of scope

The following are outside the scope of TOME:

* Providing book content or distributing translations.
* Bypassing DRM. Every encrypted PDF is refused.
* Modifying source PDFs or producing PDFs.
* Operating as an online service.

TOME is intended only for books the user owns. Translations are for personal use and must not be distributed.

## Requirements

* Node.js 24 or later.
* [uv](https://docs.astral.sh/uv/), only when installing a parsing engine.

## Installation

TOME has no official release yet. After the first release, it can be installed with:

```bash
npm install -g tome-trpg
```

> [!WARNING]
> Do not run `npx tome`. The `tome` package on npm belongs to another author and is unrelated to this project.

## Documentation

All project documents other than this README are written in Traditional Chinese.

| Document | Contents |
| :--- | :--- |
| [Whitepaper](docs/WHITEPAPER.md) | System design and rationale |
| [Architecture decision records](docs/adr) | The background and outcome of each decision |
| [Changelog](CHANGELOG.md) | Changes in each version |
| [Contributing guide](CONTRIBUTING.md) | Development environment and contribution rules |
| [Security policy](SECURITY.md) | How to report a security vulnerability |

## License

The code is licensed under [Apache-2.0](LICENSE). Built-in rule packs carry their own licenses, listed in [NOTICE](NOTICE).

TOME is an independent project. It is not affiliated with or endorsed by any tabletop RPG publisher. Trademarks mentioned in the documentation belong to their respective owners. Legal notes in this project's documentation are not legal advice.

## Contributing

Issues and pull requests are welcome. Please read the [contributing guide](CONTRIBUTING.md) before submitting one.

**Do not post text or translations from any commercial book.** Use a synthetic example when reporting a problem. Report security issues as described in the [security policy](SECURITY.md).
