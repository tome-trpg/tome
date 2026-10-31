// tome-ir/1 的型別，手寫對應 schemas/tome-ir-1.schema.json。schema 才是真實來源（ADR-0082）。

export type CoreRole =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table'
  | 'sidebar'
  | 'figure'
  | 'caption'
  | 'footnote'
  | 'toc'
  | 'index'
  | 'credits'
  | 'furniture';

/** 規則包宣告的角色，寫成 `<規則包 ID>:<角色>`。核心不認得，只原樣傳遞（ADR-0023）。 */
export type PackRole = `${string}:${string}`;

export interface Span {
  readonly page: number;
  readonly bbox: readonly [number, number, number, number];
}

export interface Run {
  readonly start: number;
  readonly end: number;
  readonly marks?: readonly ('bold' | 'italic' | 'small_caps')[];
  readonly ruby?: string;
  readonly link?: { readonly page?: number; readonly uri?: string };
}

export interface TableCell {
  readonly row: number;
  readonly col: number;
  readonly row_span?: number;
  readonly col_span?: number;
  readonly header?: boolean;
  readonly text: string;
  readonly raw?: string;
  readonly runs?: readonly Run[];
}

export interface Table {
  readonly rows: number;
  readonly cols: number;
  readonly cells: readonly TableCell[];
}

export interface Provenance {
  readonly engine: string;
  readonly version: string;
  readonly config_hash: string;
  readonly confidence?: number;
}

export interface BlockBase {
  readonly id: string;
  readonly content_hash: string;
  readonly group?: string;
  readonly section?: readonly string[];
  readonly spans: readonly Span[];
  readonly text: string;
  readonly raw: string;
  readonly runs?: readonly Run[];
  readonly table?: Table;
  readonly lang: string;
  readonly writing_mode: 'horizontal-tb' | 'vertical-rl';
  readonly provenance: Provenance;
}

export interface SourceBlock extends BlockBase {
  readonly role: CoreRole;
  readonly flow?: 'main' | 'aside';
}

export interface DocumentBlock extends BlockBase {
  readonly role: CoreRole | PackRole;
  readonly flow: 'main' | 'aside';
}

export interface SourcePage {
  readonly schema: 'tome-ir/1';
  readonly layer: 'source';
  readonly pdf_sha256: string;
  readonly page: number;
  readonly blocks: readonly SourceBlock[];
}

export interface Section {
  readonly title: string;
  readonly block_id?: string;
  readonly children: readonly Section[];
}

export interface IrDocument {
  readonly schema: 'tome-ir/1';
  readonly layer: 'document';
  readonly pdf_sha256: string;
  readonly page_map: readonly { readonly page: number; readonly label: string }[];
  readonly sections: readonly Section[];
  readonly blocks: readonly DocumentBlock[];
}

export type TomeIr = SourcePage | IrDocument;
