// 測試用的引擎：說 tome-engine/1，但不解析任何東西。FAKE_ENGINE_SCENARIO 決定它怎麼出錯，
// 這樣協定的每條路都不需要 Docling。有 FAKE_ENGINE_RECORDED 時回放錄好的輸出（ADR-0064）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = '1.2.3';
const LICENSE = { code: 'Apache-2.0', weights: 'none' };

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function fileOf(page) {
  return `p${String(page).padStart(4, '0')}.json`;
}

/** FAKE_ENGINE_TEXT_FILE 是鍛造時的標準答案，有它才過得了字元守恆。 */
function textOf(page) {
  const file = process.env.FAKE_ENGINE_TEXT_FILE;
  if (!file) return `Synthetic text of page ${page}.`;
  const pages = JSON.parse(readFileSync(file, 'utf8'));
  const text = (pages[page] ?? []).join(' ');
  if (process.env.FAKE_ENGINE_SCENARIO === 'lost_text') return text.slice(0, Math.floor(text.length / 2));
  return text;
}

function block(manifest, page) {
  const text = textOf(page);
  const hash = sha256(text);
  return {
    id: `p${String(page).padStart(4, '0')}-${hash.slice(0, 6)}`,
    content_hash: hash,
    role: 'paragraph',
    spans: [{ page, bbox: [72, 700, 500, 720] }],
    text,
    raw: text,
    lang: manifest.source_lang,
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: VERSION, config_hash: manifest.config_hash },
  };
}

function sourcePage(manifest, page) {
  return {
    schema: 'tome-ir/1',
    layer: 'source',
    pdf_sha256: manifest.pdf_sha256,
    page,
    blocks: [block(manifest, page)],
  };
}

function recorded(manifest, page) {
  const data = JSON.parse(readFileSync(join(process.env.FAKE_ENGINE_RECORDED, fileOf(page)), 'utf8'));
  const provenance = { engine: 'fake', version: VERSION, config_hash: manifest.config_hash };
  return { ...data, blocks: data.blocks.map((item) => ({ ...item, provenance })) };
}

function say(event) {
  console.log(JSON.stringify(event));
}

function run(manifest) {
  const scenario = process.env.FAKE_ENGINE_SCENARIO ?? 'ok';
  writeFileSync(join(manifest.output_dir, 'seen-pages.json'), JSON.stringify(manifest.pages));
  writeFileSync(join(manifest.output_dir, 'seen-env.json'), JSON.stringify(Object.keys(process.env)));
  const results = [];
  for (const [index, page] of manifest.pages.entries()) {
    const path = join(manifest.output_dir, fileOf(page));
    if (scenario === 'crash' && index === 1) process.exit(3);
    if (scenario === 'one_failed' && index === 1) {
      say({ event: 'page', page, status: 'failed', reason: 'conversion_failed' });
      results.push({ page, status: 'failed', reason: 'conversion_failed' });
      continue;
    }
    if (scenario === 'not_json') writeFileSync(path, '{ not json');
    else if (scenario === 'bad_schema') writeFileSync(path, JSON.stringify({ schema: 'tome-ir/1', layer: 'source' }));
    else if (scenario === 'wrong_book') {
      writeFileSync(path, JSON.stringify({ ...sourcePage(manifest, page), pdf_sha256: sha256('other') }));
    } else if (scenario === 'silent') {
      continue;
    } else if (process.env.FAKE_ENGINE_RECORDED) {
      writeFileSync(path, JSON.stringify(recorded(manifest, page)));
    } else {
      writeFileSync(path, JSON.stringify(sourcePage(manifest, page)));
    }
    say({ event: 'page', page, status: 'ok' });
    results.push({ page, status: 'ok' });
  }
  if (scenario !== 'no_record') {
    writeFileSync(
      join(manifest.output_dir, 'engine.json'),
      JSON.stringify({
        schema: 'tome-engine/1',
        name: 'fake',
        version: VERSION,
        license: LICENSE,
        config_hash: manifest.config_hash,
        pages: results,
      }),
    );
  }
  say({ event: 'done' });
}

const [flag, value, data] = process.argv.slice(2);
if (flag === '--version') {
  console.log(VERSION);
} else if (flag === '--prepare') {
  writeFileSync(join(data, 'prepared.txt'), 'ok');
} else if (flag === '--manifest' && existsSync(value)) {
  run(JSON.parse(readFileSync(value, 'utf8')));
} else {
  process.exit(2);
}
