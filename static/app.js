// === STATE ===
let selectedFiles = [];
let categoriesCache = [];
let dashboardData = null;
let lastCreatedBatchId = null;
let firstListingThisSession = true;

// === ELEMENTS ===
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadBatchSelect = document.getElementById("upload-batch-select");
const uploadCategorySelect = document.getElementById("upload-category-select");
const listingsContainer = document.getElementById("listings-container");
const emptyMsg = document.getElementById("empty-msg");
const toast = document.getElementById("toast");
const batchesContainer = document.getElementById("batches-container");
const batchesEmpty = document.getElementById("batches-empty");
const settingsOverlay = document.getElementById("settings-overlay");
const promptEditor = document.getElementById("prompt-editor");
const categoryEditor = document.getElementById("category-editor");

// === TABS ===
function switchTab(tabName) {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add("active");
    document.getElementById(`tab-${tabName}`).classList.add("active");
    if (tabName === "inventory") loadBatches();
    if (tabName === "listings") loadListings();
    if (tabName === "dashboard") loadDashboard();
}

document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

// === SETTINGS OVERLAY ===
document.getElementById("settings-cog").addEventListener("click", () => { settingsOverlay.hidden = false; });
document.getElementById("settings-close").addEventListener("click", () => { settingsOverlay.hidden = true; });
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) settingsOverlay.hidden = true; });

// === DRAG & DROP ===
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

function addFiles(fileList) {
    for (const f of fileList) if (f.type.startsWith("image/")) selectedFiles.push(f);
    renderPreviews();
    uploadBtn.disabled = selectedFiles.length === 0;
}

function renderPreviews() {
    let container = dropzone.querySelector(".file-previews");
    if (!container) { container = document.createElement("div"); container.className = "file-previews"; dropzone.appendChild(container); }
    container.innerHTML = "";
    if (selectedFiles.length === 0) { container.remove(); return; }
    selectedFiles.forEach((file, i) => {
        const div = document.createElement("div"); div.className = "file-preview";
        const img = document.createElement("img"); img.src = URL.createObjectURL(file);
        const btn = document.createElement("button"); btn.className = "remove-preview"; btn.textContent = "\u00d7";
        btn.onclick = (e) => { e.stopPropagation(); selectedFiles.splice(i, 1); renderPreviews(); uploadBtn.disabled = selectedFiles.length === 0; };
        div.appendChild(img); div.appendChild(btn); container.appendChild(div);
    });
}

