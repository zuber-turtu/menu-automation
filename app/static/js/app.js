// MenuFlow AI State
let state = {
  menuFile: null,
  extractedItems: [],
  referenceSheets: [],
  selectedTemplate: null,
  categories: []
};

let editingVarIndex = null;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  fetchReferenceSheets();
  fetchCategories();
  setupDragAndDrop();
  initBatchSettings();
  initApiKeyStatus();

  // Escape key closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeVariationModal();
      closeApiKeyModal();
    }
  });

  // Sync variations form to raw JSON on change
  ['varGroupName', 'varGroupType', 'varGroupRequired'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', syncFormToJson);
      el.addEventListener('change', syncFormToJson);
    }
  });

  const rawJsonEl = document.getElementById('varRawJson');
  if (rawJsonEl) {
    rawJsonEl.addEventListener('input', syncJsonToForm);
  }
});

// =====================================================================
// 0. Non-blocking Toast Notification System
// =====================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = '';
  if (type === 'success') {
    icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (type === 'error') {
    icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  } else if (type === 'warning') {
    icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  } else {
    icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }

  toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// =====================================================================
// 1. Reference Sheets & Categories
// =====================================================================

async function fetchReferenceSheets() {
  const box = document.getElementById('templateStatusBox');
  try {
    const res = await fetch('/api/menu/reference-sheets');
    const data = await res.json();
    state.referenceSheets = data.sheets || [];

    if (state.referenceSheets.length > 0) {
      const preferred = state.referenceSheets.find(s => s.filename === 'actual_menu_format.xlsx');
      const activeSheet = preferred ? preferred.filename : state.referenceSheets[0].filename;
      state.selectedTemplate = activeSheet;
      box.innerHTML = `
        <span class="status-dot success"></span>
        <span style="color: var(--success); font-weight: 600;">✓ Template:</span>
        <span class="text-mono">${activeSheet} (21 cols)</span>
      `;
    } else {
      box.innerHTML = `
        <span class="status-dot idle"></span>
        <span class="text-muted">Standard 21-column actual portal template</span>
      `;
    }
  } catch (err) {
    box.innerHTML = `
      <span class="status-dot idle" style="background:var(--danger)"></span>
      <span style="color:var(--danger)">Error checking templates</span>
    `;
  }
}

async function uploadReferenceSheet(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const box = document.getElementById('templateStatusBox');
  box.innerHTML = `<div class="loading-spinner-sm"></div> <span class="text-muted">Uploading ${file.name}...</span>`;

  try {
    const res = await fetch('/api/menu/upload-reference', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (res.ok) {
      await fetchReferenceSheets();
      showToast(`Master Template '${file.name}' saved! Output strictly matches 21-column schema.`, 'success');
    } else {
      showToast(`Upload failed: ${result.detail || 'Error'}`, 'error');
      await fetchReferenceSheets();
    }
  } catch (err) {
    showToast(`Failed to upload reference: ${err.message}`, 'error');
    await fetchReferenceSheets();
  }
}

async function fetchCategories() {
  const box = document.getElementById('categoryStatusBox');
  try {
    const res = await fetch('/api/menu/categories');
    const data = await res.json();
    state.categories = data.categories || [];

    // Populate datalist for category auto-completion
    const datalist = document.getElementById('categoriesDatalist');
    if (datalist) {
      datalist.innerHTML = state.categories.map(c => `
        <option value="${escapeHtml(c.name)}">${c.id}: ${escapeHtml(c.name)}</option>
      `).join('');
    }

    if (state.categories.length > 0) {
      box.innerHTML = `
        <span class="status-dot success"></span>
        <span style="color: var(--success); font-weight: 600;">✓ Taxonomy:</span>
        <span>${state.categories.length} categories active (Turtu)</span>
      `;
    } else {
      box.innerHTML = `
        <span class="status-dot idle"></span>
        <span class="text-muted">No categories loaded. Upload categories_turtu.csv below.</span>
      `;
    }
  } catch (err) {
    box.innerHTML = `
      <span class="status-dot idle" style="background:var(--danger)"></span>
      <span style="color:var(--danger)">Error loading categories</span>
    `;
  }
}

async function uploadCategoryCsv(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const box = document.getElementById('categoryStatusBox');
  box.innerHTML = `<div class="loading-spinner-sm"></div> <span class="text-muted">Loading ${file.name}...</span>`;

  try {
    const res = await fetch('/api/menu/upload-categories', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (res.ok) {
      await fetchCategories();
      showToast(`Loaded ${result.count} categories! Gemini will match items directly to these IDs.`, 'success');
    } else {
      showToast(`Error: ${result.detail || 'Upload failed'}`, 'error');
      await fetchCategories();
    }
  } catch (err) {
    showToast(`Category upload error: ${err.message}`, 'error');
    await fetchCategories();
  }
}

// =====================================================================
// 2. Menu File Selection & Drag & Drop
// =====================================================================

function setupDragAndDrop() {
  const dropzone = document.getElementById('menuDropzone');
  if (!dropzone) return;
  
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--company-teal)';
      dropzone.style.background = 'var(--company-mint)';
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
    });
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processMenuFile(e.dataTransfer.files[0]);
    }
  });
}

function handleMenuFileSelected(event) {
  if (event.target.files && event.target.files[0]) {
    processMenuFile(event.target.files[0]);
  }
}

