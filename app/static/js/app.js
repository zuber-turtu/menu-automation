// MenuFlow AI State
let state = {
  menuFile: null,
  extractedItems: [],
  referenceSheets: [],
  selectedTemplate: null,
  categories: []
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  fetchReferenceSheets();
  fetchCategories();
  setupDragAndDrop();
});

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
        <span style="color: var(--success); font-weight: 600;">✓ Template:</span>
        <span class="text-mono">${activeSheet} (21 cols)</span>
      `;
    } else {
      box.innerHTML = `<span class="text-muted">Using standard 21-column actual portal template</span>`;
    }
  } catch (err) {
    box.innerHTML = `<span style="color:var(--danger)">Error checking templates</span>`;
  }
}

async function uploadReferenceSheet(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const box = document.getElementById('templateStatusBox');
  box.innerHTML = `<div class="loading-spinner-sm"></div> Uploading ${file.name}...`;

  try {
    const res = await fetch('/api/menu/upload-reference', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (res.ok) {
      await fetchReferenceSheets();
      alert(`Master Template '${file.name}' saved! Extracted menus will strictly match this 22-column structure.`);
    } else {
      alert(`Error: ${result.detail || 'Upload failed'}`);
      await fetchReferenceSheets();
    }
  } catch (err) {
    alert(`Failed to upload reference: ${err.message}`);
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
    datalist.innerHTML = state.categories.map(c => `
      <option value="${escapeHtml(c.name)}">${c.id}: ${escapeHtml(c.name)}</option>
    `).join('');

    if (state.categories.length > 0) {
      box.innerHTML = `
        <span style="color: var(--success); font-weight: 600;">✓ Taxonomy:</span>
        <span>${state.categories.length} categories active (Turtu)</span>
      `;
    } else {
      box.innerHTML = `<span class="text-muted">No categories loaded. Upload categories_turtu.csv below.</span>`;
    }
  } catch (err) {
    box.innerHTML = `<span style="color:var(--danger)">Error loading categories</span>`;
  }
}

async function uploadCategoryCsv(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  const box = document.getElementById('categoryStatusBox');
  box.innerHTML = `<div class="loading-spinner-sm"></div> Loading ${file.name}...`;

  try {
    const res = await fetch('/api/menu/upload-categories', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (res.ok) {
      await fetchCategories();
      alert(`Loaded ${result.count} categories! Gemini will now match dishes directly to these category IDs.`);
    } else {
      alert(`Error: ${result.detail || 'Upload failed'}`);
      await fetchCategories();
    }
  } catch (err) {
    alert(`Category upload error: ${err.message}`);
    await fetchCategories();
  }
}

// =====================================================================
// 2. Menu File Selection & Drag & Drop
// =====================================================================

function setupDragAndDrop() {
  const dropzone = document.getElementById('menuDropzone');
  
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-primary)';
      dropzone.style.background = 'rgba(99, 102, 241, 0.1)';
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
    <strong style="color:var(--success)">${file.name}</strong><br>
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
  if (!state.menuFile) return;

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

  try {
    progFill.style.width = '65%';
    progPercent.innerText = '65%';
    progText.innerText = 'Mapping items, Category IDs, Veg/Non-Veg & Variations...';

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
    }, 600);

    if (data.status === 'success' && Array.isArray(data.items)) {
      state.extractedItems = data.items;
      renderTable(data.items);
      document.getElementById('downloadSheetBtn').disabled = false;
    } else if (data.status === 'no_key') {
      alert("Notice: No GEMINI_API_KEY found in .env. Please configure your key in .env to run AI extraction.");
    } else {
      alert(data.message || "Extraction notice received.");
    }
  } catch (err) {
    progContainer.style.display = 'none';
    btn.disabled = false;
    alert(`Extraction failed: ${err.message}`);
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
        <td colspan="7" class="text-center text-muted">No items extracted.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map((item, idx) => {
    // Format variations badge
    let varBadge = `<span class="text-muted" style="font-size:0.75rem;">None</span>`;
    if (Array.isArray(item.variations) && item.variations.length > 0) {
      const summary = item.variations.flatMap(g => 
        (g.values || []).map(v => `${v.label}: ₹${v.optionPrice}`)
      ).join(', ');
      varBadge = `<span class="var-tag" title="${escapeHtml(JSON.stringify(item.variations))}">${escapeHtml(summary || 'Custom')}</span>`;
    }

    const isVeg = (String(item.veg).toLowerCase() === 'yes');

    return `
      <tr data-index="${idx}">
        <td>
          <div style="display:flex; align-items:center;">
            <input 
              type="text" 
              list="categoriesDatalist" 
              value="${escapeHtml(item.category_name || '')}" 
              placeholder="Search category..."
              onchange="handleCategoryChange(${idx}, this.value)"
              style="font-weight: 500;"
            >
            <span class="cat-badge" id="catBadge_${idx}">${escapeHtml(item.category_id || '-')}</span>
          </div>
        </td>
        <td>
          <input type="text" value="${escapeHtml(item.name || '')}" onchange="updateItemField(${idx}, 'name', this.value)" placeholder="Dish title">
        </td>
        <td style="max-width: 90px;">
          <input type="number" step="1" value="${item.price !== null && item.price !== undefined ? item.price : ''}" onchange="updateItemField(${idx}, 'price', parseFloat(this.value) || 0)">
        </td>
        <td>
          <select onchange="updateItemField(${idx}, 'veg', this.value)" style="background:transparent; border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:inherit; padding:4px 6px; font-size:0.75rem;">
            <option value="yes" ${isVeg ? 'selected' : ''}>🟢 Veg</option>
            <option value="no" ${!isVeg ? 'selected' : ''}>🔴 Non-Veg</option>
          </select>
        </td>
        <td>
          <div style="cursor:pointer;" onclick="editVariations(${idx})">
            ${varBadge}
          </div>
        </td>
        <td>
          <input type="text" value="${escapeHtml(item.description || '')}" onchange="updateItemField(${idx}, 'description', this.value)" placeholder="Optional description">
        </td>
        <td style="text-align: center;">
          <button class="btn-del-row" onclick="deleteRow(${idx})" title="Delete row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function handleCategoryChange(index, newCategoryName) {
  const item = state.extractedItems[index];
  if (!item) return;

  item.category_name = newCategoryName;

  // Try matching against loaded categories
  const matched = state.categories.find(c => c.name.toLowerCase() === newCategoryName.trim().toLowerCase());
  if (matched) {
    item.category_id = matched.id;
  }

  // Update badge UI
  const badge = document.getElementById(`catBadge_${index}`);
  if (badge) {
    badge.innerText = item.category_id || '-';
  }
}

