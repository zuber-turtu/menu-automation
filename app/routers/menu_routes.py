import os
import re
import json
import time
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any, Union
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import openpyxl

from app.config import settings
from app.services.category_service import category_service

router = APIRouter(prefix="/api/menu", tags=["Menu Processing & Automation"])

# Regex pattern to identify portion and piece suffixes in dish titles
PORTION_REGEX = re.compile(
    r"^(?P<base>.+?)[\s\(\[\{,\-]+(?P<portion>(?:\d+\s*(?:pieces?|pcs?|nos?|no\.|slices?))|(?:half|full|quarter|regular|small|medium|large|single|double|triple|jumbo|mini))[\)\]\}]*$",
    re.IGNORECASE
)

def consolidate_duplicate_dishes(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Consolidates items that represent the same dish with different portion sizes or piece counts
    (e.g. 'Idali 1 Piece' & 'Idali 2 Piece', 'Vada (1 Piece)' & 'Vada (2 Piece)').
    """
    grouped = {}
    order = []

    for item in items:
        # If item already has multiple variation options, keep as is
        has_existing_vars = bool(item.get("variations") and len(item.get("variations")) > 0 and len(item["variations"][0].get("values", [])) > 1)
        
        name = item.get("name", "").strip()
        match = PORTION_REGEX.match(name)

        if match and not has_existing_vars:
            base_name = match.group("base").strip()
            portion_label = match.group("portion").strip().title()
            cat_id = str(item.get("category_id") or "")
            group_key = f"{cat_id.lower()}::{base_name.lower()}"

            if group_key not in grouped:
                grouped[group_key] = {
                    "is_multi": True,
                    "base_name": base_name,
                    "primary_item": dict(item),
                    "options": []
                }
                order.append(group_key)
            
            price_val = float(item.get("price", 0.0) or 0.0)
            grouped[group_key]["options"].append({
                "label": portion_label,
                "price": price_val
            })
        else:
            group_key = f"standalone_{len(order)}"
            grouped[group_key] = {
                "is_multi": False,
                "primary_item": dict(item),
                "options": []
            }
            order.append(group_key)

    consolidated = []
    for key in order:
        entry = grouped[key]
        item = entry["primary_item"]
        
        if entry["is_multi"] and len(entry["options"]) > 1:
            sorted_opts = sorted(entry["options"], key=lambda x: x["price"])
            item["name"] = entry["base_name"]
            item["price"] = sorted_opts[0]["price"]
            item["variations"] = [
                {
                    "name": "Portion",
                    "type": "single",
                    "min": "0",
                    "max": "0",
                    "required": "off",
                    "values": [
                        {
                            "label": opt["label"],
                            "optionPrice": str(int(opt["price"]) if opt["price"].is_integer() else opt["price"])
                        }
                        for opt in sorted_opts
                    ]
                }
            ]
        consolidated.append(item)

    return consolidated

# =====================================================================
# PYDANTIC SCHEMAS FOR STRUCTURED GEMINI EXTRACTION & PAYLOADS
# =====================================================================

class VariationOption(BaseModel):
    label: str = Field(description="Size or portion label, e.g. Half, Full, Small, Medium, Large, 4 pcs")
    optionPrice: Union[str, int, float] = Field(description="Numeric price for this option, e.g. '50', '150', or 50")

class VariationGroup(BaseModel):
    name: str = Field(default="Portion", description="Variation title, e.g. Portion, Size")
    type: str = Field(default="single", description="'single' or 'multi'")
    min: Union[str, int] = Field(default="0", description="Min choices, e.g. '0' or 0")
    max: Union[str, int] = Field(default="0", description="Max choices, e.g. '0' or 0")
    required: str = Field(default="off", description="'off' or 'on'")
    values: List[VariationOption] = Field(default_factory=list, description="List of price variations")

class ExtractedMenuItem(BaseModel):
    name: str = Field(description="Item name as per menu, e.g. Chicken Shawarma, Paneer Butter Masala")
    description: Optional[str] = Field(default="", description="Dish description or ingredients as per menu")
    price: Union[float, int, str] = Field(default=0.0, description="Base price as per menu")
    category_name: Optional[str] = Field(default="General", description="Category name matched from taxonomy")
    category_id: Optional[Union[str, int]] = Field(default="", description="Category numeric ID matched from taxonomy")
    veg: Optional[str] = Field(default="yes", description="Dietary flag: strictly 'yes' for vegetarian, 'no' for non-veg/meat/chicken/fish/egg")
    variations: Optional[List[VariationGroup]] = Field(default_factory=list, description="Portion size variations if present, else empty list []")

class MenuExtractionContainer(BaseModel):
    items: List[ExtractedMenuItem]

# =====================================================================
# FRONTEND INTERCHANGE PAYLOADS
# =====================================================================

class MenuItemPayload(BaseModel):
    id: Optional[Union[int, str]] = None
    name: str
    description: Optional[str] = ""
    price: Optional[float] = 0.0
    category_name: Optional[str] = "General"
    category_id: Optional[str] = ""
    veg: Optional[str] = "yes"
    variations: Optional[Union[List[Any], str]] = "[]"
    stock: Optional[int] = 0
    store_id: Optional[int] = None
    module_id: Optional[int] = None
    discount: Optional[float] = None
    discount_type: Optional[str] = None
    available_time_starts: Optional[str] = None
    available_time_ends: Optional[str] = None
    recommended: Optional[str] = "no"

class GenerateSheetPayload(BaseModel):
    items: List[MenuItemPayload]
    template_filename: Optional[str] = None
    global_store_id: Optional[int] = 95
    global_module_id: Optional[int] = 3
    global_discount: Optional[float] = 0.0
    global_discount_type: Optional[str] = "percent"
    global_available_time_starts: Optional[str] = "08:00:00"
    global_available_time_ends: Optional[str] = "23:55:00"

# =====================================================================
# CATEGORY MANAGEMENT ENDPOINTS
# =====================================================================

@router.get("/categories")
async def get_categories():
    """
    Returns active category taxonomy for frontend search and dropdowns.
    """
    cats = category_service.get_all()
    return {
        "status": "success",
        "count": len(cats),
        "categories": cats
    }

@router.post("/upload-categories")
async def upload_categories(file: UploadFile = File(...)):
    """
    Upload a CSV category list (e.g. categories_turtu.csv) containing ID and Name.
    Persists categories for current and future AI extractions.
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported for category lists.")

    content = await file.read()
    try:
        decoded = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        decoded = content.decode("latin-1")

    count = category_service.load_from_csv_content(decoded)
    if count == 0:
        raise HTTPException(status_code=400, detail="Could not detect valid category columns ('id' and 'name') in the CSV.")

    return {
        "status": "success",
        "message": f"Successfully loaded and remembered {count} categories.",
        "count": count
    }

# =====================================================================
# REFERENCE SHEET ENDPOINTS
# =====================================================================

@router.get("/reference-sheets")
async def list_reference_sheets():
    """
    Lists uploaded reference spreadsheet templates.
    """
    files = []
    for f in settings.REFERENCE_DIR.glob("*.xlsx"):
        files.append({
            "filename": f.name,
            "size_bytes": f.stat().st_size
        })
    return {"sheets": files}

@router.post("/upload-reference")
async def upload_reference_sheet(file: UploadFile = File(...)):
    """
    Upload your master reference spreadsheet (.xlsx).
    """
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only Excel (.xlsx) files are supported as reference templates.")
    
    destination = settings.REFERENCE_DIR / file.filename
    with open(destination, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    return {
        "status": "success",
        "filename": file.filename,
        "message": f"Reference template '{file.filename}' uploaded successfully."
    }

# =====================================================================
# GEMINI MULTIMODAL MENU EXTRACTION
# =====================================================================

@router.post("/extract-preview")
async def extract_menu_items(
    menu_file: UploadFile = File(...),
    api_key: Optional[str] = Form(None)
):
    """
    Accepts a menu PDF or image file and extracts dishes, prices, veg/non-veg,
    variations, and matches Category IDs using Google Gemini Vision.
    """
    # Dynamic reload from .env in case user updated it while server is running
    from dotenv import load_dotenv
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    effective_key = (api_key or "").strip() or os.getenv("GEMINI_API_KEY", "").strip() or settings.GEMINI_API_KEY
    filename = menu_file.filename
    ext = Path(filename).suffix.lower()

    if ext not in [".pdf", ".png", ".jpg", ".jpeg", ".webp"]:
        raise HTTPException(status_code=400, detail="Unsupported format. Please upload PDF, PNG, JPG, or WEBP.")

    saved_path = settings.UPLOAD_DIR / filename
    with open(saved_path, "wb") as buffer:
        shutil.copyfileobj(menu_file.file, buffer)

    if not effective_key:
        return {
            "status": "no_key",
            "message": "No GEMINI_API_KEY detected. Please configure your key in .env or Settings.",
            "items": []
        }

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=effective_key)

        with open(saved_path, "rb") as f:
            file_bytes = f.read()

        mime_type = "application/pdf" if ext == ".pdf" else f"image/{ext.replace('.', '')}"
        if mime_type == "image/jpg":
            mime_type = "image/jpeg"

        taxonomy_prompt = category_service.get_taxonomy_prompt(max_items=120)

        prompt = f"""You are a world-class restaurant menu digitization expert.
Examine this menu image/PDF carefully and extract EVERY dish, drink, or food item into structured data.

### TARGET CATEGORY TAXONOMY:
{taxonomy_prompt}

### CRITICAL DISH CONSOLIDATION & VARIATION GROUPING:
Analyze the ENTIRE menu before extracting items.
If the SAME dish appears multiple times with different piece counts, portion sizes, or quantities:
(for example: 'Idali 1 Piece' & 'Idali 2 Piece', 'Vada (1 Piece)' & 'Vada (2 Piece)', 'Chicken Dum Biryani (Half)' & 'Chicken Dum Biryani (Full)', 'Filter Coffee Regular' & 'Filter Coffee Large', 'Paneer Tikka 6 Pcs' & 'Paneer Tikka 12 Pcs'):
YOU MUST CONSOLIDATE THEM INTO A SINGLE MENU ITEM.
NEVER create separate items for different sizes/pieces of the same dish!

Rules for Consolidation:
1. Base Item Name: Strip the portion/piece suffix to get the clean common dish name (e.g. 'Idali' instead of 'Idali 1 Piece'/'Idali 2 Piece'; 'Vada' instead of 'Vada (1 Piece)'/'Vada (2 Piece)').
2. Base Price: Set 'price' to the lowest/single-portion price (e.g. 48 for Idali, 54 for Vada).
3. Variations Array: Populate the 'variations' list with all portions/piece counts in ascending order:
   Example for Idali:
   "variations": [
     {{
       "name": "Portion",
       "type": "single",
       "min": 0,
       "max": 0,
       "required": "off",
       "values": [
         {{"label": "1 Piece", "optionPrice": "48"}},
         {{"label": "2 Piece", "optionPrice": "78"}}
       ]
     }}
   ]
   Example for Vada:
   "variations": [
     {{
       "name": "Portion",
       "type": "single",
       "min": 0,
       "max": 0,
       "required": "off",
       "values": [
         {{"label": "1 Piece", "optionPrice": "54"}},
         {{"label": "2 Piece", "optionPrice": "96"}}
       ]
     }}
   ]

### GENERAL EXTRACTION RULES:
1. Item Name: Extract the clean common title of the food item. Do NOT include price inside the name.
2. Description: Extract the description or ingredients listed under the dish. If none, leave empty "".
3. Category Assignment:
   - Identify which category from the taxonomy above best fits each dish.
   - Provide the EXACT matching 'category_id' (e.g., '76', '3225') and 'category_name'.
   - If a dish doesn't have an exact match, choose the closest logical category (e.g. Chicken Shawarma -> Shawarma ID 3225, Butter Naan -> Roti, Paneer Tikka -> Paneer or Starters).
4. Veg / Non-Veg Classification:
   - Strictly set 'veg' to 'yes' if the item is vegetarian (vegetables, paneer, lentils, dairy, cheese, wheat, rice, fruits).
   - Strictly set 'veg' to 'no' if the item contains meat, chicken, mutton, egg, fish, seafood, or non-veg stock.
5. If an item has NO variations or only 1 fixed portion (e.g. 'Mangalore Bun', 'Masala Dosa'), set variations to empty list [].

Format strictly according to the requested JSON schema.
"""

        # Resilient multi-tier candidate cascade with exponential backoff for transient 503 spikes
        candidate_models = [
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.7-flash",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
            "gemini-flash-latest"
        ]

        extracted_data = None
        for model_name in candidate_models:
            # Try up to 2 attempts per model with backoff if 503 high demand is encountered
            for attempt in range(2):
                try:
                    response = client.models.generate_content(
                        model=model_name,
                        contents=[
                            types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                            prompt
                        ],
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                            response_schema=MenuExtractionContainer
                        )
                    )
                    if response.text:
                        parsed_json = json.loads(response.text)
                        extracted_data = parsed_json.get("items", [])
                        print(f"Extraction successful with model: {model_name} ({len(extracted_data)} items extracted)")
                        break
                except Exception as model_err:
                    err_str = str(model_err)
                    print(f"Model {model_name} attempt {attempt + 1}: {err_str}")
                    # If high demand 503 spike, wait briefly before retrying or moving to next candidate
                    if "503" in err_str or "UNAVAILABLE" in err_str or "high demand" in err_str:
                        if attempt == 0:
                            time.sleep(1.5)
                            continue
                        else:
                            time.sleep(1.0)
                    # If model not found (404) or quota (429), break inner loop to try next model immediately
                    break

            if extracted_data is not None:
                break

        if extracted_data is None:
            return {
                "status": "warning",
                "message": "AI extraction was temporarily unavailable due to high demand spikes (503 UNAVAILABLE). Please click 'Extract & Preview' again in a few moments.",
                "items": []
            }

        # Post-process: Verify and normalize Category IDs using category_service
        processed_items = []
        for item in extracted_data:
            c_id = str(item.get("category_id") or "").strip()
            c_name = str(item.get("category_name") or "").strip()
            dish_name = str(item.get("name") or "").strip()

            # Verify or find Category ID if missing or unrecognized
            if not c_id or c_id not in category_service.categories.values():
                matched_id, matched_name = category_service.find_match(dish_name)
                if not matched_id and c_name:
                    matched_id, matched_name = category_service.find_match(c_name)
                if matched_id:
                    c_id = matched_id
                    c_name = matched_name

            veg_raw = str(item.get("veg", "yes")).lower()
            is_veg = "yes" if veg_raw in ["yes", "true", "1", "veg"] else "no"

            # Format variations
            vars_list = item.get("variations", [])
            formatted_vars = []
            for v in vars_list:
                if isinstance(v, dict) and "values" in v and len(v["values"]) > 0:
                    formatted_vars.append({
                        "name": v.get("name", "Portion"),
                        "type": v.get("type", "single"),
                        "min": str(v.get("min", "0")),
                        "max": str(v.get("max", "0")),
                        "required": str(v.get("required", "off")),
                        "values": [
                            {"label": str(opt.get("label", "")), "optionPrice": str(opt.get("optionPrice", "0"))}
                            for opt in v.get("values", [])
                        ]
                    })

            processed_items.append({
                "name": dish_name,
                "description": item.get("description", ""),
                "price": float(item.get("price", 0.0) or 0.0),
                "category_name": c_name or "General",
                "category_id": c_id,
                "veg": is_veg,
                "variations": formatted_vars
            })

        # Consolidate any duplicate dishes with different piece/portion sizes
        consolidated_items = consolidate_duplicate_dishes(processed_items)

        return {
            "status": "success",
            "items_count": len(consolidated_items),
            "items": consolidated_items
        }

    except Exception as e:
        return {
            "status": "warning",
            "message": f"Extraction notice: {str(e)}",
            "items": []
        }

