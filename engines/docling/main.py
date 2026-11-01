"""TOME 的 Docling 轉接器：一邊是 tome-engine/1，一邊是 Docling。

主程式與這裡只靠 tome-ir 的 JSON Schema 溝通（白皮書 §5.3）。Python 只留在這個資料夾。
"""

import argparse
import hashlib
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path

ENGINE = "docling"
LICENSE = {"code": "MIT", "weights": "Apache-2.0 AND CDLA-Permissive-2.0"}

# 釘在 commit（ADR-0085）。Docling 自己抓 layout 模型時跟著 main 走，權重會飄。
MODELS = [
    {
        "repo": "docling-project/docling-layout-heron",
        "revision": "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
        "files": ["config.json", "model.safetensors", "preprocessor_config.json"],
    },
    {
        "repo": "docling-project/docling-models",
        "revision": "fc0f2d45e2218ea24bce5045f58a389aed16dc23",
        "files": [
            "model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
            "model_artifacts/tableformer/accurate/tm_config.json",
        ],
    },
]

# Docling 的標籤對到核心角色，沒列到的當段落，內容不能不見。遊戲概念不在這裡（ADR-0023）。
ROLES = {
    "caption": "caption",
    "checkbox_selected": "list_item",
    "checkbox_unselected": "list_item",
    "chart": "figure",
    "document_index": "toc",
    "footnote": "footnote",
    "list_item": "list_item",
    "page_footer": "furniture",
    "page_header": "furniture",
    "picture": "figure",
    "section_header": "heading",
    "table": "table",
    "title": "title",
}


def prepare(data: Path) -> None:
    from huggingface_hub import snapshot_download

    for model in MODELS:
        snapshot_download(
            repo_id=model["repo"],
            revision=model["revision"],
            allow_patterns=model["files"],
            local_dir=data / model["repo"].replace("/", "--"),
        )


def build_converter(data: str, device: str):
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # 0.1.0 只處理原生文字頁，用不到 OCR（ADR-0081）。
    options = PdfPipelineOptions(artifacts_path=data)
    options.do_ocr = False
    options.do_table_structure = True
    options.enable_remote_services = False
    options.accelerator_options = AcceleratorOptions(
        device=AcceleratorDevice.CUDA if device == "gpu" else AcceleratorDevice.CPU
    )
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def spans_of(item, document, page: int) -> list:
    """PDF 點，原點在左下，跟 `src/core/pdf.ts` 一樣。"""
    spans = []
    for prov in item.prov:
        height = document.pages[prov.page_no].size.height
        box = prov.bbox.to_bottom_left_origin(page_height=height)
        spans.append({"page": prov.page_no - 1, "bbox": [box.l, box.b, box.r, box.t]})
    if spans:
        return spans
    size = document.pages[page + 1].size
    return [{"page": page, "bbox": [0, 0, size.width, size.height]}]


def table_of(item) -> dict:
    cells = []
    for cell in item.data.table_cells:
        entry = {
            "row": cell.start_row_offset_idx,
            "col": cell.start_col_offset_idx,
            "text": cell.text,
        }
        if cell.row_span > 1:
            entry["row_span"] = cell.row_span
        if cell.col_span > 1:
            entry["col_span"] = cell.col_span
        if cell.column_header or cell.row_header:
            entry["header"] = True
        cells.append(entry)
    return {"rows": max(item.data.num_rows, 1), "cols": max(item.data.num_cols, 1), "cells": cells}


def blocks_of(document, manifest: dict, page: int, engine_version: str) -> list:
    from docling_core.types.doc import ContentLayer, DocItem, TableItem

    seen = {}
    blocks = []
    # 頁首頁尾與圖裡的字都要帶出來：字元守恆看的是整頁（S-14）。
    items = document.iterate_items(
        included_content_layers=set(ContentLayer), traverse_pictures=True
    )
    for item, _level in items:
        if not isinstance(item, DocItem):
            continue
        table = table_of(item) if isinstance(item, TableItem) else None
        text = "\n".join(cell["text"] for cell in table["cells"]) if table else getattr(item, "text", "")
        raw = text if table else getattr(item, "orig", text)
        digest = sha256(text)
        base = f"p{page:04d}-{digest[:6]}"
        count = seen.get(base, 0)
        seen[base] = count + 1
        block = {
            "id": base if count == 0 else f"{base}-{count}",
            "content_hash": digest,
            "role": ROLES.get(str(item.label.value), "paragraph"),
            "spans": spans_of(item, document, page),
            "text": text,
            "raw": raw,
            "lang": manifest["source_lang"],
            "writing_mode": "horizontal-tb",
            "provenance": {
                "engine": ENGINE,
                "version": engine_version,
                "config_hash": manifest["config_hash"],
            },
        }
        if table:
            block["role"] = "toc" if block["role"] == "toc" else "table"
            block["table"] = table
        blocks.append(block)
    return blocks


def write_json(path: Path, value: dict) -> None:
    """先寫暫存檔再換名字，當掉時不會留下半個檔案。"""
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def convert_page(converter, manifest: dict, page: int, engine_version: str) -> str | None:
    """回傳原因代碼，成功時回 None。例外的訊息可能帶書本文字，不往外傳（ADR-0059）。"""
    from docling.datamodel.base_models import ConversionStatus

    number = page + 1
    try:
        result = converter.convert(
            manifest["pdf"], page_range=(number, number), raises_on_error=False
        )
        if result.status != ConversionStatus.SUCCESS:
            return "conversion_failed"
        blocks = blocks_of(result.document, manifest, page, engine_version)
    except Exception as error:
        return "out_of_memory" if type(error).__name__ == "OutOfMemoryError" else "conversion_failed"
    write_json(
        Path(manifest["output_dir"]) / f"p{page:04d}.json",
        {
            "schema": "tome-ir/1",
            "layer": "source",
            "pdf_sha256": manifest["pdf_sha256"],
            "page": page,
            "blocks": blocks,
        },
    )
    return None


def run(manifest: dict, events) -> None:
    def say(event: dict) -> None:
        print(json.dumps(event), file=events, flush=True)

    engine_version = version(ENGINE)
    converter = build_converter(manifest["data_dir"], manifest["options"]["device"])
    results = []
    for page in manifest["pages"]:
        reason = convert_page(converter, manifest, page, engine_version)
        result = {"page": page, "status": "ok" if reason is None else "failed"}
        if reason is not None:
            result["reason"] = reason
        results.append(result)
        say({"event": "page", **result})
    write_json(
        Path(manifest["output_dir"]) / "engine.json",
        {
            "schema": "tome-engine/1",
            "name": ENGINE,
            "version": engine_version,
            "license": LICENSE,
            "config_hash": manifest["config_hash"],
            "pages": results,
        },
    )
    say({"event": "done"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--data", type=Path)
    parser.add_argument("--manifest", type=Path)
    arguments = parser.parse_args()
    if arguments.version:
        print(version(ENGINE))
    elif arguments.prepare:
        prepare(arguments.data)
    else:
        manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
        # stdout 是事件，相依套件印的東西不能混進來。
        events = sys.stdout
        sys.stdout = sys.stderr
        run(manifest, events)


if __name__ == "__main__":
    main()
