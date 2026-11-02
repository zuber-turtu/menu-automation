from sqlalchemy import Column, String, Integer, Text, Index
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class ApiKeyModel(Base):
    """
    SQLAlchemy model for Gemini API Key Pool.
    Dynamically created on server startup if not yet present in database.
    """
    __tablename__ = "api_keys"

    id = Column(String(64), primary_key=True)
    label = Column(String(128), nullable=False, default="API Key")
    key = Column(Text, nullable=False)
    masked_key = Column(String(64), nullable=False)
    status = Column(String(32), default="active")
    latency_ms = Column(Integer, nullable=True)
    last_checked_at = Column(String(64), nullable=True)
    created_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "key": self.key,
            "masked_key": self.masked_key,
            "status": self.status,
            "latency_ms": self.latency_ms,
            "last_checked_at": self.last_checked_at,
            "created_at": self.created_at
        }

class CategoryModel(Base):
    """
    SQLAlchemy model for Turtu Category Taxonomy.
    Dynamically created on server startup if not yet present in database.
    """
    __tablename__ = "categories"

    id = Column(String(64), primary_key=True)
    name = Column(String(255), nullable=False, index=True)
    created_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name
        }

