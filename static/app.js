// === STATE ===
let selectedFiles = [];
let categoriesCache = [];
let brandsCache = [];
let listingsCache = [];
let activeFilter = "all";
let batchesCache = [];
let batchListingsCache = [];   // all listings across all batches
let activeBatchFilter = "all";
let agingDays = 30;
let dashboardData = null;
let lastCreatedBatchId = null;
let firstListingThisSession = true;

// Expanded batch card state (null = none, "" = batchless, "123" = batch id)
let expandedBatchId = null;

// Delete-with-undo state
const pendingDeleteIds = new Set();
let _undoTimer    = null;
let _undoInterval = null;
let _undoPendingConfirm = null;  // called if a second delete fires while one is pending
const UNDO_TIMER_KEY = "flipstack_undo_timer_secs";
let undoDeleteMs = (parseInt(localStorage.getItem(UNDO_TIMER_KEY)) || 5) * 1000;

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
        listingsCache = await res.json();
        renderListings();
    } catch (err) { console.error("Failed to load listings:", err); }
}

function renderListings() {
    updateFilterCounts(listingsCache);

    if (listingsCache.length === 0) {
        listingsContainer.innerHTML = "";
        listingsContainer.appendChild(emptyMsg);
        emptyMsg.hidden = false;
        return;
    }

    const filtered = activeFilter === "all"
        ? listingsCache
        : listingsCache.filter(l => l.status === activeFilter);

    emptyMsg.hidden = true;

    if (filtered.length === 0) {
        const label = document.querySelector(`.filter-btn[data-filter="${activeFilter}"]`)?.firstChild?.textContent?.trim() || activeFilter;
        listingsContainer.innerHTML = `<p class="empty-state">No <strong>${label}</strong> listings yet.</p>`;
        return;
    }

    listingsContainer.innerHTML = filtered.map(renderListingCard).join("");
    attachListingEvents();
}

function updateFilterCounts(listings) {
    const counts = { all: listings.length, unlisted: 0, listed: 0, aging: 0, sold: 0 };
    for (const l of listings) { if (l.status in counts) counts[l.status]++; }
    document.querySelectorAll(".filter-btn").forEach(btn => {
        const span = btn.querySelector(".filter-count");
        if (span) span.textContent = counts[btn.dataset.filter] ?? 0;
    });
}

// Filter button clicks
document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        activeFilter = btn.dataset.filter;
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderListings();   // instant — no fetch
    });
});

function statusBadgeHtml(status) {
    const labels = { sold: "Sold", listed: "Listed", unlisted: "Unlisted", aging: "Aging Listing" };
    return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
}

function renderListingCard(listing) {
    const mainPhoto = listing.photos[0];
    const extraPhotos = listing.photos.slice(1);
    const catOptions = categoriesCache.map(c => `<option value="${escapeAttr(c)}" ${listing.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
    const itemNumDisplay = listing.item_number != null
        ? `<button class="item-number-badge item-number-link" data-action="nav-to-inventory" title="Jump to inventory row">#${listing.item_number}</button>`
        : "";

    return `
    <div class="listing-card" data-id="${listing.id}" data-batch-id="${listing.batch_id || ""}">
        <div class="listing-header">
            <div class="listing-header-left">
                <h3>Listing &mdash; ${listing.photos.length} photo${listing.photos.length !== 1 ? "s" : ""}${listing.batch_id ? " &bull; In batch" : ""}</h3>
                <div class="listing-meta-badges">${itemNumDisplay}${statusBadgeHtml(listing.status)}</div>
            </div>
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
                <div class="field-row-two">
                    <div class="field-group">
                        <div class="field-label"><label>Brand</label></div>
                        <input type="text" data-field="brand" value="${escapeAttr(listing.brand)}" list="brand-options" placeholder="e.g. Levi's">
                    </div>
                    <div class="field-group">
                        <div class="field-label"><label>Size</label></div>
                        <input type="text" data-field="size" value="${escapeAttr(listing.size)}" list="size-options" placeholder="e.g. M, 32, 9.5">
                    </div>
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
                <div class="field-row-two">
                    <div class="field-group">
                        <div class="field-label"><label>Date Listed</label></div>
                        <input type="text" class="date-shorthand-input" data-field="date_listed" value="${escapeAttr(listing.date_listed)}" placeholder="YYYY-MM-DD or t, t+1…">
                    </div>
                    <div class="field-group">
                        <div class="field-label"><label>Date Sold</label></div>
                        <input type="text" class="date-shorthand-input" data-field="date_sold" value="${escapeAttr(listing.date_sold)}" placeholder="YYYY-MM-DD or t, t-3…">
                    </div>
                </div>
                <div class="hold-days-display">${holdDaysDisplay(listing.date_listed, listing.date_sold)}</div>
            </div>
        </div>
        <div class="copy-all-row">
            <button class="btn btn-sm btn-copy" data-action="copy-all">Copy All to Clipboard</button>
            <button class="btn btn-sm btn-save-photos" data-action="save-photos">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Save Photos
            </button>
            <button class="btn btn-sm btn-pinterest" data-action="post-pinterest">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
                Pinterest
            </button>
            <button class="btn btn-sm btn-facebook" data-action="post-fb">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                Facebook
            </button>
            <a href="https://www.depop.com/products/create/" target="_blank" class="btn btn-sm btn-depop" data-action="post-depop">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
                Depop
            </a>
            <a href="https://www.ebay.com/sl/sell" target="_blank" class="btn btn-sm btn-ebay" data-action="post-ebay">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5.8 9.4c-2 0-3.4 1-3.4 2.8 0 1.5.9 2.8 3.5 2.8 1.5 0 2.6-.5 3.2-1.3h.05v1.1h2V11c0-2.3-1.7-3.1-3.7-3.1-1.6 0-3 .6-3.4 2.1l2 .4c.2-.6.7-1 1.5-1 .9 0 1.4.4 1.4 1.1v.3h-1.7zm6.2-4h2.2v2.5h.05c.5-.9 1.5-1.5 2.8-1.5 2.2 0 3.7 1.7 3.7 4s-1.5 4-3.7 4c-1.2 0-2.2-.6-2.8-1.5h-.05v1.3H12V5.4z"/></svg>
                eBay
            </a>
        </div>
    </div>`;
}

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
function escapeAttr(str) { return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// === DATE HELPERS ===
/**
 * Parse a date value that may be a shorthand:
 *   t        → today
 *   t+1      → tomorrow
 *   t-3      → 3 days ago
 *   YYYY-MM-DD → returned as-is
 * Anything else is attempted via Date() then returned as ISO date.
 */
function parseDateShorthand(val) {
    val = (val || "").trim();
    if (!val) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;          // already ISO
    const m = val.match(/^t([+-]\d+)?$/i);
    if (m) {
        const d = new Date();
        if (m[1]) d.setDate(d.getDate() + parseInt(m[1], 10));
        return d.toISOString().split("T")[0];
    }
    const parsed = new Date(val);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];
    return val;   // return as-is so the user can see something is wrong
}

/** Days between two ISO date strings. Returns null if either is missing or result is negative. */
function holdDays(dateListed, dateSold) {
    if (!dateListed || !dateSold) return null;
    const diff = Math.round((new Date(dateSold) - new Date(dateListed)) / 86_400_000);
    return diff >= 0 ? diff : null;
}

function holdDaysDisplay(dateListed, dateSold) {
    const d = holdDays(dateListed, dateSold);
    if (d === null) return "";
    return `⏱ ${d} day${d !== 1 ? "s" : ""}`;
}

// === CROSS-TAB NAVIGATION ===
function setActiveTab(tabName) {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add("active");
    document.getElementById(`tab-${tabName}`).classList.add("active");
}

function flashElement(el) {
    if (!el) return;
    el.classList.remove("highlight-flash");   // reset if already running
    void el.offsetWidth;                       // force reflow so animation restarts
    el.classList.add("highlight-flash");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => el.classList.remove("highlight-flash"), 2000);
}

