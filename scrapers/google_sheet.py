from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx

from core.normalizer import classify_importer, normalize_barcode

DEFAULT_SHEET_ID = "1pKIBLRiPc_JgznhfTw32DgDvLrb20qsYxBvFCp0St3I"

STORE_ID_MAP = {
    "ksp": ("ksp", "KSP"),
    "bug": ("bug", "באג (Bug)"),
    "באג": ("bug", "באג (Bug)"),
    "ivory": ("ivory", "אייבורי (Ivory)"),
    "אייבורי": ("ivory", "אייבורי (Ivory)"),
    "payngo": ("payngo", "מחסני חשמל"),
    "מחסני חשמל": ("payngo", "מחסני חשמל"),
    "lastprice": ("lastprice", "LastPrice"),
    "לאסטפרייס": ("lastprice", "LastPrice"),
}


class GoogleSheetSync:
    """
    Pulls `Our_Catalog` and `Competitor_Prices` directly from a Google Sheet
    shared as 'Anyone with the link -> Viewer' via Google's public CSV export endpoint.
    """

    def __init__(self, sheet_id: str = DEFAULT_SHEET_ID) -> None:
        self.sheet_id = sheet_id.strip()

    def _csv_url(self, sheet_name: str) -> str:
        return (
            f"https://docs.google.com/spreadsheets/d/{self.sheet_id}"
            f"/gviz/tq?tqx=out:csv&sheet={quote(sheet_name)}"
        )

    def fetch_tab_rows(self, sheet_name: str) -> list[dict[str, str]]:
        url = self._csv_url(sheet_name)
        resp = httpx.get(url, timeout=25.0, follow_redirects=True)
        if resp.status_code != 200:
            raise RuntimeError(f"Google Sheet HTTP {resp.status_code} for tab '{sheet_name}'")
        text = resp.text
        if "<html" in text[:300].lower() and "accounts.google.com" in text.lower():
            raise PermissionError(
                "Google Sheet is private. Set Share -> General access -> Anyone with the link (Viewer)."
            )
        return self.parse_csv_text(text)

    @staticmethod
    def parse_csv_text(text: str) -> list[dict[str, str]]:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
        rows: list[dict[str, str]] = []
        for raw in reader:
            cleaned = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            if any(cleaned.values()):
                rows.append(cleaned)
        return rows

    def fetch_our_catalog(self) -> list[dict[str, Any]]:
        rows = self.fetch_tab_rows("Our_Catalog")
        return self.parse_our_catalog_rows(rows)

    def fetch_competitor_prices(self) -> list[dict[str, Any]]:
        rows = self.fetch_tab_rows("Competitor_Prices")
        return self.parse_competitor_rows(rows)

    @staticmethod
    def parse_our_catalog_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
        products: list[dict[str, Any]] = []
        for row in rows:
            name = row.get("product_name") or row.get("name") or ""
            price = _to_float(row.get("our_price_vat") or row.get("price"))
            if not name or price <= 0:
                continue
            sku = (row.get("sku") or "").strip()
            bc = normalize_barcode(row.get("barcode") or "")
            brand = (row.get("brand") or "").strip()
            is_on_sale = _to_bool(row.get("is_on_sale"), default=False)
            url = (row.get("our_url") or row.get("url") or "").strip()

            products.append(
                {
                    "id": f"sheet:{sku or name}",
                    "name": name,
                    "brand": brand,
                    "sku": sku,
                    "barcodes": [bc] if bc else [],
                    "our_price": round(price, 2),
                    "regular_price": None,
                    "is_on_sale": is_on_sale,
                    "in_stock": True,
                    "source_id": "dji_israel" if "djistore" in url.lower() else "benda_store",
                    "source_name": "DJI ישראל" if "djistore" in url.lower() else "בנדא סטור",
                    "source_url": url,
                    "category": "",
                    "image_url": "",
                    "secondary_sources": [],
                }
            )
        return products

    @staticmethod
    def parse_competitor_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
        now_iso = datetime.now(timezone.utc).isoformat()
        offers: list[dict[str, Any]] = []
        for row in rows:
            price = _to_float(row.get("price_vat") or row.get("price"))
            url = (row.get("product_url") or row.get("url") or "").strip()
            if price <= 0 or not url:
                continue

            # Safety guard: NEVER allow eilat subdomain URLs
            if "eilat." in url.lower():
                continue

            raw_store = (row.get("store_name") or "").strip()
            store_id, store_name = STORE_ID_MAP.get(
                raw_store.lower(),
                (re.sub(r"[^a-z0-9]+", "_", raw_store.lower()).strip("_") or "competitor", raw_store or "מתחרה"),
            )

            raw_imp = (row.get("importer_status") or "").strip().lower()
            if raw_imp in ("official", "parallel", "unverified"):
                importer_status = raw_imp
            else:
                importer_status = classify_importer(raw_imp)

            offers.append(
                {
                    "store_id": store_id,
                    "store_name": store_name,
                    "our_sku": (row.get("our_sku") or "").strip(),
                    "our_product_name": (row.get("our_product_name") or "").strip(),
                    "title": (row.get("competitor_title") or row.get("our_product_name") or "").strip(),
                    "price": round(price, 2),
                    "url": url,
                    "in_stock": _to_bool(row.get("in_stock"), default=True),
                    "importer_status": importer_status,
                    "importer_text": raw_imp,
                    "sku": (row.get("our_sku") or "").strip(),
                    "barcodes": [],
                    "scraped_at": (row.get("checked_at") or now_iso).strip(),
                }
            )
        return offers


def _to_float(val: Any) -> float:
    if val is None or val == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.]", "", str(val).replace(",", ""))
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0


def _to_bool(val: Any, default: bool = False) -> bool:
    s = str(val or "").strip().lower()
    if s in ("true", "1", "yes", "כן", "in_stock"):
        return True
    if s in ("false", "0", "no", "לא", "out_of_stock"):
        return False
    return default