function processMenuFile(file) {
  state.menuFile = file;
  document.getElementById('menuDropzoneText').innerHTML = `
    <strong style="color:var(--success)">${escapeHtml(file.name)}</strong><br>
    <span>${(file.size / (1024 * 1024)).toFixed(2)} MB • Ready for AI extraction</span>
  `;
  document.getElementById('extractBtn').disabled = false;
  document.getElementById('previewDocName').innerText = file.name;

  // Render preview
  const preview = document.getElementById('previewContent');
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `<img src="${e.target.result}" alt="Menu Preview">`;
    };
    reader.readAsDataURL(file);
  } else if (file.type === 'application/pdf') {
    const fileUrl = URL.createObjectURL(file);
    preview.innerHTML = `<iframe src="${fileUrl}" width="100%" height="480px"></iframe>`;
  }
}

// =====================================================================
// 3. AI Extraction with Gemini Vision
// =====================================================================

async function startExtraction() {
  if (!state.menuFile) {
    showToast("Please choose or drag a menu PDF or image first.", "warning");
    return;
  }

  const btn = document.getElementById('extractBtn');
  const progContainer = document.getElementById('progressContainer');
  const progFill = document.getElementById('progressFill');
  const progText = document.getElementById('progressText');
  const progPercent = document.getElementById('progressPercent');

  btn.disabled = true;
  progContainer.style.display = 'block';
  progFill.style.width = '30%';
  progPercent.innerText = '30%';
  progText.innerText = 'Uploading document to Gemini Vision...';

  const formData = new FormData();
  formData.append('menu_file', state.menuFile);

  const customKey = localStorage.getItem('menu_gemini_api_key');
  if (customKey && customKey.trim().length > 5) {
    formData.append('api_key', customKey.trim());
  }

  try {
    progFill.style.width = '65%';
    progPercent.innerText = '65%';
    progText.innerText = 'Extracting dishes, Category IDs, Veg/Non-Veg & Variations...';

    const res = await fetch('/api/menu/extract-preview', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    progFill.style.width = '100%';
    progPercent.innerText = '100%';
    progText.innerText = 'Extraction complete!';

    setTimeout(() => {
      progContainer.style.display = 'none';
      btn.disabled = false;
    }, 500);

    if (data.status === 'success' && Array.isArray(data.items)) {
      state.extractedItems = data.items;
      renderTable(data.items);
      document.getElementById('downloadSheetBtn').disabled = false;
      showToast(`Extracted ${data.items.length} items with Category IDs!`, 'success');
    } else if (data.status === 'no_key') {
      showToast("Gemini API key is required for AI extraction.", "warning");
      openApiKeyModal();
    } else {
      showToast(data.message || "Extraction notice received.", "warning");
    }
  } catch (err) {
    progContainer.style.display = 'none';
    btn.disabled = false;
    showToast(`Extraction failed: ${err.message}`, 'error');
  }
}

// =====================================================================
// 4. Interactive Review Table & Dietary Separation
// =====================================================================

const NON_VEG_KEYWORDS = [
  'chicken', 'murgh', 'murg', 'mutton', 'gosht', 'meat', 'lamb', 'fish', 'prawn', 
  'prawns', 'shrimp', 'seafood', 'crab', 'squid', 'egg', 'eggs', 'anda', 'keema', 
  'beef', 'pork', 'bacon', 'ham', 'duck', 'non-veg', 'nonveg', 'non veg', 'wings', 'pepperoni'
];

const VEG_KEYWORDS = [
  'veg', 'vegetarian', 'pure veg', 'paneer', 'cottage cheese', 'mushroom', 'corn', 
  'aloo', 'potato', 'gobi', 'soya', 'soy', 'tofu', 'cheese', 'onion', 'mirchi', 
  'capsicum', 'palak', 'spinach', 'dal', 'plain', 'mix veg', 'vegetable'
];

function isNonVegLabel(text) {
  if (!text) return false;
  const clean = text.toLowerCase();
  return NON_VEG_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`, 'i').test(clean));
}

function isVegLabel(text) {
  if (!text) return false;
  if (isNonVegLabel(text)) return false;
  const clean = text.toLowerCase();
  return VEG_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`, 'i').test(clean));
}

const ADDON_HEADER_REGEX = /(?:[\.\,\;\-\(\[\{]?\s*(?:(?:with\s+)?(?:add\s*[-]?\s*ons?|extras?|add\s*[-]?\s*in|options?))\s*[:\-]?\s*)(.+)$/i;
const ADDON_DELIMITER_REGEX = /[,;/|]|\s*&\s*|\s+and\s+/i;

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

function extractAddonsFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return { cleanDesc: desc || '', addons: [] };
  const text = desc.trim();
  const match = text.match(ADDON_HEADER_REGEX);
  if (!match) return { cleanDesc: text, addons: [] };

  const addonRaw = match[1].trim().replace(/[\.\)\]\}]+$/, '');
  const cleanDesc = text.substring(0, match.index).trim().replace(/[\.\,\;\:\-]+$/, '');
  const rawTokens = addonRaw.split(ADDON_DELIMITER_REGEX).map(t => t.trim()).filter(Boolean);
  if (rawTokens.length === 0) rawTokens.push(addonRaw);

  const addons = [];
  for (const token of rawTokens) {
    const m1 = token.match(/^(.*?)(?:[\+@₹:\(]+|\s+)(\d+(?:\.\d+)?)\s*(?:\/-)?\s*[\)\]]*$/);
    if (m1 && m1[1].trim()) {
      const lbl = m1[1].trim().replace(/^[:+\-@₹\s\(\)]+|[:+\-@₹\s\(\)]+$/g, '');
      const p = Math.round(parseFloat(m1[2]));
      if (lbl.length >= 2 && !isNaN(p)) {
        addons.push({ label: toTitleCase(lbl), optionPrice: String(p) });
        continue;
      }
    }
    const m2 = token.match(/^(?:[\+@₹:\(]*\s*)(\d+(?:\.\d+)?)\s*(?:\/-)?\s*[\)\]]*\s+(.+)$/);
    if (m2 && m2[2].trim()) {
      const lbl = m2[2].trim().replace(/^[:+\-@₹\s\(\)]+|[:+\-@₹\s\(\)]+$/g, '');
      const p = Math.round(parseFloat(m2[1]));
      if (lbl.length >= 2 && !isNaN(p)) {
        addons.push({ label: toTitleCase(lbl), optionPrice: String(p) });
        continue;
      }
    }
  }

  return { cleanDesc, addons };
}

