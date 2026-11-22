from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from core.normalizer import classify_importer, extract_barcodes_from_text, normalize_barcode
from scrapers.base import CompetitorOffer, ScraperBase

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None  # type: ignore[assignment]


class BugScraper(ScraperBase):
    """
    Bug (bug.co.il) competitor scraper.
    CRITICAL RULES ENFORCED:
    - Restricts links in DJI mode strictly to `/brand/dji/` (never scrapes unrelated nav links).
    - Reads real full product title from <title> / og:title / h1 (Bug's JSON-LD name often holds only category).
    - Strips Eilat price elements explicitly before extracting VAT-included center price.
    - Classifies official importer vs parallel vs unverified from product details.
    """

    store_id = "bug"
    store_name = "באג (Bug)"
    is_base_source = False
    BASE_URL = "https://www.bug.co.il"

    def __init__(self, delay_sec: float = 0.4, max_products: int = 120) -> None:
        self.delay_sec = delay_sec
        self.max_products = max_products

    def fetch(self, mode: str = "dji", queries: list[str] | None = None) -> list[dict[str, Any]]:
        category_urls = (
            [f"{self.BASE_URL}/dji/", f"{self.BASE_URL}/drones/"]
            if mode == "dji"
            else [f"{self.BASE_URL}/dji/", f"{self.BASE_URL}/drones/"]
        )
        product_urls: list[str] = []
        seen: set[str] = set()

        for cat_url in category_urls:
            html = self._get_html(cat_url)
            if not html:
                continue
            soup = BeautifulSoup(html, "lxml")
            for a in soup.select("a[href*='/brand/']"):
                href = str(a.get("href") or "").split("?")[0].strip()
                if not href:
                    continue
                if mode == "dji" and "/brand/dji/" not in href.lower():
                    continue
                full_url = urljoin(self.BASE_URL, href)
                if full_url not in seen:
                    seen.add(full_url)
                    product_urls.append(full_url)

        print(f"[BUG] Discovered {len(product_urls)} product URLs")
        now_iso = datetime.now(timezone.utc).isoformat()
        offers: list[CompetitorOffer] = []

        for url in product_urls[: self.max_products]:
            html = self._get_html(url)
            if not html:
                continue
            offer = self._parse_product_page(html, url, now_iso)
            if offer:
                offers.append(offer)
            time.sleep(self.delay_sec)

        return [o.to_dict() for o in offers]

    def _get_html(self, url: str) -> str:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
        }
        try:
            if cffi_requests is not None:
                resp = cffi_requests.get(url, headers=headers, impersonate="chrome124", timeout=20)
            else:
                resp = httpx.get(url, headers=headers, timeout=20, follow_redirects=True)
            return resp.text if resp.status_code == 200 else ""
        except Exception:
            return ""

    def _parse_product_page(self, html: str, url: str, scraped_at: str) -> CompetitorOffer | None:
        soup = BeautifulSoup(html, "lxml")

        # 1) Extract REAL product title (og:title / <title> / h1) — Bug's JSON-LD name is often just category
        title = _extract_best_title(soup)

        price_val = 0.0
        in_stock = True
        sku = ""
        barcodes: list[str] = []

        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                data = json.loads(script.string or "{}")
            except Exception:
                continue
            nodes = data.get("@graph", [data]) if isinstance(data, dict) else data
            if not isinstance(nodes, list):
                nodes = [nodes]
            for node in nodes:
                if isinstance(node, dict) and node.get("@type") == "Product":
                    if not title:
                        title = str(node.get("name") or "").strip()
                    sku = str(node.get("sku") or "").strip()
                    for k in ("gtin13", "gtin12", "gtin", "ean"):
                        nb = normalize_barcode(str(node.get(k) or ""))
                        if nb and nb not in barcodes:
                            barcodes.append(nb)
                    offers = node.get("offers") or {}
                    if isinstance(offers, list):
                        offers = offers[0] if offers else {}
                    price_val = _to_float(offers.get("price"))
                    avail = str(offers.get("availability", "")).lower()
                    in_stock = "outofstock" not in avail
                    break

        if not title:
            return None

        # 2) Fallback DOM price while STRICTLY removing Eilat price containers
        if price_val <= 0:
            clean_soup = BeautifulSoup(html, "lxml")
            for el in clean_soup.find_all(string=re.compile(r"אילת|ללא מע.?מ")):
                parent = el.find_parent(["div", "span", "p", "li", "td"])
                if parent:
                    parent.decompose()
            for sel in ("[itemprop='price']", ".price", ".product-price"):
                el = clean_soup.select_one(sel)
                if el:
                    cand = _to_float(el.get("content") or el.get_text(" ", strip=True))
                    if cand > 0:
                        price_val = cand
                        break

        if price_val <= 0:
            return None

        page_text = soup.get_text(" ", strip=True)
        if "אזל מהמלאי" in page_text or "אזל במלאי" in page_text:
            in_stock = False

        importer_status = classify_importer(page_text)
        for found in extract_barcodes_from_text(page_text):
            if found not in barcodes:
                barcodes.append(found)

        return CompetitorOffer(
            store_id=self.store_id,
            store_name=self.store_name,
            title=title,
            price=round(price_val, 2),
            url=url,
            in_stock=in_stock,
            importer_status=importer_status,
            importer_text=_extract_warranty_snippet(page_text),
            sku=sku,
            barcodes=barcodes,
            scraped_at=scraped_at,
        )


def _extract_best_title(soup: BeautifulSoup) -> str:
    candidates: list[str] = []
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        candidates.append(str(og["content"]))
    if soup.title and soup.title.string:
        candidates.append(str(soup.title.string))
    h1 = soup.find("h1")
    if h1:
        candidates.append(h1.get_text(" ", strip=True))

    cleaned: list[str] = []
    for c in candidates:
        t = re.sub(r"\s*[\-|–]\s*באג\s*$", "", c.strip()).strip()
        if t:
            cleaned.append(t)

    # Prefer the longest title that contains Latin model characters (e.g. DJI / Neo / Mini 4 Pro)
    latin_titles = [t for t in cleaned if re.search(r"[A-Za-z]{2,}", t)]
    if latin_titles:
        return max(latin_titles, key=len)
    return max(cleaned, key=len) if cleaned else ""


def _extract_warranty_snippet(text: str) -> str:
    m = re.search(r"(.{0,35}(?:יבואן רשמי|בנדא|יבוא מקביל|אחריות).{0,60})", text)
    return m.group(1).strip() if m else ""


def _to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.]", "", str(value))
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0