// === UPLOAD ===
uploadBtn.addEventListener("click", async () => {
    if (selectedFiles.length === 0) return;
    const formData = new FormData();
    selectedFiles.forEach(f => formData.append("photos", f));
    const batchId = uploadBatchSelect.value;
    const category = uploadCategorySelect.value;
    if (batchId) formData.append("batch_id", batchId);
    if (category) formData.append("category", category);

    uploadBtn.disabled = true;
    uploadBtn.querySelector(".btn-text").hidden = true;
    uploadBtn.querySelector(".btn-loading").hidden = false;
    document.querySelector(".upload-section").classList.add("loading");

    try {
        const res = await fetch("/api/listings", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Upload failed", true); return; }
        selectedFiles = [];
        renderPreviews();
        showToast("Listing created! AI drafted your name, description & hashtags.");
        loadListings();

        // First listing prompt
        if (firstListingThisSession) {
            firstListingThisSession = false;
            setTimeout(() => {
                if (confirm("Your first listing is ready! Want to visit Settings to customize the AI prompt for future listings?")) {
                    settingsOverlay.hidden = false;
                }
            }, 500);
        }
    } catch (err) {
        showToast("Upload failed: " + err.message, true);
    } finally {
        uploadBtn.querySelector(".btn-text").hidden = false;
        uploadBtn.querySelector(".btn-loading").hidden = true;
        uploadBtn.disabled = false;
        document.querySelector(".upload-section").classList.remove("loading");
    }
});

// === LISTINGS ===
async function loadListings() {
    try {
        const res = await fetch("/api/listings");
        const listings = await res.json();
        if (listings.length === 0) {
            listingsContainer.innerHTML = ""; listingsContainer.appendChild(emptyMsg); emptyMsg.hidden = false; return;
        }
        emptyMsg.hidden = true;
        listingsContainer.innerHTML = listings.map(renderListingCard).join("");
        attachListingEvents();
    } catch (err) { console.error("Failed to load listings:", err); }
}

function renderListingCard(listing) {
    const mainPhoto = listing.photos[0];
    const extraPhotos = listing.photos.slice(1);
    const catOptions = categoriesCache.map(c => `<option value="${escapeAttr(c)}" ${listing.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");

    return `
    <div class="listing-card" data-id="${listing.id}" data-batch-id="${listing.batch_id || ""}">
        <div class="listing-header">
            <h3>Listing &mdash; ${listing.photos.length} photo${listing.photos.length !== 1 ? "s" : ""}${listing.batch_id ? " &bull; In batch" : ""}</h3>
            <div class="listing-actions">
                <button class="btn btn-sm btn-add-photos" data-action="add-photos">+ Photos</button>
                <button class="btn btn-sm btn-save" data-action="save">Save</button>
                <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
            </div>
        </div>
        <div class="listing-body">
            <div class="listing-photos">
                ${mainPhoto ? `<img src="${mainPhoto.url}" alt="Listing photo" data-action="lightbox" data-url="${mainPhoto.url}">` : ""}
                ${extraPhotos.length > 0 ? `<div class="photo-thumb-row">${extraPhotos.map(p => `<img src="${p.url}" alt="Photo" data-action="lightbox" data-url="${p.url}">`).join("")}</div>` : ""}
            </div>
            <div class="listing-fields">
                <div class="field-group">
                    <div class="field-label"><label>Name / Title</label><button class="btn btn-sm btn-copy" data-action="copy" data-field="name">Copy</button></div>
                    <input type="text" data-field="name" value="${escapeAttr(listing.name)}">
                </div>
                <div class="field-group">
                    <div class="field-label"><label>Description</label><button class="btn btn-sm btn-copy" data-action="copy" data-field="description">Copy</button></div>
                    <textarea data-field="description" rows="3">${escapeHtml(listing.description)}</textarea>
                </div>
                <div class="field-group">
                    <div class="field-label"><label>Hashtags</label><button class="btn btn-sm btn-copy" data-action="copy" data-field="hashtags">Copy</button></div>
                    <textarea data-field="hashtags" rows="2">${escapeHtml(listing.hashtags)}</textarea>
                </div>
                <div class="field-group">
                    <div class="field-label"><label>Category</label></div>
                    <select data-field="category"><option value="">Select...</option>${catOptions}</select>
                </div>
            </div>
        </div>
        <div class="copy-all-row">
            <button class="btn btn-sm btn-copy" data-action="copy-all">Copy All to Clipboard</button>
        </div>
    </div>`;
}

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
function escapeAttr(str) { return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// === LISTING EVENTS ===
function attachListingEvents() {
    document.querySelectorAll(".listing-card").forEach(card => {
        const id = card.dataset.id;
        card.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === "copy") { await copyText(card.querySelector(`[data-field="${btn.dataset.field}"]`).value, btn); }
            if (action === "copy-all") {
                const n = card.querySelector('[data-field="name"]').value;
                const d = card.querySelector('textarea[data-field="description"]').value;
                const t = card.querySelector('textarea[data-field="hashtags"]').value;
                await copyText(`${n}\n\n${d}\n\n${t}`, btn);
            }
            if (action === "save") {
                const body = {
                    name: card.querySelector('[data-field="name"]').value,
                    description: card.querySelector('textarea[data-field="description"]').value,
                    hashtags: card.querySelector('textarea[data-field="hashtags"]').value,
                    category: card.querySelector('[data-field="category"]').value,
                };
                try { await fetch(`/api/listings/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); showToast("Listing saved!"); } catch { showToast("Save failed", true); }
            }
            if (action === "delete") {
                if (!confirm("Delete this listing and its photos?")) return;
                try { await fetch(`/api/listings/${id}`, { method: "DELETE" }); showToast("Listing deleted"); loadListings(); } catch { showToast("Delete failed", true); }
            }
            if (action === "add-photos") {
                const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.accept = "image/*";
                input.onchange = async () => {
                    const fd = new FormData();
                    for (const f of input.files) fd.append("photos", f);
                    try { await fetch(`/api/listings/${id}/photos`, { method: "POST", body: fd }); showToast("Photos added!"); loadListings(); } catch { showToast("Failed", true); }
                };
                input.click();
            }
            if (action === "lightbox") openLightbox(btn.dataset.url);
        });
    });
}

