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
// 1. Tab Navigation & View Switching
// =====================================================================

function switchMainTab(tabName) {
  const digitizerBtn = document.getElementById('tabBtnDigitizer');
  const categoriesBtn = document.getElementById('tabBtnCategories');
  const digitizerPanel = document.getElementById('panelDigitizer');
  const categoriesPanel = document.getElementById('panelCategories');

  if (tabName === 'categories') {
    if (digitizerBtn) digitizerBtn.classList.remove('active');
    if (categoriesBtn) categoriesBtn.classList.add('active');
    if (digitizerPanel) digitizerPanel.style.display = 'none';
    if (categoriesPanel) {
      categoriesPanel.style.display = 'block';
      // Reset search input on switch
      const searchInput = document.getElementById('categorySearchInput');
      if (searchInput) searchInput.value = '';
      renderCategoriesTable(state.categories);
    }
  } else {
    if (categoriesBtn) categoriesBtn.classList.remove('active');
    if (digitizerBtn) digitizerBtn.classList.add('active');
    if (categoriesPanel) categoriesPanel.style.display = 'none';
    if (digitizerPanel) digitizerPanel.style.display = 'block';
  }
}

// =====================================================================
// 2. Reference Sheets & Category Taxonomy
// =====================================================================

async function fetchReferenceSheets() {
  try {
    const res = await fetch('/api/menu/reference-sheets');
    const data = await res.json();
    state.referenceSheets = data.sheets || [];

    if (state.referenceSheets.length > 0) {
      const preferred = state.referenceSheets.find(s => s.filename === 'actual_menu_format.xlsx');
      state.selectedTemplate = preferred ? preferred.filename : state.referenceSheets[0].filename;
    } else {
      state.selectedTemplate = 'actual_menu_format.xlsx';
    }
  } catch (err) {
    console.warn("Reference sheets check:", err);
    state.selectedTemplate = 'actual_menu_format.xlsx';
  }
}

async function fetchCategories() {
  try {
    const res = await fetch('/api/menu/categories');
    const data = await res.json();
    state.categories = data.categories || [];

    // Populate datalist for category auto-completion in review table
    const datalist = document.getElementById('categoriesDatalist');
    if (datalist) {
      datalist.innerHTML = state.categories.map(c => `
        <option value="${escapeHtml(c.name)}">${c.id}: ${escapeHtml(c.name)}</option>
      `).join('');
    }

    // Update Header tab badge
    const navBadge = document.getElementById('navCategoryBadge');
    if (navBadge) {
      navBadge.innerText = state.categories.length;
    }

    // Update Digitizer banner count
    const bannerCount = document.getElementById('bannerCategoryCount');
    if (bannerCount) {
      bannerCount.innerText = `${state.categories.length} Turtu Categories Active`;
    }

    // Update Categories view filter count badge
    const filterBadge = document.getElementById('categoryFilterCountBadge');
    if (filterBadge) {
      filterBadge.innerText = `${state.categories.length} categories active`;
    }

    // If categories panel is currently open, re-render its table
    const categoriesPanel = document.getElementById('panelCategories');
    if (categoriesPanel && categoriesPanel.style.display !== 'none') {
      const searchInput = document.getElementById('categorySearchInput');
      const query = searchInput ? searchInput.value.trim() : '';
      if (query) {
        filterCategoriesTable(query);
      } else {
        renderCategoriesTable(state.categories);
      }
    }
  } catch (err) {
    console.error("Error loading categories:", err);
    showToast("Error loading categories taxonomy", "error");
  }
}

