from __future__ import annotations

from pathlib import Path

from core.cache import StickyCache
from core.loader import merge_base_catalog
from core.matcher import match_catalog_to_competitors
from core.normalizer import barcode_variants, classify_importer, normalize_barcode
from scrapers.google_sheet import GoogleSheetSync
from scrapers.woocommerce import WooCommerceScraper


def test_google_sheet_csv_parsing_and_exact_sku_matching():
    our_csv = (
        "sku,barcode,brand,product_name,our_price_vat,is_on_sale,our_url,updated_at\n"
        "99999-958-88,,DJI,מצלמת אקשן Osmo 360 II Adventure Combo,2699,FALSE,https://www.djistore.benda.co.il/product/99999-958-88/,2026-11-22 09:27\n"
        "99999-958-90,,DJI,מצלמת גימבל דגם Osmo Pocket 4P Standard Combo מבית DJI,2499,FALSE,https://www.djistore.benda.co.il/product/99999-958-90/,2026-11-22 09:27\n"
    )
    comp_csv = (
        "our_sku,our_product_name,store_name,competitor_title,price_vat,in_stock,importer_status,product_url,checked_at\n"
        "99999-958-88,מצלמת אקשן Osmo 360 II Adventure Combo,KSP,מצלמת אקסטרים DJI Osmo 360 II Adventure Combo,2399,TRUE,unverified,https://ksp.co.il/web/item/492065,2026-11-22 09:27\n"
        "99999-958-88,מצלמת אקשן Osmo 360 II Adventure Combo,Bug,מצלמה Osmo 360 II Adventure Combo DJI,2699,TRUE,official,https://www.bug.co.il/brand/dji/osmo/360/ii/adventure/combo,2026-11-22 09:27\n"
        "99999-958-90,מצלמת גימבל דגם Osmo Pocket 4P Standard Combo מבית DJI,Bug,מצלמת גימבל Osmo Pocket 4P Standard Combo DJI,2499,TRUE,official,https://www.bug.co.il/brand/dji/osmo/pocket/4p/standard/combo,2026-11-22 09:27\n"
        "99999-958-90,מצלמת גימבל דגם Osmo Pocket 4P Standard Combo מבית DJI,Payngo,אילת,2000,TRUE,official,https://eilat.payngo.co.il/123.html,2026-11-22 09:27\n"
    )
    our_items = GoogleSheetSync.parse_our_catalog_rows(GoogleSheetSync.parse_csv_text(our_csv))
    comp_items = GoogleSheetSync.parse_competitor_rows(GoogleSheetSync.parse_csv_text(comp_csv))
    assert len(our_items) == 2
    assert len(comp_items) == 3  # eilat.payngo.co.il row strictly rejected!

    matched = match_catalog_to_competitors(our_items, comp_items)
    osmo360 = [m for m in matched if m["sku"] == "99999-958-88"][0]
    assert len(osmo360["competitors"]) == 2
    # KSP is cheaper (2399) but unverified -> Bug (2699 official) is best_in_stock_match
    assert osmo360["best_in_stock_match"]["store_id"] == "bug"
    ksp_offer = [c for c in osmo360["competitors"] if c["store_id"] == "ksp"][0]
    assert ksp_offer["needs_seller_check"] is True


def test_real_bug_hebrew_title_matches_dji_israel():
    base = [
        {
            "id": "dji:neo",
            "name": "רחפן DJI Neo Fly More Combo",
            "brand": "DJI",
            "sku": "99999-111-01",
            "barcodes": [],
            "our_price": 1599.0,
            "source_name": "DJI ישראל",
        }
    ]
    offers = [
        {
            "store_id": "bug",
            "store_name": "באג (Bug)",
            "title": "רחפן Neo Fly More Combo די ג'יי איי - DJI",
            "price": 1549.0,
            "url": "https://www.bug.co.il/brand/dji/neo/fly/more/combo",
            "in_stock": True,
            "importer_status": "official",
        }
    ]
    res = match_catalog_to_competitors(base, offers)[0]
    assert len(res["competitors"]) == 1
    assert res["best_in_stock_match"]["store_id"] == "bug"


def test_woocommerce_zero_minor_unit_not_divided_by_100():
    scraper = WooCommerceScraper("dji_israel", "DJI ישראל", "https://www.djistore.benda.co.il", default_brand="DJI")
    parsed = scraper._parse_store_api_item(
        {
            "id": 101,
            "name": "מצלמת גימבל דגם Osmo Pocket 4P Standard Combo DJI (Pearl White)",
            "sku": "99999-959-03",
            "prices": {"price": "2499", "regular_price": "2499", "sale_price": "", "currency_minor_unit": 0},
            "on_sale": False,
            "is_in_stock": True,
            "permalink": "https://www.djistore.benda.co.il/product/test/",
            "categories": [{"name": "Osmo Pocket"}],
        }
    )
    assert parsed is not None
    assert parsed.our_price == 2499.0
    assert parsed.barcodes == []


