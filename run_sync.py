from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.cache import StickyCache
from core.loader import merge_base_catalog
from core.matcher import match_catalog_to_competitors
from scrapers.base import ScraperBase
from scrapers.bug import BugScraper
from scrapers.ksp import KspScraper
from scrapers.woocommerce import WooCommerceScraper

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
OVERRIDES_DIR = ROOT / "overrides"
OUTPUT_PUBLIC_JSON = ROOT / "docs" / "data" / "prices.json"


def run_scraper_with_cache(
    scraper: ScraperBase,
    cache: StickyCache,
    mode: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        items = scraper.fetch(mode=mode)
        if items:
            health = cache.save_success(scraper.store_id, scraper.store_name, items)
            print(f"[SYNC] {scraper.store_id}: OK ({len(items)} items)")
            return items, health
        print(f"[SYNC] {scraper.store_id}: returned 0 items -> fallback to cache")
        return cache.fallback_on_failure(
            scraper.store_id,
            scraper.store_name,
            "הסריקה החזירה 0 פריטים (ייתכן חסימה זמנית)",
        )
    except Exception as exc:
        print(f"[SYNC] {scraper.store_id}: ERROR ({exc}) -> fallback to cache")
        return cache.fallback_on_failure(scraper.store_id, scraper.store_name, str(exc))


def build_demo_dataset() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    now_iso = datetime.now(timezone.utc).isoformat()
    dji_demo = [
        {
            "id": "dji_israel:neo-fmc",
            "name": "DJI Neo Fly More Combo",
            "brand": "DJI",
            "sku": "CP.FP.00000185.01",
            "barcodes": ["0190021114562"],
            "our_price": 1599.0,
            "regular_price": 1699.0,
            "is_on_sale": True,
            "in_stock": True,
            "source_id": "dji_israel",
            "source_name": "DJI ישראל",
            "source_url": "https://www.djistore.benda.co.il/product/%D7%A8%D7%97%D7%A4%D7%9F-dji-neo-fly-more-combo/",
            "category": "רחפנים",
            "image_url": "",
            "secondary_sources": [],
        },
    ]
    comp_demo = [
        {
            "store_id": "bug",
            "store_name": "באג (Bug)",
            "title": "רחפן Neo Fly More Combo די ג'יי איי - DJI",
            "price": 1499.0,
            "url": "https://www.bug.co.il/brand/dji/neo/fly/more/combo",
            "in_stock": True,
            "importer_status": "official",
            "importer_text": "אחריות יבואן רשמי",
            "barcodes": [],
            "scraped_at": now_iso,
        },
    ]
    health = [
        {"store_id": "dji_israel", "store_name": "DJI ישראל", "status": "ok", "status_label": "נתוני הדגמה", "last_ok_at": now_iso, "count": 1, "message": ""},
        {"store_id": "bug", "store_name": "באג (Bug)", "status": "ok", "status_label": "נתוני הדגמה", "last_ok_at": now_iso, "count": 1, "message": ""},
    ]
    return dji_demo, comp_demo, health


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily market price sync for Herzliya store")
    parser.add_argument("--mode", choices=["dji", "full"], default="dji", help="Scan scope")
    parser.add_argument("--demo", action="store_true", help="Generate offline demo prices.json")
    args = parser.parse_args()

    cache = StickyCache(CACHE_DIR)
    store_health: list[dict[str, Any]] = []

    if args.demo:
        dji_items, comp_offers, store_health = build_demo_dataset()
        benda_items: list[dict[str, Any]] = []
    else:
        dji_scraper = WooCommerceScraper(
            store_id="dji_israel",
            store_name="DJI ישראל",
            base_url="https://www.djistore.benda.co.il",
            default_brand="DJI",
        )
        benda_scraper = WooCommerceScraper(
            store_id="benda_store",
            store_name="בנדא סטור",
            base_url="https://www.bendastore.co.il",
        )
        ksp_scraper = KspScraper()
        bug_scraper = BugScraper()

        dji_items, h_dji = run_scraper_with_cache(dji_scraper, cache, args.mode)
        benda_items, h_benda = run_scraper_with_cache(benda_scraper, cache, args.mode)
        ksp_offers, h_ksp = run_scraper_with_cache(ksp_scraper, cache, args.mode)
        bug_offers, h_bug = run_scraper_with_cache(bug_scraper, cache, args.mode)

        store_health = [h_dji, h_benda, h_ksp, h_bug]
        comp_offers = ksp_offers + bug_offers

    base_catalog = merge_base_catalog(dji_items, benda_items, overrides_dir=OVERRIDES_DIR)
    matched_products = match_catalog_to_competitors(base_catalog, comp_offers)
    with_matches = sum(1 for p in matched_products if p["competitors"])

    print(
        f"[SUMMARY] base={len(base_catalog)} | comp_offers={len(comp_offers)} | matched_products={with_matches}"
    )
    if comp_offers:
        print("[SAMPLE COMP OFFERS]", [o.get("title") for o in comp_offers[:5]])

    output_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "demo" if args.demo else args.mode,
        "product_count": len(matched_products),
        "stores": store_health,
        "products": matched_products,
    }

    OUTPUT_PUBLIC_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PUBLIC_JSON.write_text(
        json.dumps(output_payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {len(matched_products)} products to {OUTPUT_PUBLIC_JSON}")


if __name__ == "__main__":
    main()
