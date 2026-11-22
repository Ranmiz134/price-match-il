from __future__ import annotations

from typing import Any

from core.normalizer import VariantSignature, barcode_variants, extract_variant_signature

ANOMALY_DROP_THRESHOLD = 0.30  # >30% cheaper than our official price triggers Price Match Guard


def match_catalog_to_competitors(
    base_products: list[dict[str, Any]],
    competitor_offers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Match each base product against competitor offers with strict business rules:
    1. Reject parallel imports automatically.
    2. Enforce variant/bundle/controller/storage compatibility (Price Match Guard).
    3. Flag offers >30% cheaper as anomaly (never auto-selected as match price).
    4. Flag unverified importer offers for seller verification (never auto-selected).
    5. Surface BOTH cheapest overall (even if out of stock, clearly tagged) AND
       cheapest approved in-stock price for immediate seller decision.
    """
    # Pre-compute signatures and barcode sets for competitor offers
    indexed_offers: list[tuple[dict[str, Any], VariantSignature, set[str]]] = []
    for offer in competitor_offers:
        if offer.get("importer_status") == "parallel":
            continue  # Rule 2: Hard-reject parallel import / store warranty
        if float(offer.get("price", 0)) <= 0:
            continue
        sig = extract_variant_signature(offer.get("title", ""))
        bc_set: set[str] = set()
        for bc in offer.get("barcodes") or []:
            bc_set.update(barcode_variants(bc))
        indexed_offers.append((offer, sig, bc_set))

    enriched: list[dict[str, Any]] = []

    for prod in base_products:
        our_price = float(prod.get("our_price", 0))
        if our_price <= 0:
            continue

        prod_sig = extract_variant_signature(prod.get("name", ""), prod.get("brand", ""))
        prod_barcodes: set[str] = set()
        for bc in prod.get("barcodes") or []:
            prod_barcodes.update(barcode_variants(bc))

        matched_offers: list[dict[str, Any]] = []
        best_per_store: dict[str, dict[str, Any]] = {}

        for offer, offer_sig, offer_barcodes in indexed_offers:
            match_type, score = _evaluate_match(prod_sig, prod_barcodes, offer_sig, offer_barcodes)
            if not match_type:
                continue

            comp_price = float(offer["price"])
            diff_ils = round(comp_price - our_price, 2)
            diff_pct = round(((comp_price - our_price) / our_price) * 100, 1)
            drop_ratio = (our_price - comp_price) / our_price

            anomaly_flag = drop_ratio > ANOMALY_DROP_THRESHOLD
            importer_status = offer.get("importer_status", "unverified")
            needs_seller_check = importer_status != "official" or anomaly_flag

            # Eligible as automatic approved match price ONLY if official importer + no >30% anomaly + in stock
            is_approved_match = (
                importer_status == "official"
                and not anomaly_flag
                and bool(offer.get("in_stock", True))
            )

            entry = {
                "store_id": offer["store_id"],
                "store_name": offer["store_name"],
                "title": offer["title"],
                "price": comp_price,
                "url": offer["url"],
                "in_stock": bool(offer.get("in_stock", True)),
                "stock_label": "במלאי" if offer.get("in_stock", True) else "אין במלאי אצל המתחרה",
                "importer_status": importer_status,
                "importer_label": "יבואן רשמי" if importer_status == "official" else "לבדיקת מוכר (יבואן לא ודאי)",
                "anomaly_flag": anomaly_flag,
                "anomaly_warning": (
                    "⚠️ פער חריג — יש לוודא התאמת דגם/חבילה בקישור" if anomaly_flag else ""
                ),
                "needs_seller_check": needs_seller_check,
                "is_approved_match": is_approved_match,
                "diff_ils": diff_ils,
                "diff_pct": diff_pct,
                "match_type": match_type,
                "match_score": round(score, 2),
                "scraped_at": offer.get("scraped_at", ""),
            }

            store_id = offer["store_id"]
            # Keep the highest-confidence (or lowest valid price on tie) listing per store
            prev = best_per_store.get(store_id)
            if prev is None or (entry["match_score"], -entry["price"]) > (prev["match_score"], -prev["price"]):
                best_per_store[store_id] = entry

        matched_offers = sorted(best_per_store.values(), key=lambda x: x["price"])

        # Compute summary prices for seller UI
        approved_in_stock = [o for o in matched_offers if o["is_approved_match"]]
        official_any_stock = [
            o for o in matched_offers if o["importer_status"] == "official" and not o["anomaly_flag"]
        ]

        best_in_stock = approved_in_stock[0] if approved_in_stock else None
        cheapest_overall = official_any_stock[0] if official_any_stock else (matched_offers[0] if matched_offers else None)

        enriched.append(
            {
                "id": prod["id"],
                "name": prod["name"],
                "brand": prod.get("brand", ""),
                "sku": prod.get("sku", ""),
                "barcodes": prod.get("barcodes", []),
                "our_price": our_price,
                "regular_price": prod.get("regular_price"),
                "is_on_sale": bool(prod.get("is_on_sale", False)),
                "source_name": prod.get("source_name", ""),
                "source_url": prod.get("source_url", ""),
                "secondary_sources": prod.get("secondary_sources", []),
                "best_in_stock_match": best_in_stock,
                "cheapest_overall": cheapest_overall,
                "competitors": matched_offers,
            }
        )

    return enriched


def _evaluate_match(
    prod_sig: VariantSignature,
    prod_barcodes: set[str],
    offer_sig: VariantSignature,
    offer_barcodes: set[str],
) -> tuple[str, float]:
    """Return (match_type, score) or ('', 0.0) if rejected by Price Match Guard."""
    # 1) Exact barcode match (highest confidence)
    if prod_barcodes and offer_barcodes and (prod_barcodes & offer_barcodes):
        return ("barcode", 1.0)

    # 2) Strict variant guards (hard rejection on mismatch)
    if prod_sig.brand and offer_sig.brand and prod_sig.brand != offer_sig.brand:
        return ("", 0.0)

    # Bundle guard: NEVER match Fly More Combo to Standard / Body Only, or Adventure to Standard
    if prod_sig.bundle != offer_sig.bundle:
        return ("", 0.0)

    # Storage guard: if both specify storage, they MUST match
    if (
        prod_sig.storage != "unspecified"
        and offer_sig.storage != "unspecified"
        and prod_sig.storage != offer_sig.storage
    ):
        return ("", 0.0)

    # Controller / Goggles guard: if both specify controller, they MUST match
    if (
        prod_sig.controller != "unspecified"
        and offer_sig.controller != "unspecified"
        and prod_sig.controller != offer_sig.controller
    ):
        return ("", 0.0)

    # 3) Model token overlap (all numeric version tokens must match, e.g., Mini 4 != Mini 3, Action 5 != Action 4)
    if not prod_sig.model_tokens or not offer_sig.model_tokens:
        return ("", 0.0)

    prod_nums = {t for t in prod_sig.model_tokens if any(ch.isdigit() for ch in t)}
    offer_nums = {t for t in offer_sig.model_tokens if any(ch.isdigit() for ch in t)}
    if prod_nums != offer_nums:
        return ("", 0.0)

    intersection = prod_sig.model_tokens & offer_sig.model_tokens
    union = prod_sig.model_tokens | offer_sig.model_tokens
    jaccard = len(intersection) / len(union)

    if jaccard >= 0.72 and len(intersection) >= 2:
        return ("variant_exact", jaccard)

    return ("", 0.0)
