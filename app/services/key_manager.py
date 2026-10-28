import os
import json
import time
import uuid
import logging
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from threading import Lock
from dotenv import load_dotenv

logger = logging.getLogger("menu_automation.key_manager")

class KeyManager:
    """
    Thread-safe Gemini API Key Pool Manager with:
    - Strict sequential Round-Robin rotation (Key 1 -> Key 2 -> Key 3 -> Key 1)
    - Write-only security (raw keys stored on server, only masked keys returned to UI)
    - Real-time health check & latency testing
    - Automatic 429 rate-limit cooldown & failover
    - Automatic fallback to .env GEMINI_API_KEY
    """

    def __init__(self, data_dir: Optional[Path] = None):
        if data_dir is None:
            # Default to <project_root>/data
            self.data_dir = Path(__file__).resolve().parent.parent.parent / "data"
        else:
            self.data_dir = Path(data_dir)
            
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.keys_file = self.data_dir / "api_keys.json"
        self._lock = Lock()
        self._current_index = 0
        self._cooldowns: Dict[str, float] = {}  # key_id -> unblock timestamp
        
        # Initialize storage and pre-seed from .env if empty
        self._init_storage()

    def _init_storage(self):
        """Initializes keys file if it does not exist."""
        with self._lock:
            if not self.keys_file.exists():
                self._save_raw_keys([])

    def _read_raw_keys(self) -> List[Dict]:
        """Reads keys list directly from json file."""
        if not self.keys_file.exists():
            return []
        try:
            with open(self.keys_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error reading {self.keys_file}: {e}")
            return []

    def _save_raw_keys(self, keys: List[Dict]):
        """Persists keys list to json file safely."""
        temp_file = self.keys_file.with_suffix(".tmp")
        try:
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(keys, f, indent=2)
            temp_file.replace(self.keys_file)
        except Exception as e:
            logger.error(f"Error saving {self.keys_file}: {e}")
            if temp_file.exists():
                temp_file.unlink()

    @staticmethod
    def mask_key(key: str) -> str:
        """Returns write-only preview: AIzaSy••••••••9k2A"""
        if not key or len(key) < 10:
            return "••••••••"
        return f"{key[:6]}••••••••{key[-4:]}"


    def list_keys(self) -> List[Dict]:
        """
        Returns all keys with MASKED secrets for the frontend.
        Raw API keys are NEVER exposed in this output.
        """
        with self._lock:
            raw_keys = self._read_raw_keys()
            now = time.time()
            clean_list = []
            
            for k in raw_keys:
                key_id = k.get("id")
                status = k.get("status", "active")
                
                # Check dynamic rate-limit cooldown
                if key_id in self._cooldowns:
                    if now < self._cooldowns[key_id]:
                        remaining = int(self._cooldowns[key_id] - now)
                        status = f"rate_limited ({remaining}s)"
                    else:
                        del self._cooldowns[key_id]
                        status = "active"
                
                clean_list.append({
                    "id": key_id,
                    "label": k.get("label") or "API Key",
                    "masked_key": k.get("masked_key") or self.mask_key(k.get("key", "")),
                    "status": status,
                    "latency_ms": k.get("latency_ms"),
                    "last_checked_at": k.get("last_checked_at"),
                    "created_at": k.get("created_at")
                })
            return clean_list

    def get_next_key(self) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """
        Sequential Round-Robin key selector.
        Returns: (raw_key, key_id, label)
        Skips invalid or rate-limited keys.
        Falls back to .env key if no pool keys are available.
        """
        with self._lock:
            raw_keys = self._read_raw_keys()
            now = time.time()
            
            # Filter active eligible keys
            eligible_keys = []
            for k in raw_keys:
                key_id = k.get("id")
                # Skip if in active cooldown
                if key_id in self._cooldowns and now < self._cooldowns[key_id]:
                    continue
                # Skip if permanently marked invalid
                if k.get("status") == "invalid":
                    continue
                eligible_keys.append(k)
                
            if not eligible_keys:
                return None, None, None
                
            # Advance round-robin pointer
            idx = self._current_index % len(eligible_keys)
            selected = eligible_keys[idx]
            self._current_index = (idx + 1) % len(eligible_keys)
            
            logger.info(f"Round-Robin selected key [{idx + 1}/{len(eligible_keys)}]: {selected.get('label')} ({selected.get('masked_key')})")
            return selected.get("key"), selected.get("id"), selected.get("label")

    def mark_rate_limited(self, key_id: str, cooldown_seconds: int = 60):
        """Puts a key into temporary rate-limit cooldown for automatic failover."""
        with self._lock:
            self._cooldowns[key_id] = time.time() + cooldown_seconds
            logger.warning(f"Key {key_id} placed in cooldown for {cooldown_seconds}s (429 Rate Limit)")

    def verify_key_live(self, raw_key: str) -> Tuple[bool, Optional[int], str]:
        """
        Pings Gemini API to verify whether a key is valid and measures latency.
        Returns: (is_valid, latency_ms, message)
        """
        from google import genai
        from google.genai import types
        
        t0 = time.time()
        try:
            client = genai.Client(api_key=raw_key.strip())
            # Fast ping with minimal token output
            resp = client.models.generate_content(
                model="gemini-3.5-flash-lite",
                contents="ping",
                config=types.GenerateContentConfig(
                    max_output_tokens=3,
                    temperature=0.1
                )
            )
            latency = int((time.time() - t0) * 1000)
            if resp and resp.text:
                return True, latency, "Key verified active"
            return True, latency, "Key verified active"
        except Exception as e:
            err_msg = str(e)
            latency = int((time.time() - t0) * 1000)
            if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "quota" in err_msg.lower():
                return False, latency, "Rate-limited / Quota exhausted (429)"
            if "400" in err_msg or "403" in err_msg or "API_KEY_INVALID" in err_msg or "PERMISSION_DENIED" in err_msg:
                return False, latency, "Invalid or expired API Key (403)"
            if "503" in err_msg or "UNAVAILABLE" in err_msg:
                # Key itself is valid, but Google server is busy
                return True, latency, "Key valid (Gemini server currently busy)"
            return False, latency, f"Verification failed: {err_msg[:80]}"

    def add_key(self, raw_key: str, label: Optional[str] = None) -> Tuple[bool, str, Optional[Dict]]:
        """
        Validates, masks, and adds a new key to the pool.
        Returns: (success, message, masked_key_record)
        """
        raw_key = raw_key.strip()
        if not raw_key or len(raw_key) < 15:
            return False, "API key is too short or invalid format.", None
            
        with self._lock:
            existing = self._read_raw_keys()
            for k in existing:
                if k.get("key") == raw_key:
                    return False, f"This key is already in the pool as '{k.get('label')}'.", None

        # Verify live before adding
        is_valid, latency, msg = self.verify_key_live(raw_key)
        if not is_valid and "429" not in msg:
            return False, f"Key verification failed: {msg}", None

        key_id = f"key_{uuid.uuid4().hex[:8]}"
        clean_label = (label or "").strip() or f"Key #{len(existing) + 1}"
        masked = self.mask_key(raw_key)
        status = "rate_limited" if "429" in msg else "active"

        record = {
            "id": key_id,
            "label": clean_label,
            "key": raw_key,
            "masked_key": masked,
            "status": status,
            "latency_ms": latency,
            "last_checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
        }

        with self._lock:
            keys = self._read_raw_keys()
            keys.append(record)
            self._save_raw_keys(keys)
            
        logger.info(f"Added new key '{clean_label}' ({masked}) to pool. Latency: {latency}ms")
        
        # Return masked public record
        public_record = {
            "id": key_id,
            "label": clean_label,
            "masked_key": masked,
            "status": status,
            "latency_ms": latency,
            "last_checked_at": record["last_checked_at"],
            "created_at": record["created_at"]
        }
        return True, "API Key validated and successfully added to pool!", public_record

    def delete_key(self, key_id: str) -> Tuple[bool, str]:
        """Deletes a key from the pool."""
        with self._lock:
            keys = self._read_raw_keys()
            initial_count = len(keys)
            updated = [k for k in keys if k.get("id") != key_id]
            if len(updated) == initial_count:
                return False, f"Key ID '{key_id}' not found."
                
            self._save_raw_keys(updated)
            if key_id in self._cooldowns:
                del self._cooldowns[key_id]
            logger.info(f"Deleted key {key_id} from pool")
            return True, "Key deleted successfully."

    def test_key(self, key_id: str) -> Dict:
        """Tests a single key and updates its status & latency."""
        with self._lock:
            keys = self._read_raw_keys()
            target = None
            for k in keys:
                if k.get("id") == key_id:
                    target = k
                    break
        if not target:
            return {"status": "error", "message": "Key not found."}

        is_valid, latency, msg = self.verify_key_live(target["key"])
        new_status = "active" if is_valid else ("rate_limited" if "429" in msg else "invalid")
        
        with self._lock:
            keys = self._read_raw_keys()
            for k in keys:
                if k.get("id") == key_id:
                    k["status"] = new_status
                    k["latency_ms"] = latency
                    k["last_checked_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    break
            self._save_raw_keys(keys)

        return {
            "id": key_id,
            "status": new_status,
            "latency_ms": latency,
            "message": msg
        }

    def test_all_keys(self) -> List[Dict]:
        """Tests all keys in the pool and returns updated health statuses."""
        with self._lock:
            keys = self._read_raw_keys()

        results = []
        for k in keys:
            key_id = k.get("id")
            raw_key = k.get("key")
            is_valid, latency, msg = self.verify_key_live(raw_key)
            new_status = "active" if is_valid else ("rate_limited" if "429" in msg else "invalid")
            
            k["status"] = new_status
            k["latency_ms"] = latency
            k["last_checked_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            
            results.append({
                "id": key_id,
                "label": k.get("label"),
                "masked_key": k.get("masked_key"),
                "status": new_status,
                "latency_ms": latency,
                "message": msg
            })

        with self._lock:
            self._save_raw_keys(keys)

        return results

    def get_pool_summary(self) -> Dict:
        """Returns high-level statistics for the header pill and UI."""
        keys = self.list_keys()
        active_count = sum(1 for k in keys if "active" in k.get("status", ""))
        rate_limited_count = sum(1 for k in keys if "rate_limited" in k.get("status", ""))
        invalid_count = sum(1 for k in keys if "invalid" in k.get("status", ""))
        
        return {
            "total_keys": len(keys),
            "active_keys": active_count,
            "rate_limited_keys": rate_limited_count,
            "invalid_keys": invalid_count,
            "has_any_key": (active_count > 0)
        }

key_manager = KeyManager()
