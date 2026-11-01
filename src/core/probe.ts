import type { TextQuality } from './language.ts';
import type { OutlineNode, PageFacts, PdfHandle, PdfLink } from './pdf.ts';
import type { ToolRunner } from './process.ts';

// tome probe 的判斷（白皮書 §5.1）。不載入模型，不連網。

export const PROBE_SCHEMA = 'tome-probe/1';

/** 探測的規則一改，這個數字就要加一，舊的結果才會重算（ADR-0056）。 */
export const PROBE_VERSION = 3;

// 下面的數字都是提案，要等本機語料量過才算定案（H-7、H-8、H-10）。
const SCAN_COVERAGE = 0.6;
const SPARSE_TEXT_CHARS = 40;
const INVISIBLE_SHARE = 0.9;
const BAD_CHAR_SHARE = 0.05;
const VECTOR_ART_PATHS = 50;
const SPREAD_ASPECT = 1.2;
const SPREAD_PAGE_SHARE = 0.6;

export type PageKind = 'native' | 'scan' | 'broken_text' | 'image_only';

export const PAGE_KINDS: readonly PageKind[] = ['native', 'scan', 'broken_text', 'image_only'];

export interface PageProbe {
  readonly page: number;
  readonly kind: PageKind;
  readonly width: number;
  readonly height: number;
  readonly chars: number;
  readonly bad_chars: number;
  readonly image_coverage: number;
  /** 字母分布跟來源語言有多像，0 到 1。字母太少不判斷時沒有這個欄位。 */
  readonly language_match?: number;
  /** 要交給哪個引擎。沒有引擎能處理時沒有這個欄位。 */
  readonly engine?: string;
}

export interface PageLabel {
  readonly page: number;
  readonly label: string;
}

export interface Probe {
  readonly schema: typeof PROBE_SCHEMA;
  readonly pdf_sha256: string;
  readonly page_count: number;
  readonly tagged: boolean;
  readonly spread: boolean;
  readonly outline: readonly OutlineNode[];
  readonly page_labels: readonly PageLabel[];
  readonly links: readonly PdfLink[];
  readonly pages: readonly PageProbe[];
}

/** 訊息與 `--json` 用的摘要。只有數字，書籤標題這類書本文字不出工作區。 */
export interface ProbeSummary {
  readonly pages: number;
  readonly kinds: Readonly<Record<PageKind, number>>;
  /** 分配給引擎的頁數。 */
  readonly assigned: number;
  readonly tagged: boolean;
  readonly spread: boolean;
  readonly outline_items: number;
  readonly outline_unresolved: number;
  readonly label_pages: number;
  readonly links: number;
}

export interface GpuInfo {
  readonly name: string;
  readonly vram_mb: number;
  /** 現在還沒被占用的量。桌面與別的程式也在用 VRAM，引擎放不放得下要看這個。 */
  readonly vram_free_mb: number;
}

const WHITESPACE = /\s/u;
const BAD_CHAR = /[\p{Co}\p{Cn}\p{Cc}\p{Cs}�]/u;

function countChars(facts: PageFacts): { chars: number; bad: number } {
  let chars = 0;
  let bad = 0;
  for (const run of facts.runs) {
    for (const char of run.text) {
      if (WHITESPACE.test(char)) continue;
      chars += 1;
      if (BAD_CHAR.test(char)) bad += 1;
    }
  }
  return { chars, bad };
}

/**
 * 頁面字母分布與語言設定檔的餘弦相似度。對應錯的 ToUnicode 字元都合法，但字母分布會移位。
 * 不用常見字比對：索引頁、數值塊幾乎沒有常見字，會被誤判。
 */
function languageMatch(facts: PageFacts, quality: TextQuality): number | undefined {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const run of facts.runs) {
    for (const char of run.text.toLowerCase()) {
      if (quality.letter_frequency[char] === undefined) continue;
      counts.set(char, (counts.get(char) ?? 0) + 1);
      letters += 1;
    }
  }
  if (letters < quality.min_letters) return undefined;
  let dot = 0;
  let observed = 0;
  let expected = 0;
  for (const [char, frequency] of Object.entries<number>(quality.letter_frequency)) {
    const count = counts.get(char) ?? 0;
    dot += count * frequency;
    observed += count * count;
    expected += frequency * frequency;
  }
  return dot / Math.sqrt(observed * expected);
}

