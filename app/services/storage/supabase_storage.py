import httpx
import logging
import time
from typing import List, Dict, Optional, Tuple
from app.services.storage.base import BaseStorage
from app.config import settings

logger = logging.getLogger("menu_automation.storage.supabase")

class SupabaseStorage(BaseStorage):
    """
    Supabase Cloud PostgreSQL storage engine via PostgREST.
    Zero local state, persists permanently across container rebuilds/reboots.
    """

    def __init__(self, supabase_url: Optional[str] = None, supabase_key: Optional[str] = None):
        self.url = (supabase_url or settings.SUPABASE_URL or "").rstrip("/")
        self.key = supabase_key or settings.SUPABASE_KEY or ""
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        self.timeout = 8.0

    def get_storage_type(self) -> str:
        return "supabase"

    def get_storage_label(self) -> str:
        return "Supabase Cloud"

    def is_configured(self) -> bool:
        return bool(self.url and self.key and "http" in self.url)

    def ping(self) -> Tuple[bool, str]:
        if not self.is_configured():
            return False, "Supabase credentials missing in .env (SUPABASE_URL / SUPABASE_KEY)"

        test_url = f"{self.url}/rest/v1/api_keys?select=id&limit=1"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(test_url, headers=self.headers)
                if resp.status_code in (200, 206):
                    return True, "Supabase connected & ready"
                elif resp.status_code in (401, 403):
                    return False, f"Supabase auth failed: {resp.status_code} (Check SUPABASE_KEY)"
                elif resp.status_code == 404:
                    return False, "Supabase table 'api_keys' not found (run table creation SQL)"
                else:
                    return False, f"Supabase error: HTTP {resp.status_code}"
        except httpx.ConnectError:
            return False, "Failed to connect to Supabase (Host unreachable or no internet)"
        except Exception as e:
            return False, f"Supabase ping error: {e}"

    # ==========================================
    # API KEYS POOL
    # ==========================================
    def get_api_keys(self) -> List[Dict]:
        if not self.is_configured():
            return []
        url = f"{self.url}/rest/v1/api_keys?select=*&order=created_at.asc"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(url, headers=self.headers)
                if resp.status_code == 200:
                    return resp.json()
                logger.error(f"Supabase get_api_keys failed: HTTP {resp.status_code} - {resp.text}")
                return []
        except Exception as e:
            logger.error(f"Error fetching API keys from Supabase: {e}")
            return []

    def save_api_keys(self, keys: List[Dict]) -> bool:
        if not self.is_configured():
            return False
        # Clear & re-insert or upsert
        try:
            with httpx.Client(timeout=self.timeout) as client:
                # Delete all existing keys
                client.delete(f"{self.url}/rest/v1/api_keys?id=neq.empty", headers=self.headers)
                if not keys:
                    return True
                
                payload = []
                for k in keys:
                    payload.append({
                        "id": k.get("id"),
                        "label": k.get("label", "API Key"),
                        "key": k.get("key", ""),
                        "masked_key": k.get("masked_key", ""),
                        "status": k.get("status", "active"),
                        "latency_ms": k.get("latency_ms"),
                        "last_checked_at": k.get("last_checked_at"),
                        "created_at": k.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S")
                    })

                resp = client.post(f"{self.url}/rest/v1/api_keys", headers=self.headers, json=payload)
                return resp.status_code in (200, 201)
        except Exception as e:
            logger.error(f"Error saving API keys to Supabase: {e}")
            return False

    def add_api_key(self, record: Dict) -> bool:
        if not self.is_configured():
            return False
        url = f"{self.url}/rest/v1/api_keys"
        upsert_headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"}
        payload = {
            "id": record.get("id"),
            "label": record.get("label", "API Key"),
            "key": record.get("key", ""),
            "masked_key": record.get("masked_key", ""),
            "status": record.get("status", "active"),
            "latency_ms": record.get("latency_ms"),
            "last_checked_at": record.get("last_checked_at"),
            "created_at": record.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S")
        }
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, headers=upsert_headers, json=payload)
                return resp.status_code in (200, 201)
        except Exception as e:
            logger.error(f"Error adding API key to Supabase: {e}")
            return False

    def delete_api_key(self, key_id: str) -> bool:
        if not self.is_configured():
            return False
        url = f"{self.url}/rest/v1/api_keys?id=eq.{key_id}"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.delete(url, headers=self.headers)
                return resp.status_code in (200, 204)
        except Exception as e:
            logger.error(f"Error deleting API key {key_id} from Supabase: {e}")
            return False

    def update_api_key(self, key_id: str, updates: Dict) -> bool:
        if not self.is_configured() or not updates:
            return False
        url = f"{self.url}/rest/v1/api_keys?id=eq.{key_id}"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.patch(url, headers=self.headers, json=updates)
                return resp.status_code in (200, 204)
        except Exception as e:
            logger.error(f"Error updating API key {key_id} in Supabase: {e}")
            return False

    # ==========================================
    # CATEGORY TAXONOMY
    # ==========================================
    def get_categories(self) -> List[Dict[str, str]]:
        if not self.is_configured():
            return []
        url = f"{self.url}/rest/v1/categories?select=id,name&order=name.asc"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(url, headers=self.headers)
                if resp.status_code == 200:
                    rows = resp.json()
                    return [{"id": str(r.get("id", "")), "name": str(r.get("name", ""))} for r in rows if r.get("id") and r.get("name")]
                return []
        except Exception as e:
            logger.error(f"Error fetching categories from Supabase: {e}")
            return []

    def save_categories(self, categories: List[Dict[str, str]]) -> int:
        if not self.is_configured() or not categories:
            return 0
        try:
            with httpx.Client(timeout=15.0) as client:
                # Clear existing categories
                client.delete(f"{self.url}/rest/v1/categories?id=neq.empty", headers=self.headers)
                
                # Batch post in chunks of 500
                chunk_size = 500
                total_inserted = 0
                now_str = time.strftime("%Y-%m-%d %H:%M:%S")

                for i in range(0, len(categories), chunk_size):
                    chunk = categories[i:i + chunk_size]
                    payload = [
                        {
                            "id": str(c.get("id", "")).strip(),
                            "name": str(c.get("name", "")).strip(),
                            "created_at": now_str
                        }
                        for c in chunk if c.get("id") and c.get("name")
                    ]
                    resp = client.post(
                        f"{self.url}/rest/v1/categories",
                        headers=self.headers,
                        json=payload
                    )
                    if resp.status_code in (200, 201):
                        total_inserted += len(payload)
                    else:
                        logger.warning(f"Failed to insert category chunk {i}: HTTP {resp.status_code}")

                logger.info(f"Successfully saved {total_inserted} categories to Supabase.")
                return total_inserted
        except Exception as e:
            logger.error(f"Error saving categories to Supabase: {e}")
            return 0

    def add_category(self, category_id: str, name: str) -> bool:
        if not self.is_configured():
            return False
        cid = str(category_id).strip()
        cname = str(name).strip()
        if not cid or not cname:
            return False
        url = f"{self.url}/rest/v1/categories"
        upsert_headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"}
        payload = {
            "id": cid,
            "name": cname,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
        }
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, headers=upsert_headers, json=payload)
                return resp.status_code in (200, 201)
        except Exception as e:
            logger.error(f"Error adding category {cid} to Supabase: {e}")
            return False

    def delete_category(self, category_id: str) -> bool:
        if not self.is_configured():
            return False
        cid = str(category_id).strip()
        url = f"{self.url}/rest/v1/categories?id=eq.{cid}"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.delete(url, headers=self.headers)
                return resp.status_code in (200, 204)
        except Exception as e:
            logger.error(f"Error deleting category {cid} from Supabase: {e}")
            return False