async function navigateToListing(listingId) {
    // Leaving the inventory tab — release any full-screen card lock
    document.body.classList.remove("card-expanded");
    expandedBatchId = null;

    // Ensure the "All" filter is active so the target card is visible
    activeFilter = "all";
    document.querySelectorAll("#listing-filters .filter-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('#listing-filters .filter-btn[data-filter="all"]')?.classList.add("active");

    setActiveTab("listings");
    await loadListings();

    flashElement(document.querySelector(`.listing-card[data-id="${listingId}"]`));
}

async function navigateToInventoryRow(listingId) {
    // Ensure the "All" filter is active so the target row is visible
    activeBatchFilter = "all";
    document.querySelectorAll("#batch-filters .filter-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('#batch-filters .filter-btn[data-filter="all"]')?.classList.add("active");

    setActiveTab("inventory");
    await loadBatches();

    flashElement(document.querySelector(`tr[data-listing-id="${listingId}"]`));
}

// === LISTING EVENTS ===
function attachListingEvents() {
    document.querySelectorAll(".listing-card").forEach(card => {
        const id = card.dataset.id;

        // Date shorthand parsing + live hold-days update on blur
        card.addEventListener("focusout", (e) => {
            if (!e.target.classList.contains("date-shorthand-input")) return;
            const el = e.target;
            const parsed = parseDateShorthand(el.value);
            if (parsed !== el.value) el.value = parsed;
            // Refresh hold-days display
            const listed = card.querySelector('[data-field="date_listed"]').value;
            const sold   = card.querySelector('[data-field="date_sold"]').value;
            const disp   = card.querySelector(".hold-days-display");
            if (disp) disp.textContent = holdDaysDisplay(listed, sold);
        });

        card.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === "copy") { await copyText(card.querySelector(`input[data-field="${btn.dataset.field}"], textarea[data-field="${btn.dataset.field}"]`).value, btn); }
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
                    brand: card.querySelector('[data-field="brand"]').value,
                    size: card.querySelector('[data-field="size"]').value,
                    date_listed: card.querySelector('[data-field="date_listed"]').value,
                    date_sold: card.querySelector('[data-field="date_sold"]').value,
                };
                try {
                    await fetch(`/api/listings/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
                    showToast("Listing saved!");
                    loadBrands(); // refresh brand autocomplete in case a new one was added
                    loadListings(); // refresh status badge
                } catch { showToast("Save failed", true); }
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
            if (action === "post-fb") {
                btn.disabled = true;
                try {
                    // Tell the API which listing to fill next
                    await fetch("/api/pending-post", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ listing_id: id }),
                    });
                    // Open Facebook Marketplace create listing page
                    window.open("https://www.facebook.com/marketplace/create/item", "_blank");
                    showToast("Opening Facebook — extension will auto-fill the listing");
                } catch {
                    showToast("Failed to set up auto-fill", true);
                }
                btn.disabled = false;
            }
            if (action === "post-pinterest") {
                btn.disabled = true;
                try {
                    const res = await fetch(`/api/listings/${id}/post-pinterest`, { method: "POST" });
                    const data = await res.json();
                    if (!res.ok) {
                        showToast(data.error || "Pinterest post failed", true);
                        // If the error is about connecting/setup, pop Settings open
                        if (res.status === 401 || (data.error || "").toLowerCase().includes("settings")) {
                            settingsOverlay.hidden = false;
                        }
                    } else {
                        showToast("📌 Posted to Pinterest!");
                    }
                } catch { showToast("Pinterest post failed", true); }
                btn.disabled = false;
            }
            if (action === "save-photos") {
                btn.disabled = true; btn.textContent = "Saving...";
                try {
                    const res = await fetch(`/api/listings/${id}/export-photos`, { method: "POST" });
                    const data = await res.json();
                    if (res.ok) {
                        showToast(`Photos saved to: ${data.folder}`);
                    } else {
                        showToast(data.error || "Failed to save photos", true);
                    }
                } catch { showToast("Failed to save photos", true); }
                btn.disabled = false; btn.textContent = "Save Photos";
            }
            if (action === "lightbox") openLightbox(btn.dataset.url);
            if (action === "nav-to-inventory") navigateToInventoryRow(id);
        });
    });
}

async function copyText(text, btn) {
    let success = false;

    // Try modern clipboard API first (works on https and some localhost setups)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            success = true;
        } catch { /* fall through */ }
    }

    // Fallback: create a visible, focused textarea and execCommand
    if (!success) {
        const ta = document.createElement("textarea");
        ta.value = text;
        // Must be visible and in the viewport for execCommand to work
        ta.style.position = "fixed";
        ta.style.left = "0";
        ta.style.top = "0";
        ta.style.width = "1px";
        ta.style.height = "1px";
        ta.style.opacity = "0.01";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            success = document.execCommand("copy");
        } catch { /* silent */ }
        document.body.removeChild(ta);
    }

    if (success) {
        const orig = btn.textContent; btn.textContent = "Copied!"; btn.classList.add("copied");
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
        showToast("Copied to clipboard!");
    } else {
        showToast("Copy failed — try selecting the text manually", true);
    }
}

function openLightbox(url) {
    const lb = document.createElement("div"); lb.className = "lightbox";
    lb.innerHTML = `<img src="${url}">`; lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
}

function showToast(msg, isError = false) {
    // If there's a pending delete waiting for undo, confirm it immediately
    if (_undoPendingConfirm) {
        clearTimeout(_undoTimer);
        clearInterval(_undoInterval);
        const confirm = _undoPendingConfirm;
        _undoTimer = null; _undoInterval = null; _undoPendingConfirm = null;
        confirm();
    }
    toast.classList.remove("toast-undo");
    toast.innerHTML = "";
    toast.textContent = msg;
    toast.style.background = isError ? "var(--red)" : "var(--bg-card-solid)";
    toast.style.color = isError ? "#fff" : "var(--text)";
    toast.hidden = false; toast.classList.add("show");
    setTimeout(() => { toast.classList.remove("show"); setTimeout(() => (toast.hidden = true), 300); }, 2500);
}

/**
 * Show an undo toast with a countdown.
 * onUndo()    — called if the user clicks Undo (cancels the action)
 * onConfirm() — called when the timer expires (commits the action)
 */
function showUndoToast(msg, onUndo, onConfirm, durationMs = 5000) {
    // Flush any prior pending undo immediately
    if (_undoPendingConfirm) {
        clearTimeout(_undoTimer);
        clearInterval(_undoInterval);
        const prev = _undoPendingConfirm;
        _undoTimer = null; _undoInterval = null; _undoPendingConfirm = null;
        prev();
    }

    _undoPendingConfirm = onConfirm;

    let remaining = Math.ceil(durationMs / 1000);

    const countdownEl = document.createElement("span");
    countdownEl.className = "undo-countdown";
    countdownEl.textContent = `${remaining}s`;

    const undoBtn = document.createElement("button");
    undoBtn.className = "undo-btn";
    undoBtn.textContent = "Undo";

    const msgEl = document.createElement("span");
    msgEl.className = "undo-msg";
    msgEl.textContent = msg;

    toast.innerHTML = "";
    toast.classList.add("toast-undo");
    toast.style.background = "";
    toast.style.color = "";
    toast.appendChild(msgEl);
    toast.appendChild(undoBtn);
    toast.appendChild(countdownEl);
    toast.hidden = false;
    toast.classList.add("show");

    _undoInterval = setInterval(() => {
        remaining -= 1;
        countdownEl.textContent = `${remaining}s`;
        if (remaining <= 0) { clearInterval(_undoInterval); _undoInterval = null; }
    }, 1000);

    undoBtn.addEventListener("click", () => {
        clearTimeout(_undoTimer);
        clearInterval(_undoInterval);
        _undoTimer = null; _undoInterval = null; _undoPendingConfirm = null;
        toast.classList.remove("show");
        setTimeout(() => { toast.hidden = true; toast.classList.remove("toast-undo"); toast.innerHTML = ""; }, 300);
        onUndo();
    }, { once: true });

    _undoTimer = setTimeout(() => {
        clearInterval(_undoInterval);
        _undoInterval = null; _undoPendingConfirm = null; _undoTimer = null;
        toast.classList.remove("show");
        setTimeout(() => { toast.hidden = true; toast.classList.remove("toast-undo"); toast.innerHTML = ""; }, 300);
        onConfirm();
    }, durationMs);
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
        const [bRes, lRes] = await Promise.all([fetch("/api/batches"), fetch("/api/listings")]);
        batchesCache = await bRes.json();
        batchListingsCache = await lRes.json();
        renderBatches();
    } catch (e) { console.error(e); }
}

function renderBatchlessCard(displayListings, totalCount) {
    const batchOpts = batchesCache.map(b =>
        `<option value="${b.id}">${escapeHtml(b.name)}</option>`
    ).join("");

    let bodyHtml;
    if (totalCount === 0) {
        bodyHtml = '<div class="batch-empty-items"><p class="muted">No unassigned items. Click "+ Add Item" or "Post w/o Photos" to create a listing without a batch.</p></div>';
    } else if (displayListings.length === 0) {
        const label = document.querySelector(`#batch-filters .filter-btn[data-filter="${activeBatchFilter}"]`)?.childNodes[0]?.textContent?.trim() || activeBatchFilter;
        bodyHtml = `<div class="batch-empty-items"><p class="muted">No unassigned <strong>${label}</strong> items.</p></div>`;
    } else {
        bodyHtml = `
        <div class="batch-items">
            <div class="table-scroll-wrap">
            <table class="inventory-table">
                <thead><tr>
                    <th class="sort-col" data-col="0">Batch <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="1"># <span class="sort-icon"></span></th>
                    <th>Photo</th>
                    <th class="sort-col" data-col="3">Name <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="4">Status <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="5">Brand <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="6">Size <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="7">Category <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="8">Cost <span class="sort-icon"></span></th>
                    <th>Non-std cost</th>
                    <th class="sort-col" data-col="10">List Price <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="11">Sale Price <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="12">Processing <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="13">Other Fees <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="14">Date Listed <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="15">Date Sold <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="16">Hold Days <span class="sort-icon"></span></th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${displayListings.map(l => {
                        const thumb = l.photos[0] ? `<img src="${l.photos[0].url}" class="table-thumb">` : "";
                        const selCatOpts = categoriesCache.map(c => `<option value="${escapeAttr(c)}" ${l.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
                        const itemNum = l.item_number != null
                            ? `<button class="item-number-badge item-number-link" data-action="nav-to-listing" data-listing-id="${l.id}" title="Jump to listing card">#${l.item_number}</button>`
                            : "<span class='muted'>—</span>";
                        const pendingClass = pendingDeleteIds.has(l.id) ? ' class="row-pending-delete"' : '';
                        return `<tr data-listing-id="${l.id}"${pendingClass}>
                            <td><select class="table-select" data-field="batch_id">
                                <option value="">— Unassigned —</option>
                                ${batchOpts}
                            </select></td>
                            <td class="center-cell">${itemNum}</td>
                            <td>${thumb}</td>
                            <td class="item-name" title="${escapeAttr(l.name)}">${escapeHtml(l.name)}</td>
                            <td class="center-cell">${statusBadgeHtml(l.status)}</td>
                            <td><input type="text" class="table-text-input" data-field="brand" value="${escapeAttr(l.brand)}" list="brand-options" placeholder="Brand"></td>
                            <td><input type="text" class="table-text-input" data-field="size" value="${escapeAttr(l.size)}" list="size-options" placeholder="Size"></td>
                            <td><select data-field="category" class="table-select"><option value="">--</option>${selCatOpts}</select></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="cost" step="0.01" min="0" value="${l.cost.toFixed(2)}"></div></td>
                            <td class="center-cell"><input type="checkbox" data-field="cost_locked" ${l.cost_locked ? "checked" : ""}></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="list_price" step="0.01" min="0" value="${l.list_price.toFixed(2)}"></div></td>
                            <td><input type="number" class="cost-input" data-field="sale_price" step="0.01" min="0" value="${l.sale_price.toFixed(2)}"></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="processing_cost" step="0.01" min="0" value="${l.processing_cost.toFixed(2)}"></div></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="other_fees" step="0.01" min="0" value="${l.other_fees.toFixed(2)}"></div></td>
                            <td><input type="text" class="table-text-input date-shorthand-input" data-field="date_listed" value="${escapeAttr(l.date_listed || '')}" placeholder="t or YYYY-MM-DD"></td>
                            <td><input type="text" class="table-text-input date-shorthand-input" data-field="date_sold" value="${escapeAttr(l.date_sold || '')}" placeholder="t or YYYY-MM-DD"></td>
                            <td class="center-cell hold-days-cell">${holdDays(l.date_listed, l.date_sold) !== null ? holdDays(l.date_listed, l.date_sold) + "d" : "—"}</td>
                            <td class="center-cell"><button class="btn-row-delete" data-action="delete-item" tabindex="-1" title="Delete item">&times;</button></td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
            </div>
            <div class="batch-table-actions"><button class="btn btn-sm btn-save" data-action="save-batchless">Save All</button></div>
        </div>`;
    }

    return `
    <div class="batch-card batchless-card" data-batch-id="" data-batchless="true" data-batch-total="0">
        <div class="batch-card-header">
            <div class="batch-info">
                <h3>Unassigned Items <span class="batchless-count-badge">${totalCount}</span></h3>
                <div class="batch-stats">
                    <span class="muted" style="font-size:0.75rem">Not linked to any batch &mdash; select a batch in the table and Save All to move items.</span>
                </div>
            </div>
            <div class="batch-actions">
                <button class="btn btn-sm btn-accent" data-action="add-item">+ Add Item</button>
                <button class="btn btn-sm btn-ghost btn-expand-card" data-action="expand-card" title="Expand to full screen">${ICON_EXPAND}</button>
            </div>
        </div>

        <div class="batch-inline-upload" hidden>
            <div class="inline-upload-inner">
                <div class="inline-dropzone">
                    <input type="file" class="inline-file-input" multiple accept="image/*" hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    <p><strong>Click or drop photos</strong></p>
                    <p class="muted inline-file-count">No files selected</p>
                </div>
                <div class="inline-file-previews"></div>
                <div class="inline-upload-actions">
                    <button class="btn btn-sm btn-accent inline-upload-btn" disabled>
                        <span class="btn-text">Upload &amp; Analyze</span>
                        <span class="btn-loading" hidden><span class="spinner"></span> Analyzing…</span>
                    </button>
                    <button class="btn btn-sm btn-ghost" data-action="no-photo-upload">No Photo</button>
                    <button class="btn btn-sm btn-ghost" data-action="cancel-upload">Cancel</button>
                </div>
            </div>
        </div>

        ${bodyHtml}
    </div>`;
}

function renderBatches() {
    updateBatchFilterCounts(batchListingsCache);

    const batchlessAll = batchListingsCache.filter(l => !l.batch_id);
    const batchlessDisplay = activeBatchFilter === "all"
        ? batchlessAll
        : batchlessAll.filter(l => l.status === activeBatchFilter);

    // Show the empty state only when there are literally no batches and no batchless items
    if (batchesCache.length === 0 && batchlessAll.length === 0) {
        batchesContainer.innerHTML = "";
        batchesContainer.appendChild(batchesEmpty);
        batchesEmpty.hidden = false;
        return;
    }
    batchesEmpty.hidden = true;

    // Batchless card always comes first
    const htmlParts = [renderBatchlessCard(batchlessDisplay, batchlessAll.length)];

    batchesCache.forEach(batch => {
        const allItems     = batchListingsCache.filter(l => l.batch_id === batch.id);
        const displayItems = activeBatchFilter === "all"
            ? allItems
            : allItems.filter(l => l.status === activeBatchFilter);
        if (activeBatchFilter !== "all" && displayItems.length === 0) return;
        htmlParts.push(renderBatchCard(batch, allItems, displayItems));
    });

    batchesContainer.innerHTML = htmlParts.join("");
    attachBatchEvents();

    // Re-apply expanded state after re-render
    if (expandedBatchId !== null) {
        const card = batchesContainer.querySelector(`.batch-card[data-batch-id="${expandedBatchId}"]`);
        if (card) {
            card.classList.add("expanded");
            document.body.classList.add("card-expanded");
            const btn = card.querySelector('[data-action="expand-card"]');
            if (btn) { btn.innerHTML = ICON_COLLAPSE; btn.title = "Collapse"; }
        } else {
            // Batch was deleted — clear the saved state
            expandedBatchId = null;
            document.body.classList.remove("card-expanded");
        }
    }
}

function updateBatchFilterCounts(listings) {
    // Count ALL listings (including batchless) so filter pills reflect everything
    const counts = { all: listings.length, unlisted: 0, listed: 0, aging: 0, sold: 0 };
    for (const l of listings) { if (l.status in counts) counts[l.status]++; }
    document.querySelectorAll("#batch-filters .filter-btn").forEach(btn => {
        const span = btn.querySelector(".filter-count");
        if (span) span.textContent = counts[btn.dataset.filter] ?? 0;
    });
}

// Batch filter pill clicks
document.getElementById("batch-filters").querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        activeBatchFilter = btn.dataset.filter;
        document.querySelectorAll("#batch-filters .filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderBatches();   // instant — no fetch
    });
});

function renderBatchCard(batch, listings, displayListings = listings) {
    const perItem = batch.item_count > 0 ? (batch.total_cost / batch.item_count).toFixed(2) : "0.00";
    const totalAssignedCost = listings.reduce((s, l) => s + (l.cost || 0), 0);
    const isBalanced = Math.abs(totalAssignedCost - batch.total_cost) < 0.02;
    const assignedClass = isBalanced ? "balanced" : "out-of-balance";
    const totalListPrice = listings.reduce((s, l) => s + (l.list_price || 0), 0);

    return `
    <div class="batch-card" data-batch-id="${batch.id}" data-batch-total="${batch.total_cost}">
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
                <button class="btn btn-sm btn-accent" data-action="add-item">+ Add Item</button>
                <button class="btn btn-sm btn-save" data-action="edit-batch">Edit</button>
                <button class="btn btn-sm btn-danger" data-action="delete-batch">Delete</button>
                <button class="btn btn-sm btn-ghost btn-expand-card" data-action="expand-card" title="Expand to full screen">${ICON_EXPAND}</button>
            </div>
        </div>

        <!-- Inline item uploader (hidden until "+ Add Item" is clicked) -->
        <div class="batch-inline-upload" hidden>
            <div class="inline-upload-inner">
                <div class="inline-dropzone">
                    <input type="file" class="inline-file-input" multiple accept="image/*" hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    <p><strong>Click or drop photos</strong></p>
                    <p class="muted inline-file-count">No files selected</p>
                </div>
                <div class="inline-file-previews"></div>
                <div class="inline-upload-actions">
                    <label class="bulk-mode-row" title="Drop every photo for the whole batch at once — AI groups them by clothing item and creates one listing per item">
                        <span class="toggle-switch">
                            <input type="checkbox" class="bulk-mode-toggle">
                            <span class="toggle-slider"></span>
                        </span>
                        <span class="bulk-mode-label">Bulk Mode <span class="bulk-mode-hint">— AI sorts all photos by item</span></span>
                    </label>
                    <div class="inline-upload-btns">
                        <button class="btn btn-sm btn-accent inline-upload-btn" disabled>
                            <span class="btn-text">Upload &amp; Analyze</span>
                            <span class="btn-loading" hidden><span class="spinner"></span> <span class="loading-text">Analyzing…</span></span>
                        </button>
                        <button class="btn btn-sm btn-ghost" data-action="no-photo-upload">No Photo</button>
                        <button class="btn btn-sm btn-ghost" data-action="cancel-upload">Cancel</button>
                    </div>
                </div>
            </div>
        </div>

        ${listings.length > 0 ? `
        <div class="batch-items">
            <div class="table-scroll-wrap">
            <table class="inventory-table">
                <thead><tr>
                    <th class="sort-col" data-col="0"># <span class="sort-icon"></span></th>
                    <th>Photo</th>
                    <th class="sort-col" data-col="2">Name <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="3">Status <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="4">Brand <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="5">Size <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="6">Category <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="7">Cost <span class="sort-icon"></span></th>
                    <th>Non-std cost</th>
                    <th class="sort-col" data-col="9">List Price <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="10">Sale Price <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="11">Processing <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="12">Other Fees <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="13">Date Listed <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="14">Date Sold <span class="sort-icon"></span></th>
                    <th class="sort-col" data-col="15">Hold Days <span class="sort-icon"></span></th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${displayListings.map(l => {
                        const thumb = l.photos[0] ? `<img src="${l.photos[0].url}" class="table-thumb">` : "";
                        const selCatOpts = categoriesCache.map(c => `<option value="${escapeAttr(c)}" ${l.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
                        const itemNum = l.item_number != null
                            ? `<button class="item-number-badge item-number-link" data-action="nav-to-listing" data-listing-id="${l.id}" title="Jump to listing card">#${l.item_number}</button>`
                            : "<span class='muted'>—</span>";
                        const pendingClass = pendingDeleteIds.has(l.id) ? ' class="row-pending-delete"' : '';
                        return `<tr data-listing-id="${l.id}"${pendingClass}>
                            <td class="center-cell">${itemNum}</td>
                            <td>${thumb}</td>
                            <td class="item-name" title="${escapeAttr(l.name)}">${escapeHtml(l.name)}</td>
                            <td class="center-cell">${statusBadgeHtml(l.status)}</td>
                            <td><input type="text" class="table-text-input" data-field="brand" value="${escapeAttr(l.brand)}" list="brand-options" placeholder="Brand"></td>
                            <td><input type="text" class="table-text-input" data-field="size" value="${escapeAttr(l.size)}" list="size-options" placeholder="Size"></td>
                            <td><select data-field="category" class="table-select"><option value="">--</option>${selCatOpts}</select></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="cost" step="0.01" min="0" value="${l.cost.toFixed(2)}"></div></td>
                            <td class="center-cell"><input type="checkbox" data-field="cost_locked" ${l.cost_locked ? "checked" : ""}></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="list_price" step="0.01" min="0" value="${l.list_price.toFixed(2)}"></div></td>
                            <td><input type="number" class="cost-input" data-field="sale_price" step="0.01" min="0" value="${l.sale_price.toFixed(2)}"></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="processing_cost" step="0.01" min="0" value="${l.processing_cost.toFixed(2)}"></div></td>
                            <td><div class="currency-wrap"><span>$</span><input type="number" class="cost-input" data-field="other_fees" step="0.01" min="0" value="${l.other_fees.toFixed(2)}"></div></td>
                            <td><input type="text" class="table-text-input date-shorthand-input" data-field="date_listed" value="${escapeAttr(l.date_listed || '')}" placeholder="t or YYYY-MM-DD"></td>
                            <td><input type="text" class="table-text-input date-shorthand-input" data-field="date_sold" value="${escapeAttr(l.date_sold || '')}" placeholder="t or YYYY-MM-DD"></td>
                            <td class="center-cell hold-days-cell">${holdDays(l.date_listed, l.date_sold) !== null ? holdDays(l.date_listed, l.date_sold) + "d" : "—"}</td>
                            <td class="center-cell"><button class="btn-row-delete" data-action="delete-item" tabindex="-1" title="Delete item">&times;</button></td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
            </div>
            <div class="batch-table-actions"><button class="btn btn-sm btn-save" data-action="save-costs">Save All</button></div>
        </div>
        ` : '<div class="batch-empty-items"><p class="muted">No items uploaded yet. Go to the Listings tab, select this batch, and upload photos.</p></div>'}
    </div>`;
}

// Per-batch sort state: batchId → { col: Number, dir: 'asc'|'desc' }
const batchSortState = new Map();
// Files staged in the per-batch inline uploader: batchId → File[]
const inlineFilesMap = new Map();

/** Extract a sortable scalar from a given table cell. */
function getCellSortValue(row, colIndex) {
    const cell = row.cells[colIndex];
    if (!cell) return "";
    const numInput = cell.querySelector('input[type="number"]');
    if (numInput) return parseFloat(numInput.value) || 0;
    const textInput = cell.querySelector('input[type="text"]');
    if (textInput) return textInput.value.toLowerCase();
    const sel = cell.querySelector("select");
    if (sel) return sel.value.toLowerCase();
    const txt = cell.textContent.trim();
    if (txt === "—" || txt === "") return "￿";  // sort blanks last
    const holdMatch = txt.match(/^(\d+)d$/);
    if (holdMatch) return parseInt(holdMatch[1]);
    const idMatch = txt.match(/^#(\d+)$/);
    if (idMatch) return parseInt(idMatch[1]);
    return txt.toLowerCase();
}

/** Sort a table's tbody rows by the given column index and direction. */
function sortBatchTable(table, colIndex, dir) {
    const tbody = table.querySelector("tbody");
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
        const av = getCellSortValue(a, colIndex);
        const bv = getCellSortValue(b, colIndex);
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
        return 0;
    });
    rows.forEach(r => tbody.appendChild(r));
}

/** Render staged file previews inside the batch inline-upload section. */
function updateInlinePreview(card, files) {
    const countEl  = card.querySelector(".inline-file-count");
    const previewEl = card.querySelector(".inline-file-previews");
    const uploadBtn = card.querySelector(".inline-upload-btn");
    countEl.textContent = files.length
        ? `${files.length} photo${files.length !== 1 ? "s" : ""} selected`
        : "No files selected";
    previewEl.innerHTML = "";
    files.forEach(f => {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(f);
        img.className = "inline-preview-img";
        previewEl.appendChild(img);
    });
    uploadBtn.disabled = files.length === 0;
}

/**
 * Redistribute batch cost among unlocked rows so they sum to the batch total.
 * Skips silently if rebalancing would produce a negative per-item cost.
 */
function rebalanceBatchTable(card) {
    const batchTotal = parseFloat(card.dataset.batchTotal) || 0;
    const rows = Array.from(card.querySelectorAll("tbody tr"));

    let lockedSum = 0;
    const unlockedRows = [];

    for (const row of rows) {
        const locked = row.querySelector('[data-field="cost_locked"]').checked;
        const cost   = parseFloat(row.querySelector('[data-field="cost"]').value) || 0;
        if (locked) lockedSum += cost;
        else        unlockedRows.push(row);
    }

    if (unlockedRows.length === 0) return;          // nothing to distribute to
    const remaining = Math.round((batchTotal - lockedSum) * 100) / 100;
    if (remaining < 0) return;                      // would produce negative costs

    // Distribute evenly; give the last row any leftover from rounding
    const perItem = Math.floor((remaining / unlockedRows.length) * 100) / 100;
    let distributed = 0;
    unlockedRows.forEach((row, i) => {
        const costInput = row.querySelector('[data-field="cost"]');
        const isLast = i === unlockedRows.length - 1;
        const amount = isLast
            ? Math.round((remaining - distributed) * 100) / 100
            : perItem;
        costInput.value = amount.toFixed(2);
        distributed += perItem;
    });
}

// Expand / collapse icons for the full-screen card toggle
const ICON_EXPAND   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const ICON_COLLAPSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;

// === BATCH EDIT MODAL ===
const batchEditModal    = document.getElementById("batch-edit-modal");
const batchEditName     = document.getElementById("be-name");
const batchEditTotal    = document.getElementById("be-total");
const batchEditExpected = document.getElementById("be-expected");
const batchEditUploaded = document.getElementById("be-uploaded");
const batchEditSaveBtn  = document.getElementById("batch-edit-save");

let _editingBatchId = null;

function openBatchEditModal(batchId, card) {
    _editingBatchId = batchId;

    // Populate fields from the card
    const nameEl = card.querySelector("h3");
    const stats  = card.querySelectorAll(".batch-stats strong");

    batchEditName.value     = nameEl ? nameEl.textContent.trim() : "";
    batchEditTotal.value    = stats[0] ? stats[0].textContent.replace("$", "").trim() : "";
    batchEditExpected.value = stats[1] ? stats[1].textContent.trim() : "";
    batchEditUploaded.textContent = stats[2] ? stats[2].textContent.trim() : "—";

    batchEditModal.hidden = false;
    batchEditName.focus();
}

function closeBatchEditModal() {
    batchEditModal.hidden = true;
    _editingBatchId = null;
}

// Close on backdrop click
batchEditModal.addEventListener("click", (e) => {
    if (e.target === batchEditModal) closeBatchEditModal();
});
// Close button & Cancel
document.getElementById("batch-edit-close").addEventListener("click", closeBatchEditModal);
document.getElementById("batch-edit-cancel").addEventListener("click", closeBatchEditModal);
// Escape key
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (!batchEditModal.hidden) { closeBatchEditModal(); return; }
        // Collapse any expanded batch card
        const expanded = document.querySelector(".batch-card.expanded");
        if (expanded) {
            expanded.classList.remove("expanded");
            document.body.classList.remove("card-expanded");
            expandedBatchId = null;
            const btn = expanded.querySelector('[data-action="expand-card"]');
            if (btn) { btn.innerHTML = ICON_EXPAND; btn.title = "Expand to full screen"; }
        }
    }
});

// Save
batchEditSaveBtn.addEventListener("click", async () => {
    if (!_editingBatchId) return;
    const name       = batchEditName.value.trim();
    const total_cost = parseFloat(batchEditTotal.value);
    const item_count = parseInt(batchEditExpected.value);

    if (!name)              { showToast("Batch name is required", true); return; }
    if (isNaN(total_cost))  { showToast("Enter a valid total", true); return; }
    if (isNaN(item_count))  { showToast("Enter a valid item count", true); return; }

    batchEditSaveBtn.disabled = true;
    batchEditSaveBtn.textContent = "Saving…";
    try {
        const res = await fetch(`/api/batches/${_editingBatchId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, total_cost, item_count }),
        });
        if (!res.ok) { const d = await res.json(); showToast(d.error || "Update failed", true); return; }
        closeBatchEditModal();
        showToast("Batch updated! Costs rebalanced.");
        loadBatches();
        loadBatchSelectDropdown();
    } catch { showToast("Update failed", true); }
    finally {
        batchEditSaveBtn.disabled = false;
        batchEditSaveBtn.textContent = "Save Changes";
    }
});

