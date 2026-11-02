import csv
import json
import difflib
import logging
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from app.config import settings
from app.services.storage import get_storage, BaseStorage

logger = logging.getLogger("menu_automation.category_service")

class CategoryService:
    """
    Turtu Category Taxonomy Service with:
    - High-speed in-memory fuzzy matching and reverse lookup
    - Pluggable persistent storage (SQLite, Supabase, or Local JSON)
    - Auto-seeding from categories_turtu.csv
    """

    def __init__(self, storage: Optional[BaseStorage] = None):
        self.storage = storage or get_storage()
        self.categories: Dict[str, str] = {}  # Normalized name -> Category ID
        self.category_list: List[Dict[str, str]] = []  # [{"id": "...", "name": "..."}, ...]
        self.storage_file = settings.REFERENCE_DIR / "categories.json"
        self._initialize_categories()

    def _initialize_categories(self):
        """Loads categories from active storage backend, falling back to stored JSON or categories_turtu.csv."""
        try:
            stored_cats = self.storage.get_categories()
            if stored_cats:
                self.category_list = stored_cats
                self._rebuild_lookup()
                logger.info(f"Loaded {len(stored_cats)} categories from {self.storage.get_storage_label()}.")
                return
        except Exception as e:
            logger.error(f"Error reading categories from {self.storage.get_storage_label()}: {e}")

        # Fallback to local categories.json
        if self.storage_file.exists():
            try:
                with open(self.storage_file, "r", encoding="utf-8") as f:
                    self.category_list = json.load(f)
                    self._rebuild_lookup()
                if self.category_list:
                    self.storage.save_categories(self.category_list)
                    return
            except Exception as e:
                logger.error(f"Error reading {self.storage_file}: {e}")

        # Fallback to categories_turtu.csv in BASE_DIR
        csv_path = settings.BASE_DIR / "categories_turtu.csv"
        if csv_path.exists():
            self.load_from_csv_file(csv_path)

    def _rebuild_lookup(self):
        self.categories = {}
        for item in self.category_list:
            cid = str(item.get("id", "")).strip()
            name = str(item.get("name", "")).strip()
            if cid and name:
                self.categories[name.lower()] = cid

    def save_to_storage(self):
        """Persists active categories to both active storage engine and local backup file."""
        try:
            self.storage.save_categories(self.category_list)
        except Exception as e:
            logger.error(f"Failed to save categories to {self.storage.get_storage_label()}: {e}")

        # Always maintain local backup
        try:
            with open(self.storage_file, "w", encoding="utf-8") as f:
                json.dump(self.category_list, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Failed to save categories backup {self.storage_file}: {e}")

    def add_category(self, category_id: str, name: str) -> Tuple[bool, str, Optional[Dict]]:
        """Adds or updates a category in the active taxonomy registry."""
        cid = str(category_id).strip()
        cname = str(name).strip()
        if not cid:
            return False, "Category ID is required.", None
        if not cname:
            return False, "Category Name is required.", None

        existing_idx = -1
        for idx, item in enumerate(self.category_list):
            if str(item.get("id")) == cid:
                existing_idx = idx
                break

        record = {"id": cid, "name": cname}
        if existing_idx >= 0:
            self.category_list[existing_idx] = record
            msg = f"Updated category ID '{cid}' to '{cname}'."
        else:
            self.category_list.append(record)
            msg = f"Added category '{cname}' (ID: {cid})."

        self._rebuild_lookup()

        try:
            self.storage.add_category(cid, cname)
        except Exception as e:
            logger.error(f"Error persisting category to storage: {e}")

        try:
            with open(self.storage_file, "w", encoding="utf-8") as f:
                json.dump(self.category_list, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Error saving categories backup {self.storage_file}: {e}")

        return True, msg, record

    def delete_category(self, category_id: str) -> Tuple[bool, str]:
        """Deletes a category by its ID from the active taxonomy registry."""
        cid = str(category_id).strip()
        initial_len = len(self.category_list)
        self.category_list = [c for c in self.category_list if str(c.get("id")) != cid]

        if len(self.category_list) == initial_len:
            return False, f"Category ID '{cid}' not found."

        self._rebuild_lookup()

        try:
            self.storage.delete_category(cid)
        except Exception as e:
            logger.error(f"Error deleting category from storage: {e}")

        try:
            with open(self.storage_file, "w", encoding="utf-8") as f:
                json.dump(self.category_list, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Error saving categories backup {self.storage_file}: {e}")

        return True, f"Category ID '{cid}' deleted successfully."

    def load_from_csv_content(self, content_str: str) -> int:
        """Parses CSV string content and replaces the active category store completely."""
        lines = content_str.splitlines()
        reader = csv.reader(lines)
        rows = list(reader)
        if not rows:
            return 0

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
                id_idx = 1
                name_idx = 2
            elif len(rows[0]) >= 2:
                id_idx = 0
                name_idx = 1
            else:
                return 0
            if rows[0][id_idx].strip().isdigit():
                has_header = False

        start_row = 1 if has_header else 0
        new_categories = []
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
                        new_categories.append({"id": cid, "name": name})

        if new_categories:
            self.category_list = new_categories
            self._rebuild_lookup()
            self.save_to_storage()
            return len(self.category_list)
        return 0

    def load_from_excel_content(self, content_bytes: bytes) -> int:
        """Parses Excel (.xlsx/.xls) binary content and replaces active category store completely."""
        import io
        import openpyxl

        try:
            wb = openpyxl.load_workbook(io.BytesIO(content_bytes), data_only=True)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                return 0

            header = [str(h or "").strip().lower() for h in rows[0]]
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
                    id_idx = 1
                    name_idx = 2
                elif len(rows[0]) >= 2:
                    id_idx = 0
                    name_idx = 1
                else:
                    return 0
                val_str = str(rows[0][id_idx] or "").strip()
                if val_str.isdigit() or val_str.replace(".0", "").isdigit():
                    has_header = False

            start_row = 1 if has_header else 0
            new_categories = []
            seen_ids = set()

            for row in rows[start_row:]:
                if len(row) > max(id_idx, name_idx):
                    raw_id = row[id_idx]
                    raw_name = row[name_idx]
                    if raw_id is not None and raw_name is not None:
                        cid = str(raw_id).strip()
                        name = str(raw_name).strip()
                        if cid and name and cid.lower() not in ["none", "id", "category_id", "categoryid"]:
                            if cid.endswith(".0"):
                                cid = cid[:-2]
                            if cid not in seen_ids:
                                seen_ids.add(cid)
                                new_categories.append({"id": cid, "name": name})

            if new_categories:
                self.category_list = new_categories
                self._rebuild_lookup()
                self.save_to_storage()
                return len(self.category_list)
            return 0
        except Exception as e:
            logger.error(f"Error loading Excel categories: {e}")
            return 0

    def load_from_csv_file(self, filepath: Path) -> int:
        """Loads categories directly from a CSV file path."""
        try:
            with open(filepath, "r", encoding="utf-8-sig") as f:
                content = f.read()
            return self.load_from_csv_content(content)
        except Exception as e:
            logger.error(f"Error loading CSV from {filepath}: {e}")
            return 0

    def get_all(self) -> List[Dict[str, str]]:
        return self.category_list

    def find_match(self, query: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Finds the best matching Category ID and Name for a query or dish name.
        Uses exact match, substring match, and difflib fuzzy ratio.
        """
        if not query or not self.category_list:
            return None, None

        q_clean = query.strip().lower()

        # 1. Exact match
        if q_clean in self.categories:
            cid = self.categories[q_clean]
            for item in self.category_list:
                if item["id"] == cid:
                    return cid, item["name"]

        # 2. Check if any category name is contained within the dish name
        sorted_cats = sorted(self.category_list, key=lambda x: len(x["name"]), reverse=True)
        for cat in sorted_cats:
            cname = cat["name"].lower()
            if len(cname) >= 3 and cname in q_clean:
                return cat["id"], cat["name"]

        # 3. Check if query is contained inside category name
        for cat in sorted_cats:
            cname = cat["name"].lower()
            if len(q_clean) >= 3 and q_clean in cname:
                return cat["id"], cat["name"]

        # 4. Fuzzy match using difflib
        all_names = [c["name"] for c in self.category_list]
        matches = difflib.get_close_matches(query, all_names, n=1, cutoff=0.45)
        if matches:
            matched_name = matches[0]
            matched_id = self.categories.get(matched_name.lower())
            return matched_id, matched_name

        return None, None

    def get_taxonomy_prompt(self, max_items: int = 100) -> str:
        """Returns compact text taxonomy suitable for injecting into Gemini prompt."""
        if not self.category_list:
            return "No predefined categories. Suggest clean food category names."
        
        sample = self.category_list[:max_items]
        formatted = [f"ID {item['id']}: '{item['name']}'" for item in sample]
        return "\n".join(formatted)

category_service = CategoryService()