function processItemAddons(item) {
  if (!item || !item.description) return item;
  const { cleanDesc, addons } = extractAddonsFromDescription(item.description);
  if (addons && addons.length > 0) {
    item.description = cleanDesc;
    if (!Array.isArray(item.variations)) item.variations = [];
    
    let existingAddonGroup = item.variations.find(g => 
      g && (String(g.type).toLowerCase() === 'multi' || String(g.type).toLowerCase() === 'multiple' || String(g.name).toLowerCase().includes('add'))
    );

    if (existingAddonGroup) {
      existingAddonGroup.type = "multi";
      existingAddonGroup.required = "off";
      existingAddonGroup.min = "0";
      const existingLabels = new Set((existingAddonGroup.values || []).map(v => String(v.label || '').toLowerCase()));
      for (const a of addons) {
        if (!existingLabels.has(a.label.toLowerCase())) {
          existingAddonGroup.values.push(a);
        }
      }
      existingAddonGroup.max = String(existingAddonGroup.values.length);
    } else {
      item.variations.push({
        name: "Add-on",
        type: "multi",
        min: "0",
        max: String(addons.length),
        required: "off",
        values: addons
      });
    }
  }
  return item;
}

const PROTEIN_CLASSES = {
  chicken: ['chicken', 'murgh', 'murg', 'duck', 'turkey'],
  egg: ['egg', 'eggs', 'anda', 'omlet', 'omelette', 'omelet'],
  mutton: ['mutton', 'gosht', 'ghosht', 'meat', 'lamb', 'beef', 'pork', 'bacon', 'ham', 'keema', 'kheema'],
  fish: ['fish', 'machli', 'salmon', 'pomfret'],
  prawn: ['prawn', 'prawns', 'shrimp', 'shrimps', 'crab', 'squid', 'lobster', 'seafood'],
  paneer: ['paneer', 'cottage cheese', 'tofu', 'soya', 'soy'],
  mushroom: ['mushroom', 'mushrooms'],
  veg: ['veg', 'vegetarian', 'pure veg', 'mix veg', 'mixed veg', 'vegetable', 'vegetables']
};

const PREFIX_FOOD_NOUNS = [
  'hakka noodles', 'schezwan noodles', 'noodles', 'fried rice', 'rice',
  'biryani', 'pulao', 'roll', 'rolls', 'curry', 'masala', 'soup',
  'burger', 'burgers', 'pizza', 'pizzas', 'pasta', 'momos', 'sandwich',
  'sandwiches', 'maggi', 'puff', 'puffs', 'manchurian', 'wrap', 'wraps',
  'kebab', 'kebabs', 'tikka', 'crunchies', 'platter', 'thali'
];

function getProteinClass(text) {
  if (!text) return null;
  const clean = text.toLowerCase();
  for (const [pClass, terms] of Object.entries(PROTEIN_CLASSES)) {
    if (terms.some(t => new RegExp(`\\b${t}\\b`, 'i').test(clean))) {
      return pClass;
    }
  }
  return null;
}

function shouldSplitProteinOrDietary(labels) {
  if (!Array.isArray(labels) || labels.length < 2) return false;
  const hasNv = labels.some(isNonVegLabel);
  const hasV = labels.some(isVegLabel);
  if (hasNv && hasV) return true;

  const classes = new Set();
  for (const l of labels) {
    const p = getProteinClass(l);
    if (p) classes.add(p);
  }
  return classes.size >= 2;
}

function formatSplitDishTitle(baseName, optLabel) {
  const cleanBase = (baseName || '').replace(/\s*-\s*(Paneer|Chicken|Veg|Non-Veg|Egg|Mutton|Prawn|Fish)$/i, '').trim();
  const optClean = (optLabel || '').trim();
  if (cleanBase.toLowerCase().includes(optClean.toLowerCase())) {
    return cleanBase;
  }
  const lowerBase = cleanBase.toLowerCase();
  for (const noun of PREFIX_FOOD_NOUNS) {
    if (lowerBase === noun || lowerBase.endsWith(' ' + noun)) {
      return `${optClean} ${cleanBase}`;
    }
  }
  return `${cleanBase} - ${optClean}`;
}

function getDishVegStatus(dishName, optLabel) {
  const combined = `${dishName} ${optLabel}`.toLowerCase();
  if (isNonVegLabel(combined)) return 'no';
  if (isVegLabel(combined)) return 'yes';
  return 'yes';
}

function splitProteinAndDietaryItems(items) {
  if (!Array.isArray(items)) return [];
  const result = [];

  for (const item of items) {
    let splitGroupIdx = -1;
    if (Array.isArray(item.variations) && item.variations.length > 0) {
      for (let gIdx = 0; gIdx < item.variations.length; gIdx++) {
        const group = item.variations[gIdx];
        const values = group.values || [];
        const labels = values.map(v => (v.label || '').trim()).filter(Boolean);

        if (shouldSplitProteinOrDietary(labels)) {
          splitGroupIdx = gIdx;
          break;
        }
      }
    }

    if (splitGroupIdx >= 0) {
      const group = item.variations[splitGroupIdx];
      const basePrice = Number(item.price) || 0;
      const otherGroups = item.variations.filter((_, idx) => idx !== splitGroupIdx);

      for (const opt of group.values) {
        const optLbl = (opt.label || '').trim();
        const optDelta = Number(opt.optionPrice) || 0;
        const dishTitle = formatSplitDishTitle(item.name || '', optLbl);
        const dishVeg = getDishVegStatus(dishTitle, optLbl);

        result.push({
          ...item,
          name: dishTitle,
          price: Math.round((basePrice + optDelta) * 100) / 100,
          veg: dishVeg,
          variations: otherGroups
        });
      }
    } else {
      result.push(item);
    }
  }

  return result;
}

