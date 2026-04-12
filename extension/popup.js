const API = "http://localhost:5000";

let allListings = [];
let allBatches = [];

// === ELEMENTS ===
const listingsSection = document.getElementById("listings-section");
const listingsList = document.getElementById("listings-list");
const emptyMsg = document.getElementById("empty-msg");
const notOnFb = document.getElementById("not-on-fb");
const connectionError = document.getElementById("connection-error");
const statusBar = document.getElementById("status-bar");
const statusIcon = document.getElementById("status-icon");
const statusText = document.getElementById("status-text");
const searchInput = document.getElementById("search");
const filterBatch = document.getElementById("filter-batch");
const filterPosted = document.getElementById("filter-posted");

// === INIT ===
async function init() {
    // Check if we're on Facebook Marketplace create page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    const onFB = url.includes("facebook.com/marketplace/create");

    if (!onFB) {
        notOnFb.hidden = false;
    }

    // Load data from FlipStack
    try {
        const [listingsRes, batchesRes] = await Promise.all([
            fetch(`${API}/api/listings`),
            fetch(`${API}/api/batches`),
        ]);
        allListings = await listingsRes.json();
        allBatches = await batchesRes.json();

        // Populate batch filter
        allBatches.forEach(b => {
            const opt = document.createElement("option");
            opt.value = b.id;
            opt.textContent = b.name;
            filterBatch.appendChild(opt);
        });

        listingsSection.hidden = false;
        connectionError.hidden = true;
        renderListings();
    } catch (err) {
        connectionError.hidden = false;
        listingsSection.hidden = true;
    }
}

// === RENDER ===
function renderListings() {
    const query = searchInput.value.toLowerCase().trim();
    const batchFilter = filterBatch.value;
    const postedFilter = filterPosted.value;

    let filtered = allListings.filter(l => {
        if (query && !l.name.toLowerCase().includes(query) && !l.description.toLowerCase().includes(query)) return false;
        if (batchFilter && l.batch_id !== batchFilter) return false;
        if (postedFilter === "posted" && !l.posted) return false;
        if (postedFilter === "unposted" && l.posted) return false;
        return true;
    });

    if (filtered.length === 0) {
        listingsList.innerHTML = "";
        emptyMsg.hidden = false;
        return;
    }

    emptyMsg.hidden = true;
    listingsList.innerHTML = filtered.map(l => {
        const thumb = l.photos?.[0]
            ? `<img class="listing-thumb" src="${API}${l.photos[0].url}" alt="">`
            : `<div class="listing-thumb-placeholder">&#128247;</div>`;

        const batchName = allBatches.find(b => b.id === l.batch_id)?.name || "";
        const price = l.list_price > 0 ? `$${l.list_price.toFixed(2)}` : "No price";
        const metaParts = [`<span class="price">${price}</span>`];
        if (batchName) metaParts.push(`<span class="batch">${escapeHtml(batchName)}</span>`);
        if (l.category) metaParts.push(escapeHtml(l.category));

        const actionBtn = l.posted
            ? `<button class="btn-posted" data-id="${l.id}" data-action="unpost">&#10003; Posted</button>`
            : `<button class="btn-fill" data-id="${l.id}">Fill &rarr;</button>`;

        return `
        <div class="listing-item" data-id="${l.id}">
            ${thumb}
            <div class="listing-info">
                <div class="listing-name">${escapeHtml(l.name)}</div>
                <div class="listing-meta">${metaParts.join(" &middot; ")}</div>
            </div>
            <div class="listing-actions">${actionBtn}</div>
        </div>`;
    }).join("");

    // Attach fill button events
    listingsList.querySelectorAll(".btn-fill").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            fillListing(btn.dataset.id);
        });
    });

    // Attach unpost button events
    listingsList.querySelectorAll('[data-action="unpost"]').forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            unpostListing(btn.dataset.id);
        });
    });
}

// === FILL LISTING ===
async function fillListing(listingId) {
    const listing = allListings.find(l => l.id === listingId);
    if (!listing) return;

    // Check we're on the right page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("facebook.com/marketplace/create")) {
        showStatus("Navigate to Marketplace → Create Listing first", "error");
        return;
    }

    // Disable the button
    const btn = listingsList.querySelector(`.btn-fill[data-id="${listingId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Filling..."; }

    showStatus("Filling fields...", "filling");

    try {
        // Inject content script and send data
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
        });

        // Small delay to let script initialize
        await sleep(300);

        const response = await chrome.tabs.sendMessage(tab.id, {
            action: "fill",
            listing: {
                name: listing.name,
                description: listing.description,
                hashtags: listing.hashtags,
                price: listing.list_price > 0 ? listing.list_price.toFixed(2) : "",
                category: listing.category || "",
            },
        });

        if (response?.success) {
            const filledStr = response.filled.join(", ");
            const skippedStr = response.skipped.length > 0
                ? ` (skipped: ${response.skipped.join(", ")})`
                : "";
            showStatus(`Filled: ${filledStr}${skippedStr}. Review and post!`, "success");

            // Mark as posted in FlipStack
            try {
                await fetch(`${API}/api/listings/${listingId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ posted: 1 }),
                });
                listing.posted = true;
                renderListings();
            } catch { /* non-critical */ }
        } else {
            const hint = response?.skipped?.length
                ? ` Skipped: ${response.skipped.join(", ")}. Check console (F12) for [FlipStack] debug logs.`
                : "";
            showStatus((response?.error || "Fill failed — try refreshing the page") + hint, "error");
            if (btn) { btn.disabled = false; btn.textContent = "Fill →"; }
        }
    } catch (err) {
        showStatus("Could not reach the page. Refresh Facebook and try again.", "error");
        if (btn) { btn.disabled = false; btn.textContent = "Fill →"; }
    }
}

// === UNPOST LISTING ===
async function unpostListing(listingId) {
    const listing = allListings.find(l => l.id === listingId);
    if (!listing) return;

    try {
        await fetch(`${API}/api/listings/${listingId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ posted: 0 }),
        });
        listing.posted = false;
        renderListings();
        showStatus("Marked as not posted", "success");
    } catch {
        showStatus("Failed to update", "error");
    }
}

// === STATUS ===
function showStatus(msg, type = "success") {
    statusBar.hidden = false;
    statusBar.className = `status-bar ${type}`;
    statusIcon.textContent = type === "error" ? "✕" : type === "filling" ? "⟳" : "✓";
    statusText.textContent = msg;
    if (type !== "filling") {
        setTimeout(() => { statusBar.hidden = true; }, 4000);
    }
}

// === UTILS ===
function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// === EVENTS ===
searchInput.addEventListener("input", renderListings);
filterBatch.addEventListener("change", renderListings);
filterPosted.addEventListener("change", renderListings);
document.getElementById("retry-btn").addEventListener("click", init);

// === GO ===
init();
