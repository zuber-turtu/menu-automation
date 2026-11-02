import sqlite3
import logging
import time
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from contextlib import contextmanager
from app.services.storage.base import BaseStorage
from app.config import settings

logger = logging.getLogger("menu_automation.storage.sqlite")

class SqliteStorage(BaseStorage):
    """
    SQLite embedded database storage engine.
    Stores data in data/app.db.
    Zero configuration, ACID-compliant, concurrent WAL journal mode.
    """

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or (settings.DATA_DIR / "app.db")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_database()

    @contextmanager
    def _get_connection(self):
        """Context manager providing thread-safe SQLite connection with WAL mode."""
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA busy_timeout=5000;")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_database(self):
        """Initializes tables and indexes if they do not exist."""
        try:
            with self._get_connection() as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS api_keys (
                        id TEXT PRIMARY KEY,
                        label TEXT NOT NULL,
                        key TEXT NOT NULL,
                        masked_key TEXT NOT NULL,
                        status TEXT DEFAULT 'active',
                        latency_ms INTEGER,
                        last_checked_at TEXT,
                        created_at TEXT
                    );
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS categories (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at TEXT
                    );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_cat_name ON categories (name);")
            logger.info(f"SQLite database initialized at {self.db_path}")
        except Exception as e:
            logger.error(f"Error initializing SQLite DB at {self.db_path}: {e}")

    def get_storage_type(self) -> str:
        return "sqlite"

    def get_storage_label(self) -> str:
        return "SQLite DB"

    def ping(self) -> Tuple[bool, str]:
        try:
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("SELECT 1;")
                cur.fetchone()
            return True, f"SQLite operational ({self.db_path.name})"
        except Exception as e:
            return False, f"SQLite ping failed: {e}"

    # ==========================================
    # API KEYS POOL
    # ==========================================
    def get_api_keys(self) -> List[Dict]:
        try:
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("SELECT id, label, key, masked_key, status, latency_ms, last_checked_at, created_at FROM api_keys ORDER BY created_at ASC;")
                rows = cur.fetchall()
                return [dict(row) for row in rows]
        except Exception as e:
            logger.error(f"Error fetching API keys from SQLite: {e}")
            return []

    def save_api_keys(self, keys: List[Dict]) -> bool:
        try:
            with self._get_connection() as conn:
                conn.execute("DELETE FROM api_keys;")
                for k in keys:
                    conn.execute("""
                        INSERT INTO api_keys (id, label, key, masked_key, status, latency_ms, last_checked_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                    """, (
                        k.get("id"),
                        k.get("label", "API Key"),
                        k.get("key", ""),
                        k.get("masked_key", ""),
                        k.get("status", "active"),
                        k.get("latency_ms"),
                        k.get("last_checked_at"),
                        k.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S")
                    ))
            return True
        except Exception as e:
            logger.error(f"Error saving API keys in SQLite: {e}")
            return False

    def add_api_key(self, record: Dict) -> bool:
        try:
            with self._get_connection() as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO api_keys (id, label, key, masked_key, status, latency_ms, last_checked_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    record.get("id"),
                    record.get("label", "API Key"),
                    record.get("key", ""),
                    record.get("masked_key", ""),
                    record.get("status", "active"),
                    record.get("latency_ms"),
                    record.get("last_checked_at"),
                    record.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S")
                ))
            return True
        except Exception as e:
            logger.error(f"Error inserting API key into SQLite: {e}")
            return False

    def delete_api_key(self, key_id: str) -> bool:
        try:
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("DELETE FROM api_keys WHERE id = ?;", (key_id,))
                return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error deleting API key {key_id} from SQLite: {e}")
            return False

    def update_api_key(self, key_id: str, updates: Dict) -> bool:
        if not updates:
            return True
        try:
            set_clauses = []
            values = []
            for col, val in updates.items():
                if col in ["label", "status", "latency_ms", "last_checked_at", "masked_key", "key"]:
                    set_clauses.append(f"{col} = ?")
                    values.append(val)
            if not set_clauses:
                return True
            values.append(key_id)
            query = f"UPDATE api_keys SET {', '.join(set_clauses)} WHERE id = ?;"
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute(query, tuple(values))
                return cur.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating API key {key_id} in SQLite: {e}")
            return False

    # ==========================================
    # CATEGORY TAXONOMY
    # ==========================================
    def get_categories(self) -> List[Dict[str, str]]:
        try:
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("SELECT id, name FROM categories ORDER BY name ASC;")
                rows = cur.fetchall()
                return [{"id": str(r["id"]), "name": str(r["name"])} for r in rows]
        except Exception as e:
            logger.error(f"Error fetching categories from SQLite: {e}")
            return []

    def save_categories(self, categories: List[Dict[str, str]]) -> int:
        if not categories:
            return 0
        try:
            now_str = time.strftime("%Y-%m-%d %H:%M:%S")
            with self._get_connection() as conn:
                conn.execute("DELETE FROM categories;")
                data = [(str(c.get("id", "")).strip(), str(c.get("name", "")).strip(), now_str) for c in categories if c.get("id") and c.get("name")]
                conn.executemany("INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?);", data)
            logger.info(f"Saved {len(categories)} categories to SQLite database.")
            return len(categories)
        except Exception as e:
            logger.error(f"Error saving categories to SQLite: {e}")
            return 0

