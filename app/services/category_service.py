import csv
import json
import difflib
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from app.config import settings

class CategoryService:
    def __init__(self):
        self.categories: Dict[str, str] = {}  # Normalized name -> Category ID
        self.category_list: List[Dict[str, str]] = []  # [{"id": "...", "name": "..."}, ...]
        self.storage_file = settings.REFERENCE_DIR / "categories.json"
        self._initialize_categories()

    def _initialize_categories(self):
        """Loads categories from stored JSON if present, or automatically imports from categories_turtu.csv."""
        if self.storage_file.exists():
            try:
                with open(self.storage_file, "r", encoding="utf-8") as f:
                    self.category_list = json.load(f)
                    self._rebuild_lookup()
                if self.category_list:
                    return
            except Exception as e:
                print(f"Error reading {self.storage_file}: {e}")

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
        """Persists active categories to JSON file."""
        try:
            with open(self.storage_file, "w", encoding="utf-8") as f:
                json.dump(self.category_list, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Failed to save categories: {e}")

    def load_from_csv_content(self, content_str: str) -> int:
        """Parses CSV string content and updates category store."""
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

        if id_idx == -1 or name_idx == -1:
            # Fallback by column position: Turtu CSV usually has sl, id, name
            if len(rows[0]) >= 3:
                id_idx = 1
                name_idx = 2
            else:
                return 0

        new_categories = []
        for row in rows[1:]:
            if len(row) > max(id_idx, name_idx):
                cid = str(row[id_idx]).strip()
                name = str(row[name_idx]).strip()
                if cid and name:
                    new_categories.append({"id": cid, "name": name})

        if new_categories:
            self.category_list = new_categories
            self._rebuild_lookup()
            self.save_to_storage()
            return len(self.category_list)
        return 0

    def load_from_csv_file(self, filepath: Path) -> int:
        """Loads categories directly from a CSV file path."""
        try:
            with open(filepath, "r", encoding="utf-8-sig") as f:
                content = f.read()
            return self.load_from_csv_content(content)
        except Exception as e:
            print(f"Error loading CSV from {filepath}: {e}")
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
        # Sorted by length descending so longer category matches take priority
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
