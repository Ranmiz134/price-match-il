from __future__ import annotations

import json
import re
import time
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from core.normalizer import extract_barcodes_from_text, infer_brand, normalize_barcode
from scrapers.base import BaseProduct, ScraperBase

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
}

OUTLET_KEYWORDS = ("outlet", "אאוטלט", "עודפים", "תצוגה", "מתצוגה", "משומש", "פגם באריזה")


class WooCommerceScraper(ScraperBase):
    """Unified scraper for WooCommerce storefronts (DJI Israel & Benda Store)."""

    is_base_source = True

    def __init__(
        self,
        store_id: str,
        store_name: str,
        base_url: str,
        default_brand: str = "",
        exclude_outlet: bool = True,
        max_pages: int = 80,
        delay_sec: float = 0.25,
    ) -> None:
        self.store_id = store_id
        self.store_name = store_name
        self.base_url = base_url.rstrip("/")
        self.default_brand = default_brand
        self.exclude_outlet = exclude_outlet
        self.max_pages = max_pages
        self.delay_sec = delay_sec

    def fetch(self, mode: str = "dji", queries: list[str] | None = None) -> list[dict[str, Any]]:
        with httpx.Client(headers=DEFAULT_HEADERS, timeout=25.0, follow_redirects=True) as client:
            products = self._fetch_via_store_api(client, mode=mode)
            if not products:
                products = self._fetch_via_sitemap(client, mode=mode)
        return [p.to_dict() for p in products]

    def _fetch_via_store_api(self, client: httpx.Client, mode: str) -> list[BaseProduct]:
        results: list[BaseProduct] = []
        endpoint = f"{self.base_url}/wp-json/wc/store/v1/products"
        page = 1

        while page <= self.max_pages:
            params: dict[str, Any] = {"per_page": 100, "page": page}
            if mode == "dji" and self.store_id == "benda_store":
                params["search"] = "DJI"

            try:
                resp = client.get(endpoint, params=params)
                if resp.status_code != 200:
                    break
                items = resp.json()
                if not isinstance(items, list) or not items:
                    break
            except Exception:
                break

            for raw in items:
                product = self._parse_store_api_item(raw)
                if not product:
                    continue
                if mode == "dji" and "dji" not in f"{product.brand} {product.name}".lower():
                    continue
                results.append(product)

            if len(items) < 100:
                break
            page += 1
            time.sleep(self.delay_sec)

        return results

    def _parse_store_api_item(self, raw: dict[str, Any]) -> BaseProduct | None:
        name = _clean_html(str(raw.get("name", "")))
        if not name:
            return None

        categories = [c.get("name", "") for c in raw.get("categories", []) if isinstance(c, dict)]
        cat_str = " / ".join(categories)
        if self.exclude_outlet and _is_outlet(name, cat_str):
            return None

        prices = raw.get("prices") or {}
        minor_unit = int(prices.get("currency_minor_unit", 2) or 2)
        divisor = 10**minor_unit

        price_val = _to_float(prices.get("price")) / divisor
        regular_val = _to_float(prices.get("regular_price")) / divisor
        sale_val = _to_float(prices.get("sale_price")) / divisor

        if price_val <= 0:
            return None

        is_on_sale = bool(raw.get("on_sale")) or (0 < sale_val < regular_val)
        sku = str(raw.get("sku") or "").strip()

        barcodes: list[str] = []
        for candidate in (sku, raw.get("gtin"), raw.get("ean"), raw.get("barcode")):
            nb = normalize_barcode(str(candidate or ""))
            if nb and nb not in barcodes:
                barcodes.append(nb)

        desc_text = f"{raw.get('short_description', '')} {raw.get('description', '')}"
        for found in extract_barcodes_from_text(desc_text):
            if found not in barcodes:
                barcodes.append(found)

        images = raw.get("images") or []
        image_url = images[0].get("src", "") if images and isinstance(images[0], dict) else ""
        brand = self.default_brand or infer_brand(name, categories)

        return BaseProduct(
            id=f"{self.store_id}:{raw.get('id') or sku or name}",
            name=name,
            brand=brand,
            sku=sku,
            barcodes=barcodes,
            our_price=round(price_val, 2),
            regular_price=round(regular_val, 2) if regular_val > 0 else None,
            is_on_sale=is_on_sale,
            in_stock=bool(raw.get("is_in_stock", True)),
            source_id=self.store_id,
            source_name=self.store_name,
            source_url=str(raw.get("permalink") or self.base_url),
            category=cat_str,
            image_url=image_url,
        )

    def _fetch_via_sitemap(self, client: httpx.Client, mode: str) -> list[BaseProduct]:
        """Fallback: discover product URLs from product-sitemap.xml and parse JSON-LD."""
        sitemap_urls = [
            f"{self.base_url}/product-sitemap.xml",
            f"{self.base_url}/wp-sitemap-posts-product-1.xml",
            f"{self.base_url}/sitemap_index.xml",
        ]
        product_urls: list[str] = []
        for sm_url in sitemap_urls:
            try:
                resp = client.get(sm_url)
                if resp.status_code != 200 or "<loc>" not in resp.text:
                    continue
                root = ET.fromstring(resp.text)
                locs = [el.text.strip() for el in root.iter() if el.tag.endswith("loc") and el.text]
                for loc in locs:
                    if "/product/" in loc:
                        product_urls.append(loc)
                if product_urls:
                    break
            except Exception:
                continue

        results: list[BaseProduct] = []
        for url in product_urls[:400]:
            if mode == "dji" and self.store_id == "benda_store" and "dji" not in url.lower():
                continue
            try:
                resp = client.get(url)
                if resp.status_code != 200:
                    continue
                parsed = self._parse_product_html(resp.text, url)
                if parsed:
                    results.append(parsed)
                time.sleep(self.delay_sec)
            except Exception:
                continue
        return results

    def _parse_product_html(self, html: str, url: str) -> BaseProduct | None:
        soup = BeautifulSoup(html, "lxml")
        ld_nodes = soup.find_all("script", attrs={"type": "application/ld+json"})
        product_ld: dict[str, Any] | None = None

        for node in ld_nodes:
            try:
                payload = json.loads(node.string or "{}")
            except Exception:
                continue
            candidates = payload.get("@graph", [payload]) if isinstance(payload, dict) else payload
            if not isinstance(candidates, list):
                candidates = [candidates]
            for item in candidates:
                if isinstance(item, dict) and item.get("@type") == "Product":
                    product_ld = item
                    break
            if product_ld:
                break

        if not product_ld:
            return None

        name = _clean_html(str(product_ld.get("name", "")))
        if not name or (self.exclude_outlet and _is_outlet(name, "")):
            return None

        offers = product_ld.get("offers") or {}
        if isinstance(offers, list):
            offers = offers[0] if offers else {}

        price_val = _to_float(offers.get("price") or offers.get("lowPrice"))
        if price_val <= 0:
            return None

        sku = str(product_ld.get("sku") or "").strip()
        barcodes: list[str] = []
        for key in ("gtin13", "gtin12", "gtin", "ean", "mpn", "sku"):
            nb = normalize_barcode(str(product_ld.get(key) or ""))
            if nb and nb not in barcodes:
                barcodes.append(nb)

        availability = str(offers.get("availability", "")).lower()
        in_stock = "outofstock" not in availability
        brand_obj = product_ld.get("brand")
        brand = (
            brand_obj.get("name", "") if isinstance(brand_obj, dict) else str(brand_obj or "")
        ) or self.default_brand or infer_brand(name, [])

        return BaseProduct(
            id=f"{self.store_id}:{sku or name}",
            name=name,
            brand=brand,
            sku=sku,
            barcodes=barcodes,
            our_price=round(price_val, 2),
            regular_price=None,
            is_on_sale=False,
            in_stock=in_stock,
            source_id=self.store_id,
            source_name=self.store_name,
            source_url=urljoin(self.base_url, url),
            image_url=str(product_ld.get("image") or ""),
        )


def _clean_html(text: str) -> str:
    return re.sub(r"\s+", " ", BeautifulSoup(text, "lxml").get_text(" ")).strip()


def _to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.]", "", str(value))
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0


def _is_outlet(name: str, category: str) -> bool:
    haystack = f"{name} {category}".lower()
    return any(kw in haystack for kw in OUTLET_KEYWORDS)
