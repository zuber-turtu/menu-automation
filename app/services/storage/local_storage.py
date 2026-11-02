import os
import json
import csv
import logging
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from app.services.storage.base import BaseStorage
from app.config import settings

logger = logging.getLogger("menu_automation.storage.local")

class LocalStorage(BaseStorage):
    """
    Local file-based storage engine.
    Stores API keys in data/api_keys.json.
    Stores categories in reference/categories.json (with fallback to categories_turtu.csv).
    """

    def __init__(self, data_dir: Optional[Path] = None, ref_dir: Optional[Path] = None):
        self.data_dir = data_dir or settings.DATA_DIR
        self.ref_dir = ref_dir or settings.REFERENCE_DIR
        self.keys_file = self.data_dir / "api_keys.json"
        self.categories_file = self.ref_dir / "categories.json"
        self.csv_fallback = settings.BASE_DIR / "categories_turtu.csv"

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.ref_dir.mkdir(parents=True, exist_ok=True)

        if not self.keys_file.exists():
            self.save_api_keys([])

    def get_storage_type(self) -> str:
        return "local"

    def get_storage_label(self) -> str:
        return "Local JSON/CSV"

    def ping(self) -> Tuple[bool, str]:
        try:
            can_read_keys = self.keys_file.exists() or self.data_dir.exists()
            return True, "Local files accessible"
        except Exception as e:
            return False, f"Local storage error: {e}"

    # ==========================================
    # API KEYS POOL
    # ==========================================
    def get_api_keys(self) -> List[Dict]:
        if not self.keys_file.exists():
            return []
        try:
            with open(self.keys_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error reading {self.keys_file}: {e}")
            return []

    def save_api_keys(self, keys: List[Dict]) -> bool:
        temp_file = self.keys_file.with_suffix(".tmp")
        try:
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(keys, f, indent=2, ensure_ascii=False)
            temp_file.replace(self.keys_file)
            return True
        except Exception as e:
            logger.error(f"Error saving {self.keys_file}: {e}")
            if temp_file.exists():
                temp_file.unlink()
            return False

    def add_api_key(self, record: Dict) -> bool:
        keys = self.get_api_keys()
        # Replace if ID exists, otherwise append
        updated = [k for k in keys if k.get("id") != record.get("id")]
        updated.append(record)
        return self.save_api_keys(updated)

    def delete_api_key(self, key_id: str) -> bool:
        keys = self.get_api_keys()
        new_keys = [k for k in keys if k.get("id") != key_id]
        if len(new_keys) == len(keys):
            return False
        return self.save_api_keys(new_keys)

    def update_api_key(self, key_id: str, updates: Dict) -> bool:
        keys = self.get_api_keys()
        found = False
        for k in keys:
            if k.get("id") == key_id:
                k.update(updates)
                found = True
                break
        if found:
            return self.save_api_keys(keys)
        return False

    # ==========================================
    # CATEGORY TAXONOMY
    # ==========================================
    def get_categories(self) -> List[Dict[str, str]]:
        if self.categories_file.exists():
            try:
                with open(self.categories_file, "r", encoding="utf-8") as f:
                    cats = json.load(f)
                    if cats:
                        return cats
            except Exception as e:
                logger.error(f"Error reading {self.categories_file}: {e}")

        # Fallback to categories_turtu.csv
        if self.csv_fallback.exists():
            return self._load_categories_from_csv(self.csv_fallback)

        return []

    def save_categories(self, categories: List[Dict[str, str]]) -> int:
        try:
            with open(self.categories_file, "w", encoding="utf-8") as f:
                json.dump(categories, f, indent=2, ensure_ascii=False)
            return len(categories)
        except Exception as e:
            logger.error(f"Error saving categories to {self.categories_file}: {e}")
            return 0

    def add_category(self, category_id: str, name: str) -> bool:
        cid = str(category_id).strip()
        cname = str(name).strip()
        if not cid or not cname:
            return False
        cats = self.get_categories()
        # Replace if ID exists, otherwise append
        updated = [c for c in cats if str(c.get("id")) != cid]
        updated.append({"id": cid, "name": cname})
        return self.save_categories(updated) > 0

    def delete_category(self, category_id: str) -> bool:
        cid = str(category_id).strip()
        cats = self.get_categories()
        updated = [c for c in cats if str(c.get("id")) != cid]
        if len(updated) == len(cats):
            return False
        return self.save_categories(updated) >= 0

    def _load_categories_from_csv(self, csv_path: Path) -> List[Dict[str, str]]:
        try:
            with open(csv_path, "r", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                rows = list(reader)
            if not rows:
                return []

            header = [h.strip().lower() for h in rows[0]]
            id_idx = -1
            name_idx = -1
            for idx, col in enumerate(header):
                if col in ["id", "category_id", "categoryid"]:
                    id_idx = idx
                elif col in ["name", "category_name", "categoryname", "title"]:
                    name_idx = idx

            has_header = True
            if id_idx == -1 or name_idx == -1:
                if len(rows[0]) >= 3:
                    id_idx, name_idx = 1, 2
                elif len(rows[0]) >= 2:
                    id_idx, name_idx = 0, 1
                else:
                    return []
                if rows[0][id_idx].strip().isdigit():
                    has_header = False

            start_row = 1 if has_header else 0
            new_cats = []
            seen_ids = set()

            for row in rows[start_row:]:
                if len(row) > max(id_idx, name_idx):
                    cid = str(row[id_idx]).strip()
                    name = str(row[name_idx]).strip()
                    if cid and name and cid.lower() not in ["id", "category_id", "categoryid"]:
                        if cid.endswith(".0"):
                            cid = cid[:-2]
                        if cid not in seen_ids:
                            seen_ids.add(cid)
                            new_cats.append({"id": cid, "name": name})

            if new_cats:
                self.save_categories(new_cats)
            return new_cats
        except Exception as e:
            logger.error(f"Error loading CSV {csv_path}: {e}")
            return []

