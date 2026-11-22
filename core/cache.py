from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class StickyCache:
    """
    Per-store sticky cache: if a store fails or is blocked today,
    preserves the last known good scrape with its timestamp and marks store health as 'stale'.
    """

    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, store_id: str) -> Path:
        return self.cache_dir / f"{store_id}.json"

    def save_success(
        self,
        store_id: str,
        store_name: str,
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        payload = {
            "store_id": store_id,
            "store_name": store_name,
            "last_ok_at": now_iso,
            "count": len(items),
            "items": items,
        }
        self._path(store_id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return {
            "store_id": store_id,
            "store_name": store_name,
            "status": "ok",
            "status_label": "תקין",
            "last_ok_at": now_iso,
            "count": len(items),
            "message": "",
        }

    def fallback_on_failure(
        self,
        store_id: str,
        store_name: str,
        reason: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        path = self._path(store_id)
        if path.exists():
            try:
                cached = json.loads(path.read_text(encoding="utf-8"))
                items = cached.get("items") or []
                last_ok = cached.get("last_ok_at", "")
                health = {
                    "store_id": store_id,
                    "store_name": store_name,
                    "status": "stale",
                    "status_label": "שמור מסריקה קודמת",
                    "last_ok_at": last_ok,
                    "count": len(items),
                    "message": reason,
                }
                return items, health
            except Exception:
                pass

        return [], {
            "store_id": store_id,
            "store_name": store_name,
            "status": "error",
            "status_label": "שגיאת סריקה",
            "last_ok_at": "",
            "count": 0,
            "message": reason,
        }
