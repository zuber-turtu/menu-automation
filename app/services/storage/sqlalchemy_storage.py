import time
import logging
from typing import List, Dict, Optional, Tuple
from contextlib import contextmanager

from sqlalchemy import create_engine, text, event
from sqlalchemy.orm import sessionmaker, Session

from app.services.storage.base import BaseStorage
from app.services.storage.models import Base, ApiKeyModel, CategoryModel
from app.config import settings

logger = logging.getLogger("menu_automation.storage.sqlalchemy")

class SQLAlchemyStorage(BaseStorage):
    """
    Universal SQLAlchemy storage engine supporting SQLite and PostgreSQL/Supabase.
    Dynamically creates all required tables and indexes on server initialization if not yet present.
    """

    def __init__(self, db_url: str, storage_type: str = "sqlite", storage_label: Optional[str] = None):
        self.raw_url = db_url
        self.storage_type = storage_type
        self.storage_label = storage_label or ("SQLite DB" if storage_type == "sqlite" else "Supabase DB")
        
        # Normalize postgresql scheme for SQLAlchemy 2.0+ (Render & Supabase often use postgres://)
        normalized_url = db_url.strip()
        if normalized_url.startswith("postgres://"):
            normalized_url = normalized_url.replace("postgres://", "postgresql://", 1)

        self.db_url = normalized_url

        # Configure connection engine
        connect_args = {}
        if "sqlite" in self.db_url:
            connect_args["check_same_thread"] = False
            self.engine = create_engine(
                self.db_url,
                connect_args=connect_args,
                pool_pre_ping=True
            )
            # Enable high-concurrency WAL mode for SQLite
            @event.listens_for(self.engine, "connect")
            def set_sqlite_pragma(dbapi_connection, connection_record):
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA journal_mode=WAL;")
                cursor.execute("PRAGMA synchronous=NORMAL;")
                cursor.execute("PRAGMA busy_timeout=5000;")
                cursor.close()
        else:
            # PostgreSQL / Supabase direct connection
            try:
                self.engine = create_engine(
                    self.db_url,
                    pool_pre_ping=True,
                    pool_size=10,
                    max_overflow=20
                )
            except Exception as e:
                # Driver fallback: if psycopg fails, fallback to psycopg2 or vice versa
                if "psycopg" in str(e).lower():
                    if "postgresql+psycopg2://" in self.db_url:
                        alt_url = self.db_url.replace("postgresql+psycopg2://", "postgresql://", 1)
                    else:
                        alt_url = self.db_url.replace("postgresql://", "postgresql+psycopg2://", 1)
                    logger.info(f"Retrying PostgreSQL connection with alternative driver URL: {alt_url[:25]}...")
                    self.engine = create_engine(
                        alt_url,
                        pool_pre_ping=True,
                        pool_size=10,
                        max_overflow=20
                    )
                else:
                    raise

        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)

        # DYNAMIC TABLE CREATION ON SERVER INITIALIZATION
        self._create_tables_dynamically()

    def _create_tables_dynamically(self):
        """
        Dynamically inspects and creates tables ('api_keys', 'categories')
        and indexes if they do not yet exist in the database.
        """
        try:
            Base.metadata.create_all(bind=self.engine)
            logger.info(f"SQLAlchemy: Verified/Created database tables dynamically for {self.storage_label}.")
        except Exception as e:
            logger.error(f"SQLAlchemy table creation failed on {self.storage_label}: {e}")

    @contextmanager
    def _get_session(self) -> Session:
        """Context manager for thread-safe scoped database sessions."""
        session = self.SessionLocal()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def get_storage_type(self) -> str:
        return self.storage_type

    def get_storage_label(self) -> str:
        return self.storage_label

    def ping(self) -> Tuple[bool, str]:
        """Checks connectivity to database by executing lightweight SELECT 1."""
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1;"))
            return True, f"{self.storage_label} connected & operational"
        except Exception as e:
            return False, f"{self.storage_label} connection failed: {e}"

    # ==========================================
    # API KEYS POOL
    # ==========================================
    def get_api_keys(self) -> List[Dict]:
        try:
            with self._get_session() as session:
                records = session.query(ApiKeyModel).order_by(ApiKeyModel.created_at.asc()).all()
                return [r.to_dict() for r in records]
        except Exception as e:
            logger.error(f"Error fetching API keys via SQLAlchemy: {e}")
            return []

    def save_api_keys(self, keys: List[Dict]) -> bool:
        try:
            now_str = time.strftime("%Y-%m-%d %H:%M:%S")
            with self._get_session() as session:
                session.query(ApiKeyModel).delete()
                for k in keys:
                    new_item = ApiKeyModel(
                        id=k.get("id"),
                        label=k.get("label", "API Key"),
                        key=k.get("key", ""),
                        masked_key=k.get("masked_key", ""),
                        status=k.get("status", "active"),
                        latency_ms=k.get("latency_ms"),
                        last_checked_at=k.get("last_checked_at"),
                        created_at=k.get("created_at") or now_str
                    )
                    session.add(new_item)
            return True
        except Exception as e:
            logger.error(f"Error saving API keys via SQLAlchemy: {e}")
            return False

    def add_api_key(self, record: Dict) -> bool:
        try:
            now_str = time.strftime("%Y-%m-%d %H:%M:%S")
            with self._get_session() as session:
                existing = session.query(ApiKeyModel).filter(ApiKeyModel.id == record.get("id")).first()
                if existing:
                    existing.label = record.get("label", existing.label)
                    existing.key = record.get("key", existing.key)
                    existing.masked_key = record.get("masked_key", existing.masked_key)
                    existing.status = record.get("status", existing.status)
                    existing.latency_ms = record.get("latency_ms", existing.latency_ms)
                    existing.last_checked_at = record.get("last_checked_at", existing.last_checked_at)
                else:
                    new_item = ApiKeyModel(
                        id=record.get("id"),
                        label=record.get("label", "API Key"),
                        key=record.get("key", ""),
                        masked_key=record.get("masked_key", ""),
                        status=record.get("status", "active"),
                        latency_ms=record.get("latency_ms"),
                        last_checked_at=record.get("last_checked_at"),
                        created_at=record.get("created_at") or now_str
                    )
                    session.add(new_item)
            return True
        except Exception as e:
            logger.error(f"Error adding API key via SQLAlchemy: {e}")
            return False

    def delete_api_key(self, key_id: str) -> bool:
        try:
            with self._get_session() as session:
                deleted_count = session.query(ApiKeyModel).filter(ApiKeyModel.id == key_id).delete()
                return deleted_count > 0
        except Exception as e:
            logger.error(f"Error deleting API key {key_id} via SQLAlchemy: {e}")
            return False

    def update_api_key(self, key_id: str, updates: Dict) -> bool:
        if not updates:
            return True
        try:
            with self._get_session() as session:
                target = session.query(ApiKeyModel).filter(ApiKeyModel.id == key_id).first()
                if not target:
                    return False
                for field, val in updates.items():
                    if hasattr(target, field):
                        setattr(target, field, val)
                return True
        except Exception as e:
            logger.error(f"Error updating API key {key_id} via SQLAlchemy: {e}")
            return False

    # ==========================================
    # CATEGORY TAXONOMY
    # ==========================================
    def get_categories(self) -> List[Dict[str, str]]:
        try:
            with self._get_session() as session:
                rows = session.query(CategoryModel).order_by(CategoryModel.name.asc()).all()
                return [{"id": str(r.id), "name": str(r.name)} for r in rows]
        except Exception as e:
            logger.error(f"Error fetching categories via SQLAlchemy: {e}")
            return []

    def save_categories(self, categories: List[Dict[str, str]]) -> int:
        if not categories:
            return 0
        try:
            now_str = time.strftime("%Y-%m-%d %H:%M:%S")
            with self._get_session() as session:
                session.query(CategoryModel).delete()
                
                # Bulk insert Category objects
                batch = [
                    CategoryModel(
                        id=str(c.get("id", "")).strip(),
                        name=str(c.get("name", "")).strip(),
                        created_at=now_str
                    )
                    for c in categories if c.get("id") and c.get("name")
                ]
                session.bulk_save_objects(batch)
            logger.info(f"SQLAlchemy: Saved {len(batch)} categories dynamically to {self.storage_label}.")
            return len(batch)
        except Exception as e:
            logger.error(f"Error saving categories via SQLAlchemy: {e}")
            return 0

    def add_category(self, category_id: str, name: str) -> bool:
        cid = str(category_id).strip()
        cname = str(name).strip()
        if not cid or not cname:
            return False
        try:
            now_str = time.strftime("%Y-%m-%d %H:%M:%S")
            with self._get_session() as session:
                existing = session.query(CategoryModel).filter(CategoryModel.id == cid).first()
                if existing:
                    existing.name = cname
                else:
                    new_cat = CategoryModel(id=cid, name=cname, created_at=now_str)
                    session.add(new_cat)
            return True
        except Exception as e:
            logger.error(f"Error adding category {cid} via SQLAlchemy: {e}")
            return False

    def delete_category(self, category_id: str) -> bool:
        cid = str(category_id).strip()
        try:
            with self._get_session() as session:
                deleted_count = session.query(CategoryModel).filter(CategoryModel.id == cid).delete()
                return deleted_count > 0
        except Exception as e:
            logger.error(f"Error deleting category {cid} via SQLAlchemy: {e}")
            return False