// Backward-compatibility alias
const splitMixedDietaryItems = splitProteinAndDietaryItems;

function renderTable(items) {
  // Pre-process any add-ons embedded in item descriptions
  items = (items || []).map(it => processItemAddons(it));
  // Enforce strict dietary separation: dishes with both veg and non-veg options split into distinct food items
  items = splitMixedDietaryItems(items);
  state.extractedItems = items;

  const tbody = document.getElementById('menuItemsBody');
  document.getElementById('itemsCountBadge').innerText = items.length;

  if (!items || items.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7" class="text-center text-muted">Upload a menu document and click "Extract Menu with Gemini AI" to populate the sheet.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map((item, idx) => {
    // Format variations badge with clear multi-group support
    let varBadge = `
      <button type="button" class="add-var-btn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        Add Sizes / Add-ons
      </button>
    `;
    if (Array.isArray(item.variations) && item.variations.length > 0) {
      const groupSummaries = item.variations.map(g => {
        const isMulti = (g.type === 'multi' || g.type === 'multiple' || String(g.name).toLowerCase().includes('add'));
        const optSummary = (g.values || []).map(v => {
          const delta = parseFloat(v.optionPrice) || 0;
          return `${v.label} (+₹${delta})`;
        }).join(', ');
        const badgeType = isMulti ? 'Multi/Opt' : 'Single/Req';
        return `${escapeHtml(g.name || 'Portion')} [${badgeType}]: ${escapeHtml(optSummary)}`;
      });

      varBadge = `
        <div class="var-tag" title="Click to edit variations: ${escapeHtml(JSON.stringify(item.variations))}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${groupSummaries.join(' • ') || 'Configured'}</span>
        </div>
      `;
    }

    const isVeg = (String(item.veg).toLowerCase() === 'yes');

    return `
      <tr data-index="${idx}">
        <td>
          <div class="cat-cell-wrapper">
            <input 
              type="text" 
              class="table-input cat-input"
              list="categoriesDatalist" 
              value="${escapeHtml(item.category_name || '')}" 
              placeholder="Search category or ID..."
              onchange="handleCategoryChange(${idx}, this.value)"
              title="${escapeHtml(item.category_name || '')}"
            >
            <span class="cat-badge" id="catBadge_${idx}" title="${item.category_id ? 'Turtu Category ID: ' + item.category_id : 'Unmapped Category'}">${escapeHtml(item.category_id || '-')}</span>
          </div>
        </td>
        <td>
          <input 
            type="text" 
            class="table-input" 
            value="${escapeHtml(item.name || '')}" 
            onchange="updateItemField(${idx}, 'name', this.value)" 
            placeholder="Dish title"
            title="${escapeHtml(item.name || '')}"
          >
        </td>
        <td>
          <div class="price-input-wrapper">
            <span class="currency-prefix">₹</span>
            <input 
              type="number" 
              step="1" 
              min="0"
              value="${item.price !== null && item.price !== undefined ? item.price : ''}" 
              onchange="updateItemField(${idx}, 'price', parseFloat(this.value) || 0)"
              placeholder="0"
            >
          </div>
        </td>
        <td>
          <select class="dietary-select" onchange="updateItemField(${idx}, 'veg', this.value)">
            <option value="yes" ${isVeg ? 'selected' : ''}>🟢 Veg</option>
            <option value="no" ${!isVeg ? 'selected' : ''}>🔴 Non-Veg</option>
          </select>
        </td>
        <td>
          <div class="var-cell-container" onclick="openVariationModal(${idx})" title="Click to edit portion sizes">
            ${varBadge}
          </div>
        </td>
        <td>
          <input 
            type="text" 
            class="table-input" 
            value="${escapeHtml(item.description || '')}" 
            onchange="updateItemField(${idx}, 'description', this.value)" 
            placeholder="Optional description"
            title="${escapeHtml(item.description || '')}"
          >
        </td>
        <td style="text-align: center;">
          <button type="button" class="btn-del-row" onclick="deleteRow(${idx})" title="Delete row">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function handleCategoryChange(index, newCategoryName) {
  const item = state.extractedItems[index];
  if (!item) return;

  const val = (newCategoryName || '').trim();
  item.category_name = val;

  if (!val) {
    item.category_id = '';
    const badge = document.getElementById(`catBadge_${index}`);
    if (badge) badge.innerText = '-';
    return;
  }

  // 1. Check if user typed a pure numeric ID (e.g., '76' or '3225')
  let matched = state.categories.find(c => String(c.id) === val);

  // 2. Check if user typed "76: Biryani" or "Biryani [76]" or "Biryani (76)"
  if (!matched) {
    const idMatch = val.match(/^(\d+)\s*:\s*(.*)$/) || val.match(/^(.*?)\s*[\(\[](\d+)[\)\]]$/);
    if (idMatch) {
      const possibleId = idMatch[1].match(/^\d+$/) ? idMatch[1] : idMatch[2];
      matched = state.categories.find(c => String(c.id) === possibleId);
    }
  }

  // 3. Exact category name match (case-insensitive)
  if (!matched) {
    matched = state.categories.find(c => c.name.toLowerCase() === val.toLowerCase());
  }

  // 4. Substring containment match
  if (!matched && val.length >= 3) {
    matched = state.categories.find(c => c.name.toLowerCase().includes(val.toLowerCase()));
  }

  if (matched) {
    item.category_id = String(matched.id);
    item.category_name = matched.name;
    const inputEl = document.querySelector(`tr[data-index="${index}"] input[list="categoriesDatalist"]`);
    if (inputEl) inputEl.value = matched.name;
  }

  // Update badge UI
  const badge = document.getElementById(`catBadge_${index}`);
  if (badge) {
    badge.innerText = item.category_id || '-';
    badge.title = item.category_id ? `Turtu Category ID: ${item.category_id}` : 'Unmapped Category';
  }
}

function updateItemField(index, field, value) {
  const item = state.extractedItems[index];
  if (!item) return;

  item[field] = value;

  if (field === 'description') {
    const { cleanDesc, addons } = extractAddonsFromDescription(value);
    if (addons && addons.length > 0) {
      processItemAddons(item);
      renderTable(state.extractedItems);
      showToast(`Detected & added ${addons.length} add-on(s) to item variations!`, 'success');
    }
  }
}

function addNewRow() {
  const newItem = {
    name: "New Item",
    category_name: state.categories.length > 0 ? state.categories[0].name : "General",
    category_id: state.categories.length > 0 ? String(state.categories[0].id) : "",
    price: 0.0,
    veg: "yes",
    variations: [],
    description: ""
  };
  state.extractedItems.push(newItem);
  renderTable(state.extractedItems);
  document.getElementById('downloadSheetBtn').disabled = false;
  showToast("Added new row to table", "info");
}

function deleteRow(index) {
  const removed = state.extractedItems.splice(index, 1);
  renderTable(state.extractedItems);
  if (state.extractedItems.length === 0) {
    document.getElementById('downloadSheetBtn').disabled = true;
  }
  showToast(`Deleted "${removed[0]?.name || 'Item'}"`, "info");
}

// =====================================================================
// 5. Visual Variations Modal Controller (Multi-Group & Add-on Support)
// =====================================================================

let currentVarGroups = [];
let currentVarGroupIdx = 0;

function openVariationModal(index) {
  editingVarIndex = index;
  const item = state.extractedItems[index];
  if (!item) return;

  document.getElementById('varModalTitle').innerText = `Edit Variations: ${item.name || 'Dish'}`;
  document.getElementById('varModalSubtitle').innerText = `Base Item Price: ₹${item.price || 0} • Formatted for Turtu actual import`;

  if (Array.isArray(item.variations) && item.variations.length > 0) {
    currentVarGroups = JSON.parse(JSON.stringify(item.variations));
  } else {
    currentVarGroups = [{
      name: "Portion",
      type: "single",
      min: "1",
      max: "1",
      required: "on",
      values: []
    }];
  }
  currentVarGroupIdx = 0;
  renderVarGroupTabs();
  loadCurrentGroupIntoForm();
  document.getElementById('variationModal').style.display = 'flex';
}

function closeVariationModal() {
  const modal = document.getElementById('variationModal');
  if (modal) modal.style.display = 'none';
  editingVarIndex = null;
  currentVarGroups = [];
  currentVarGroupIdx = 0;
}

function renderVarGroupTabs() {
  const bar = document.getElementById('varGroupsBar');
  const tabsContainer = document.getElementById('varGroupTabs');
  if (!bar || !tabsContainer) return;

  bar.style.display = 'flex';
  tabsContainer.innerHTML = currentVarGroups.map((g, idx) => {
    const isSelected = (idx === currentVarGroupIdx);
    const isMulti = (g.type === 'multi' || g.type === 'multiple' || String(g.name).toLowerCase().includes('add'));
    const typeLabel = isMulti ? 'Multi/Opt' : 'Single/Req';
    return `
      <button type="button" class="preset-chip ${isSelected ? 'active' : ''}" 
        style="${isSelected ? 'background: var(--company-teal); color: white; border-color: var(--company-teal); font-weight: 700;' : ''}"
        onclick="switchVariationGroup(${idx})">
        ${escapeHtml(g.name || 'Group ' + (idx + 1))} (${typeLabel})
        ${currentVarGroups.length > 1 ? `<span onclick="event.stopPropagation(); removeVariationGroup(${idx});" style="margin-left: 6px; font-weight: bold; opacity: 0.8; cursor: pointer;" title="Delete group">&times;</span>` : ''}
      </button>
    `;
  }).join('');
}

function switchVariationGroup(index) {
  syncCurrentGroupFromForm();
  currentVarGroupIdx = index;
  renderVarGroupTabs();
  loadCurrentGroupIntoForm();
}

function addNewVariationGroup() {
  syncCurrentGroupFromForm();
  currentVarGroups.push({
    name: "Add-on",
    type: "multi",
    min: "0",
    max: "1",
    required: "off",
    values: []
  });
  currentVarGroupIdx = currentVarGroups.length - 1;
  renderVarGroupTabs();
  loadCurrentGroupIntoForm();
  addVariationOptionRow('', '');
  showToast("Added new variation group (Add-on)", "info");
}

function removeVariationGroup(index) {
  if (currentVarGroups.length <= 1) {
    showToast("Dish must have at least one variation group", "warning");
    return;
  }
  currentVarGroups.splice(index, 1);
  if (currentVarGroupIdx >= currentVarGroups.length) {
    currentVarGroupIdx = currentVarGroups.length - 1;
  }
  renderVarGroupTabs();
  loadCurrentGroupIntoForm();
  showToast("Removed variation group", "info");
}

function updatePricingHint(type) {
  const hintEl = document.getElementById('varPricingHint');
  if (!hintEl) return;
  if (type === 'multiple' || type === 'multi') {
    hintEl.innerText = "Multi/Add-on (Optional): Base dish price untouched • Each option adds extra ₹";
    hintEl.style.color = "var(--company-saffron)";
  } else {
    hintEl.innerText = "Single (Mandatory): Customer must pick 1 • Lowest option is base (₹0), others are deltas";
    hintEl.style.color = "var(--company-teal)";
  }
}

function loadCurrentGroupIntoForm() {
  const g = currentVarGroups[currentVarGroupIdx] || {
    name: "Portion",
    type: "single",
    required: "on",
    values: []
  };

  const isMulti = (g.type === "multi" || g.type === "multiple" || String(g.name).toLowerCase().includes('add'));
  document.getElementById('varGroupName').value = g.name || (isMulti ? "Add-on" : "Portion");
  document.getElementById('varGroupType').value = isMulti ? "multiple" : "single";
  document.getElementById('varGroupRequired').value = g.required || (isMulti ? "off" : "on");

  updatePricingHint(isMulti ? "multiple" : "single");

  const container = document.getElementById('variationOptionsList');
  container.innerHTML = '';
  if (Array.isArray(g.values) && g.values.length > 0) {
    g.values.forEach(v => addVariationOptionRow(v.label, v.optionPrice));
  } else {
    addVariationOptionRow('', '');
  }

  syncFormToJson();
}

function handleVarGroupNameChange(val) {
  if (currentVarGroups[currentVarGroupIdx]) {
    currentVarGroups[currentVarGroupIdx].name = val.trim() || "Portion";
  }
  renderVarGroupTabs();
  syncFormToJson();
}

function handleVarGroupTypeChange(type) {
  const reqSelect = document.getElementById('varGroupRequired');
  const nameInput = document.getElementById('varGroupName');
  if (type === 'single') {
    if (reqSelect) reqSelect.value = 'on';
    if (nameInput && nameInput.value.toLowerCase().includes('add-on')) {
      nameInput.value = 'Portion';
    }
  } else {
    if (reqSelect) reqSelect.value = 'off';
    if (nameInput && (nameInput.value.toLowerCase().includes('portion') || nameInput.value.toLowerCase() === 'variation')) {
      nameInput.value = 'Add-on';
    }
  }
  updatePricingHint(type);
  if (currentVarGroups[currentVarGroupIdx]) {
    currentVarGroups[currentVarGroupIdx].name = nameInput ? nameInput.value : "Group";
    currentVarGroups[currentVarGroupIdx].type = (type === 'multiple' || type === 'multi') ? "multi" : "single";
    currentVarGroups[currentVarGroupIdx].required = reqSelect ? reqSelect.value : (type === 'single' ? "on" : "off");
  }
  renderVarGroupTabs();
  syncFormToJson();
}

function addVariationOptionRow(label = '', price = '') {
  const container = document.getElementById('variationOptionsList');
  const row = document.createElement('div');
  row.className = 'variation-option-row';
  row.innerHTML = `
    <input type="text" class="opt-label" placeholder="Option (e.g. Onion, 1 Piece, Half, Piri Piri)" value="${escapeHtml(label)}" style="flex: 2;">
    <div style="display:flex; align-items:center; gap: 4px; flex: 1.2;">
      <span style="color:var(--text-muted); font-size:0.85rem;">+₹</span>
      <input type="number" class="opt-price" placeholder="0 for base" value="${price !== '' && price !== null && price !== undefined ? price : ''}" style="width: 100%;">
    </div>
    <button type="button" class="btn-remove-opt" onclick="this.parentElement.remove(); syncFormToJson();" title="Remove option">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  `;

  row.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', syncFormToJson);
  });

  container.appendChild(row);
  syncFormToJson();
}

function applyVariationPreset(preset) {
  const basePrice = (editingVarIndex !== null && state.extractedItems[editingVarIndex] && state.extractedItems[editingVarIndex].price) ? Number(state.extractedItems[editingVarIndex].price) : 200;
  const container = document.getElementById('variationOptionsList');
  container.innerHTML = '';

  if (preset === 'clear') {
    currentVarGroups = [];
    document.getElementById('varRawJson').value = '[]';
    renderVarGroupTabs();
    showToast("Cleared variations for item", "info");
    return;
  }

  if (preset === 'addon') {
    document.getElementById('varGroupName').value = "Add-on";
    document.getElementById('varGroupType').value = "multiple";
    document.getElementById('varGroupRequired').value = "off";
    updatePricingHint("multiple");
    addVariationOptionRow('Extra Cheese', 30);
    addVariationOptionRow('Piri Piri Seasoning', 20);
    syncFormToJson();
    renderVarGroupTabs();
    return;
  }

  if (preset === 'flavors_same_price') {
    document.getElementById('varGroupName').value = "Variation";
    document.getElementById('varGroupType').value = "single";
    document.getElementById('varGroupRequired').value = "on";
    updatePricingHint("single");
    addVariationOptionRow('Onion', 0);
    addVariationOptionRow('Potato', 0);
    addVariationOptionRow('Mirchi', 0);
    syncFormToJson();
    renderVarGroupTabs();
    return;
  }

  document.getElementById('varGroupName').value = (preset === 's_m_l' || preset === 'reg_large') ? "Size" : "Portion";
  document.getElementById('varGroupType').value = "single";
  document.getElementById('varGroupRequired').value = "on";
  updatePricingHint("single");

  if (preset === 'half_full') {
    const extra = Math.round((basePrice * 0.4) / 10) * 10 || 50;
    addVariationOptionRow('Half', 0);
    addVariationOptionRow('Full', extra);
  } else if (preset === 's_m_l') {
    const medExtra = Math.round((basePrice * 0.25) / 10) * 10 || 40;
    const largeExtra = Math.round((basePrice * 0.55) / 10) * 10 || 90;
    addVariationOptionRow('Small', 0);
    addVariationOptionRow('Medium', medExtra);
    addVariationOptionRow('Large', largeExtra);
  } else if (preset === 'reg_large') {
    const extra = Math.round((basePrice * 0.35) / 10) * 10 || 50;
    addVariationOptionRow('Regular', 0);
    addVariationOptionRow('Large', extra);
  } else if (preset === 'q_h_f') {
    const halfExtra = Math.round((basePrice * 0.35) / 10) * 10 || 40;
    const fullExtra = Math.round((basePrice * 0.75) / 10) * 10 || 90;
    addVariationOptionRow('Quarter', 0);
    addVariationOptionRow('Half', halfExtra);
    addVariationOptionRow('Full', fullExtra);
  }

  syncFormToJson();
  renderVarGroupTabs();
}

function syncCurrentGroupFromForm() {
  const container = document.getElementById('variationOptionsList');
  if (!container) return;

  const rows = container.querySelectorAll('.variation-option-row');
  const values = [];

  rows.forEach(r => {
    const label = r.querySelector('.opt-label')?.value.trim();
    const priceVal = r.querySelector('.opt-price')?.value.trim();
    if (label) {
      values.push({
        label: label,
        optionPrice: String(priceVal !== "" && priceVal !== null && priceVal !== undefined ? priceVal : "0")
      });
    }
  });

  const groupName = document.getElementById('varGroupName').value.trim() || "Portion";
  const groupType = document.getElementById('varGroupType').value || "single";
  const isMulti = (groupType === "multiple" || groupType === "multi");
  const groupReq = document.getElementById('varGroupRequired').value || (isMulti ? "off" : "on");

  if (!currentVarGroups[currentVarGroupIdx]) {
    currentVarGroups[currentVarGroupIdx] = {};
  }

  currentVarGroups[currentVarGroupIdx] = {
    name: groupName,
    type: isMulti ? "multi" : "single",
    min: isMulti ? "0" : "1",
    max: isMulti ? String(values.length) : "1",
    required: isMulti ? groupReq : "on",
    values: values
  };
}

function syncFormToJson() {
  syncCurrentGroupFromForm();
  const activeGroups = currentVarGroups.filter(g => g && Array.isArray(g.values) && g.values.length > 0);
  document.getElementById('varRawJson').value = JSON.stringify(activeGroups, null, 2);
}

function syncJsonToForm() {
  const rawText = document.getElementById('varRawJson').value.trim();
  if (!rawText) return;

  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed) && parsed.length > 0) {
      currentVarGroups = parsed;
      currentVarGroupIdx = 0;
      renderVarGroupTabs();
      loadCurrentGroupIntoForm();
    } else if (Array.isArray(parsed) && parsed.length === 0) {
      currentVarGroups = [];
      renderVarGroupTabs();
      document.getElementById('variationOptionsList').innerHTML = '';
    }
  } catch (e) {
    // Invalid JSON during user typing, keep current UI
  }
}

function saveVariationModal() {
  if (editingVarIndex === null || !state.extractedItems[editingVarIndex]) {
    closeVariationModal();
    return;
  }

  syncCurrentGroupFromForm();
  const rawJson = document.getElementById('varRawJson').value.trim();
  try {
    let parsed = JSON.parse(rawJson || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      parsed.forEach(group => {
        if (!group || !Array.isArray(group.values) || group.values.length === 0) return;
        
        const gType = (group.type || 'single').toLowerCase();
        const gName = (group.name || '').toLowerCase();
        const isAddon = (gType === 'multiple' || gType === 'multi') || gName.includes('add') || gName.includes('extra') || gName.includes('topping');

        if (isAddon) {
          // Multi-type Add-ons: optional, min 0, max count, do NOT alter base item price
          group.type = "multi";
          group.required = "off";
          group.min = "0";
          group.max = String(group.values.length);
          group.values.forEach(v => {
            const p = parseFloat(v.optionPrice) || 0;
            v.optionPrice = String(Math.round(p * 100) / 100);
          });
        } else {
          // Single-type Variations: mandatory choice, min 1, max 1, delta pricing
          group.type = "single";
          group.required = "on";
          group.min = "1";
          group.max = "1";

          const numPrices = group.values.map(v => parseFloat(v.optionPrice) || 0);
          const minP = Math.min(...numPrices);
          const maxP = Math.max(...numPrices);

          if (minP === maxP && minP > 0) {
            state.extractedItems[editingVarIndex].price = minP;
            group.values.forEach(v => { v.optionPrice = "0"; });
          } else if (minP > 0) {
            state.extractedItems[editingVarIndex].price = minP;
            group.values.forEach(v => {
              const delta = (parseFloat(v.optionPrice) || 0) - minP;
              v.optionPrice = String(Math.round(delta * 100) / 100);
            });
          } else {
            group.values.forEach(v => {
              const delta = parseFloat(v.optionPrice) || 0;
              v.optionPrice = String(Math.round(delta * 100) / 100);
            });
          }
        }
      });
    }

    state.extractedItems[editingVarIndex].variations = Array.isArray(parsed) ? parsed : [];
    const prevCount = state.extractedItems.length;
    state.extractedItems = splitMixedDietaryItems(state.extractedItems);
    renderTable(state.extractedItems);
    closeVariationModal();
    if (state.extractedItems.length > prevCount) {
      showToast("Split dish into separate Veg and Non-Veg items as per dietary catalog rules.", "info");
    } else {
      showToast(`Saved variations with delta pricing for "${state.extractedItems[editingVarIndex]?.name || 'Dish'}"`, "success");
    }
  } catch (err) {
    showToast("Invalid JSON in advanced editor. Please fix formatting.", "error");
  }
}

// =====================================================================
// 6. Gemini API Key Configuration
// =====================================================================

function initApiKeyStatus() {
  const customKey = localStorage.getItem('menu_gemini_api_key');
  const badge = document.getElementById('apiKeyStatusBadge');
  if (customKey && customKey.trim().length > 5 && badge) {
    badge.innerHTML = `<span class="status-indicator active"></span> Gemini Key Configured`;
  }
}

function openApiKeyModal() {
  const customKey = localStorage.getItem('menu_gemini_api_key') || '';
  const input = document.getElementById('geminiApiKeyInput');
  input.value = customKey;

  const clearBtn = document.getElementById('clearApiKeyBtn');
  clearBtn.style.display = customKey ? 'block' : 'none';

  const notice = document.getElementById('apiKeyNoticeBox');
  if (customKey) {
    notice.innerHTML = `<span style="color:var(--success);">✓ Active custom key loaded (${customKey.slice(0, 6)}...${customKey.slice(-4)})</span>`;
  } else {
    notice.innerHTML = `<span class="text-muted">No custom key stored. Using environment variable if present.</span>`;
  }

  document.getElementById('apiKeyModal').style.display = 'flex';
}

function closeApiKeyModal() {
  const modal = document.getElementById('apiKeyModal');
  if (modal) modal.style.display = 'none';
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('geminiApiKeyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function saveApiKey() {
  const input = document.getElementById('geminiApiKeyInput');
  const key = input.value.trim();

  if (key) {
    localStorage.setItem('menu_gemini_api_key', key);
    const badge = document.getElementById('apiKeyStatusBadge');
    if (badge) {
      badge.innerHTML = `<span class="status-indicator active"></span> Gemini Key Configured`;
    }
    showToast("Gemini API Key saved for this browser session!", "success");
  }
  closeApiKeyModal();
}

function clearApiKey() {
  localStorage.removeItem('menu_gemini_api_key');
  const badge = document.getElementById('apiKeyStatusBadge');
  if (badge) {
    badge.innerHTML = `<span class="status-indicator idle"></span> Key Needed`;
  }
  showToast("Custom Gemini API key cleared.", "info");
  closeApiKeyModal();
}

// =====================================================================
// 7. Batch Parameters Persistence
// =====================================================================

function initBatchSettings() {
  const fields = [
    'batchStoreId',
    'batchModuleId',
    'batchDiscount',
    'batchDiscountType',
    'batchTimeStarts',
    'batchTimeEnds'
  ];

  fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    // Restore from localStorage
    const saved = localStorage.getItem('menu_' + id);
    if (saved !== null && saved !== '') {
      el.value = saved;
    }

    // Save on change
    el.addEventListener('input', () => {
      localStorage.setItem('menu_' + id, el.value);
    });
    el.addEventListener('change', () => {
      localStorage.setItem('menu_' + id, el.value);
    });
  });
}

// =====================================================================
// 8. Excel Generation (21-Column Actual Portal Format)
// =====================================================================

async function generateAndDownloadExcel() {
  if (state.extractedItems.length === 0) {
    showToast("Please extract or add menu items before generating spreadsheet.", "warning");
    return;
  }

  // Pre-split any items with mixed dietary variations before exporting
  state.extractedItems = splitMixedDietaryItems(state.extractedItems);

  const btn = document.getElementById('downloadSheetBtn');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<div class="loading-spinner-sm"></div> Exporting 21-Col Sheet...`;
  btn.disabled = true;

  // Collect batch settings with strict time normalization
  const storeId = parseInt(document.getElementById('batchStoreId').value) || 95;
  const moduleId = parseInt(document.getElementById('batchModuleId').value) || 3;
  const discount = parseFloat(document.getElementById('batchDiscount').value) || 0.0;
  const discountType = document.getElementById('batchDiscountType').value || 'percent';
  const rawStarts = document.getElementById('batchTimeStarts').value;
  const rawEnds = document.getElementById('batchTimeEnds').value;
  const timeStarts = formatToExcelTime(rawStarts, '08:00:00');
  const timeEnds = formatToExcelTime(rawEnds, '23:55:00');

  const payload = {
    items: state.extractedItems,
    template_filename: state.selectedTemplate,
    global_store_id: storeId,
    global_module_id: moduleId,
    global_discount: discount,
    global_discount_type: discountType,
    global_available_time_starts: timeStarts,
    global_available_time_ends: timeEnds
  };

  try {
    const res = await fetch('/api/menu/generate-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'actual_menu_format_upload.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast("Excel spreadsheet downloaded successfully!", "success");
    } else {
      const err = await res.json();
      showToast(`Generation failed: ${err.detail || 'Unknown error'}`, "error");
    }
  } catch (err) {
    showToast(`Download error: ${err.message}`, "error");
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

function applyTimingPreset(presetValue) {
  if (!presetValue) return;
  const parts = presetValue.split('_');
  if (parts.length === 2) {
    const starts = parts[0];
    const ends = parts[1];
    const startsEl = document.getElementById('batchTimeStarts');
    const endsEl = document.getElementById('batchTimeEnds');
    if (startsEl) {
      startsEl.value = starts;
      localStorage.setItem('menu_batchTimeStarts', starts);
    }
    if (endsEl) {
      endsEl.value = ends;
      localStorage.setItem('menu_batchTimeEnds', ends);
    }
    showToast(`Timing preset applied: ${starts} to ${ends}`, 'info');
  }
}

function formatToExcelTime(timeStr, defaultTime) {
  if (!timeStr) return defaultTime;
  const trimmed = timeStr.trim();
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
  }
  if (parts.length >= 3) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  }
  return defaultTime;
}

// Modal helper for backdrop click
function handleModalOverlayClick(event, modalId) {
  if (event.target && event.target.id === modalId) {
    if (modalId === 'variationModal') closeVariationModal();
    if (modalId === 'apiKeyModal') closeApiKeyModal();
  }
}

function escapeHtml(string) {
  if (!string && string !== 0) return '';
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