def test_barcode_leading_zero_equivalence():
    assert normalize_barcode("190021114562") == "0190021114562"
    assert barcode_variants("190021114562") == barcode_variants("0190021114562")


def test_importer_classification_rules():
    assert classify_importer("שנה אחריות יבואן רשמי בנדא") == "official"
    assert classify_importer("אחריות יבוא מקביל ע\"י החנות") == "parallel"
    assert classify_importer("אחריות חנות לשנה") == "parallel"
    assert classify_importer("אחריות לשנה") == "unverified"


def test_price_match_guard_rejects_bundle_and_storage_mismatch():
    base = [
        {
            "id": "dji:1",
            "name": "DJI Mini 4 Pro Fly More Combo (DJI RC 2)",
            "brand": "DJI",
            "sku": "SKU1",
            "barcodes": [],
            "our_price": 4699.0,
            "source_name": "DJI ישראל",
        }
    ]
    offers = [
        {
            "store_id": "bug",
            "store_name": "באג",
            "title": "DJI Mini 4 Pro (DJI RC 2)",
            "price": 3499.0,
            "url": "https://www.bug.co.il/1",
            "in_stock": True,
            "importer_status": "official",
        },
        {
            "store_id": "ksp",
            "store_name": "KSP",
            "title": "DJI Mini 4 Pro Fly More Combo (DJI RC 2)",
            "price": 4100.0,
            "url": "https://ksp.co.il/web/item/1",
            "in_stock": True,
            "importer_status": "parallel",
        },
    ]
    res = match_catalog_to_competitors(base, offers)
    assert res[0]["competitors"] == []
    assert res[0]["best_in_stock_match"] is None


def test_out_of_stock_and_anomaly_guard():
    base = [
        {
            "id": "dji:2",
            "name": "DJI Neo Fly More Combo",
            "brand": "DJI",
            "sku": "SKU2",
            "barcodes": ["0190021114562"],
            "our_price": 1600.0,
            "source_name": "DJI ישראל",
        }
    ]
    offers = [
        {
            "store_id": "store_anom",
            "store_name": "חנות חריגה",
            "title": "DJI Neo Fly More Combo",
            "price": 999.0,
            "url": "https://example.com/anom",
            "in_stock": True,
            "importer_status": "official",
        },
        {
            "store_id": "bug",
            "store_name": "באג",
            "title": "DJI Neo Fly More Combo",
            "price": 1490.0,
            "url": "https://www.bug.co.il/neo",
            "in_stock": False,
            "importer_status": "official",
        },
        {
            "store_id": "ksp",
            "store_name": "KSP",
            "title": "רחפן DJI Neo Fly More Combo",
            "price": 1549.0,
            "url": "https://ksp.co.il/web/item/99",
            "in_stock": True,
            "importer_status": "official",
            "barcodes": ["190021114562"],
        },
    ]
    res = match_catalog_to_competitors(base, offers)[0]
    assert res["best_in_stock_match"]["store_id"] == "ksp"
    assert res["cheapest_overall"]["store_id"] == "bug"
    assert res["cheapest_overall"]["stock_label"] == "אין במלאי אצל המתחרה"
    anom = [c for c in res["competitors"] if c["store_id"] == "store_anom"][0]
    assert anom["anomaly_flag"] is True
    assert anom["is_approved_match"] is False


def test_overrides_csv_merges_barcodes_and_manual_price(tmp_path: Path):
    csv_file = tmp_path / "manual.csv"
    csv_file.write_text(
        "sku,barcode,name,brand,manual_price,is_on_sale,source_url\n"
        "SKU1,0190021094833,DJI Mini 4 Pro,DJI,4499,true,\n",
        encoding="utf-8",
    )
    base = [
        {
            "id": "dji:1",
            "name": "DJI Mini 4 Pro",
            "brand": "DJI",
            "sku": "SKU1",
            "barcodes": [],
            "our_price": 4699.0,
            "source_id": "dji_israel",
            "source_name": "DJI ישראל",
        }
    ]
    merged = merge_base_catalog(base, [], overrides_dir=tmp_path)
    assert merged[0]["our_price"] == 4499.0
    assert merged[0]["is_on_sale"] is True
    assert "0190021094833" in merged[0]["barcodes"]


def test_sticky_cache_preserves_previous_data_on_block(tmp_path: Path):
    cache = StickyCache(tmp_path)
    cache.save_success("ksp", "KSP", [{"title": "DJI Neo", "price": 1500}])
    items, health = cache.fallback_on_failure("ksp", "KSP", "HTTP 403 Cloudflare")
    assert len(items) == 1
    assert health["status"] == "stale"