function attachBatchEvents() {
    document.querySelectorAll(".batch-card").forEach(card => {
        const batchId = card.dataset.batchId;

        const isBatchless = card.dataset.batchless === "true";

        // Live rebalancing of unlocked costs (not meaningful for batchless items)
        if (!isBatchless) {
            card.addEventListener("change", (e) => {
                // Toggling the Non-std cost checkbox → rebalance immediately
                if (e.target.matches('[data-field="cost_locked"]')) rebalanceBatchTable(card);
            });
            card.addEventListener("input", (e) => {
                // Editing the cost of a *locked* row → rebalance unlocked rows as you type
                if (e.target.matches('[data-field="cost"]')) {
                    const row = e.target.closest("tr");
                    if (row?.querySelector('[data-field="cost_locked"]')?.checked) {
                        rebalanceBatchTable(card);
                    }
                }
            });
        }

        // Date shorthand parsing + live hold-days cell update
        card.addEventListener("focusout", (e) => {
            if (!e.target.classList.contains("date-shorthand-input")) return;
            const el = e.target;
            const parsed = parseDateShorthand(el.value);
            if (parsed !== el.value) el.value = parsed;
            // Update the hold-days cell in the same row
            const row = el.closest("tr");
            if (row) {
                const listed = row.querySelector('[data-field="date_listed"]').value;
                const sold   = row.querySelector('[data-field="date_sold"]').value;
                const cell   = row.querySelector(".hold-days-cell");
                if (cell) {
                    const d = holdDays(listed, sold);
                    cell.textContent = d !== null ? d + "d" : "—";
                }
            }
        });

        // Sortable column headers
        card.querySelectorAll("th.sort-col").forEach(th => {
            th.addEventListener("click", () => {
                const table = th.closest("table");
                if (!table) return;
                const colIndex = parseInt(th.dataset.col);
                const state = batchSortState.get(batchId) || { col: -1, dir: "asc" };
                const newDir = (state.col === colIndex && state.dir === "asc") ? "desc" : "asc";
                batchSortState.set(batchId, { col: colIndex, dir: newDir });
                card.querySelectorAll("th.sort-col").forEach(h => h.classList.remove("sort-asc", "sort-desc"));
                th.classList.add(newDir === "asc" ? "sort-asc" : "sort-desc");
                sortBatchTable(table, colIndex, newDir);
            });
        });

        // Inline upload section wiring
        const inlineSection  = card.querySelector(".batch-inline-upload");
        const inlineDropzone = card.querySelector(".inline-dropzone");
        const inlineFileInput = card.querySelector(".inline-file-input");
        const inlineUploadBtn = card.querySelector(".inline-upload-btn");

        inlineDropzone.addEventListener("click", () => inlineFileInput.click());
        inlineDropzone.addEventListener("dragover",  (e) => { e.preventDefault(); inlineDropzone.classList.add("dragover"); });
        inlineDropzone.addEventListener("dragleave", ()  => inlineDropzone.classList.remove("dragover"));
        inlineDropzone.addEventListener("drop", (e) => {
            e.preventDefault();
            inlineDropzone.classList.remove("dragover");
            const newFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
            const merged = [...(inlineFilesMap.get(batchId) || []), ...newFiles];
            inlineFilesMap.set(batchId, merged);
            updateInlinePreview(card, merged);
        });
        inlineFileInput.addEventListener("change", () => {
            const newFiles = Array.from(inlineFileInput.files).filter(f => f.type.startsWith("image/"));
            const merged = [...(inlineFilesMap.get(batchId) || []), ...newFiles];
            inlineFilesMap.set(batchId, merged);
            updateInlinePreview(card, merged);
            inlineFileInput.value = "";
        });
        // Bulk mode toggle — update button label when switched
        const bulkToggle = card.querySelector(".bulk-mode-toggle");
        if (bulkToggle) {
            bulkToggle.addEventListener("change", () => {
                const bulk = bulkToggle.checked;
                const btnText = inlineUploadBtn.querySelector(".btn-text");
                if (btnText) btnText.textContent = bulk ? "Upload & Auto-Sort" : "Upload & Analyze";
            });
        }

        inlineUploadBtn.addEventListener("click", async () => {
            const files = inlineFilesMap.get(batchId) || [];
            if (!files.length) return;

            const isBulk = !isBatchless && bulkToggle?.checked && !!batchId;
            const loadingText = inlineUploadBtn.querySelector(".loading-text");

            inlineUploadBtn.disabled = true;
            inlineUploadBtn.querySelector(".btn-text").hidden = true;
            inlineUploadBtn.querySelector(".btn-loading").hidden = false;
            if (loadingText) loadingText.textContent = isBulk ? "Sorting & analyzing…" : "Analyzing…";

            try {
                const fd = new FormData();
                files.forEach(f => fd.append("photos", f));

                if (isBulk) {
                    // ── Bulk mode: one API call groups all photos, creates N listings ──
                    const res = await fetch(`/api/batches/${batchId}/bulk-analyze`, { method: "POST", body: fd });
                    const data = await res.json();
                    if (!res.ok) { showToast(data.error || "Bulk analysis failed", true); return; }
                    inlineFilesMap.delete(batchId);
                    inlineSection.hidden = true;
                    const n = data.listings_created;
                    showToast(`${n} item${n !== 1 ? "s" : ""} created from ${files.length} photos!`);
                    await loadBatches();
                } else {
                    // ── Normal mode: single listing per upload ──
                    if (batchId) fd.append("batch_id", batchId);
                    const res = await fetch("/api/listings", { method: "POST", body: fd });
                    const data = await res.json();
                    if (!res.ok) { showToast(data.error || "Upload failed", true); return; }
                    inlineFilesMap.delete(batchId);
                    inlineSection.hidden = true;
                    showToast("Item added! AI drafted your listing.");
                    await loadBatches();
                }
            } catch (err) {
                showToast("Upload failed: " + err.message, true);
            } finally {
                inlineUploadBtn.querySelector(".btn-text").hidden = false;
                inlineUploadBtn.querySelector(".btn-loading").hidden = true;
                const remaining = inlineFilesMap.get(batchId) || [];
                inlineUploadBtn.disabled = remaining.length === 0;
            }
        });

        card.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === "expand-card") {
                const isExpanded = card.classList.toggle("expanded");
                btn.innerHTML = isExpanded ? ICON_COLLAPSE : ICON_EXPAND;
                btn.title     = isExpanded ? "Collapse" : "Expand to full screen";
                document.body.classList.toggle("card-expanded", isExpanded);
                expandedBatchId = isExpanded ? batchId : null;
                if (isExpanded) card.scrollTop = 0;
                return;
            }
            if (action === "nav-to-listing") { navigateToListing(btn.dataset.listingId); return; }
            if (action === "add-item") {
                inlineSection.hidden = !inlineSection.hidden;
                return;
            }
            if (action === "cancel-upload") {
                inlineSection.hidden = true;
                inlineFilesMap.delete(batchId);
                updateInlinePreview(card, []);
                return;
            }
            if (action === "no-photo-upload") {
                const itemName = prompt("Enter item name:");
                if (!itemName || !itemName.trim()) return;
                try {
                    const body = { name: itemName.trim() };
                    if (batchId) body.batch_id = batchId;
                    const res = await fetch("/api/listings/no-photo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    });
                    const data = await res.json();
                    if (!res.ok) { showToast(data.error || "Failed to create listing", true); return; }
                    showToast("Listing created!");
                    await loadBatches();
                } catch { showToast("Failed to create listing", true); }
                return;
            }
            if (action === "save-batchless") {
                const rows = card.querySelectorAll("tbody tr");
                let anyFailed = false;
                let anyMoved = false;
                for (const row of rows) {
                    const listingId = row.dataset.listingId;
                    const selectedBatchId = row.querySelector('[data-field="batch_id"]').value || null;
                    if (selectedBatchId) anyMoved = true;
                    const body = {
                        batch_id: selectedBatchId,
                        cost: parseFloat(row.querySelector('[data-field="cost"]').value) || 0,
                        cost_locked: row.querySelector('[data-field="cost_locked"]').checked ? 1 : 0,
                        list_price: parseFloat(row.querySelector('[data-field="list_price"]').value) || 0,
                        sale_price: parseFloat(row.querySelector('[data-field="sale_price"]').value) || 0,
                        processing_cost: parseFloat(row.querySelector('[data-field="processing_cost"]').value) || 0,
                        other_fees: parseFloat(row.querySelector('[data-field="other_fees"]').value) || 0,
                        category: row.querySelector('[data-field="category"]').value,
                        brand: row.querySelector('[data-field="brand"]').value,
                        size: row.querySelector('[data-field="size"]').value,
                        date_listed: row.querySelector('[data-field="date_listed"]').value,
                        date_sold: row.querySelector('[data-field="date_sold"]').value,
                        // Let backend rebalance the target batch when items are assigned
                        skip_rebalance: false,
                    };
                    try {
                        await fetch(`/api/listings/${listingId}`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                        });
                    } catch { anyFailed = true; }
                }
                loadBrands();
                await loadBatches();
                if (anyFailed) {
                    showToast("Some items failed to save", true);
                } else if (anyMoved) {
                    showToast("Saved! Assigned items have been moved to their batches.");
                } else {
                    showToast("All changes saved!");
                }
                return;
            }
            if (action === "delete-item") {
                const row = btn.closest("tr");
                if (!row) return;
                const listingId = row.dataset.listingId;
                if (!listingId || pendingDeleteIds.has(listingId)) return;

                // Find item name for the toast message
                const nameCell = row.querySelector(".item-name");
                const itemName = nameCell ? nameCell.textContent.trim() : "Item";
                const shortName = itemName.length > 28 ? itemName.substring(0, 28) + "…" : itemName;

                // Mark row as pending-delete (visually dims it)
                pendingDeleteIds.add(listingId);
                row.classList.add("row-pending-delete");

                showUndoToast(
                    `"${shortName}" deleted.`,
                    // onUndo: restore the row
                    () => {
                        pendingDeleteIds.delete(listingId);
                        row.classList.remove("row-pending-delete");
                    },
                    // onConfirm: actually delete via API then reload
                    async () => {
                        pendingDeleteIds.delete(listingId);
                        try {
                            await fetch(`/api/listings/${listingId}`, { method: "DELETE" });
                        } catch { /* silently ignore — row is already gone from UI */ }
                        await loadBatches();
                    },
                    undoDeleteMs
                );
                return;
            }
            if (action === "delete-batch") {
                if (!confirm("Delete this batch? Listings will be kept but unlinked.")) return;
                try { await fetch(`/api/batches/${batchId}`, { method: "DELETE" }); showToast("Batch deleted"); loadBatches(); loadBatchSelectDropdown(); } catch { showToast("Delete failed", true); }
            }
            if (action === "edit-batch") {
                openBatchEditModal(batchId, card);
            }
            if (action === "save-costs") {
                const rows = card.querySelectorAll("tbody tr");
                let anyFailed = false;
                let totalEntered = 0;
                for (const row of rows) {
                    const listingId = row.dataset.listingId;
                    const cost = parseFloat(row.querySelector('[data-field="cost"]').value) || 0;
                    totalEntered += cost;
                    const body = {
                        cost,
                        cost_locked: row.querySelector('[data-field="cost_locked"]').checked ? 1 : 0,
                        list_price: parseFloat(row.querySelector('[data-field="list_price"]').value) || 0,
                        sale_price: parseFloat(row.querySelector('[data-field="sale_price"]').value) || 0,
                        processing_cost: parseFloat(row.querySelector('[data-field="processing_cost"]').value) || 0,
                        other_fees: parseFloat(row.querySelector('[data-field="other_fees"]').value) || 0,
                        category: row.querySelector('[data-field="category"]').value,
                        brand: row.querySelector('[data-field="brand"]').value,
                        size: row.querySelector('[data-field="size"]').value,
                        date_listed: row.querySelector('[data-field="date_listed"]').value,
                        date_sold: row.querySelector('[data-field="date_sold"]').value,
                        skip_rebalance: true,   // never auto-redistribute on manual save
                    };
                    try { await fetch(`/api/listings/${listingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { anyFailed = true; }
                }
                loadBrands();
                await loadBatches();   // reload so the balance warning banner reflects reality

                if (anyFailed) {
                    showToast("Some items failed to save", true);
                } else {
                    // Read the batch total from the card header so we can compare
                    const batchTotalEl = card.querySelector(".batch-stats strong");
                    const batchTotal = batchTotalEl ? parseFloat(batchTotalEl.textContent.replace("$", "")) : null;
                    const outOfBalance = batchTotal !== null && Math.abs(totalEntered - batchTotal) > 0.02;
                    if (outOfBalance) {
                        showToast(
                            `Saved — but costs are out of balance ($${totalEntered.toFixed(2)} assigned vs $${batchTotal.toFixed(2)} total). Review the warning below.`,
                            true
                        );
                    } else {
                        showToast("All changes saved!");
                    }
                }
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
        container.innerHTML = renderPLTable(["Item","Batch","Category","Cost","List","Sale","Processing","Other Fees","P/L"],
            dashboardData.items.map(r => [r.name, r.batch_name, r.category, `$${r.cost.toFixed(2)}`, `$${r.list_price.toFixed(2)}`, `$${r.sale_price.toFixed(2)}`, `$${r.processing_cost.toFixed(2)}`, `$${r.other_fees.toFixed(2)}`, plCell(r.profit)]));
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

// === BRANDS AUTOCOMPLETE ===
async function loadBrands() {
    try {
        const res = await fetch("/api/brands");
        brandsCache = await res.json();
        const dl = document.getElementById("brand-options");
        if (dl) {
            dl.innerHTML = brandsCache.map(b => `<option value="${escapeAttr(b)}">`).join("");
        }
    } catch (e) { console.error("Failed to load brands:", e); }
}

// === AGING DAYS SETTING ===
async function loadAgingDays() {
    try {
        const res = await fetch("/api/settings/aging-days");
        const d = await res.json();
        agingDays = d.aging_days;
        const input = document.getElementById("aging-days-input");
        if (input) input.value = agingDays;
    } catch (e) { console.error(e); }
}

document.getElementById("save-aging-btn").addEventListener("click", async () => {
    const days = parseInt(document.getElementById("aging-days-input").value) || 30;
    try {
        const res = await fetch("/api/settings/aging-days", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ days }),
        });
        if (res.ok) {
            agingDays = days;
            showToast(`Aging threshold set to ${days} days`);
            loadListings(); // refresh badges
        }
    } catch { showToast("Failed to save aging setting", true); }
});

// === DELETE UNDO TIMER SETTING ===
(function () {
    const input = document.getElementById("undo-timer-input");
    if (input) input.value = Math.round(undoDeleteMs / 1000);
})();

document.getElementById("save-undo-timer-btn").addEventListener("click", () => {
    const secs = Math.min(30, Math.max(2, parseInt(document.getElementById("undo-timer-input").value) || 5));
    document.getElementById("undo-timer-input").value = secs;   // clamp display value
    undoDeleteMs = secs * 1000;
    localStorage.setItem(UNDO_TIMER_KEY, secs);
    showToast(`Delete undo window set to ${secs} second${secs !== 1 ? "s" : ""}`);
});

// === PINTEREST SETTINGS ===
async function loadPinterestSettings() {
    try {
        const res = await fetch("/api/pinterest/status");
        const d = await res.json();
        document.getElementById("pinterest-disconnected").hidden = d.connected;
        document.getElementById("pinterest-connected").hidden   = !d.connected;
        if (d.connected) loadPinterestBoards();
    } catch (e) { console.error("Pinterest status error:", e); }
}

async function loadPinterestBoards() {
    try {
        const res = await fetch("/api/pinterest/boards");
        if (res.status === 401) {
            // Token expired — revert UI to disconnected
            document.getElementById("pinterest-disconnected").hidden = false;
            document.getElementById("pinterest-connected").hidden   = true;
            return;
        }
        const d = await res.json();
        const sel = document.getElementById("pinterest-board-select");
        sel.innerHTML = '<option value="">Select a board…</option>';
        (d.boards || []).forEach(b => {
            const opt = document.createElement("option");
            opt.value = b.id; opt.textContent = b.name;
            if (b.id === d.selected_board_id) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch (e) { console.error("Pinterest boards error:", e); }
}

document.getElementById("pinterest-connect-btn").addEventListener("click", async () => {
    try {
        const res = await fetch("/api/pinterest/auth");
        const d   = await res.json();
        if (!res.ok) { showToast(d.error, true); return; }
        const popup = window.open(d.url, "pinterest_auth", "width=620,height=720,scrollbars=yes");
        const handler = async (e) => {
            if (e.data !== "pinterest_connected") return;
            window.removeEventListener("message", handler);
            popup?.close();
            showToast("Pinterest connected! 📌");
            loadPinterestSettings();
        };
        window.addEventListener("message", handler);
    } catch { showToast("Failed to start Pinterest auth", true); }
});

document.getElementById("pinterest-disconnect-btn").addEventListener("click", async () => {
    if (!confirm("Disconnect Pinterest?")) return;
    try {
        await fetch("/api/pinterest/disconnect", { method: "DELETE" });
        showToast("Pinterest disconnected.");
        loadPinterestSettings();
    } catch { showToast("Failed", true); }
});

document.getElementById("pinterest-save-board-btn").addEventListener("click", async () => {
    const sel = document.getElementById("pinterest-board-select");
    const boardId = sel.value;
    const boardName = sel.options[sel.selectedIndex]?.text || "";
    if (!boardId) { showToast("Select a board first", true); return; }
    try {
        await fetch("/api/pinterest/boards/select", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ board_id: boardId, board_name: boardName }),
        });
        showToast("Default Pinterest board saved!");
    } catch { showToast("Failed", true); }
});

// === FIRST-TIME LINK HINT BANNER ===
(function () {
    const HINT_KEY = "flipstack_link_hint_seen";
    const banner   = document.getElementById("link-hint-banner");
    const dismiss  = document.getElementById("link-hint-dismiss");
    if (!localStorage.getItem(HINT_KEY)) banner.hidden = false;
    dismiss.addEventListener("click", () => {
        banner.hidden = true;
        localStorage.setItem(HINT_KEY, "1");
    });
})();

// === FIRST-TIME EXPAND HINT BANNER ===
(function () {
    const HINT_KEY = "flipstack_expand_hint_seen";
    const banner   = document.getElementById("expand-hint-banner");
    const dismiss  = document.getElementById("expand-hint-dismiss");
    if (!localStorage.getItem(HINT_KEY)) banner.hidden = false;
    dismiss.addEventListener("click", () => {
        banner.hidden = true;
        localStorage.setItem(HINT_KEY, "1");
    });
})();

// === POST WITHOUT PHOTOS ===
document.getElementById("no-photo-btn").addEventListener("click", async () => {
    const itemName = prompt("Enter item name:");
    if (!itemName || !itemName.trim()) return;
    const batchId = uploadBatchSelect.value || null;
    const category = uploadCategorySelect.value || "";
    try {
        const res = await fetch("/api/listings/no-photo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: itemName.trim(), batch_id: batchId, category }),
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Failed to create listing", true); return; }
        showToast("Listing created!");
        loadListings();
        if (batchId) loadBatches();
    } catch { showToast("Failed to create listing", true); }
});

// === INIT ===
loadTheme();
loadBatches();
loadPrompt();
loadCategories();
loadBatchSelectDropdown();
loadBrands();
loadAgingDays();
loadPinterestSettings();
