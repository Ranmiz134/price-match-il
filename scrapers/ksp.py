from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any

from core.normalizer import classify_importer, extract_barcodes_from_text, normalize_barcode
from scrapers.base import CompetitorOffer, ScraperBase

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None  # type: ignore[assignment]

import httpx


class KspScraper(ScraperBase):
    """
    KSP competitor scraper with real-browser Playwright search + recursive JSON interception.
    CRITICAL RULES ENFORCED:
    - Center price (VAT included) ONLY — explicitly ignores Eilat price fields.
    - Classifies official importer vs parallel vs unverified.
    - Direct item URL: https://ksp.co.il/web/item/<uin>
    """

    store_id = "ksp"
    store_name = "KSP"
    is_base_source = False

    def __init__(self, delay_sec: float = 0.6) -> None:
        self.delay_sec = delay_sec

    def fetch(self, mode: str = "dji", queries: list[str] | None = None) -> list[dict[str, Any]]:
        search_terms = queries or (
            ["DJI"]
            if mode == "dji"
            else ["DJI", "Insta360", "GoPro", "Anker", "Logitech", "Razer", "Bluetti"]
        )
        offers = self._fetch_via_playwright(search_terms)
        if not offers:
            offers = self._fetch_via_http(search_terms)
        return [o.to_dict() for o in offers]

    def _fetch_via_playwright(self, search_terms: list[str]) -> list[CompetitorOffer]:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            print("[KSP] Playwright not installed")
            return []

        now_iso = datetime.now(timezone.utc).isoformat()
        captured_items: dict[str, dict[str, Any]] = {}

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            )
            context = browser.new_context(
                locale="he-IL",
                timezone_id="Asia/Jerusalem",
                viewport={"width": 1366, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                ),
            )
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")

            def handle_response(resp: Any) -> None:
                try:
                    ct = (resp.headers.get("content-type") or "").lower()
                    if "json" not in ct or resp.status != 200:
                        return
                    data = resp.json()
                    for raw in _find_ksp_items_recursive(data):
                        uin = str(raw.get("uin") or "").strip()
                        if uin:
                            captured_items[uin] = {**captured_items.get(uin, {}), **raw}
                except Exception:
                    pass

            page.on("response", handle_response)

            try:
                page.goto("https://ksp.co.il/web/", wait_until="domcontentloaded", timeout=35000)
                page.wait_for_timeout(3000)
            except Exception as exc:
                print(f"[KSP] Homepage load error: {exc}")

            for term in search_terms:
                try:
                    search_box = page.locator("input[type='search'], input[placeholder*='חיפוש'], input[name*='search']").first
                    if search_box.count() > 0:
                        search_box.click()
                        search_box.fill(term)
                        search_box.press("Enter")
                        page.wait_for_timeout(4000)
                        for _ in range(3):
                            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                            page.wait_for_timeout(1500)
                    else:
                        print(f"[KSP] Search input not found on page (title={page.title()!r})")
                except Exception as exc:
                    print(f"[KSP] Search error for {term!r}: {exc}")

            browser.close()

        print(f"[KSP] Playwright captured {len(captured_items)} raw items")
        offers: list[CompetitorOffer] = []
        for raw in captured_items.values():
            offer = self._parse_item(raw, now_iso)
            if offer:
                offers.append(offer)
        return offers

    def _fetch_via_http(self, search_terms: list[str]) -> list[CompetitorOffer]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
            "Referer": "https://ksp.co.il/web/",
        }
        now_iso = datetime.now(timezone.utc).isoformat()
        offers: list[CompetitorOffer] = []
        seen: set[str] = set()
        for term in search_terms:
            try:
                url = "https://ksp.co.il/m_action/api/category"
                if cffi_requests is not None:
                    resp = cffi_requests.get(url, params={"search": term, "page": 1}, headers=headers, impersonate="chrome124", timeout=20)
                else:
                    resp = httpx.get(url, params={"search": term, "page": 1}, headers=headers, timeout=20, follow_redirects=True)
                print(f"[KSP] HTTP fallback status={resp.status_code} for {term!r}")
                if resp.status_code != 200:
                    continue
                for raw in _find_ksp_items_recursive(resp.json()):
                    uin = str(raw.get("uin") or "").strip()
                    if uin and uin not in seen:
                        seen.add(uin)
                        offer = self._parse_item(raw, now_iso)
                        if offer:
                            offers.append(offer)
            except Exception as exc:
                print(f"[KSP] HTTP fallback error: {exc}")
        return offers

    def _parse_item(self, merged: dict[str, Any], scraped_at: str) -> CompetitorOffer | None:
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
            for k in ("warranty", "importer", "warranty_text", "sub_title", "description", "brand_warranty", "tags")
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


def _find_ksp_items_recursive(obj: Any, out: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if out is None:
        out = []
    if isinstance(obj, dict):
        if "uin" in obj and ("price" in obj or "name" in obj or "title" in obj):
            out.append(obj)
        else:
            for v in obj.values():
                if isinstance(v, (dict, list)):
                    _find_ksp_items_recursive(v, out)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _find_ksp_items_recursive(item, out)
    return out


def _to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.]", "", str(value))
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0
