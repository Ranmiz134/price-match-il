from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from core.normalizer import barcode_variants, extract_variant_signature, normalize_barcode

try:
    import openpyxl
except ImportError:
    openpyxl = None  # type: ignore[assignment]


def merge_base_catalog(
    dji_items: list[dict[str, Any]],
    benda_items: list[dict[str, Any]],
    overrides_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """
    Merge DJI Israel + Benda Store catalogs into a unified base catalog,
    then apply any modular CSV/Excel overrides from `overrides/`.
    """
    merged: list[dict[str, Any]] = []
    by_barcode: dict[str, int] = {}
    by_sku: dict[str, int] = {}
    by_sig: dict[tuple[str, str, str, frozenset[str]], int] = {}

    def _index(idx: int, item: dict[str, Any]) -> None:
        if item.get("sku"):
            by_sku[item["sku"].strip().upper()] = idx
        for bc in item.get("barcodes") or []:
            for v in barcode_variants(bc):
                by_barcode[v] = idx
        sig = extract_variant_signature(item["name"], item.get("brand", ""))
        by_sig[(sig.brand, sig.bundle, sig.storage, sig.model_tokens)] = idx

    # DJI Israel takes priority as primary record for DJI items
    for raw in dji_items + benda_items:
        item = dict(raw)
        item.setdefault("barcodes", [])
        item.setdefault("secondary_sources", [])

        existing_idx: int | None = None
        sku_key = (item.get("sku") or "").strip().upper()
        if sku_key and sku_key in by_sku:
            existing_idx = by_sku[sku_key]
        if existing_idx is None:
            for bc in item.get("barcodes") or []:
                for v in barcode_variants(bc):
                    if v in by_barcode:
                        existing_idx = by_barcode[v]
                        break
                if existing_idx is not None:
                    break
        if existing_idx is None:
            sig = extract_variant_signature(item["name"], item.get("brand", ""))
            key = (sig.brand, sig.bundle, sig.storage, sig.model_tokens)
            if key in by_sig:
                existing_idx = by_sig[key]

        if existing_idx is None:
            idx = len(merged)
            merged.append(item)
            _index(idx, item)
        else:
            target = merged[existing_idx]
            # Preserve secondary source pricing (e.g., both DJI Israel & Benda Store)
            if item.get("source_id") != target.get("source_id"):
                target["secondary_sources"].append(
                    {
                        "source_id": item.get("source_id"),
                        "source_name": item.get("source_name"),
                        "price": item.get("our_price"),
                        "is_on_sale": item.get("is_on_sale", False),
                        "url": item.get("source_url", ""),
                    }
                )
                # If secondary official site has a lower active price, surface it as our_price
                if 0 < float(item.get("our_price", 0)) < float(target.get("our_price", 0)):
                    target["our_price"] = item["our_price"]
                    target["is_on_sale"] = item.get("is_on_sale", target.get("is_on_sale", False))
            # Merge barcodes
            for bc in item.get("barcodes") or []:
                nb = normalize_barcode(bc)
                if nb and nb not in target["barcodes"]:
                    target["barcodes"].append(nb)
            if not target.get("sku") and item.get("sku"):
                target["sku"] = item["sku"]
            _index(existing_idx, target)

    if overrides_dir and overrides_dir.exists():
        _apply_overrides(merged, by_sku, by_barcode, overrides_dir)

    return merged


def _apply_overrides(
    catalog: list[dict[str, Any]],
    by_sku: dict[str, int],
    by_barcode: dict[str, int],
    overrides_dir: Path,
) -> None:
    """
    Auto-load all .csv and .xlsx files in `overrides/` (ignoring sample_* files).
    Supported columns (case-insensitive):
      sku, barcode, name, brand, manual_price, is_on_sale, source_url
    """
    files = sorted(
        p
        for p in overrides_dir.iterdir()
        if p.is_file()
        and p.suffix.lower() in (".csv", ".xlsx")
        and not p.name.lower().startswith("sample_")
    )
    for path in files:
        rows = _read_override_rows(path)
        for row in rows:
            sku = str(row.get("sku") or "").strip()
            barcode = normalize_barcode(str(row.get("barcode") or ""))
            name = str(row.get("name") or "").strip()
            manual_price = _safe_float(row.get("manual_price"))
            is_on_sale = str(row.get("is_on_sale") or "").strip().lower() in ("1", "true", "yes", "כן")

            idx: int | None = None
            if sku and sku.upper() in by_sku:
                idx = by_sku[sku.upper()]
            elif barcode:
                for v in barcode_variants(barcode):
                    if v in by_barcode:
                        idx = by_barcode[v]
                        break
            if idx is None and name:
                low_name = name.lower()
                for i, prod in enumerate(catalog):
                    if prod["name"].lower() == low_name:
                        idx = i
                        break

            if idx is not None:
                target = catalog[idx]
                if barcode and barcode not in target["barcodes"]:
                    target["barcodes"].append(barcode)
                    for v in barcode_variants(barcode):
                        by_barcode[v] = idx
                if manual_price and manual_price > 0:
                    target["our_price"] = round(manual_price, 2)
                    target["is_on_sale"] = is_on_sale or True
            elif name and manual_price and manual_price > 0:
                new_item = {
                    "id": f"override:{sku or barcode or name}",
                    "name": name,
                    "brand": str(row.get("brand") or "DJI").strip(),
                    "sku": sku,
                    "barcodes": [barcode] if barcode else [],
                    "our_price": round(manual_price, 2),
                    "regular_price": None,
                    "is_on_sale": is_on_sale,
                    "in_stock": True,
                    "source_id": "override",
                    "source_name": f"קובץ ידני ({path.name})",
                    "source_url": str(row.get("source_url") or ""),
                    "category": "",
                    "image_url": "",
                    "secondary_sources": [],
                }
                new_idx = len(catalog)
                catalog.append(new_item)
                if sku:
                    by_sku[sku.upper()] = new_idx
                for v in barcode_variants(barcode):
                    by_barcode[v] = new_idx


def _read_override_rows(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            return [{(k or "").strip().lower(): v for k, v in row.items()} for row in reader]

    if path.suffix.lower() == ".xlsx" and openpyxl is not None:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        headers = [str(h or "").strip().lower() for h in next(rows_iter, [])]
        out: list[dict[str, Any]] = []
        for values in rows_iter:
            if not any(values):
                continue
            out.append({headers[i]: values[i] for i in range(min(len(headers), len(values)))})
        wb.close()
        return out
    return []


def _safe_float(val: Any) -> float:
    try:
        return float(str(val or "").replace(",", "").replace("₪", "").strip())
    except ValueError:
        return 0.0
