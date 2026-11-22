from __future__ import annotations

from pathlib import Path

from core.cache import StickyCache
from core.loader import merge_base_catalog
from core.matcher import match_catalog_to_competitors
from core.normalizer import barcode_variants, classify_importer, normalize_barcode


def test_barcode_leading_zero_equivalence():
    assert normalize_barcode("190021114562") == "0190021114562"
    v_upc = barcode_variants("190021114562")
    v_ean = barcode_variants("0190021114562")
    assert v_upc == v_ean


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
        # Standard (non-combo) must be rejected
        {
            "store_id": "bug",
            "store_name": "באג",
            "title": "DJI Mini 4 Pro (DJI RC 2)",
            "price": 3499.0,
            "url": "https://www.bug.co.il/1",
            "in_stock": True,
            "importer_status": "official",
        },
        # Parallel import must be rejected
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
    assert len(res) == 1
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
        # >30% cheaper -> anomaly warning, NOT auto-approved
        {
            "store_id": "store_anom",
            "store_name": "חנות חריגה",
            "title": "DJI Neo Fly More Combo",
            "price": 999.0,
            "url": "https://example.com/anom",
            "in_stock": True,
            "importer_status": "official",
        },
        # Cheapest valid official, but OUT OF STOCK
        {
            "store_id": "bug",
            "store_name": "באג",
            "title": "DJI Neo Fly More Combo",
            "price": 1490.0,
            "url": "https://www.bug.co.il/neo",
            "in_stock": False,
            "importer_status": "official",
        },
        # Valid official IN STOCK (matched via 12-digit UPC-A barcode without leading 0)
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
    assert res["best_in_stock_match"]["price"] == 1549.0
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
    assert health["count"] == 1
