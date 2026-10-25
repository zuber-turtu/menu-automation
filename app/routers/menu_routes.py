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

# Universal portion patterns covering pieces, counts, portions, weights, volumes, and sizing
PORTION_PATTERN = (
    r"(?:\d+\s*(?:pieces?|pcs?|nos?|no\.|slices?|pc|shots?|cups?|glasses?|plates?|pack|buckets?|scoops?|inch))|"
    r"(?:\(\s*\d+\s*(?:pieces?|pcs?|nos?|no\.)?\s*\))|"
    r"(?:\d+\s*(?:g|gm|gms|kg|kgs|ml|l|ltr|litres?))|"
    r"(?:half|full|quarter|regular|small|medium|large|single|double|triple|jumbo|mini|family(?:\s+pack)?|standard|big|mega|xl|xxl)"
)

SEP = r"[\s\(\[\{,\-]+"
END = r"[\)\]\}]*$"

PORTION_SUFFIX_REGEX = re.compile(r"^(?P<base>.+?)" + SEP + r"(?P<portion>" + PORTION_PATTERN + r")" + END, re.IGNORECASE)
PORTION_PREFIX_REGEX = re.compile(r"^(?P<portion>" + PORTION_PATTERN + r")" + SEP + r"(?P<base>.+)$", re.IGNORECASE)

# Universal inline variety regex covering options separated by slash (/), backslash (\), comma (,), or 'or'
INLINE_VARIETY_REGEX = re.compile(
    r"^(?P<base>[^-\(\[\{/:]+?)\s*[-\(\[\{:]\s*(?P<options>[^-\)\]\}]+?(?:[/\\,]|\s+or\s+)[^-\)\]\}]+)[\)\]\}]*$",
    re.IGNORECASE
)

# Prefixed inline options (e.g. 'Onion/Mirchi/Potato Bhajji')
SLASH_PREFIX_REGEX = re.compile(
    r"^(?P<options>[A-Za-z0-9\s]+(?:/[A-Za-z0-9\s]+)+)\s+(?P<base>[A-Za-z0-9\s]+)$",
    re.IGNORECASE
)

COMMON_FLAVOR_PREFIXES = {
    'onion', 'potato', 'mirchi', 'aloo', 'gobi', 'cheese', 'steamed', 'fried', 
    'tandoori', 'kurkure', 'plain', 'butter', 'garlic', 
    'vanilla', 'chocolate', 'strawberry', 'mango', 'oreo'
}

ADDON_HEADER_REGEX = re.compile(
    r"(?:[\.\,\;\-\(\[\{]?\s*(?:(?:with\s+)?add\s*[-]?\s*ons?|extras?|add\s*[-]?\s*in|options?)\s*[:\-]?\s*)(.+)$",
    re.IGNORECASE
)
ADDON_DELIMITER_REGEX = re.compile(r"[,;/|]|\s*&\s*|\s+and\s+", re.IGNORECASE)

def extract_addons_from_description(desc: str) -> tuple[str, List[Dict[str, str]]]:
    """
    Detects add-on patterns in description text, e.g.:
    'Cheesy fries loaded with golden, cheesy melty goodness. ADD ON PIRI PIRI +20'
    'Loaded Nachos. Add-ons: Jalapeno +15, Sour Cream +25'
    
    Returns:
    (clean_description, list_of_addons)
    """
    if not desc or not isinstance(desc, str):
        return desc or "", []

    text = desc.strip()
    match = ADDON_HEADER_REGEX.search(text)
    if not match:
        return text, []

    addon_raw = match.group(1).strip().rstrip(".)]}")
    clean_desc = text[:match.start()].strip().rstrip(".,;:-")
    raw_tokens = [t.strip() for t in ADDON_DELIMITER_REGEX.split(addon_raw) if t.strip()]
    if not raw_tokens:
        raw_tokens = [addon_raw]

    addons = []
    for token in raw_tokens:
        # Pattern 1: Label followed by Price (e.g. 'PIRI PIRI +20', 'Cheese @ 30', 'Dip 15/-')
        m1 = re.search(r"^(.*?)(?:[\+@₹:\(]+|\s+)(\d+(?:\.\d+)?)\s*(?:/-)?\s*[\)\]]*$", token)
        if m1 and m1.group(1).strip():
            lbl = m1.group(1).strip().strip(":+-@₹ ()").title()
            try:
                price = str(int(float(m1.group(2))))
                if len(lbl) >= 2:
                    addons.append({"label": lbl, "optionPrice": price})
                    continue
            except (ValueError, TypeError):
                pass

        # Pattern 2: Price followed by Label (e.g. '+20 Piri Piri', '@30 Cheese')
        m2 = re.search(r"^(?:[\+@₹:\(]*\s*)(\d+(?:\.\d+)?)\s*(?:/-)?\s*[\)\]]*\s+(.+)$", token)
        if m2 and m2.group(2).strip():
            lbl = m2.group(2).strip().strip(":+-@₹ ()").title()
            try:
                price = str(int(float(m2.group(1))))
                if len(lbl) >= 2:
                    addons.append({"label": lbl, "optionPrice": price})
                    continue
            except (ValueError, TypeError):
                pass

    if not addons:
        return text, []

    return clean_desc, addons

