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
// 4. Interactive Review Table
// =====================================================================

function renderTable(items) {
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
    // Format variations badge
    let varBadge = `
      <button type="button" class="add-var-btn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        Add Sizes
      </button>
    `;
    if (Array.isArray(item.variations) && item.variations.length > 0) {
      const summary = item.variations.flatMap(g => 
        (g.values || []).map(v => {
          const delta = parseFloat(v.optionPrice) || 0;
          return `${v.label} (+₹${delta})`;
        })
      ).join(', ');
      varBadge = `
        <div class="var-tag" title="Click to edit variations: ${escapeHtml(JSON.stringify(item.variations))}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          <span>${escapeHtml(summary || 'Configured')}</span>
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
  if (state.extractedItems[index]) {
    state.extractedItems[index][field] = value;
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
// 5. Visual Variations Modal Controller
// =====================================================================

function openVariationModal(index) {
  editingVarIndex = index;
  const item = state.extractedItems[index];
  if (!item) return;

  document.getElementById('varModalTitle').innerText = `Edit Variations: ${item.name || 'Dish'}`;
  document.getElementById('varModalSubtitle').innerText = `Base Item Price: ₹${item.price || 0} • Formatted for Turtu actual import`;

  let groupName = "Portion";
  let groupType = "single";
  let groupRequired = "off";
  let values = [];

  if (Array.isArray(item.variations) && item.variations.length > 0) {
    const firstGroup = item.variations[0];
    groupName = firstGroup.name || "Portion";
    groupType = firstGroup.type || "single";
    groupRequired = firstGroup.required || "off";
    values = Array.isArray(firstGroup.values) ? firstGroup.values : [];
  }

  document.getElementById('varGroupName').value = groupName;
  document.getElementById('varGroupType').value = groupType;
  document.getElementById('varGroupRequired').value = groupRequired;

  const container = document.getElementById('variationOptionsList');
  container.innerHTML = '';

  if (values.length > 0) {
    values.forEach(v => addVariationOptionRow(v.label, v.optionPrice));
  } else {
    // Start with empty or prompt
    addVariationOptionRow('', '');
  }

  syncFormToJson();
  document.getElementById('variationModal').style.display = 'flex';
}

function closeVariationModal() {
  const modal = document.getElementById('variationModal');
  if (modal) modal.style.display = 'none';
  editingVarIndex = null;
}

function addVariationOptionRow(label = '', price = '') {
  const container = document.getElementById('variationOptionsList');
  const row = document.createElement('div');
  row.className = 'variation-option-row';
  row.innerHTML = `
    <input type="text" class="opt-label" placeholder="Option (e.g. Onion, 1 Piece, Half)" value="${escapeHtml(label)}" style="flex: 2;">
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
    document.getElementById('varRawJson').value = '[]';
    showToast("Cleared variations for item", "info");
    return;
  }

  if (preset === 'flavors_same_price') {
    document.getElementById('varGroupName').value = "Variation";
    document.getElementById('varGroupType').value = "single";
    document.getElementById('varGroupRequired').value = "off";
    addVariationOptionRow('Onion', 0);
    addVariationOptionRow('Potato', 0);
    addVariationOptionRow('Mirchi', 0);
    syncFormToJson();
    return;
  }

  document.getElementById('varGroupName').value = (preset === 's_m_l' || preset === 'reg_large') ? "Size" : "Portion";
  document.getElementById('varGroupType').value = "single";
  document.getElementById('varGroupRequired').value = "off";

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
}

function syncFormToJson() {
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

  if (values.length === 0) {
    document.getElementById('varRawJson').value = '[]';
    return;
  }

  const groupName = document.getElementById('varGroupName').value.trim() || "Portion";
  const groupType = document.getElementById('varGroupType').value || "single";
  const groupReq = document.getElementById('varGroupRequired').value || "off";

  const group = [{
    name: groupName,
    type: groupType,
    min: "0",
    max: "0",
    required: groupReq,
    values: values
  }];

  document.getElementById('varRawJson').value = JSON.stringify(group, null, 2);
}

function syncJsonToForm() {
  const rawText = document.getElementById('varRawJson').value.trim();
  if (!rawText) return;

  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const g = parsed[0];
      if (g.name) document.getElementById('varGroupName').value = g.name;
      if (g.type) document.getElementById('varGroupType').value = g.type;
      if (g.required) document.getElementById('varGroupRequired').value = g.required;

      const container = document.getElementById('variationOptionsList');
      container.innerHTML = '';
      if (Array.isArray(g.values)) {
        g.values.forEach(v => addVariationOptionRow(v.label, v.optionPrice));
      }
    } else if (Array.isArray(parsed) && parsed.length === 0) {
      document.getElementById('variationOptionsList').innerHTML = '';
    }
  } catch (e) {
    // Invalid JSON during typing, do nothing
  }
}

function saveVariationModal() {
  if (editingVarIndex === null || !state.extractedItems[editingVarIndex]) {
    closeVariationModal();
    return;
  }

  const rawJson = document.getElementById('varRawJson').value.trim();
  try {
    let parsed = JSON.parse(rawJson || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      parsed.forEach(group => {
        if (Array.isArray(group.values) && group.values.length > 0) {
          const numPrices = group.values.map(v => parseFloat(v.optionPrice) || 0);
          const minP = Math.min(...numPrices);
          const maxP = Math.max(...numPrices);

          if (minP === maxP && minP > 0) {
            // All options have identical absolute price (e.g. 72)
            state.extractedItems[editingVarIndex].price = minP;
            group.values.forEach(v => { v.optionPrice = "0"; });
          } else if (minP > 0) {
            // Absolute prices entered (e.g. 50 and 70)
            state.extractedItems[editingVarIndex].price = minP;
            group.values.forEach(v => {
              const delta = (parseFloat(v.optionPrice) || 0) - minP;
              v.optionPrice = String(Math.round(delta * 100) / 100);
            });
          } else {
            // Already deltas (minP is 0)
            group.values.forEach(v => {
              const delta = parseFloat(v.optionPrice) || 0;
              v.optionPrice = String(Math.round(delta * 100) / 100);
            });
          }
        }
      });
    }

    state.extractedItems[editingVarIndex].variations = Array.isArray(parsed) ? parsed : [];
    renderTable(state.extractedItems);
    closeVariationModal();
    showToast(`Saved variations with delta pricing for "${state.extractedItems[editingVarIndex].name}"`, "success");
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
