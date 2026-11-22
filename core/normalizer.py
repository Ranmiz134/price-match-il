from __future__ import annotations

import re
from dataclasses import dataclass

from scrapers.base import ImporterStatus

KNOWN_BRANDS = (
    "DJI",
    "Insta360",
    "GoPro",
    "Anker",
    "Logitech",
    "Razer",
    "Bluetti",
    "Shure",
    "Baseus",
    "EZVIZ",
    "TP-Link",
    "SanDisk",
    "Samsung",
    "Sony",
    "Apple",
)

STOPWORDS = {
    "רחפן",
    "מצלמת",
    "מצלמה",
    "אקסטרים",
    "אקשן",
    "גימבל",
    "מייצב",
    "מיקרופון",
    "אלחוטי",
    "דגם",
    "צבע",
    "שחור",
    "אפור",
    "לבן",
    "פנינה",
    "כסוף",
    "כחול",
    "מבית",
    "די",
    "גיי",
    "איי",
    "ג'יי",
    "עם",
    "שלט",
    "חכם",
    "ערכת",
    "ערכה",
    "סוללה",
    "לרחפן",
    "drone",
    "camera",
    "action",
    "gimbal",
    "with",
    "color",
    "black",
    "gray",
    "grey",
    "white",
    "pearl",
    "silver",
    "official",
    "israel",
    "benda",
    "בנדא",
}

PARALLEL_PATTERNS = (
    r"יבוא\s*מקביל",
    r"ייבוא\s*מקביל",
    r"אחריות\s*חנות",
    r"אחריות\s*החנות",
    r"אחריות\s*יבואן\s*מקביל",
    r"לא\s*יבואן\s*רשמי",
)

OFFICIAL_PATTERNS = (
    r"יבואן\s*רשמי",
    r"ייבואן\s*רשמי",
    r"היבואן\s*הרשמי",
    r"אחריות\s*רשמית",
    r"בנדא\s*מגנטיק",
    r"בנדא\s*יבואן",
    r"benda\s*magnetic",
)


@dataclass(frozen=True)
class VariantSignature:
    brand: str
    bundle: str
    controller: str
    storage: str
    model_tokens: frozenset[str]


def normalize_barcode(raw: str) -> str:
    """Normalize EAN-13 / UPC-A / Code-128 barcodes. Keeps numeric EAN/UPC or alphanumeric Code-128."""
    cleaned = re.sub(r"[\s\-]+", "", raw or "").strip().upper()
    if not cleaned:
        return ""
    if cleaned.isdigit():
        if len(cleaned) == 12:
            return "0" + cleaned
        if 8 <= len(cleaned) <= 14:
            return cleaned
        return ""
    if 6 <= len(cleaned) <= 32 and re.match(r"^[A-Z0-9._/]+$", cleaned):
        return cleaned
    return ""


def barcode_variants(raw: str) -> set[str]:
    """Return all equivalent representations (with/without leading zero for 12/13-digit codes)."""
    nb = normalize_barcode(raw)
    if not nb:
        return set()
    variants = {nb}
    if nb.isdigit() and len(nb) == 13 and nb.startswith("0"):
        variants.add(nb[1:])
    elif nb.isdigit() and len(nb) == 12:
        variants.add("0" + nb)
    return variants


def extract_barcodes_from_text(text: str) -> list[str]:
    """Extract plausible EAN-13 / UPC-A barcodes embedded in text."""
    found: list[str] = []
    for match in re.findall(r"\b(\d{12,13})\b", text or ""):
        nb = normalize_barcode(match)
        if nb and nb not in found:
            found.append(nb)
    return found


def classify_importer(text: str) -> ImporterStatus:
    """Classify importer status strictly: parallel -> rejected, official -> approved, else unverified."""
    haystack = (text or "").lower()
    if any(re.search(pat, haystack) for pat in PARALLEL_PATTERNS):
        return "parallel"
    if any(re.search(pat, haystack) for pat in OFFICIAL_PATTERNS):
        return "official"
    return "unverified"


