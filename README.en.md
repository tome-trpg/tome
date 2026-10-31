# TOME

**TRPG Omnilingual Markdown Engine**: parse the tabletop RPG books you own on your own machine, and translate them with your own LLM API key into Traditional Chinese that is ready for the table.

[繁體中文](README.md)

> **Status: in development.** The foundation is done, with three commands: `tome init`, `tome doctor` and `tome provider auth set`. There is no translation yet, and nothing has been released, so there is nothing to install.

## What it is

General PDF translators do not understand tabletop RPGs. Two columns and sidebars scramble the reading order, one changed character in `1D100` breaks a rule, and a single NPC ends up with several names across four hundred pages. TOME is built for these problems.

* **Local parsing.** PDFs and page images never leave your computer. Only masked text is sent out.
* **No wrong dice or numbers.** Text is masked before translation and checked afterwards at no token cost.
* **One name per entity.** Proper nouns are extracted, and the high-impact ones are reviewed by a person before translation starts.
* **Know the cost first.** Estimates run locally, and the budget is a required hard limit.
* **Safe to interrupt.** A paragraph that passed verification is never paid for twice.
* **Made for the table.** Output is Obsidian-compatible Markdown, and edits made in Obsidian can be brought back.
* **No telemetry.** There are no usage statistics and no update checks. TOME connects only to the LLM APIs you configure, and to the downloads when you install a parsing engine.

The design and its reasons are in the [whitepaper](docs/WHITEPAPER.md), written in Traditional Chinese, with each decision in [docs/adr](docs/adr).

## What it is not

* It provides no book content and does not distribute translations.
* It does not bypass DRM, and refuses every encrypted PDF.
* It does not modify source PDFs or produce PDFs.
* It is not an online service.

TOME is for books **you own**. Translations are for your own use and must not be distributed.

## Install

After the first release:

```bash
npm install -g tome-trpg
```

It needs Node 24 or later. Installing a parsing engine also needs [uv](https://docs.astral.sh/uv/).

**Do not run `npx tome`.** The `tome` package on npm belongs to someone else and has nothing to do with this project.

## Licence

The code is [Apache-2.0](LICENSE). Built-in rule packs carry their own licences, listed in [NOTICE](NOTICE).

TOME is an independent project. It has no relationship with any tabletop RPG publisher and is not endorsed by one. Trademarks mentioned in the documents belong to their owners. Nothing here is legal advice.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. **Do not paste text or translations from any commercial book.** Use a synthetic example to report a problem. For security issues, see [SECURITY.md](SECURITY.md).