async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent; btn.textContent = "Copied!"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
        showToast("Copied to clipboard!");
    } catch {
        const ta = document.createElement("textarea"); ta.value = text;
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
        showToast("Copied to clipboard!");
    }
}

function openLightbox(url) {
    const lb = document.createElement("div"); lb.className = "lightbox";
    lb.innerHTML = `<img src="${url}">`; lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
}

function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.style.background = isError ? "var(--red)" : "var(--bg-card-solid)";
    toast.style.color = isError ? "#fff" : "var(--text)";
    toast.hidden = false; toast.classList.add("show");
    setTimeout(() => { toast.classList.remove("show"); setTimeout(() => (toast.hidden = true), 300); }, 2500);
}

// === SETTINGS: PROMPT & CATEGORIES ===
function updateCharCount() {
    const count = promptEditor.value.length;
    const counter = document.getElementById("prompt-char-count");
    if (counter) {
        counter.textContent = count;
        counter.parentElement.classList.toggle("over-limit", count > 1000);
    }
}
promptEditor.addEventListener("input", updateCharCount);

async function loadPrompt() {
    try { const res = await fetch("/api/prompt"); const d = await res.json(); promptEditor.value = d.prompt; updateCharCount(); } catch (e) { console.error(e); }
}

async function loadCategories() {
    try {
        const res = await fetch("/api/categories"); const d = await res.json();
        categoriesCache = d.categories;
        categoryEditor.value = d.categories.join("\n");
        uploadCategorySelect.innerHTML = '<option value="">Select...</option>';
        d.categories.forEach(c => { const o = document.createElement("option"); o.value = c; o.textContent = c; uploadCategorySelect.appendChild(o); });
    } catch (e) { console.error(e); }
}

document.getElementById("save-prompt-btn").addEventListener("click", async () => {
    try {
        const res = await fetch("/api/prompt", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: promptEditor.value }) });
        if (res.ok) showToast("Prompt saved!"); else { const d = await res.json(); showToast(d.error, true); }
    } catch { showToast("Failed to save prompt", true); }
});

document.getElementById("reset-prompt-btn").addEventListener("click", async () => {
    if (!confirm("Reset prompt to default?")) return;
    try { const res = await fetch("/api/prompt", { method: "DELETE" }); const d = await res.json(); if (res.ok) { promptEditor.value = d.prompt; showToast("Prompt reset."); } } catch { showToast("Failed", true); }
});

document.getElementById("save-categories-btn").addEventListener("click", async () => {
    const cats = categoryEditor.value.split("\n").map(s => s.trim()).filter(Boolean);
    if (cats.length === 0) { showToast("Need at least one category", true); return; }
    try {
        const res = await fetch("/api/categories", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categories: cats }) });
        if (res.ok) { showToast("Categories saved!"); loadCategories(); }
    } catch { showToast("Failed", true); }
});

document.getElementById("reset-categories-btn").addEventListener("click", async () => {
    if (!confirm("Reset categories to default?")) return;
    try { const res = await fetch("/api/categories", { method: "DELETE" }); const d = await res.json(); if (res.ok) { categoryEditor.value = d.categories.join("\n"); categoriesCache = d.categories; showToast("Categories reset."); loadCategories(); } } catch { showToast("Failed", true); }
});

// === THEME ===
const THEMES = {
    dark: {
        "--bg": "#0f0f13", "--bg-card": "rgba(255,255,255,0.05)", "--bg-card-solid": "#1a1a22",
        "--bg-input": "rgba(255,255,255,0.07)", "--border": "rgba(255,255,255,0.08)",
        "--text": "#e8e8ed", "--text-muted": "#8b8b9e",
        "--accent": "#6c5ce7", "--accent-light": "#a78bfa", "--accent-glow": "rgba(108,92,231,0.25)",
        "--green": "#00cec9", "--green-soft": "rgba(0,206,201,0.15)",
        "--red": "#ff6b6b", "--red-soft": "rgba(255,107,107,0.15)",
    },
    light: {
        "--bg": "#f5f5f7", "--bg-card": "rgba(255,255,255,0.95)", "--bg-card-solid": "#ffffff",
        "--bg-input": "rgba(0,0,0,0.04)", "--border": "rgba(0,0,0,0.1)",
        "--text": "#1c1c1e", "--text-muted": "#6e6e73",
        "--accent": "#6c5ce7", "--accent-light": "#8b7cf7", "--accent-glow": "rgba(108,92,231,0.15)",
        "--green": "#1da065", "--green-soft": "rgba(29,160,101,0.1)",
        "--red": "#e53935", "--red-soft": "rgba(229,57,53,0.1)",
    },
    evening: {
        "--bg": "#f5f0e8", "--bg-card": "rgba(255,255,255,0.7)", "--bg-card-solid": "#efe9df",
        "--bg-input": "rgba(0,0,0,0.04)", "--border": "rgba(160,140,110,0.2)",
        "--text": "#3d3527", "--text-muted": "#8a7d6b",
        "--accent": "#b8860b", "--accent-light": "#d4a24e", "--accent-glow": "rgba(184,134,11,0.15)",
        "--green": "#5a8a2a", "--green-soft": "rgba(90,138,42,0.1)",
        "--red": "#c0392b", "--red-soft": "rgba(192,57,43,0.1)",
    },
};

