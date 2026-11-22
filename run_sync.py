from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.cache import StickyCache
from core.loader import merge_base_catalog
from core.matcher import match_catalog_to_competitors
from scrapers.base import ScraperBase
from scrapers.bug import BugScraper
from scrapers.google_sheet import DEFAULT_SHEET_ID, GoogleSheetSync
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


def sync_from_google_sheet(
    sheet_id: str,
    cache: StickyCache,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    sheet = GoogleSheetSync(sheet_id)
    health_list: list[dict[str, Any]] = []

    try:
        our_items = sheet.fetch_our_catalog()
        if our_items:
            h_cat = cache.save_success("sheet_catalog", "DJI / בנדא (Sheets)", our_items)
        else:
            our_items, h_cat = cache.fallback_on_failure(
                "sheet_catalog", "DJI / בנדא (Sheets)", "גיליון Our_Catalog ריק"
            )
        health_list.append(h_cat)
        print(f"[SHEET] Our_Catalog: {len(our_items)} items")
    except Exception as exc:
        our_items, h_cat = cache.fallback_on_failure("sheet_catalog", "DJI / בנדא (Sheets)", str(exc))
        health_list.append(h_cat)
        print(f"[SHEET] Our_Catalog ERROR: {exc}")

    try:
        comp_items = sheet.fetch_competitor_prices()
        if comp_items:
            by_store: dict[str, list[dict[str, Any]]] = defaultdict(list)
            store_names: dict[str, str] = {}
            for offer in comp_items:
                sid = offer["store_id"]
                by_store[sid].append(offer)
                store_names[sid] = offer["store_name"]
            for sid, items in sorted(by_store.items()):
                h_store = cache.save_success(f"sheet_{sid}", store_names[sid], items)
                health_list.append(h_store)
                print(f"[SHEET] Competitor {store_names[sid]}: {len(items)} offers")
        else:
            comp_items, h_comp = cache.fallback_on_failure(
                "sheet_competitors", "מתחרים (Sheets)", "גיליון Competitor_Prices ריק"
            )
            health_list.append(h_comp)
    except Exception as exc:
        comp_items, h_comp = cache.fallback_on_failure("sheet_competitors", "מתחרים (Sheets)", str(exc))
        health_list.append(h_comp)
        print(f"[SHEET] Competitor_Prices ERROR: {exc}")

    return our_items, comp_items, health_list


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily market price sync for Herzliya store")
    parser.add_argument(
        "--source",
        choices=["sheet", "hybrid", "scrape"],
        default="sheet",
        help="sheet=Google Sheet only (fast), hybrid=Google Sheet + live DJI/Benda/Bug, scrape=live scrapers only",
    )
    parser.add_argument("--mode", choices=["dji", "full"], default="dji", help="Scan scope for live scrapers")
    parser.add_argument(
        "--sheet-id",
        default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID),
        help="Google Sheet ID containing Our_Catalog and Competitor_Prices",
    )
    args = parser.parse_args()

    cache = StickyCache(CACHE_DIR)
    store_health: list[dict[str, Any]] = []
    dji_items: list[dict[str, Any]] = []
    benda_items: list[dict[str, Any]] = []
    comp_offers: list[dict[str, Any]] = []

    if args.source in ("sheet", "hybrid"):
        sheet_catalog, sheet_comps, sheet_health = sync_from_google_sheet(args.sheet_id, cache)
        dji_items.extend(sheet_catalog)
        comp_offers.extend(sheet_comps)
        store_health.extend(sheet_health)

    if args.source in ("hybrid", "scrape"):
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
        bug_scraper = BugScraper()

        live_dji, h_dji = run_scraper_with_cache(dji_scraper, cache, args.mode)
        live_benda, h_benda = run_scraper_with_cache(benda_scraper, cache, args.mode)
        live_bug, h_bug = run_scraper_with_cache(bug_scraper, cache, args.mode)

        dji_items.extend(live_dji)
        benda_items.extend(live_benda)
        comp_offers.extend(live_bug)
        store_health.extend([h_dji, h_benda, h_bug])

        if args.source == "scrape":
            ksp_scraper = KspScraper()
            live_ksp, h_ksp = run_scraper_with_cache(ksp_scraper, cache, args.mode)
            comp_offers.extend(live_ksp)
            store_health.append(h_ksp)

    base_catalog = merge_base_catalog(dji_items, benda_items, overrides_dir=OVERRIDES_DIR)
    matched_products = match_catalog_to_competitors(base_catalog, comp_offers)
    with_matches = sum(1 for p in matched_products if p["competitors"])

    print(
        f"[SUMMARY] source={args.source} | base={len(base_catalog)} | "
        f"comp_offers={len(comp_offers)} | matched_products={with_matches}"
    )

    output_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.source,
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
