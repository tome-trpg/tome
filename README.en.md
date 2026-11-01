# TOME

TOME (TRPG Omnilingual Markdown Engine) is a command-line tool that runs locally. It parses tabletop RPG books that the user owns and translates them into Traditional Chinese with the user's own LLM API key.

[繁體中文](README.md)

> [!IMPORTANT]
> **Status: in development, not yet released.** The foundation and part of the parsing work are complete. Translation is not available yet, and npm holds only a placeholder version with no code. See [Development status](#development-status) for the state of each feature.

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
| Book registration and PDF probing | `tome add`, `tome probe` | Implemented, and suggests a rule pack from the data that packs declare |
| Rule pack management | `tome system new`, `list`, `lint`, `test` | Implemented, with the built-in `generic` pack |
| Parsing engine management | `tome engine add`, `list`, `remove` | Implemented |
| Page parsing | `tome extract` | Implemented: native text pages are handed to a parsing engine, assembled into a document, and checked for lost characters |
| Translation re-verification | `tome verify` | Implemented; there is nothing to verify until translation is available |
| Cost estimate | `tome estimate`, `tome translate --dry-run` | Implemented: runs locally with no network; the ratios are not calibrated yet |
| Translation and output | Not available | Planned |

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