function applyTheme(themeName) {
    const vars = THEMES[themeName] || THEMES.dark;
    const root = document.documentElement;
    for (const [prop, val] of Object.entries(vars)) root.style.setProperty(prop, val);
    // Update active button
    document.querySelectorAll(".theme-btn").forEach(b => b.classList.toggle("active", b.dataset.theme === themeName));
}

async function loadTheme() {
    try {
        const res = await fetch("/api/theme");
        const d = await res.json();
        applyTheme(d.theme || "dark");
    } catch { applyTheme("dark"); }
}

async function saveTheme(themeName) {
    try {
        await fetch("/api/theme", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: themeName }) });
    } catch { /* silent */ }
}

document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        applyTheme(btn.dataset.theme);
        saveTheme(btn.dataset.theme);
        showToast(`${btn.dataset.theme.charAt(0).toUpperCase() + btn.dataset.theme.slice(1)} mode applied`);
    });
});

// === BATCHES ===
async function loadBatchSelectDropdown() {
    try {
        const res = await fetch("/api/batches"); const batches = await res.json();
        uploadBatchSelect.innerHTML = '<option value="">None</option>';
        batches.forEach(b => {
            const o = document.createElement("option"); o.value = b.id;
            o.textContent = `${b.name} ($${b.total_cost.toFixed(2)} / ${b.item_count} items)`;
            uploadBatchSelect.appendChild(o);
        });
        // If a batch was just created, select it
        if (lastCreatedBatchId) {
            uploadBatchSelect.value = lastCreatedBatchId;
        }
    } catch (e) { console.error(e); }
}