def process_item_addons(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extracts any add-ons embedded in item description and converts them into
    a multi-select 'Add-on' variation group with clean description.
    """
    desc = item.get("description", "")
    clean_desc, addons = extract_addons_from_description(desc)
    if addons:
        item["description"] = clean_desc
        variations = item.get("variations")
        if not isinstance(variations, list):
            variations = []
            item["variations"] = variations

        existing_addon_group = None
        for g in variations:
            if isinstance(g, dict) and ("add" in str(g.get("name", "")).lower() or g.get("type") in ["multi", "multiple"]):
                existing_addon_group = g
                break

        if existing_addon_group:
            existing_labels = {str(v.get("label", "")).lower() for v in existing_addon_group.get("values", [])}
            for a in addons:
                if a["label"].lower() not in existing_labels:
                    existing_addon_group.setdefault("values", []).append(a)
            existing_addon_group["max"] = str(len(existing_addon_group.get("values", [])))
            existing_addon_group["type"] = "multi"
            existing_addon_group["required"] = "off"
            existing_addon_group["min"] = "0"
        else:
            variations.append({
                "name": "Add-on",
                "type": "multi",
                "min": "0",
                "max": str(len(addons)),
                "required": "off",
                "values": addons
            })

    return item

NON_VEG_TERMS = {
    "chicken", "murgh", "murg", "mutton", "gosht", "ghosht", "meat", "lamb",
    "fish", "machli", "prawn", "prawns", "shrimp", "seafood", "crab", "squid",
    "egg", "eggs", "anda", "omlet", "omelette", "omelet",
    "keema", "kheema", "beef", "pork", "bacon", "ham", "duck",
    "non-veg", "nonveg", "non veg", "wings", "pepperoni", "salami"
}

VEG_TERMS = {
    "veg", "vegetarian", "pure veg", "paneer", "cottage cheese", "mushroom", 
    "corn", "babycorn", "baby corn", "aloo", "potato", "gobi", "cauliflower",
    "soya", "soy", "tofu", "cheese", "onion", "mirchi", "capsicum", "palak",
    "spinach", "dal", "daal", "plain", "mix veg", "mixed veg", "vegetable", "vegetables"
}

def is_non_veg_text(text: str) -> bool:
    """Returns True if text contains clear non-vegetarian keywords."""
    if not text:
        return False
    clean = re.sub(r"[^a-zA-Z\s\-]", " ", text.lower())
    words = set(clean.split())
    if any(term in words for term in NON_VEG_TERMS):
        return True
    if any(re.search(rf"\b{re.escape(term)}\b", clean) for term in NON_VEG_TERMS):
        return True
    return False

def is_veg_text(text: str) -> bool:
    """Returns True if text contains clear vegetarian keywords and no non-veg keywords."""
    if not text or is_non_veg_text(text):
        return False
    clean = re.sub(r"[^a-zA-Z\s\-]", " ", text.lower())
    words = set(clean.split())
    if any(term in words for term in VEG_TERMS):
        return True
    if any(re.search(rf"\b{re.escape(term)}\b", clean) for term in VEG_TERMS):
        return True
    return False

PROTEIN_CLASSES = {
    "chicken": {"chicken", "murgh", "murg", "duck", "turkey"},
    "egg": {"egg", "eggs", "anda", "omlet", "omelette", "omelet"},
    "mutton": {"mutton", "gosht", "ghosht", "meat", "lamb", "beef", "pork", "bacon", "ham", "keema", "kheema"},
    "fish": {"fish", "machli", "salmon", "pomfret"},
    "prawn": {"prawn", "prawns", "shrimp", "shrimps", "crab", "squid", "lobster", "seafood"},
    "paneer": {"paneer", "cottage cheese", "tofu", "soya", "soy"},
    "mushroom": {"mushroom", "mushrooms"},
    "veg": {"veg", "vegetarian", "pure veg", "mix veg", "mixed veg", "vegetable", "vegetables"}
}

PREFIX_FOOD_NOUNS = [
    "hakka noodles", "schezwan noodles", "noodles", "fried rice", "rice",
    "biryani", "pulao", "roll", "rolls", "curry", "masala", "soup",
    "burger", "burgers", "pizza", "pizzas", "pasta", "momos", "sandwich",
    "sandwiches", "maggi", "puff", "puffs", "manchurian", "wrap", "wraps",
    "kebab", "kebabs", "tikka", "crunchies", "platter", "thali"
]

def get_protein_class(text: str) -> Optional[str]:
    """Returns the protein/ingredient category if text contains a distinct protein keyword."""
    if not text:
        return None
    clean = re.sub(r"[^a-zA-Z\s\-]", " ", text.lower())
    words = set(clean.split())
    for p_class, terms in PROTEIN_CLASSES.items():
        if any(term in words for term in terms):
            return p_class
        if any(re.search(rf"\b{re.escape(term)}\b", clean) for term in terms):
            return p_class
    return None

def should_split_protein_or_dietary(labels: List[str]) -> bool:
    """
    Returns True if options represent distinct proteins/meats/eggs
    (e.g. Chicken vs Egg, Chicken vs Mutton, Fish vs Prawn, Paneer vs Chicken)
    OR mixed dietary types (Veg vs Non-Veg).
    Such options MUST NEVER be variations and MUST be split into individual dishes.
    """
    if not labels or len(labels) < 2:
        return False
    
    # 1. Check if mixed veg and non-veg
    has_nv = any(is_non_veg_text(l) for l in labels)
    has_v = any(is_veg_text(l) for l in labels)
    if has_nv and has_v:
        return True
        
    # 2. Check if multiple distinct protein classes are present
    classes = set()
    for l in labels:
        p = get_protein_class(l)
        if p:
            classes.add(p)
            
    if len(classes) >= 2:
        return True
        
    return False

def format_split_dish_title(base_name: str, opt_label: str) -> str:
    """
    Formats the dish name cleanly when splitting protein/ingredient variations:
    e.g. ('Hakka Noodles', 'Egg') -> 'Egg Hakka Noodles'
    e.g. ('Schezwan Noodles', 'Chicken') -> 'Chicken Schezwan Noodles'
    e.g. ('Fried Rice', 'Egg') -> 'Egg Fried Rice'
    e.g. ('Piri Piri Crunchies', 'Paneer') -> 'Paneer Piri Piri Crunchies'
    """
    clean_base = re.sub(r"\s*-\s*(Paneer|Chicken|Veg|Non-Veg|Egg|Mutton|Prawn|Fish)$", "", base_name, flags=re.IGNORECASE).strip()
    opt_clean = opt_label.strip()
    
    if opt_clean.lower() in clean_base.lower():
        return clean_base
        
    lower_base = clean_base.lower()
    for noun in PREFIX_FOOD_NOUNS:
        if lower_base == noun or lower_base.endswith(" " + noun):
            return f"{opt_clean} {clean_base}"
            
    return f"{clean_base} - {opt_clean}"

def get_dish_veg_status(dish_name: str, opt_label: str) -> str:
    """
    Determines if the split dish is vegetarian ('yes') or non-vegetarian ('no').
    Strict rule: Chicken, Mutton, Fish, Prawn, Egg, etc. are non-veg ('no').
    """
    combined = f"{dish_name} {opt_label}".lower()
    if is_non_veg_text(combined):
        return "no"
    if is_veg_text(combined):
        return "yes"
def enforce_word_count(text: str, min_words: int = 10, max_words: int = 15) -> str:
    """
    Enforces that the description text is strictly between min_words and max_words (10 to 15 words).
    """
    if not text:
        return "Freshly prepared wholesome delicacy cooked with authentic traditional spices, herbs, and savory seasonings."
    
    words = text.strip().split()
    if len(words) > max_words:
        truncated = words[:max_words]
        clean_text = ' '.join(truncated)
        clean_text = re.sub(r"[,;:\-–—\s]+$", "", clean_text)
        if not clean_text.endswith((".", "!", "?")):
            clean_text += "."
        return clean_text

    if len(words) < min_words:
        pad_needed = min_words - len(words)
        if pad_needed <= 2:
            pad = "Freshly prepared."
        elif pad_needed <= 4:
            pad = "Crafted fresh with aromatic spices."
        else:
            pad = "Prepared fresh with traditional aromatic herbs and seasonings."
        clean_text = text.rstrip(". ") + " " + pad
        words = clean_text.split()
        if len(words) > max_words:
            clean_text = ' '.join(words[:max_words])
            clean_text = re.sub(r"[,;:\-–—\s]+$", "", clean_text) + "."
        return clean_text

    clean_text = text.strip()
    if not clean_text.endswith((".", "!", "?")):
        clean_text += "."
    return clean_text



def split_protein_and_dietary_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Enforces strict online portal catalog rules across the entire menu:
    If an item has a variation group containing:
    1. Distinct protein/meat/egg choices (e.g. Chicken vs Egg, Chicken vs Mutton, Fish vs Prawn), OR
    2. Mixed dietary choices (e.g. Paneer vs Chicken, Veg vs Non-Veg):
    It CANNOT remain as one item.
    Splits the item into separate distinct food items with correct names, prices, and dietary flags!
    """
    result = []
    for item in items:
        variations = item.get("variations")
        if not variations or not isinstance(variations, list):
            result.append(item)
            continue

        split_occurred = False
        base_price = float(item.get("price", 0.0) or 0.0)
        base_name = str(item.get("name", "")).strip()

        for g_idx, group in enumerate(variations):
            if not isinstance(group, dict):
                continue
            values = group.get("values", [])
            if not values or len(values) < 2:
                continue

            labels = [str(v.get("label", "")).strip() for v in values if str(v.get("label", "")).strip()]
            if should_split_protein_or_dietary(labels):
                split_occurred = True
                other_groups = [g for i, g in enumerate(variations) if i != g_idx]

                for opt in values:
                    opt_lbl = str(opt.get("label", "")).strip()
                    try:
                        extra_p = float(opt.get("optionPrice", 0.0) or 0.0)
                    except (ValueError, TypeError):
                        extra_p = 0.0
                    dish_price = base_price + extra_p
                    dish_title = format_split_dish_title(base_name, opt_lbl)
                    dish_veg = get_dish_veg_status(dish_title, opt_lbl)

                    new_sub_item = dict(item)
                    new_sub_item["name"] = dish_title
                    new_sub_item["price"] = int(dish_price) if dish_price.is_integer() else round(dish_price, 2)
                    new_sub_item["veg"] = dish_veg
                    new_sub_item["variations"] = other_groups
                    new_sub_item["description"] = item.get("description", "")
                    result.append(new_sub_item)

                break  # Group handled

        if not split_occurred:
            result.append(item)

    return result

# Backward-compatibility alias
split_mixed_dietary_items = split_protein_and_dietary_items

def normalize_variation_deltas(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enforces portal catalog standards for both Single-Select and Multi-Select/Add-On variations:
    1. Single-Select Variations (Portion, Size, Pieces, etc.):
       - Mandatory to select any one: required = "on", min = "1", max = "1".
       - Sets base item price to lowest variation price.
       - Base variation has optionPrice = "0".
       - Other variations have optionPrice strictly as the extra delta difference.
    2. Multi-Select Variations / Add-Ons (Add-on, Extras, Toppings, etc.):
       - Optional selection: required = "off", min = "0", max = str(len(values)).
       - Preserves base item price (add-ons do not override base item price).
       - Each option has optionPrice as its extra addon amount.
    """
    variations = item.get("variations")
    if not variations or not isinstance(variations, list):
        return item

    item_base_price = float(item.get("price", 0.0) or 0.0)

    for group in variations:
        if not isinstance(group, dict):
            continue
        values = group.get("values", [])
        if not values or len(values) < 1:
            continue

        g_type = str(group.get("type", "single")).lower()
        g_name = str(group.get("name", "")).lower()
        is_addon = (g_type in ["multi", "multiple"]) or ("add" in g_name) or ("extra" in g_name) or ("topping" in g_name) or ("dip" in g_name)

        if is_addon:
            # Multi-type add-ons: optional, multiple choices allowed, do NOT alter item base price
            group["type"] = "multi"
            group["required"] = "off"
            group["min"] = "0"
            group["max"] = str(len(values))
            for v in values:
                try:
                    p = float(v.get("optionPrice", 0.0) or 0.0)
                    v["optionPrice"] = str(int(p) if p.is_integer() else round(p, 2))
                except (ValueError, TypeError):
                    v["optionPrice"] = "0"
        else:
            # Single-type variations: mandatory to select any one!
            group["type"] = "single"
            group["required"] = "on"
            group["min"] = "1"
            group["max"] = "1"

            numeric_prices = []
            for v in values:
                try:
                    numeric_prices.append(float(v.get("optionPrice", 0.0) or 0.0))
                except (ValueError, TypeError):
                    numeric_prices.append(0.0)

            min_val = min(numeric_prices)
            max_val = max(numeric_prices)

            # Case A: All options share the same price (e.g. all 72 or all 0 like Onion/Mirchi/Potato)
            if min_val == max_val:
                if min_val > 0 and (item_base_price == 0.0 or item_base_price == min_val):
                    item_base_price = min_val
                for v in values:
                    v["optionPrice"] = "0"

            # Case B: Absolute prices provided (min_val > 0, e.g. 50 and 70, or 48 and 78)
            elif min_val > 0:
                item_base_price = min_val
                for v, p in zip(values, numeric_prices):
                    delta = p - min_val
                    v["optionPrice"] = str(int(delta) if delta.is_integer() else round(delta, 2))

            # Case C: Already delta priced (min_val == 0, e.g. 0 and 20)
            else:
                for v, p in zip(values, numeric_prices):
                    v["optionPrice"] = str(int(p) if p.is_integer() else round(p, 2))

    item["price"] = int(item_base_price) if item_base_price.is_integer() else round(item_base_price, 2)
    return item

def consolidate_duplicate_dishes(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Universal consolidator for ANY restaurant dish:
    1. Extracts any embedded add-ons from dish descriptions.
    2. Detects inline varieties (slash, comma, 'or' separated).
    3. Groups multi-portion dishes (suffix or prefix piece counts, sizes, weights, or volumes).
    4. Groups common flavor varieties.
    5. Applies delta pricing and single mandatory vs multi optional rules.
    """
    # Pre-extract add-ons embedded in item descriptions
    items = [process_item_addons(dict(it)) for it in items]

    grouped = {}
    order = []

    for item in items:
        name = item.get("name", "").strip()
        has_existing_vars = bool(item.get("variations") and len(item.get("variations")) > 0 and len(item["variations"][0].get("values", [])) > 1)

        # 1. Inline varieties check
        if not has_existing_vars:
            inline_match = INLINE_VARIETY_REGEX.match(name)
            if not inline_match:
                inline_match = SLASH_PREFIX_REGEX.match(name)

            if inline_match:
                base_name = inline_match.group("base").strip()
                opts_str = inline_match.group("options")
                raw_options = [o.strip().title() for o in re.split(r"[/\\,]|\s+or\s+", opts_str) if o.strip()]
                if len(raw_options) >= 2:
                    if should_split_protein_or_dietary(raw_options):
                        # STRICT PROTEIN & DIETARY RESTRICTION: Split distinct proteins into separate individual items
                        for opt_lbl in raw_options:
                            dish_title = format_split_dish_title(base_name, opt_lbl)
                            dish_veg = get_dish_veg_status(dish_title, opt_lbl)
                            sub_item = dict(item)
                            sub_item["name"] = dish_title
                            sub_item["veg"] = dish_veg
                            sub_item["variations"] = []
                            sub_item["description"] = item.get("description", "")
                            group_key = f"standalone_{len(order)}"
                            grouped[group_key] = {
                                "is_multi": False,
                                "primary_item": sub_item,
                                "options": []
                            }
                            order.append(group_key)
                        continue
                    else:
                        item["name"] = base_name
                        item["variations"] = [
                            {
                                "name": "Variation",
                                "type": "single",
                                "min": "0",
                                "max": "0",
                                "required": "off",
                                "values": [
                                    {"label": opt_lbl, "optionPrice": "0"}
                                    for opt_lbl in raw_options
                                ]
                            }
                        ]
                        has_existing_vars = True

        # 2. Portion Suffix & Prefix checks
        portion_match = PORTION_SUFFIX_REGEX.match(item.get("name", "").strip()) if not has_existing_vars else None
        if not portion_match and not has_existing_vars:
            portion_match = PORTION_PREFIX_REGEX.match(item.get("name", "").strip())

        # 3. Flavor prefix check (e.g. 'Onion Bhajji', 'Potato Bhajji')
        flavor_match = None
        if not portion_match and not has_existing_vars:
            parts = item.get("name", "").strip().split()
            if len(parts) >= 2 and parts[0].lower() in COMMON_FLAVOR_PREFIXES:
                flavor_match = (parts[0].title(), " ".join(parts[1:]))

        if portion_match and not has_existing_vars:
            base_name = portion_match.group("base").strip()
            portion_label = portion_match.group("portion").strip().title()
            cat_id = str(item.get("category_id") or "")
            group_key = f"{cat_id.lower()}::portion::{base_name.lower()}"

            if group_key not in grouped:
                grouped[group_key] = {
                    "is_multi": True,
                    "group_type": "portion",
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
        elif flavor_match and not has_existing_vars:
            flavor_label, base_dish = flavor_match
            cat_id = str(item.get("category_id") or "")
            item_diet = "veg" if str(item.get("veg", "yes")).lower() in ["yes", "true", "1", "veg"] else "nonveg"
            if is_non_veg_text(flavor_label):
                item_diet = "nonveg"
            elif is_veg_text(flavor_label):
                item_diet = "veg"

            # Partition group key by dietary status so veg & non-veg dishes never combine
            group_key = f"{cat_id.lower()}::{item_diet}::flavor::{base_dish.lower()}"

            if group_key not in grouped:
                grouped[group_key] = {
                    "is_multi": True,
                    "group_type": "flavor",
                    "base_name": base_dish,
                    "primary_item": dict(item),
                    "options": []
                }
                order.append(group_key)

            price_val = float(item.get("price", 0.0) or 0.0)
            grouped[group_key]["options"].append({
                "label": flavor_label,
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
            base_price = sorted_opts[0]["price"]
            item["name"] = entry["base_name"]
            item["price"] = base_price
            group_name = "Portion" if entry.get("group_type") == "portion" else "Variation"
            item["variations"] = [
                {
                    "name": group_name,
                    "type": "single",
                    "min": "0",
                    "max": "0",
                    "required": "off",
                    "values": [
                        {
                            "label": opt["label"],
                            "optionPrice": str(int(opt["price"] - base_price) if (opt["price"] - base_price).is_integer() else round(opt["price"] - base_price, 2))
                        }
                        for opt in sorted_opts
                    ]
                }
            ]

        # Apply universal delta pricing normalization
        normalized_item = normalize_variation_deltas(item)
        consolidated.append(normalized_item)

    return split_mixed_dietary_items(consolidated)

# =====================================================================
# PYDANTIC SCHEMAS FOR STRUCTURED GEMINI EXTRACTION & PAYLOADS
# =====================================================================

class VariationOption(BaseModel):
    label: str = Field(description="Size or portion label, e.g. Half, Full, Small, Medium, Large, 4 pcs")
    optionPrice: Union[str, int, float] = Field(description="Numeric price for this option, e.g. '50', '150', or 50")

class VariationGroup(BaseModel):
    name: str = Field(default="Portion", description="Variation title, e.g. Portion, Size, Add-on")
    type: str = Field(default="single", description="'single' for mandatory choices (Portion/Size) or 'multi' for optional add-ons")
    min: Union[str, int] = Field(default="1", description="Min choices: '1' for single mandatory, '0' for multi optional")
    max: Union[str, int] = Field(default="1", description="Max choices: '1' for single mandatory, or count for multi optional")
    required: str = Field(default="on", description="'on' for single mandatory, 'off' for multi optional")
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

class ItemToDescribe(BaseModel):
    index: int
    name: str
    category_name: Optional[str] = "General"
    veg: Optional[str] = "yes"
    description: Optional[str] = ""

class GenerateDescriptionsPayload(BaseModel):
    items: List[ItemToDescribe]

class SingleDescriptionOutput(BaseModel):
    index: int = Field(description="The matching item index from the request")
    description: str = Field(description="Mouth-watering, accurate culinary description tailored to the specific dish, strictly 10 to 15 words.")

class DescriptionsContainer(BaseModel):
    descriptions: List[SingleDescriptionOutput]

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
    Upload a CSV or Excel category list (.csv, .xlsx, .xls) containing ID and Name.
    Persists categories for current and future AI extractions.
    """
    fname = file.filename.lower()
    if not (fname.endswith(".csv") or fname.endswith(".xlsx") or fname.endswith(".xls")):
        raise HTTPException(status_code=400, detail="Only CSV (.csv) and Excel (.xlsx, .xls) files are supported for category lists.")

    content = await file.read()
    if fname.endswith((".xlsx", ".xls")):
        count = category_service.load_from_excel_content(content)
    else:
        try:
            decoded = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            decoded = content.decode("latin-1")
        count = category_service.load_from_csv_content(decoded)

    if count == 0:
        raise HTTPException(status_code=400, detail="Could not detect valid category columns ('id' and 'name') in the uploaded file.")

    return {
        "status": "success",
        "message": f"Successfully replaced active taxonomy with {count} new categories.",
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

### CRITICAL DISH CONSOLIDATION & VARIATION RULES (APPLIES UNIVERSALLY TO ALL DISHES & CUISINES):
Analyze the ENTIRE menu before extracting items.
These rules apply to EVERY dish category (Beverages, Breakfast, Fast Food, Chinese, Indian Breads & Curries, Biryanis, Tandoori, Snacks, Desserts, Ice Creams, Pasta, Burgers, Momos, Shakes, etc.).

1. DELTA PRICING RULE FOR ALL VARIATIONS (MANDATORY & UNIVERSAL):
   - For ANY item with variations/sizes/flavors, set the main item 'price' to the LOWEST price among all its variations.
   - In the variation format, use this lowest price as the base price with an additional amount of '0' (optionPrice: "0").
   - For every other variation, enter ONLY the extra amount that needs to be added to the base price to reach that variation's actual price.
   - Formula: optionPrice = (variation_actual_price - base_price).
   - NEVER enter the full variation price in other options, and do NOT add the extra amount to an already-defined item price again!
   - Example 1: Lowest variation costs ₹50 and another variation costs ₹70:
     Set item price = 50.
     Variation 1 (Base): optionPrice = "0"
     Variation 2: optionPrice = "20" (70 - 50 = 20)
   - Example 2: Small ₹120, Medium ₹160, Large ₹200:
     Set item price = 120.
     Small: optionPrice = "0", Medium: optionPrice = "40", Large: optionPrice = "80"
   - Example 3: All varieties share the same price (e.g. ₹72):
     Set item price = 72.
     All varieties: optionPrice = "0"

2. INLINE FLAVORS, TYPES, & VARIETIES (SAME DIETARY CLASSIFICATION ONLY):
   If ANY item lists multiple choices, flavors, preparations, or types in a single title OF THE SAME DIETARY TYPE (all Veg OR all Non-Veg):
   (e.g., 'Bhajji - Onion/Mirchi/Potato', 'Maggi (Plain / Masala / Cheese)', 'Momos - Steamed / Fried / Tandoori', 'Sandwich - Veg / Cheese / Corn', 'Pasta: Red Sauce / White Sauce', 'Paratha - Aloo / Gobi / Paneer', 'Milkshake - Mango / Oreo / Strawberry', 'Ice Cream - Vanilla / Chocolate / Butterscotch', 'Dosa - Plain / Masala / Ghee Roast', 'Chicken Tikka - Malai / Hariyali / Achari'):
   - Clean Base Name: Strip the flavors/types to get the common dish name (e.g. 'Bhajji', 'Maggi', 'Momos', 'Paratha', 'Milkshake').
   - Base Price: Lowest listed price (e.g. 72 for Bhajji).
   - Variations Group: Create group named "Variation" or "Type" (type="single", required="off") with each flavor/option listed.
   - Apply delta pricing (if all share the same price ₹72, every option has optionPrice = "0").
   Example for 'Bhajji - Onion/Mirchi/Potato' @ 72:
   "name": "Bhajji", "price": 72, "veg": "yes", "variations": [{{"name": "Variation", "type": "single", "min": 0, "max": 0, "required": "off", "values": [{{"label": "Onion", "optionPrice": "0"}}, {{"label": "Mirchi", "optionPrice": "0"}}, {{"label": "Potato", "optionPrice": "0"}}]}}]
   Example for 'Maggi - Plain (60) / Masala (80) / Cheese (100)':
   "name": "Maggi", "price": 60, "veg": "yes", "variations": [{{"name": "Variation", "type": "single", "min": 0, "max": 0, "required": "off", "values": [{{"label": "Plain", "optionPrice": "0"}}, {{"label": "Masala", "optionPrice": "20"}}, {{"label": "Cheese", "optionPrice": "40"}}]}}]

3. STRICT PROTEIN & DIETARY SEPARATION (INDIVIDUAL DISHES ONLY, NEVER VARIATIONS):
   - In restaurant catalogs (Turtu/Swiggy/Zomato), distinct proteins, meats, and primary food bases:
     (Chicken, Egg, Mutton, Fish, Prawn, Seafood, Beef, Pork, Veg, Paneer, Mushroom)
     MUST ALWAYS BE EXTRACTED AS SEPARATE INDIVIDUAL FOOD ITEMS!
   - They MUST NEVER BE GROUPED AS VARIATIONS of each other!
     Even between non-veg proteins (e.g. Chicken vs Egg, Chicken vs Mutton, Fish vs Prawn), they MUST be separate dishes!
     Examples:
     - 'Hakka Noodles (Egg / Chicken)' or 'Hakka Noodles - Egg 209, Chicken 209':
       Extract as 2 SEPARATE items:
       - Item 1: 'Egg Hakka Noodles', price: 209, veg: "no", variations: []
       - Item 2: 'Chicken Hakka Noodles', price: 209, veg: "no", variations: []
     - 'Schezwan Noodles - Egg (219) / Chicken (239)':
       Extract as 2 SEPARATE items:
       - Item 1: 'Egg Schezwan Noodles', price: 219, veg: "no", variations: []
       - Item 2: 'Chicken Schezwan Noodles', price: 239, veg: "no", variations: []
     - 'Fried Rice (Veg / Egg / Chicken / Prawn)':
       Extract as 4 SEPARATE items:
       - 'Veg Fried Rice' (veg: "yes")
       - 'Egg Fried Rice' (veg: "no")
       - 'Chicken Fried Rice' (veg: "no")
       - 'Prawn Fried Rice' (veg: "no")
     - 'Biryani (Chicken / Mutton)':
       Extract as 2 SEPARATE items: 'Chicken Biryani' and 'Mutton Biryani'.
     - 'Piri Piri Crunchies (Paneer / Chicken)':
       Extract as 2 SEPARATE items: 'Paneer Piri Piri Crunchies' (veg: "yes") and 'Chicken Piri Piri Crunchies' (veg: "no").
   - Variations are strictly restricted to:
     1. Portion sizes of the same dish (e.g. 1 Piece / 2 Piece, Half / Full, Small / Medium / Large, 6 Pcs / 12 Pcs).
     2. Cooking / flavor styles of the same base (e.g. 'Bhajji - Onion/Mirchi/Potato', 'Momos - Steamed / Fried / Tandoori').
     3. Add-ons and toppings (type="multi", e.g. Extra Cheese, Dips).

4. PIECE, PORTION, & SIZE CONSOLIDATION:
   If the SAME dish appears multiple times or on separate lines with different piece counts, portion sizes, weights, or volumes:
   (e.g. 'Idali 1 Piece' & 'Idali 2 Piece', 'Chicken Tikka (6 Pcs)' & 'Chicken Tikka (12 Pcs)', 'Chicken Biryani (Half)' & 'Chicken Biryani (Full)', 'Cold Coffee (Regular)' & 'Cold Coffee (Large)', 'Paneer Butter Masala (Half)' & 'Paneer Butter Masala (Full)', 'Ice Cream (Single Scoop)' & 'Ice Cream (Double Scoop)'):
   CONSOLIDATE THEM INTO A SINGLE MENU ITEM. NEVER create separate items for different sizes/pieces of the same dish!
   - Base Name: Clean dish name (e.g. 'Idali', 'Chicken Tikka', 'Chicken Biryani', 'Cold Coffee').
   - Base Price: Lowest price (e.g. 48 for Idali 1 Piece, 180 for Chicken Tikka 6 Pcs).
   - Variations Group: Named "Portion" (type="single", required="off") with DELTA pricing:
   Example for Idali (1 Piece = ₹48, 2 Piece = ₹78):
   "name": "Idali", "price": 48, "veg": "yes", "variations": [{{"name": "Portion", "type": "single", "min": 0, "max": 0, "required": "off", "values": [{{"label": "1 Piece", "optionPrice": "0"}}, {{"label": "2 Piece", "optionPrice": "30"}}]}}]
   Example for Chicken Tikka (6 Pcs = ₹180, 12 Pcs = ₹320):
   "name": "Chicken Tikka", "price": 180, "veg": "no", "variations": [{{"name": "Portion", "type": "single", "min": 0, "max": 0, "required": "off", "values": [{{"label": "6 Pcs", "optionPrice": "0"}}, {{"label": "12 Pcs", "optionPrice": "140"}}]}}]

5. SEPARATE ROWS OF THE SAME DISH FAMILY (SAME BASE / COOKING STYLE ONLY):
   - If a menu lists separate rows for vegetable varieties or cooking styles of the same dish:
     (e.g., 'Onion Bhajji', 'Potato Bhajji', 'Mirchi Bhajji' or 'Steamed Momos', 'Fried Momos', 'Tandoori Momos'):
     Consolidate them into a single menu item with variation choices using delta pricing.
   - CRITICAL RESTRICTION: NEVER consolidate different proteins/meats/eggs (e.g. 'Egg Hakka Noodles' and 'Chicken Hakka Noodles', or 'Egg Rice' and 'Chicken Rice', or 'Chicken Biryani' and 'Mutton Biryani')! These MUST ALWAYS remain separate individual items!

6. ADD-ONS & EXTRAS EMBEDDED IN DESCRIPTIONS (CRITICAL):
   If ANY item mentions add-ons, extras, dips, toppings, or options in its description or title:
   (e.g., 'Cheesy Fries loaded with golden, cheesy melty goodness. ADD ON PIRI PIRI +20', 'Loaded Nachos. Add-ons: Jalapeno +15, Sour Cream +25', 'Chicken Burger. Extras: Extra Cheese @ 30 / Bacon +50'):
   - Clean Description: Strip out the raw add-on text from the dish description so only the clean culinary description remains (e.g. 'Cheesy fries loaded with golden, cheesy melty goodness.').
   - Base Item Price: Keep the dish price as listed (e.g. 179 for Cheesy Fries). Do NOT alter the main item base price for add-ons!
   - Variations Group: Create an 'Add-on' group with:
     name="Add-on", type="multi", required="off", min="0", max=str(count_of_addons)
   - Each add-on option has its additional price as optionPrice (e.g. optionPrice: "20").

7. MANDATORY SINGLE-TYPE VS OPTIONAL MULTI-TYPE VARIATIONS:
   - Single-type Variations (Portion sizes, piece counts, flavors where customer MUST choose exactly one):
     type="single", required="on", min="1", max="1". Main item price is the lowest option price (base option is optionPrice: "0", other options are extra delta differences).
   - Multi-type Variations (Add-ons, extras, toppings where customer can choose none, one, or multiple):
     type="multi", required="off", min="0", max=str(len(values)). Main item price remains the base dish price, and each option is priced as its extra add-on amount.

### GENERAL EXTRACTION RULES:
1. Item Name: Extract the clean common title of the food item. Do NOT include price inside the name.
2. Description: Extract the description or ingredients listed under the dish. If none, leave empty "". Strip any add-on text into the Add-on variation group!
3. Category Assignment:
   - Identify which category from the taxonomy above best fits each dish.
   - Provide the EXACT matching 'category_id' (e.g., '76', '3225') and 'category_name'.
   - If a dish doesn't have an exact match, choose the closest logical category (e.g. Chicken Shawarma -> Shawarma ID 3225, Butter Naan -> Roti, Paneer Tikka -> Paneer or Starters).
4. Veg / Non-Veg Classification:
   - Strictly set 'veg' to 'yes' if the item is vegetarian (vegetables, paneer, lentils, dairy, cheese, wheat, rice, fruits).
   - Strictly set 'veg' to 'no' if the item contains meat, chicken, mutton, egg, fish, seafood, or non-veg stock.
   - An item MUST NEVER mix Veg and Non-Veg variations. If a dish lists both, extract them as separate food items!
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

    # Pre-process: Split any items with mixed veg and non-veg variations into distinct items
    raw_item_dicts = []
    for item in payload.items:
        it_dict = item.model_dump() if hasattr(item, "model_dump") else dict(item)
        if isinstance(it_dict.get("variations"), str) and it_dict["variations"].strip().startswith("["):
            try:
                it_dict["variations"] = json.loads(it_dict["variations"])
            except Exception:
                pass
        it_dict = process_item_addons(it_dict)
        raw_item_dicts.append(it_dict)

    expanded_items = split_mixed_dietary_items(raw_item_dicts)

    for idx, item in enumerate(expanded_items):
        item_id = item.get("id") or (base_id + idx)
        
        # Category ID resolution
        cat_id = str(item.get("category_id") or "").strip()
        item_name = str(item.get("name") or "").strip()
        if not cat_id and item_name:
            matched_id, _ = category_service.find_match(item_name)
            if matched_id:
                cat_id = matched_id

        # Variations JSON serialization with normalized delta pricing
        raw_vars = item.get("variations") or []
        if isinstance(raw_vars, str) and raw_vars.strip().startswith("["):
            try:
                raw_vars = json.loads(raw_vars)
            except Exception:
                raw_vars = []

        normalized_item_data = normalize_variation_deltas({
            "name": item_name,
            "price": float(item.get("price", 0.0) or 0.0),
            "variations": raw_vars
        })

        price_val = float(normalized_item_data.get("price", item.get("price", 0.0) or 0.0))
        norm_vars = normalized_item_data.get("variations", [])
        variations_json = json.dumps(norm_vars, ensure_ascii=False) if norm_vars else "[]"

        # Veg normalization
        veg_str = "yes" if str(item.get("veg", "yes")).lower() in ["yes", "true", "1", "veg"] else "no"

        # Batch inputs (fallback to payload globals)
        store_id = item.get("store_id") or payload.global_store_id or 95
        module_id = item.get("module_id") or payload.global_module_id or 3
        discount = item.get("discount") if item.get("discount") is not None else (payload.global_discount or 0.0)
        discount_type = item.get("discount_type") or payload.global_discount_type or "percent"
        time_starts = item.get("available_time_starts") or payload.global_available_time_starts or "08:00:00"
        time_ends = item.get("available_time_ends") or payload.global_available_time_ends or "23:55:00"

        # 21-Column Row Tuple matching actual_menu_format.xlsx strictly
        row_data = [
            item_id,                             # 1. Id
            item_name,                           # 2. Name
            item.get("description") or "",       # 3. Description
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
            item.get("recommended") or "no"      # 21. Recommended ("no")
        ]

        ws.append(row_data)

    wb.save(output_path)

    return FileResponse(
        path=output_path,
        filename=output_filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

# =====================================================================
# DEDICATED AI DESCRIPTION GENERATION ENDPOINT (PHASE 2)
# =====================================================================

@router.post("/generate-descriptions")
async def generate_descriptions(payload: GenerateDescriptionsPayload):
    """
    Step 2 in two-phase description workflow:
    Accepts extracted items missing descriptions and calls Gemini text-generation model
    to create 10-15 word mouth-watering, culinarily accurate descriptions tailored to each dish.
    Guaranteed strictly between 10 and 15 words via enforce_word_count.
    """
    effective_key = settings.GEMINI_API_KEY
    if not effective_key:
        raise HTTPException(status_code=400, detail="No GEMINI_API_KEY configured. Please add your key to .env.")

    items_to_process = [it for it in payload.items if not (it.description or "").strip()]
    if not items_to_process:
        return {
            "status": "success",
            "message": "All items already have descriptions.",
            "descriptions": []
        }

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=effective_key)

        dishes_input = [
            {
                "index": it.index,
                "name": it.name,
                "category": it.category_name or "General",
                "dietary": "Vegetarian" if str(it.veg).lower() in ["yes", "true", "1", "veg"] else "Non-Vegetarian"
            }
            for it in items_to_process
        ]

        prompt = f"""You are a world-class restaurant culinary menu copywriter.
For each of the following dishes, write an appetizing, accurate culinary description tailored specifically to that dish's cuisine, taste, ingredients, and preparation style.

ITEMS TO DESCRIBE:
{json.dumps(dishes_input, indent=2)}

CRITICAL RULES:
1. Every description MUST be strictly between 10 and 15 words in length.
2. Accurately describe the ingredients, texture, flavor profile, and preparation style appropriate for that exact dish:
   - Desserts/Ice Creams/Shakes: cool, sweet, rich, creamy, decadent.
   - Salads/Fresh Items: crisp, garden-fresh, tossed, vibrant.
   - Wok/Chinese/Noodles/Fried Rice: wok-tossed, aromatic, crisp veggies, savory Asian sauces.
   - Biryani/Pulao: fragrant basmati rice, layered, caramelized onions, slow-cooked royal spices.
   - Tandoori/Breads/Pizza: clay-oven baked, warm, flaky, melted cheese, traditional seasonings.
   - Curries/Gravies: rich, velvety simmered sauce, authentic spices, tender meats or cottage cheese.
3. NEVER mention prices, currency symbols, or dietary tags in the description text.
4. Format output strictly according to the requested JSON schema.
"""

        candidate_models = [
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.7-flash",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
            "gemini-flash-latest"
        ]

        raw_results = None
        for model_name in candidate_models:
            for attempt in range(2):
                try:
                    response = client.models.generate_content(
                        model=model_name,
                        contents=prompt,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                            response_schema=DescriptionsContainer
                        )
                    )
                    if response.text:
                        parsed = json.loads(response.text)
                        raw_results = parsed.get("descriptions", [])
                        break
                except Exception as model_err:
                    err_str = str(model_err)
                    if "503" in err_str or "UNAVAILABLE" in err_str or "high demand" in err_str:
                        time.sleep(1.0)
                        continue
                    break
            if raw_results is not None:
                break

        if raw_results is None:
            raise HTTPException(status_code=503, detail="Gemini AI is temporarily busy. Please try again.")

        # Enforce strict 10-15 word guardrail on each generated description
        sanitized_results = []
        for res in raw_results:
            idx = res.get("index")
            raw_desc = res.get("description", "")
            final_desc = enforce_word_count(raw_desc, min_words=10, max_words=15)
            sanitized_results.append({
                "index": idx,
                "description": final_desc
            })

        return {
            "status": "success",
            "count": len(sanitized_results),
            "descriptions": sanitized_results
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Description generation failed: {str(e)}")