function kindOf(
  facts: PageFacts,
  chars: number,
  bad: number,
  match: number | undefined,
  quality: TextQuality | undefined,
): PageKind {
  const covered = facts.imageLargest >= SCAN_COVERAGE;
  const glyphs = facts.visibleGlyphs + facts.invisibleGlyphs;
  // OCR 過的掃描檔文字層看不見，字數再多也不是原生頁。
  if (glyphs > 0 && facts.invisibleGlyphs / glyphs >= INVISIBLE_SHARE) {
    return covered ? 'scan' : 'image_only';
  }
  // 掃描書常被蓋上一行原生的購買者頁尾，所以字很少時先看圖。
  if (covered && chars < SPARSE_TEXT_CHARS) return 'scan';
  if (chars === 0) {
    return facts.imageTotal > 0 || facts.vectorPaths >= VECTOR_ART_PATHS ? 'image_only' : 'native';
  }
  if (bad / chars >= BAD_CHAR_SHARE) return 'broken_text';
  if (match !== undefined && quality !== undefined && match < quality.min_similarity) {
    return 'broken_text';
  }
  return 'native';
}

export function classifyPage(facts: PageFacts, quality?: TextQuality): PageProbe {
  const { chars, bad } = countChars(facts);
  const match = quality === undefined ? undefined : languageMatch(facts, quality);
  return {
    page: facts.page,
    kind: kindOf(facts, chars, bad, match, quality),
    width: facts.width,
    height: facts.height,
    chars,
    bad_chars: bad,
    image_coverage: facts.imageTotal,
    ...(match === undefined ? {} : { language_match: match }),
  };
}

function isSpread(pages: readonly PageProbe[]): boolean {
  if (pages.length === 0) return false;
  const wide = pages.filter((page) => page.width / page.height >= SPREAD_ASPECT).length;
  return wide / pages.length >= SPREAD_PAGE_SHARE;
}

export async function probePdf(
  pdf: PdfHandle,
  pdfSha256: string,
  quality?: TextQuality,
  route: (kind: PageKind) => string | undefined = () => undefined,
): Promise<Probe> {
  const pages: PageProbe[] = [];
  const links: PdfLink[] = [];
  for (let index = 0; index < pdf.pageCount; index += 1) {
    const facts = await pdf.page(index);
    const page = classifyPage(facts, quality);
    const engine = route(page.kind);
    pages.push(engine === undefined ? page : { ...page, engine });
    links.push(...facts.links);
  }
  const labels = (await pdf.pageLabels()) ?? [];
  return {
    schema: PROBE_SCHEMA,
    pdf_sha256: pdfSha256,
    page_count: pdf.pageCount,
    tagged: pdf.tagged,
    spread: isSpread(pages),
    outline: await pdf.outline(),
    page_labels: labels.flatMap((label, page) => (label === '' ? [] : [{ page, label }])),
    links,
    pages,
  };
}

function flatten(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function summarizeProbe(probe: Probe): ProbeSummary {
  const kinds = { native: 0, scan: 0, broken_text: 0, image_only: 0 };
  for (const page of probe.pages) kinds[page.kind] += 1;
  const outline = flatten(probe.outline);
  return {
    pages: probe.page_count,
    kinds,
    assigned: probe.pages.filter((page) => page.engine !== undefined).length,
    tagged: probe.tagged,
    spread: probe.spread,
    outline_items: outline.length,
    outline_unresolved: outline.filter((node) => node.page === null).length,
    label_pages: probe.page_labels.length,
    links: probe.links.length,
  };
}

/** 只認 NVIDIA：引擎要的是 CUDA。沒有 nvidia-smi 就當沒有 GPU（ADR-0024）。 */
export async function detectGpu(env: NodeJS.ProcessEnv, tool: ToolRunner): Promise<GpuInfo | null> {
  const result = await tool(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
    env,
  );
  const line = result?.stdout.split(/\r?\n/)[0] ?? '';
  const match = /^(.+?),\s*(\d+),\s*(\d+)\s*$/.exec(line);
  if (match === null) return null;
  return {
    name: (match[1] ?? '').trim(),
    vram_mb: Number(match[2]),
    vram_free_mb: Number(match[3]),
  };
}
