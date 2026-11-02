from abc import ABC, abstractmethod
from typing import List, Dict, Optional, Tuple

class BaseStorage(ABC):
    """
    Abstract Base Class for Menu Automation Storage Engines.
    Supports Local (JSON/CSV), SQLite, and Supabase.
    """

    @abstractmethod
    def get_storage_type(self) -> str:
        """Returns the internal storage type: 'supabase', 'sqlite', or 'local'."""
        pass

    @abstractmethod
    def get_storage_label(self) -> str:
        """Returns a user-friendly label for UI badges: e.g. 'Supabase Cloud', 'SQLite DB', 'Local File'."""
        pass

    @abstractmethod
    def ping(self) -> Tuple[bool, str]:
        """Checks connectivity or file integrity. Returns (is_healthy, status_message)."""
        pass

    def get_status_info(self) -> Dict:
        """Returns health status, error details, and whether setup is required."""
        ok, msg = self.ping()
        needs_setup = (not ok) and any(x in msg.lower() for x in ["not found", "missing", "failed", "error"])
        return {
            "type": self.get_storage_type(),
            "label": self.get_storage_label(),
            "healthy": ok,
            "message": msg,
            "needs_setup": needs_setup
        }

    # ==========================================
    # API KEYS POOL METHODS
    # ==========================================
    @abstractmethod
    def get_api_keys(self) -> List[Dict]:
        """Returns the list of raw API key records."""
        pass

    @abstractmethod
    def save_api_keys(self, keys: List[Dict]) -> bool:
        """Persists the entire list of API keys."""
        pass

    @abstractmethod
    def add_api_key(self, record: Dict) -> bool:
        """Adds or updates a single API key record."""
        pass

    @abstractmethod
    def delete_api_key(self, key_id: str) -> bool:
        """Deletes a single API key record by ID."""
        pass

    @abstractmethod
    def update_api_key(self, key_id: str, updates: Dict) -> bool:
        """Updates specific fields of an existing API key record."""
        pass

    # ==========================================
    # CATEGORY TAXONOMY METHODS
    # ==========================================
    @abstractmethod
    def get_categories(self) -> List[Dict[str, str]]:
        """Returns the active list of categories: [{'id': '76', 'name': 'Biryani'}, ...]"""
        pass

    @abstractmethod
    def save_categories(self, categories: List[Dict[str, str]]) -> int:
        """Replaces or saves the active category taxonomy. Returns count of saved categories."""
        pass

    @abstractmethod
    def add_category(self, category_id: str, name: str) -> bool:
        """Adds or updates a single category in the database/storage."""
        pass

    @abstractmethod
    def delete_category(self, category_id: str) -> bool:
        """Deletes a single category by its ID."""
        pass

