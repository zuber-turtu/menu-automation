import logging
from typing import Optional
from app.config import settings
from app.services.storage.base import BaseStorage
from app.services.storage.local_storage import LocalStorage
from app.services.storage.sqlite_storage import SqliteStorage
from app.services.storage.supabase_storage import SupabaseStorage
from app.services.storage.sqlalchemy_storage import SQLAlchemyStorage

logger = logging.getLogger("menu_automation.storage")

_storage_instance: Optional[BaseStorage] = None

def init_storage() -> BaseStorage:
    """
    Factory function to initialize the requested storage backend from settings.STORAGE_TYPE:
    - 'supabase': Supabase Cloud PostgreSQL (via SQLAlchemy or REST API)
    - 'sqlite': Embedded SQLite via SQLAlchemy with dynamic table creation (data/app.db)
    - 'local': Local JSON & CSV files
    
    Strict Mode: Does NOT silently fallback to another database without user confirmation.
    """
    global _storage_instance

    requested_type = (settings.STORAGE_TYPE or "sqlite").strip().lower()
    selected_storage: Optional[BaseStorage] = None

    # 1. Supabase Cloud Storage
    if requested_type in ("supabase", "postgres"):
        db_url = settings.DATABASE_URL
        if db_url and ("postgres" in db_url.lower()):
            try:
                sqla = SQLAlchemyStorage(db_url, storage_type="supabase", storage_label="Supabase PostgreSQL")
                ok, msg = sqla.ping()
                if ok:
                    selected_storage = sqla
                    logger.info("Storage Engine: Supabase PostgreSQL connected via SQLAlchemy.")
                else:
                    logger.warning(f"Supabase PostgreSQL connection failed: {msg}")
            except Exception as e:
                logger.warning(f"Supabase PostgreSQL init failed: {e}")

        # If direct Postgres URL is not configured or failed, use Supabase REST
        if selected_storage is None:
            sb = SupabaseStorage()
            selected_storage = sb
            ok, msg = sb.ping()
            if ok:
                logger.info("Storage Engine: Supabase Cloud connected via REST API.")
            else:
                logger.warning(f"Storage Engine: Supabase Cloud selected, but setup is required: {msg}")

    # 2. SQLite Database (via SQLAlchemy with Dynamic Table Creation)
    elif requested_type == "sqlite":
        sqlite_url = f"sqlite:///{settings.DATA_DIR / 'app.db'}"
        try:
            sqla_sqlite = SQLAlchemyStorage(sqlite_url, storage_type="sqlite", storage_label="SQLite DB")
            selected_storage = sqla_sqlite
            logger.info("Storage Engine: SQLite Database active via SQLAlchemy.")
        except Exception as e:
            logger.error(f"SQLite initialization failed: {e}")
            selected_storage = LocalStorage()

    # 3. Local Files (JSON / CSV)
    else:
        selected_storage = LocalStorage()
        logger.info("Storage Engine: Local File Storage active (JSON / CSV).")

    # Perform auto-seeding if the selected storage is ready and empty
    _auto_seed_storage(selected_storage)

    _storage_instance = selected_storage
    return _storage_instance

def _auto_seed_storage(storage: BaseStorage):
    """
    Checks if active database is empty and accessible.
    If so, automatically migrates categories and API keys from local files.
    """
    if storage.get_storage_type() == "local":
        return

    # Check connectivity first (do not attempt to seed if tables are not created yet)
    ok, _ = storage.ping()
    if not ok:
        return

    try:
        local_store = LocalStorage()

        # Seed categories if database is empty
        active_cats = storage.get_categories()
        if not active_cats:
            local_cats = local_store.get_categories()
            if local_cats:
                logger.info(f"Auto-seeding {len(local_cats)} categories into {storage.get_storage_label()}...")
                storage.save_categories(local_cats)

        # Seed API keys if database is empty
        active_keys = storage.get_api_keys()
        if not active_keys:
            local_keys = local_store.get_api_keys()
            if local_keys:
                logger.info(f"Auto-seeding {len(local_keys)} API keys into {storage.get_storage_label()}...")
                storage.save_api_keys(local_keys)
    except Exception as e:
        logger.error(f"Error during auto-seeding: {e}")

def set_active_storage(storage_type: str) -> BaseStorage:
    """Explicitly switch active storage engine upon user confirmation from dashboard."""
    global _storage_instance
    settings.STORAGE_TYPE = storage_type.strip().lower()
    _storage_instance = None
    return init_storage()

def get_storage() -> BaseStorage:
    """Returns the initialized storage engine singleton."""
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = init_storage()
    return _storage_instance

__all__ = [
    "get_storage", 
    "init_storage", 
    "set_active_storage",
    "BaseStorage", 
    "LocalStorage", 
    "SqliteStorage", 
    "SupabaseStorage", 
    "SQLAlchemyStorage"
]
