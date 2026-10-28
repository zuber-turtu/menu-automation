import os
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from app.config import settings
from app.routers import menu_router, key_router
from app.services.key_manager import key_manager

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Automated Menu Extraction & Excel Generator"
)

# Mount static files
app.mount("/static", StaticFiles(directory=str(settings.STATIC_DIR)), name="static")

# Templates
templates = Jinja2Templates(directory=str(settings.TEMPLATES_DIR))

# Include API Routers
app.include_router(menu_router)
app.include_router(key_router)

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard(request: Request):
    """
    Serves the unified frontend application dashboard.
    """
    key_summary = key_manager.get_pool_summary()
    has_gemini = key_summary.get("has_any_key", False)
    
    # Pre-fetch reference template & categories for instant rendering (no loading flash)
    from app.services.category_service import category_service
    cats = category_service.get_all()
    category_count = len(cats)

    ref_file = "actual_menu_format.xlsx" if (settings.REFERENCE_DIR / "actual_menu_format.xlsx").exists() else None
    if not ref_file:
        existing_xlsx = list(settings.REFERENCE_DIR.glob("*.xlsx"))
        ref_file = existing_xlsx[0].name if existing_xlsx else None

    # Cache busting timestamp
    js_path = settings.STATIC_DIR / "js" / "app.js"
    cache_id = int(os.path.getmtime(js_path)) if js_path.exists() else 1

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "project_name": settings.PROJECT_NAME,
            "version": settings.VERSION,
            "has_gemini_key": has_gemini,
            "key_summary": key_summary,
            "category_count": category_count,
            "active_template": ref_file,
            "cache_id": cache_id
        }
    )

@app.get("/api/health")
async def health_check():
    summary = key_manager.get_pool_summary()
    return {
        "status": "healthy",
        "active_keys": summary.get("active_keys", 0),
        "version": settings.VERSION
    }
