// FlipStack AI — Facebook Marketplace Form Filler
// This content script runs on facebook.com/marketplace/create/* pages.
// It receives listing data from the popup and fills in form fields.

(() => {
    // Prevent double-injection
    if (window.__flipstack_loaded) return;
    window.__flipstack_loaded = true;

    // === HELPERS ===

    // Simulate human-like typing into a field
    async function humanType(element, text) {
        element.focus();
        element.click();
        await sleep(150);

        // Clear existing content
        if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
            element.value = "";
            element.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            // Contenteditable — select all and delete
            document.execCommand("selectAll", false, null);
            await sleep(50);
            document.execCommand("delete", false, null);
        }
        await sleep(200);

        // Type character by character for short text, or paste for long text
        if (text.length <= 80) {
            for (const char of text) {
                if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
                    element.value += char;
                    element.dispatchEvent(new Event("input", { bubbles: true }));
                } else {
                    document.execCommand("insertText", false, char);
                }
                await sleep(randomBetween(20, 60));
            }
        } else {
            // For long text, insert in chunks to mimic paste behavior
            if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
                element.value = text;
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                document.execCommand("insertText", false, text);
            }
        }

        // Trigger all relevant events
        ["input", "change", "blur"].forEach(evt => {
            element.dispatchEvent(new Event(evt, { bubbles: true }));
        });
        await sleep(randomBetween(100, 300));
    }

    // Set value on a React-controlled input (bypasses React's synthetic events)
    async function setReactInput(element, value) {
        element.focus();
        element.click();
        await sleep(150);

        // Use native setter to bypass React
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
        )?.set;

        if (nativeSetter) {
            nativeSetter.call(element, value);
        } else {
            element.value = value;
        }

        // Trigger React's change detection
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
        await sleep(randomBetween(200, 400));
    }

    // Find a form field by various strategies
    function findField(selectors) {
        for (const selector of selectors) {
            try {
                const el = document.querySelector(selector);
                if (el) return el;
            } catch { /* invalid selector, skip */ }
        }
        return null;
    }

    // Find field by label text (aria-label or nearby label)
    function findFieldByLabel(labelTexts) {
        for (const text of labelTexts) {
            const lower = text.toLowerCase();

            // Try aria-label
            const byAria = document.querySelector(`[aria-label="${text}" i]`);
            if (byAria) return byAria;

            // Try placeholder
            const byPlaceholder = document.querySelector(`[placeholder="${text}" i]`);
            if (byPlaceholder) return byPlaceholder;

            // Try label element association
            const labels = document.querySelectorAll("label, span");
            for (const label of labels) {
                if (label.textContent.trim().toLowerCase().includes(lower)) {
                    // Look for input in parent or next sibling
                    const parent = label.closest("div");
                    if (parent) {
                        const input = parent.querySelector("input, textarea, [contenteditable='true']");
                        if (input) return input;
                    }
                }
            }
        }
        return null;
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // === MAIN FILL LOGIC ===

    async function fillMarketplaceForm(listing) {
        const results = { filled: [], skipped: [] };

        // --- TITLE ---
        const titleField = findFieldByLabel([
            "Title", "What are you selling?", "Listing title",
        ]) || findField([
            'input[name="title"]',
            'input[aria-label*="Title" i]',
            'input[aria-label*="selling" i]',
            'label[aria-label*="Title" i] input',
        ]);

        if (titleField && listing.name) {
            try {
                if (titleField.tagName === "INPUT") {
                    await setReactInput(titleField, listing.name);
                } else {
                    await humanType(titleField, listing.name);
                }
                results.filled.push("title");
            } catch { results.skipped.push("title"); }
        } else {
            results.skipped.push("title");
        }

        await sleep(randomBetween(300, 600));

        // --- PRICE ---
        const priceField = findFieldByLabel([
            "Price", "Listing price",
        ]) || findField([
            'input[name="price"]',
            'input[aria-label*="Price" i]',
            'input[aria-label*="price" i]',
        ]);

        if (priceField && listing.price) {
            try {
                const priceClean = listing.price.replace(/[^0-9.]/g, "");
                await setReactInput(priceField, priceClean);
                results.filled.push("price");
            } catch { results.skipped.push("price"); }
        } else {
            results.skipped.push("price");
        }

        await sleep(randomBetween(300, 600));

        // --- DESCRIPTION ---
        // Facebook's description is often a contenteditable div or textarea
        const descField = findFieldByLabel([
            "Description", "Describe your item",
        ]) || findField([
            'textarea[name="description"]',
            'textarea[aria-label*="Description" i]',
            'textarea[aria-label*="Describe" i]',
            '[aria-label*="Description" i][contenteditable="true"]',
            '[data-testid="marketplace-composer-description"] textarea',
        ]);

        if (descField && (listing.description || listing.hashtags)) {
            try {
                const fullDesc = [listing.description, listing.hashtags]
                    .filter(Boolean).join("\n\n");
                if (descField.tagName === "TEXTAREA") {
                    await setReactInput(descField, fullDesc);
                } else {
                    await humanType(descField, fullDesc);
                }
                results.filled.push("description");
            } catch { results.skipped.push("description"); }
        } else {
            results.skipped.push("description");
        }

        return results;
    }

    // === MESSAGE LISTENER ===
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "fill" && message.listing) {
            fillMarketplaceForm(message.listing).then(results => {
                if (results.filled.length > 0) {
                    sendResponse({
                        success: true,
                        filled: results.filled,
                        skipped: results.skipped,
                    });
                } else {
                    sendResponse({
                        success: false,
                        error: `Could not find form fields. Make sure you're on the "Create New Listing" page and the form is fully loaded.`,
                        skipped: results.skipped,
                    });
                }
            }).catch(err => {
                sendResponse({ success: false, error: err.message });
            });
            return true; // Keep message channel open for async response
        }
    });
})();
