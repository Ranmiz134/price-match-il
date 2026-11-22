from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ImporterStatus = Literal["official", "parallel", "unverified"]


@dataclass
class BaseProduct:
    """Normalized product from our official sources (DJI Israel / Benda Store / Overrides)."""

    id: str
    name: str
    brand: str
    sku: str = ""
    barcodes: list[str] = field(default_factory=list)
    our_price: float = 0.0
    regular_price: float | None = None
    is_on_sale: bool = False
    in_stock: bool = True
    source_id: str = ""
    source_name: str = ""
    source_url: str = ""
    category: str = ""
    image_url: str = ""
    secondary_sources: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CompetitorOffer:
    """Normalized competitor offer (always VAT-included center price)."""

    store_id: str
    store_name: str
    title: str
    price: float
    url: str
    in_stock: bool
    importer_status: ImporterStatus = "unverified"
    importer_text: str = ""
    sku: str = ""
    barcodes: list[str] = field(default_factory=list)
    regular_price: float | None = None
    is_on_sale: bool = False
    scraped_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ScraperBase(ABC):
    """Common interface for all base and competitor scrapers."""

    store_id: str = ""
    store_name: str = ""
    is_base_source: bool = False

    @abstractmethod
    def fetch(self, mode: str = "dji", queries: list[str] | None = None) -> list[dict[str, Any]]:
        """Fetch raw normalized records as dicts ready for caching and matching."""
        raise NotImplementedError