document.getElementById("create-batch-btn").addEventListener("click", async () => {
    const name = document.getElementById("batch-name").value.trim();
    const totalCost = parseFloat(document.getElementById("batch-total").value) || 0;
    const itemCount = parseInt(document.getElementById("batch-count").value) || 1;
    if (totalCost <= 0) { showToast("Enter the total amount spent", true); return; }
    try {
        const res = await fetch("/api/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, total_cost: totalCost, item_count: itemCount }) });
        if (res.ok) {
            const data = await res.json();
            lastCreatedBatchId = data.id;
            document.getElementById("batch-name").value = "";
            document.getElementById("batch-total").value = "";
            document.getElementById("batch-count").value = "1";
            showToast("Batch created!");
            loadBatches();
            loadBatchSelectDropdown();
            // Show the "Go to Listings" callout
            document.getElementById("batch-created-callout").hidden = false;
        }
    } catch { showToast("Failed to create batch", true); }
});

document.getElementById("go-to-listings-btn").addEventListener("click", () => {
    document.getElementById("batch-created-callout").hidden = true;
    switchTab("listings");
});

async function loadBatches() {
    try {
        const res = await fetch("/api/batches"); const batches = await res.json();
        if (batches.length === 0) { batchesContainer.innerHTML = ""; batchesContainer.appendChild(batchesEmpty); batchesEmpty.hidden = false; return; }
        batchesEmpty.hidden = true;

        const listingsRes = await fetch("/api/listings"); const allListings = await listingsRes.json();
        batchesContainer.innerHTML = batches.map(batch => {
            const batchListings = allListings.filter(l => l.batch_id === batch.id);
            return renderBatchCard(batch, batchListings);
        }).join("");
        attachBatchEvents();
    } catch (e) { console.error(e); }
}

function renderBatchCard(batch, listings) {
    const perItem = batch.item_count > 0 ? (batch.total_cost / batch.item_count).toFixed(2) : "0.00";
    const totalAssignedCost = listings.reduce((s, l) => s + (l.cost || 0), 0);
    const isBalanced = Math.abs(totalAssignedCost - batch.total_cost) < 0.02;
    const assignedClass = isBalanced ? "balanced" : "out-of-balance";
    const totalListPrice = listings.reduce((s, l) => s + (l.list_price || 0), 0);

    return `
    <div class="batch-card" data-batch-id="${batch.id}">
        <div class="batch-card-header">
            <div class="batch-info">
                <h3>${escapeHtml(batch.name)}</h3>
                <div class="batch-stats">
                    <span>Total: <strong>$${batch.total_cost.toFixed(2)}</strong></span>
                    <span>Items expected: <strong>${batch.item_count}</strong></span>
                    <span>Items uploaded: <strong>${listings.length}</strong></span>
                    <span>Default/item: <strong>$${perItem}</strong></span>
                    <span>Assigned: <strong class="${assignedClass}">$${totalAssignedCost.toFixed(2)}</strong></span>
                    <span>Potential revenue: <strong class="revenue">$${totalListPrice.toFixed(2)}</strong></span>
                </div>
                ${!isBalanced && listings.length > 0 ? `<div class="balance-warning">Costs are out of balance! Adjust non-standard cost items so assigned costs equal the batch total.</div>` : ""}
            </div>
            <div class="batch-actions">
                <button class="btn btn-sm btn-save" data-action="edit-batch">Edit</button>
                <button class="btn btn-sm btn-danger" data-action="delete-batch">Delete</button>
            </div>
        </div>
        ${listings.length > 0 ? `
        <div class="batch-items">
            <table class="inventory-table">
                <thead><tr>
                    <th>Photo</th><th>Name</th><th>Category</th><th>Cost</th>
                    <th>Non-standard cost</th><th>List Price</th><th>Sale Price</th><th>Shipping</th>
                </tr></thead>
                <tbody>
                    ${listings.map(l => {
                        const thumb = l.photos[0] ? `<img src="${l.photos[0].url}" class="table-thumb">` : "";
                        const selCatOpts = categoriesCache.map(c => `<option value="${escapeAttr(c)}" ${l.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
                        return `<tr data-listing-id="${l.id}">
                            <td>${thumb}</td>
                            <td class="item-name">${escapeHtml(l.name)}</td>
                            <td><select data-field="category" class="table-select"><option value="">--</option>${selCatOpts}</select></td>
                            <td><input type="number" class="cost-input" data-field="cost" step="0.01" min="0" value="${l.cost.toFixed(2)}"></td>
                            <td class="center-cell"><input type="checkbox" data-field="cost_locked" ${l.cost_locked ? "checked" : ""}></td>
                            <td><input type="number" class="cost-input" data-field="list_price" step="0.01" min="0" value="${l.list_price.toFixed(2)}"></td>
                            <td><input type="number" class="cost-input" data-field="sale_price" step="0.01" min="0" value="${l.sale_price.toFixed(2)}"></td>
                            <td><input type="number" class="cost-input" data-field="shipping_cost" step="0.01" min="0" value="${l.shipping_cost.toFixed(2)}"></td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
            <div class="batch-table-actions"><button class="btn btn-sm btn-save" data-action="save-costs">Save All</button></div>
        </div>
        ` : '<div class="batch-empty-items"><p class="muted">No items uploaded yet. Go to the Listings tab, select this batch, and upload photos.</p></div>'}
    </div>`;
}

function attachBatchEvents() {
    document.querySelectorAll(".batch-card").forEach(card => {
        const batchId = card.dataset.batchId;
        card.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === "delete-batch") {
                if (!confirm("Delete this batch? Listings will be kept but unlinked.")) return;
                try { await fetch(`/api/batches/${batchId}`, { method: "DELETE" }); showToast("Batch deleted"); loadBatches(); loadBatchSelectDropdown(); } catch { showToast("Delete failed", true); }
            }
            if (action === "edit-batch") {
                const nameEl = card.querySelector("h3");
                const newName = prompt("Batch name:", nameEl.textContent); if (newName === null) return;
                const stats = card.querySelectorAll(".batch-stats strong");
                const newTotal = prompt("Total spent ($):", stats[0].textContent.replace("$", "")); if (newTotal === null) return;
                const newCount = prompt("Number of items:", stats[1].textContent); if (newCount === null) return;
                try {
                    await fetch(`/api/batches/${batchId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName, total_cost: parseFloat(newTotal), item_count: parseInt(newCount) }) });
                    showToast("Batch updated! Costs rebalanced."); loadBatches(); loadBatchSelectDropdown();
                } catch { showToast("Update failed", true); }
            }
            if (action === "save-costs") {
                const rows = card.querySelectorAll("tbody tr");
                let anyFailed = false;
                for (const row of rows) {
                    const listingId = row.dataset.listingId;
                    const body = {
                        cost: parseFloat(row.querySelector('[data-field="cost"]').value) || 0,
                        cost_locked: row.querySelector('[data-field="cost_locked"]').checked ? 1 : 0,
                        list_price: parseFloat(row.querySelector('[data-field="list_price"]').value) || 0,
                        sale_price: parseFloat(row.querySelector('[data-field="sale_price"]').value) || 0,
                        shipping_cost: parseFloat(row.querySelector('[data-field="shipping_cost"]').value) || 0,
                        category: row.querySelector('[data-field="category"]').value,
                    };
                    try { await fetch(`/api/listings/${listingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { anyFailed = true; }
                }
                showToast(anyFailed ? "Some items failed to save" : "Saved and rebalanced!", anyFailed);
                loadBatches();
            }
        });
    });
}

// === DASHBOARD ===
async function loadDashboard() {
    try {
        const res = await fetch("/api/dashboard");
        dashboardData = await res.json();
        renderSummaryCards(dashboardData.summary);
        renderDrillDown();
    } catch (e) { console.error(e); }
}

function renderSummaryCards(s) {
    const profitClass = s.total_profit >= 0 ? "positive" : "negative";
    document.getElementById("summary-cards").innerHTML = `
        <div class="summary-card"><div class="card-label">Total Cost</div><div class="card-value">$${s.total_cost.toFixed(2)}</div></div>
        <div class="summary-card"><div class="card-label">Total List Price</div><div class="card-value">$${s.total_list_price.toFixed(2)}</div></div>
        <div class="summary-card"><div class="card-label">Revenue (Sales - Shipping)</div><div class="card-value">$${s.total_revenue.toFixed(2)}</div></div>
        <div class="summary-card ${profitClass}"><div class="card-label">Profit / Loss</div><div class="card-value">${s.total_profit >= 0 ? "+" : ""}$${s.total_profit.toFixed(2)}</div></div>
        <div class="summary-card"><div class="card-label">Items</div><div class="card-value">${s.total_items} total / ${s.sold_items} sold</div></div>
    `;
}

document.getElementById("drill-down-select").addEventListener("change", renderDrillDown);

function renderDrillDown() {
    if (!dashboardData) return;
    const view = document.getElementById("drill-down-select").value;
    const container = document.getElementById("drill-down-table");
    if (view === "batch") {
        container.innerHTML = renderPLTable(["Batch","Items","Sold","Cost","List Price","Revenue","P/L"],
            dashboardData.by_batch.map(r => [r.name, r.items, r.sold, `$${r.cost.toFixed(2)}`, `$${r.list_price.toFixed(2)}`, `$${r.revenue.toFixed(2)}`, plCell(r.profit)]));
    } else if (view === "category") {
        container.innerHTML = renderPLTable(["Category","Items","Sold","Cost","List Price","Revenue","P/L"],
            dashboardData.by_category.map(r => [r.name, r.items, r.sold, `$${r.cost.toFixed(2)}`, `$${r.list_price.toFixed(2)}`, `$${r.revenue.toFixed(2)}`, plCell(r.profit)]));
    } else {
        container.innerHTML = renderPLTable(["Item","Batch","Category","Cost","List","Sale","Shipping","P/L"],
            dashboardData.items.map(r => [r.name, r.batch_name, r.category, `$${r.cost.toFixed(2)}`, `$${r.list_price.toFixed(2)}`, `$${r.sale_price.toFixed(2)}`, `$${r.shipping_cost.toFixed(2)}`, plCell(r.profit)]));
    }
}

function plCell(val) {
    const cls = val >= 0 ? "positive" : "negative";
    return `<span class="pl-value ${cls}">${val >= 0 ? "+" : ""}$${val.toFixed(2)}</span>`;
}

function renderPLTable(headers, rows) {
    if (rows.length === 0) return '<p class="empty-state">No data yet.</p>';
    return `<table class="pl-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

// === INIT ===
loadTheme();
loadBatches();
loadPrompt();
loadCategories();
loadBatchSelectDropdown();
