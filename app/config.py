import os
from pathlib import Path
from dotenv import load_dotenv

# Base directory
BASE_DIR = Path(__file__).resolve().parent.parent

# Path to .env file
ENV_FILE = BASE_DIR / ".env"

# Ensure .env exists with default values if not present
DEFAULT_ENV_CONTENT = """# Server Configuration
HOST=127.0.0.1
PORT=8000
DEBUG=True

# Optional Default Target Portal
DEFAULT_TARGET_PORTAL_URL=

# Note: Gemini API keys are dynamically managed via the Dashboard Key Pool Manager
# and stored securely on the server in data/api_keys.json with Round-Robin load balancing.
GEMINI_API_KEY=
"""

if not ENV_FILE.exists():
    try:
        with open(ENV_FILE, "w", encoding="utf-8") as f:
            f.write(DEFAULT_ENV_CONTENT)
    except Exception as e:
        pass

# Load .env file
load_dotenv(ENV_FILE, override=True)

# Safe helper functions that gracefully handle None, empty strings, and type conversions
def _get_env_str(key: str, default: str) -> str:
    val = os.getenv(key)
    if val is None or not str(val).strip():
        return default
    return str(val).strip()

def _get_env_int(key: str, default: int) -> int:
    val = os.getenv(key)
    if val is None or not str(val).strip():
        return default
    try:
        return int(str(val).strip())
    except (ValueError, TypeError):
        return default

def _get_env_bool(key: str, default: bool) -> bool:
    val = os.getenv(key)
    if val is None or not str(val).strip():
        return default
    return str(val).strip().lower() in ("true", "1", "t", "yes", "on")

class Settings:
    PROJECT_NAME: str = "AI Menu Automation & Portal Connector"
    VERSION: str = "1.0.0"
    BASE_DIR: Path = BASE_DIR
    
    # Server Defaults: Fallback to 127.0.0.1:8000 with DEBUG=True if unset or empty
    HOST: str = _get_env_str("HOST", "127.0.0.1")
    PORT: int = _get_env_int("PORT", 8000)
    DEBUG: bool = _get_env_bool("DEBUG", True)
    
    # Optional Default Target Portal
    DEFAULT_TARGET_PORTAL_URL: str = _get_env_str("DEFAULT_TARGET_PORTAL_URL", "")
    
    # AI Keys (managed dynamically via KeyManager pool; fallback empty)
    GEMINI_API_KEY: str = _get_env_str("GEMINI_API_KEY", "")
    
    # Reference template directory
    REFERENCE_DIR: Path = BASE_DIR / "reference"
    STATIC_DIR: Path = BASE_DIR / "app" / "static"
    TEMPLATES_DIR: Path = BASE_DIR / "app" / "templates"
    UPLOAD_DIR: Path = BASE_DIR / "uploads"
    DATA_DIR: Path = BASE_DIR / "data"

settings = Settings()

# Ensure required directories exist
settings.REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
settings.STATIC_DIR.mkdir(parents=True, exist_ok=True)
settings.TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
