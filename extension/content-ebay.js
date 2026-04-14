// FlipStack AI — eBay Sell Listing Autofill
// Runs on ebay.com/sl/sell*
// Checks FlipStack API for a pending post and fills the form.

(() => {
    if (window.__flipstack_ebay_loaded) return;
    window.__flipstack_ebay_loaded = true;

    const API = "http://localhost:5000";

    function log(msg) { console.log(`[FlipStack eBay] ${msg}`); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    function setNativeValue(el, value) {
        const proto = el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function smartFill(el, value) {
        if (!el || !value) return false;
        el.focus();
        el.click();
        await sleep(rand(100, 200));

        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            el.select();
            await sleep(50);
            document.execCommand("delete", false, null);
            await sleep(100);
            setNativeValue(el, value);
            el.dispatchEvent(new Event("blur", { bubbles: true }));
        } else if (el.getAttribute("contenteditable") === "true") {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            await sleep(50);
            document.execCommand("delete", false, null);
            await sleep(100);
            document.execCommand("insertText", false, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await sleep(rand(150, 300));
        return true;
    }

    function findField(selectors) {
        for (const sel of selectors) {
            try {
                const el = document.querySelector(sel);
                if (el) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 20 && rect.height > 10) return el;
                }
            } catch {}
        }
        return null;
    }

    function findByNearbyLabel(keywords) {
        const spans = document.querySelectorAll("label, span, p, div");
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            for (const span of spans) {
                const txt = span.textContent.trim().toLowerCase();
                if (!txt.includes(lower) || txt.length > 50) continue;
                let container = span.parentElement;
                for (let i = 0; i < 5 && container; i++) {
                    const input = container.querySelector('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
                    if (input && input !== span) return input;
                    container = container.parentElement;
                }
            }
        }
        return null;
    }

    async function fillEbayForm(listing) {
        const results = { filled: [], skipped: [] };

        // --- TITLE ---
        const titleField = findField([
            'input[aria-label*="title" i]',
            'input[placeholder*="title" i]',
            'input[name="title"]',
            '#title',
        ]) || findByNearbyLabel(["title", "tell buyers about your item"]);

        if (titleField && listing.name) {
            // eBay title limit is 80 chars
            const title = listing.name.substring(0, 80);
            await smartFill(titleField, title);
            results.filled.push("title");
            log(`Title filled: ${title}`);
        } else { results.skipped.push("title"); }
        await sleep(rand(300, 500));

        // --- DESCRIPTION ---
        // eBay description can be a textarea, contenteditable iframe, or rich text editor
        const descField = findField([
            'textarea[aria-label*="description" i]',
            'textarea[placeholder*="description" i]',
            'textarea[name="description"]',
            '#description',
            '[aria-label*="description" i][contenteditable="true"]',
        ]) || findByNearbyLabel(["description", "item description"]);

        if (descField) {
            const fullDesc = [listing.description, listing.hashtags].filter(Boolean).join("\n\n");
            if (fullDesc) {
                await smartFill(descField, fullDesc);
                results.filled.push("description");
                log(`Description filled`);
            }
        } else { results.skipped.push("description"); }
        await sleep(rand(300, 500));

        // --- PRICE ---
        const priceField = findField([
            'input[aria-label*="price" i]',
            'input[placeholder*="price" i]',
            'input[name="price"]',
        ]) || findByNearbyLabel(["price", "buy it now"]);

        if (priceField && listing.price) {
            await smartFill(priceField, listing.price);
            results.filled.push("price");
            log(`Price filled: ${listing.price}`);
        } else { results.skipped.push("price"); }

        log(`Fill complete. Filled: ${results.filled.join(", ")}. Skipped: ${results.skipped.join(", ")}`);
        return results;
    }

    // === AUTO-FILL VIA API ===
    async function checkPendingPost() {
        log("Checking for pending post...");

        let pendingData;
        try {
            const res = await fetch(`${API}/api/pending-post`);
            pendingData = await res.json();
        } catch (err) {
            log(`Could not reach FlipStack API: ${err.message}`);
            return;
        }

        const listingId = pendingData?.listing_id;
        if (!listingId) { log("No pending post."); return; }

        log(`Pending post found: ${listingId}`);
        try { await fetch(`${API}/api/pending-post`, { method: "DELETE" }); } catch {}

        // Wait for form to load
        for (let i = 0; i < 15; i++) {
            const inputs = document.querySelectorAll("input, textarea");
            if (inputs.length >= 2) break;
            log(`  Waiting for form... attempt ${i + 1}`);
            await sleep(1500);
        }
        await sleep(2000);

        // Fetch listing
        let listing;
        try {
            const res = await fetch(`${API}/api/listings`);
            const listings = await res.json();
            listing = listings.find(l => l.id === listingId);
            if (!listing) { log(`Listing not found`); return; }
        } catch (err) { log(`API error: ${err.message}`); return; }

        log(`Filling: "${listing.name}"`);
        await fillEbayForm({
            name: listing.name,
            description: listing.description,
            hashtags: listing.hashtags,
            price: listing.list_price > 0 ? listing.list_price.toFixed(2) : "",
        });

        // Mark as posted
        try {
            await fetch(`${API}/api/listings/${listingId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ posted: 1 }),
            });
        } catch {}
    }

    // Also listen for popup fill messages
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "fill" && message.listing) {
            fillEbayForm(message.listing).then(results => {
                sendResponse({ success: results.filled.length > 0, filled: results.filled, skipped: results.skipped });
            }).catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
    });

    checkPendingPost();
})();