function updateItemField(index, field, value) {
  if (state.extractedItems[index]) {
    state.extractedItems[index][field] = value;
  }
}

function editVariations(index) {
  const item = state.extractedItems[index];
  if (!item) return;

  const currentJson = JSON.stringify(item.variations || [], null, 2);
  const updated = prompt(
    `Edit Variations JSON for "${item.name}":\n\nFormat: [{"name":"Portion","type":"single","min":"0","max":"0","required":"off","values":[{"label":"Half","optionPrice":"150"},{"label":"Full","optionPrice":"300"}]}]`,
    currentJson
  );

  if (updated !== null) {
    try {
      const parsed = JSON.parse(updated);
      item.variations = Array.isArray(parsed) ? parsed : [];
      renderTable(state.extractedItems);
    } catch (e) {
      alert("Invalid JSON format for variations. Please verify and retry.");
    }
  }
}

function addNewRow() {
  const newItem = {
    name: "New Item",
    category_name: "General",
    category_id: "",
    price: 0.0,
    veg: "yes",
    variations: [],
    description: ""
  };
  state.extractedItems.push(newItem);
  renderTable(state.extractedItems);
  document.getElementById('downloadSheetBtn').disabled = false;
}

function deleteRow(index) {
  state.extractedItems.splice(index, 1);
  renderTable(state.extractedItems);
  if (state.extractedItems.length === 0) {
    document.getElementById('downloadSheetBtn').disabled = true;
  }
}

// =====================================================================
// 5. Excel Generation (22-Column Export)
// =====================================================================

async function generateAndDownloadExcel() {
  if (state.extractedItems.length === 0) {
    alert("Please extract or add menu items before generating spreadsheet.");
    return;
  }

  const btn = document.getElementById('downloadSheetBtn');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<div class="loading-spinner-sm"></div> Generating 21-Col Sheet...`;
  btn.disabled = true;

  // Collect batch settings from top configuration bar
  const storeId = parseInt(document.getElementById('batchStoreId').value) || 95;
  const moduleId = parseInt(document.getElementById('batchModuleId').value) || 3;
  const discount = parseFloat(document.getElementById('batchDiscount').value) || 0.0;
  const discountType = document.getElementById('batchDiscountType').value || 'percent';
  const timeStarts = document.getElementById('batchTimeStarts').value || '08:00:00';
  const timeEnds = document.getElementById('batchTimeEnds').value || '23:55:00';

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
    } else {
      const err = await res.json();
      alert(`Generation failed: ${err.detail || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Download error: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

function escapeHtml(string) {
  if (!string) return '';
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