function renderCategoriesTable(categories) {
  const tbody = document.getElementById('categoriesTableBody');
  if (!tbody) return;

  const filterBadge = document.getElementById('categoryFilterCountBadge');
  if (filterBadge) {
    filterBadge.innerText = `${categories.length} of ${state.categories.length} categories shown`;
  }

  if (!categories || categories.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-muted" style="padding: 36px 16px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.5;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <div style="font-weight: 600;">No categories match your search</div>
          <div style="font-size: 0.8rem; margin-top: 4px;">Try searching for a different keyword or category ID number.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = categories.map((cat, idx) => `
    <tr>
      <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem; font-family: 'JetBrains Mono', monospace;">${idx + 1}</td>
      <td>
        <span class="cat-badge" style="font-size: 0.82rem; padding: 4px 10px;">${escapeHtml(cat.id)}</span>
      </td>
      <td>
        <div style="font-weight: 600; color: var(--company-dark); font-size: 0.9rem;">${escapeHtml(cat.name)}</div>
      </td>
      <td>
        <span class="status-indicator active" style="margin-right: 6px;"></span>
        <span style="font-size: 0.78rem; font-weight: 600; color: var(--company-teal);">Active Portal ID</span>
      </td>
    </tr>
  `).join('');
}

function filterCategoriesTable(query) {
  if (!state.categories || state.categories.length === 0) return;
  const q = (query || '').trim().toLowerCase();

  if (!q) {
    renderCategoriesTable(state.categories);
    return;
  }

  const filtered = state.categories.filter(c => {
    const idStr = String(c.id).toLowerCase();
    const nameStr = String(c.name).toLowerCase();
    return idStr.includes(q) || nameStr.includes(q);
  });

  renderCategoriesTable(filtered);
}

async function uploadCategoryFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const validExts = ['.csv', '.xlsx', '.xls'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (!validExts.includes(ext)) {
    showToast("Invalid file type. Please upload a CSV (.csv) or Excel (.xlsx, .xls) file.", "error");
    event.target.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  showToast(`Uploading category file '${file.name}'...`, "info");

  try {
    const res = await fetch('/api/menu/upload-categories', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (res.ok) {
      await fetchCategories();
      showToast(`Replaced categories! Active taxonomy now has ${result.count} categories.`, 'success');
    } else {
      showToast(`Upload failed: ${result.detail || 'Error'}`, 'error');
    }
  } catch (err) {
    showToast(`Category upload error: ${err.message}`, 'error');
  } finally {
    event.target.value = '';
  }
}

function exportCategoriesCsv() {
  if (!state.categories || state.categories.length === 0) {
    showToast("No categories available to export.", "warning");
    return;
  }

  const header = "id,name\n";
  const rows = state.categories.map(c => {
    const safeName = c.name.includes(',') || c.name.includes('"') ? `"${c.name.replace(/"/g, '""')}"` : c.name;
    return `${c.id},${safeName}`;
  }).join("\n");

  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `turtu_categories_${state.categories.length}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${state.categories.length} categories to CSV!`, 'success');
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
      const defaultTiming = getBatchStoreTiming();
      data.items.forEach(it => {
        if (!it.available_time_starts) it.available_time_starts = defaultTiming.starts;
        if (!it.available_time_ends) it.available_time_ends = defaultTiming.ends;
      });
      state.extractedItems = data.items;
      renderTable(data.items);
      document.getElementById('downloadSheetBtn').disabled = false;
      showToast(`Extracted ${data.items.length} items with Category IDs & timing!`, 'success');
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

// =====================================================================
// 4. Culinary Description Synthesis Engine (Strictly 10-15 Words)
// =====================================================================

function enforceWordCount(text, minWords = 10, maxWords = 15) {
  if (!text) {
    return "Freshly prepared wholesome delicacy cooked with authentic traditional spices, herbs, and savory seasonings.";
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    let clean = words.slice(0, maxWords).join(' ');
    clean = clean.replace(/[,;:\-–—\s]+$/, '');
    if (!/[.!?]$/.test(clean)) clean += '.';
    return clean;
  }
  if (words.length < minWords) {
    const padNeeded = minWords - words.length;
    let pad = "Freshly prepared.";
    if (padNeeded <= 2) {
      pad = "Freshly prepared.";
    } else if (padNeeded <= 4) {
      pad = "Crafted fresh with aromatic spices.";
    } else {
      pad = "Prepared fresh with traditional aromatic herbs and seasonings.";
    }
    let clean = text.replace(/[.\s]+$/, '') + " " + pad;
    const cleanWords = clean.split(/\s+/).filter(Boolean);
    if (cleanWords.length > maxWords) {
      clean = cleanWords.slice(0, maxWords).join(' ').replace(/[,;:\-–—\s]+$/, '') + '.';
    }
    return clean;
  }
  let clean = text.trim();
  if (!/[.!?]$/.test(clean)) clean += '.';
  return clean;
}

async function generateAIDescriptions() {
  if (!state.extractedItems || state.extractedItems.length === 0) {
    showToast("No menu items loaded. Upload a menu or add a row first.", "warning");
    return;
  }

  // Find all items with missing or blank descriptions
  const itemsToDescribe = [];
  state.extractedItems.forEach((item, index) => {
    if (!item.description || !item.description.trim()) {
      itemsToDescribe.push({
        index: index,
        name: item.name || "Dish",
        category_name: item.category_name || "General",
        veg: item.veg || "yes",
        description: ""
      });
    }
  });

  if (itemsToDescribe.length === 0) {
    showToast("All items already have descriptions! Existing descriptions preserved unchanged.", "info");
    return;
  }

  const btn = document.getElementById('generateDescBtn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="loading-spinner-sm"></span> Generating descriptions for ${itemsToDescribe.length} items...`;
  }

  try {
    const res = await fetch('/api/menu/generate-descriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: itemsToDescribe })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || data.message || "Failed to generate AI descriptions");
    }

    const descriptions = data.descriptions || [];
    let updatedCount = 0;
    descriptions.forEach(d => {
      const idx = d.index;
      if (idx !== undefined && state.extractedItems[idx]) {
        state.extractedItems[idx].description = d.description;
        updatedCount++;
      }
    });

    renderTable(state.extractedItems);
    showToast(`✨ Generated ${updatedCount} accurate AI culinary descriptions (strictly 10-15 words)!`, "success");

  } catch (err) {
    showToast(`AI Description generation error: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

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
        <td colspan="8" class="text-center text-muted">Upload a menu document and click "Extract Menu with Gemini AI" to populate the sheet.</td>
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
    const defaultTiming = getBatchStoreTiming();
    const itemStarts = item.available_time_starts ? item.available_time_starts.slice(0, 5) : defaultTiming.starts.slice(0, 5);
    const itemEnds = item.available_time_ends ? item.available_time_ends.slice(0, 5) : defaultTiming.ends.slice(0, 5);
    const hasCustomTiming = Boolean(item.custom_timing);

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
          <div class="desc-cell-wrapper">
            <textarea 
              class="desc-textarea" 
              rows="2"
              onchange="updateItemField(${idx}, 'description', this.value)" 
              placeholder="10-15 word description"
              title="${escapeHtml(item.description || '')} (${(item.description || '').trim() ? (item.description || '').trim().split(/\s+/).filter(Boolean).length + ' words' : 'empty'})"
            >${escapeHtml(item.description || '')}</textarea>
          </div>
        </td>
        <td>
          <div class="row-timing-cell">
            <div class="row-time-box">
              <span class="row-time-lbl">Start</span>
              <input 
                type="time" 
                class="row-time-input" 
                value="${itemStarts}" 
                title="Operating start time for ${escapeHtml(item.name || 'dish')}"
                onchange="updateItemTiming(${idx}, 'available_time_starts', this.value)"
              >
            </div>
            <span class="row-time-sep">-</span>
            <div class="row-time-box">
              <span class="row-time-lbl">End</span>
              <input 
                type="time" 
                class="row-time-input" 
                value="${itemEnds}" 
                title="Operating end time for ${escapeHtml(item.name || 'dish')}"
                onchange="updateItemTiming(${idx}, 'available_time_ends', this.value)"
              >
            </div>
            ${hasCustomTiming ? `<span class="custom-timing-dot" onclick="resetItemTiming(${idx})" title="Custom dish timing active. Click to reset to store default.">●</span>` : ''}
          </div>
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

function updateItemTiming(index, field, value) {
  const item = state.extractedItems[index];
  if (!item) return;

  const defaultTiming = getBatchStoreTiming();
  const fallback = field === 'available_time_starts' ? defaultTiming.starts : defaultTiming.ends;
  const formatted = formatToExcelTime(value, fallback);

  item[field] = formatted;
  item.custom_timing = true;
  renderTable(state.extractedItems);
  showToast(`Custom timing for "${item.name || 'dish'}": ${item.available_time_starts?.slice(0, 5)} - ${item.available_time_ends?.slice(0, 5)}`, 'info');
}

function resetItemTiming(index) {
  const item = state.extractedItems[index];
  if (!item) return;

  const defaultTiming = getBatchStoreTiming();
  item.available_time_starts = defaultTiming.starts;
  item.available_time_ends = defaultTiming.ends;
  item.custom_timing = false;
  renderTable(state.extractedItems);
  showToast(`Reset "${item.name || 'dish'}" to store timing (${defaultTiming.starts.slice(0, 5)} - ${defaultTiming.ends.slice(0, 5)})`, 'info');
}

function addNewRow() {
  const defaultTiming = getBatchStoreTiming();
  const newItem = {
    name: "New Item",
    category_name: state.categories.length > 0 ? state.categories[0].name : "General",
    category_id: state.categories.length > 0 ? String(state.categories[0].id) : "",
    price: 0.0,
    veg: "yes",
    variations: [],
    available_time_starts: defaultTiming.starts,
    available_time_ends: defaultTiming.ends,
    custom_timing: false,
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
    items: state.extractedItems.map(it => {
      const itStarts = it.available_time_starts || timeStarts;
      const itEnds = it.available_time_ends || timeEnds;
      return {
        ...it,
        available_time_starts: itStarts,
        available_time_ends: itEnds
      };
    }),
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
    syncStoreTimingToItems(starts, ends);
    showToast(`Timing preset applied: ${starts} to ${ends}`, 'info');
  }
}

function getBatchStoreTiming() {
  const startsEl = document.getElementById('batchTimeStarts');
  const endsEl = document.getElementById('batchTimeEnds');
  const rawStarts = startsEl ? startsEl.value : '08:00:00';
  const rawEnds = endsEl ? endsEl.value : '23:55:00';
  return {
    starts: formatToExcelTime(rawStarts, '08:00:00'),
    ends: formatToExcelTime(rawEnds, '23:55:00')
  };
}

function syncStoreTimingToItems(newStarts, newEnds) {
  const defaultTiming = getBatchStoreTiming();
  const starts = newStarts ? formatToExcelTime(newStarts, '08:00:00') : defaultTiming.starts;
  const ends = newEnds ? formatToExcelTime(newEnds, '23:55:00') : defaultTiming.ends;

  if (Array.isArray(state.extractedItems) && state.extractedItems.length > 0) {
    let updatedCount = 0;
    state.extractedItems.forEach(item => {
      // Default is added from the store setting above.
      // If user has not manually customized this item's timing, cascade the store setting!
      if (!item.custom_timing) {
        item.available_time_starts = starts;
        item.available_time_ends = ends;
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      renderTable(state.extractedItems);
    }
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