def infer_brand(name: str, categories: list[str] | None = None) -> str:
    haystack = f"{name} {' '.join(categories or [])}".lower()
    for brand in KNOWN_BRANDS:
        if brand.lower() in haystack:
            return brand
    return "כללי"


def extract_variant_signature(title: str, brand_hint: str = "") -> VariantSignature:
    """
    Extract structured variant dimensions to enforce Price Match Guard:
    prevents matching Fly More Combo to Standard, RC 2 to RC-N3, or 128GB to 256GB.
    """
    low = (title or "").lower()
    low_clean = re.sub(r"[()\[\],/|\-]+", " ", low)
    low_clean = re.sub(r"\s+", " ", low_clean).strip()

    brand = (brand_hint or infer_brand(title)).lower()

    # 1) Bundle / Kit type (Standard Combo == Standard base kit!)
    bundle = "standard"
    if "fly more combo plus" in low_clean or "fly more plus" in low_clean:
        bundle = "fly_more_plus"
    elif "fly more" in low_clean:
        bundle = "fly_more"
    elif "adventure combo" in low_clean:
        bundle = "adventure_combo"
    elif "creator combo" in low_clean:
        bundle = "creator_combo"
    elif "vlog combo" in low_clean:
        bundle = "vlog_combo"
    elif "motion fly more" in low_clean or "motion combo" in low_clean:
        bundle = "motion_combo"
    elif "pro combo" in low_clean:
        bundle = "pro_combo"
    elif "cine combo" in low_clean or "cine premium" in low_clean:
        bundle = "cine_combo"
    elif "standard combo" in low_clean:
        bundle = "standard"
    elif "combo" in low_clean or "קומבו" in low_clean:
        bundle = "combo"
    elif "גוף בלבד" in low_clean or "drone only" in low_clean or "body only" in low_clean:
        bundle = "body_only"

    # 2) Controller / Goggles
    controller = "unspecified"
    if re.search(r"\brc[\s\-]?pro\b", low_clean):
        controller = "rc_pro"
    elif re.search(r"\brc[\s\-]?2\b", low_clean):
        controller = "rc_2"
    elif re.search(r"\brc[\s\-]?n3\b", low_clean):
        controller = "rc_n3"
    elif re.search(r"\brc[\s\-]?n2\b", low_clean):
        controller = "rc_n2"
    elif re.search(r"\brc[\s\-]?motion[\s\-]?3\b", low_clean):
        controller = "rc_motion_3"
    elif re.search(r"\bgoggles[\s\-]?n3\b", low_clean):
        controller = "goggles_n3"
    elif re.search(r"\bgoggles[\s\-]?3\b", low_clean):
        controller = "goggles_3"

    # 3) Storage capacity
    storage = "unspecified"
    st_match = re.search(r"\b(32|64|128|256|512)\s*gb\b|\b(1|2|4)\s*tb\b", low_clean)
    if st_match:
        storage = re.sub(r"\s+", "", st_match.group(0))

    # 4) Core model tokens (remove bundle/controller/storage/stopwords)
    stripped = re.sub(
        r"\b(fly more combo plus|fly more plus|fly more combo|fly more|adventure combo|creator combo|"
        r"vlog combo|motion combo|pro combo|cine combo|standard combo|combo|drone only|body only|standard|"
        r"rc[\s\-]?pro|rc[\s\-]?2|rc[\s\-]?n3|rc[\s\-]?n2|rc[\s\-]?motion[\s\-]?3|"
        r"goggles[\s\-]?n3|goggles[\s\-]?3|(?:32|64|128|256|512)\s*gb|(?:1|2|4)\s*tb)\b",
        " ",
        low_clean,
    )
    raw_tokens = re.findall(r"[a-z0-9]+|[א-ת]+", stripped)
    model_tokens = frozenset(t for t in raw_tokens if t not in STOPWORDS and len(t) >= 1)

    return VariantSignature(
        brand=brand,
        bundle=bundle,
        controller=controller,
        storage=storage,
        model_tokens=model_tokens,
    )