# =====================================================================
# EXCEL GENERATOR (FULL 22 COLUMNS MATCHING menu_format.xlsx)
# =====================================================================

@router.post("/generate-sheet")
async def generate_sheet_from_items(payload: GenerateSheetPayload):
    """
    Populates extracted items into the exact 22-column schema required by menu_format.xlsx:
    Id, Name, Description, Image, CategoryId, SubCategoryId, UnitId, Stock, Price,
    Discount, DiscountType, AvailableTimeStarts, AvailableTimeEnds, Variations,
    ChoiceOptions, AddOns, Attributes, StoreId, ModuleId, Status, Veg, Recommended.
    """
    template_files = list(settings.REFERENCE_DIR.glob("*.xlsx"))
    target_template = None
    if payload.template_filename:
        candidate = settings.REFERENCE_DIR / payload.template_filename
        if candidate.exists():
            target_template = candidate

    if not target_template:
        default_actual = settings.REFERENCE_DIR / "actual_menu_format.xlsx"
        if default_actual.exists():
            target_template = default_actual
        elif template_files:
            target_template = template_files[0]

    output_filename = "formatted_menu_upload.xlsx"
    output_path = settings.UPLOAD_DIR / output_filename

    if target_template and target_template.exists():
        wb = openpyxl.load_workbook(target_template)
        ws = wb.active

        # Clear existing sample rows and trailing blank rows below row 1
        if ws.max_row > 1:
            ws.delete_rows(2, ws.max_row - 1)
    else:
        # Create standard 21-column workbook matching actual_menu_format.xlsx
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Sheet1"
        headers = [
            "Id", "Name", "Description", "Image", "CategoryId", "SubCategoryId", "UnitId",
            "Stock", "Price", "Discount", "DiscountType", "AvailableTimeStarts", "AvailableTimeEnds",
            "Variations", "AddOns", "Attributes", "StoreId", "ModuleId",
            "Status", "Veg", "Recommended"
        ]
        ws.append(headers)

    # Base ID sequence
    base_id = 10001

    for idx, item in enumerate(payload.items):
        item_id = item.id or (base_id + idx)
        
        # Category ID resolution
        cat_id = str(item.category_id or "").strip()
        if not cat_id and item.name:
            matched_id, _ = category_service.find_match(item.name)
            if matched_id:
                cat_id = matched_id

        # Variations JSON serialization
        variations_json = "[]"
        if isinstance(item.variations, list) and len(item.variations) > 0:
            variations_json = json.dumps(item.variations, ensure_ascii=False)
        elif isinstance(item.variations, str) and item.variations.strip().startswith("["):
            variations_json = item.variations.strip()

        # Veg normalization
        veg_str = "yes" if str(item.veg or "yes").lower() in ["yes", "true", "1", "veg"] else "no"

        # Batch inputs (fallback to payload globals)
        store_id = item.store_id or payload.global_store_id or 95
        module_id = item.module_id or payload.global_module_id or 3
        discount = item.discount if item.discount is not None else (payload.global_discount or 0.0)
        discount_type = item.discount_type or payload.global_discount_type or "percent"
        time_starts = item.available_time_starts or payload.global_available_time_starts or "08:00:00"
        time_ends = item.available_time_ends or payload.global_available_time_ends or "23:55:00"
        price_val = float(item.price or 0.0)

        # 21-Column Row Tuple matching actual_menu_format.xlsx strictly
        row_data = [
            item_id,                             # 1. Id
            item.name,                           # 2. Name
            item.description or "",              # 3. Description
            None,                                # 4. Image (empty cell)
            cat_id or "0",                       # 5. CategoryId (mapped to Turtu ID)
            0,                                   # 6. SubCategoryId (strictly 0)
            None,                                # 7. UnitId (strictly empty cell)
            0,                                   # 8. Stock (strictly 0)
            price_val,                           # 9. Price (as per menu)
            discount,                            # 10. Discount
            discount_type,                       # 11. DiscountType
            time_starts,                         # 12. AvailableTimeStarts
            time_ends,                           # 13. AvailableTimeEnds
            variations_json,                     # 14. Variations (exact JSON format)
            "[]",                                # 15. AddOns (strictly "[]")
            "[]",                                # 16. Attributes (strictly "[]")
            store_id,                            # 17. StoreId
            module_id,                           # 18. ModuleId
            "active",                            # 19. Status
            veg_str,                             # 20. Veg ("yes" or "no")
            item.recommended or "no"             # 21. Recommended ("no")
        ]

        ws.append(row_data)

    wb.save(output_path)

    return FileResponse(
        path=output_path,
        filename=output_filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
