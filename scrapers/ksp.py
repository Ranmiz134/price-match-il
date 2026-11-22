from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from core.normalizer import classify_importer, extract_barcodes_from_text, normalize_barcode
from scrapers.base import CompetitorOffer, ScraperBase

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None  # type: ignore[assignment]

import httpx


class KspScraper(ScraperBase):
    """
    KSP competitor scraper with two-stage resilient strategy:
    1) Fast path: KSP internal JSON API with Chrome TLS impersonation.
    2) Browser fallback: Real headless Chromium via Playwright navigating KSP search pages
       and intercepting live API JSON responses (passes Cloudflare JS challenges).
    CRITICAL RULES ENFORCED:
    - Center price (VAT included) ONLY — explicitly ignores Eilat price fields.
    - Classifies official importer vs parallel vs unverified.
    - Direct item URL: https://ksp.co.il/web/item/<uin>
    """

    store_id = "ksp"
    store_name = "KSP"
    is_base_source = False

    SEARCH_API = "https://ksp.co.il/m_action/api/category"
    ITEM_API = "https://ksp.co.il/m_action/api/item/{uin}"

    def __init__(self, delay_sec: float = 0.6, max_pages_per_query: int = 6) -> None:
        self.delay_sec = delay_sec
        self.max_pages_per_query = max_pages_per_query

    def fetch(self, mode: str = "dji", queries: list[str] | None = None) -> list[dict[str, Any]]:
        search_terms = queries or (
            ["DJI"]
            if mode == "dji"
            else ["DJI", "Insta360", "GoPro", "Anker", "Logitech", "Razer", "Bluetti"]
        )
        offers = self._fetch_via_http(search_terms)
        if not offers:
            offers = self._fetch_via_playwright(search_terms)
        return [o.to_dict() for o in offers]

    def _fetch_via_http(self, search_terms: list[str]) -> list[CompetitorOffer]:
        seen_uins: set[str] = set()
        offers: list[CompetitorOffer] = []
        now_iso = datetime.now(timezone.utc).isoformat()

        for term in search_terms:
            page = 1
            while page <= self.max_pages_per_query:
                payload = self._get_json(self.SEARCH_API, params={"search": term, "page": page})
                if not payload:
                    break
                items = _extract_items_list(payload)
                if not items:
                    break

                new_in_page = 0
                for raw in items:
                    uin = str(raw.get("uin") or raw.get("id") or "").strip()
                    if not uin or uin in seen_uins:
                        continue
                    seen_uins.add(uin)
                    new_in_page += 1
                    detail = self._get_json(self.ITEM_API.format(uin=uin)) or {}
                    offer = self._parse_item(raw, detail, now_iso)
                    if offer:
                        offers.append(offer)
                    time.sleep(self.delay_sec * 0.4)

                if new_in_page == 0 or len(items) < 12:
                    break
                page += 1
                time.sleep(self.delay_sec)

        return offers

    def _fetch_via_playwright(self, search_terms: list[str]) -> list[CompetitorOffer]:
        """Real headless Chromium fallback that passes JS/Cloudflare checks and captures KSP JSON responses."""
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return []

        now_iso = datetime.now(timezone.utc).isoformat()
        captured_items: dict[str, dict[str, Any]] = {}

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            context = browser.new_context(
                locale="he-IL",
                timezone_id="Asia/Jerusalem",
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                ),
            )
            page = context.new_page()

            def handle_response(resp: Any) -> None:
                try:
                    if "/m_action/api/" in resp.url and resp.status == 200:
                        data = resp.json()
                        for raw in _extract_items_list(data):
                            uin = str(raw.get("uin") or raw.get("id") or "").strip()
                            if uin:
                                captured_items[uin] = {**captured_items.get(uin, {}), **raw}
                except Exception:
                    pass

            page.on("response", handle_response)

            for term in search_terms:
                try:
                    url = f"https://ksp.co.il/web/cat/-1..{quote(term)}"
                    page.goto(url, wait_until="networkidle", timeout=35000)
                    page.wait_for_timeout(2000)
                    # Scroll down once to trigger lazy pages
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(1500)
                except Exception:
                    continue

            browser.close()

        offers: list[CompetitorOffer] = []
        for raw in captured_items.values():
            offer = self._parse_item(raw, {}, now_iso)
            if offer:
                offers.append(offer)
        return offers

    def _get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
            "Referer": "https://ksp.co.il/web/",
            "Origin": "https://ksp.co.il",
        }
        try:
            if cffi_requests is not None:
                resp = cffi_requests.get(
                    url,
                    params=params,
                    headers=headers,
                    impersonate="chrome124",
                    timeout=20,
                )
            else:
                resp = httpx.get(url, params=params, headers=headers, timeout=20, follow_redirects=True)
            if resp.status_code != 200:
                return None
            data = resp.json()
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _parse_item(
        self,
        summary: dict[str, Any],
        detail: dict[str, Any],
        scraped_at: str,
    ) -> CompetitorOffer | None:
        item_data = detail.get("result", {}).get("data", {}) if isinstance(detail.get("result"), dict) else {}
        merged = {**summary, **item_data}

        uin = str(merged.get("uin") or merged.get("id") or "").strip()
        title = str(merged.get("name") or merged.get("title") or "").strip()
        if not uin or not title:
            return None

        # STRICT RULE 1: Extract VAT-included center price ONLY. Never touch eilat_price / price_eilat.
        price_regular = _to_float(merged.get("price"))
        bms = merged.get("bms") if isinstance(merged.get("bms"), dict) else {}
        promo_price = _to_float(bms.get("price") or merged.get("sale_price"))

        effective_price = promo_price if 0 < promo_price < price_regular else price_regular
        if effective_price <= 0:
            return None

        warranty_blob = " ".join(
            str(merged.get(k) or "")
            for k in ("warranty", "importer", "warranty_text", "sub_title", "description", "brand_warranty")
        )
        importer_status = classify_importer(warranty_blob)

        stock_val = merged.get("stock")
        in_stock = True
        if isinstance(stock_val, bool):
            in_stock = stock_val
        elif isinstance(stock_val, (int, float)):
            in_stock = stock_val > 0
        elif str(merged.get("availability", "")).lower() in ("out_of_stock", "0", "false", "אזל במלאי"):
            in_stock = False

        barcodes: list[str] = []
        for key in ("barcode", "ean", "gtin"):
            nb = normalize_barcode(str(merged.get(key) or ""))
            if nb and nb not in barcodes:
                barcodes.append(nb)
        for found in extract_barcodes_from_text(str(merged.get("description") or "")):
            if found not in barcodes:
                barcodes.append(found)

        return CompetitorOffer(
            store_id=self.store_id,
            store_name=self.store_name,
            title=title,
            price=round(effective_price, 2),
            regular_price=round(price_regular, 2) if price_regular > effective_price else None,
            is_on_sale=0 < promo_price < price_regular,
            url=f"https://ksp.co.il/web/item/{uin}",
            in_stock=in_stock,
            importer_status=importer_status,
            importer_text=warranty_blob[:180].strip(),
            sku=str(merged.get("makat") or uin),
            barcodes=barcodes,
            scraped_at=scraped_at,
        )


def _extract_items_list(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    result = payload.get("result")
    if isinstance(result, dict):
        items = result.get("items") or result.get("data") or []
        if isinstance(items, list):
            return [i for i in items if isinstance(i, dict)]
    items = payload.get("items") or []
    return [i for i in items if isinstance(i, dict)]


def _to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.]", "", str(value))
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0
