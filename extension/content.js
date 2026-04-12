// FlipStack AI — Facebook Marketplace Form Filler
// Robust field detection for Facebook's React-based Marketplace create listing form.

(() => {
    // Allow re-injection (popup re-injects each time)
    window.__flipstack_loaded = true;

    // === UTILITIES ===

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // Log to console for debugging
    function log(msg) { console.log(`[FlipStack] ${msg}`); }

    // === REACT INPUT SETTER ===
    // Facebook uses React — normal .value = won't trigger state updates.
    // We need the native HTMLInputElement setter + React's synthetic event.

    function setNativeValue(el, value) {
        // Get the right native setter for the element type
        const proto = el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        if (nativeSetter) {
            nativeSetter.call(el, value);
        } else {
            el.value = value;
        }

        // React 16+ listens for these specific events
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // === FIELD FILLING STRATEGIES ===

    // Strategy 1: Focus + native setter (for React inputs)
    async function fillReactInput(el, value) {
        el.focus();
        el.click();
        await sleep(rand(100, 200));
        setNativeValue(el, value);
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        await sleep(rand(150, 300));
    }

    // Strategy 2: Focus + execCommand insertText (for contenteditable)
    async function fillContentEditable(el, text) {
        el.focus();
        el.click();
        await sleep(rand(100, 200));

        // Select all existing content and delete
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        await sleep(50);
        document.execCommand("delete", false, null);
        await sleep(100);

        // Insert text (this triggers React/contenteditable change detection)
        document.execCommand("insertText", false, text);
        await sleep(rand(150, 300));

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    // Strategy 3: Keyboard simulation (most reliable for stubborn fields)
    async function fillViaKeyboard(el, text) {
        el.focus();
        el.click();
        await sleep(rand(100, 200));

        // Select all + delete
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true }));
        await sleep(50);
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "Backspace", bubbles: true }));
        await sleep(100);

        // Use execCommand which works broadly
        document.execCommand("insertText", false, text);
        await sleep(rand(100, 250));

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Smart fill — uses one strategy only (no double-filling)
    async function smartFill(el, value) {
        if (!el || !value) return false;
        const tag = el.tagName;
        const isEditable = el.getAttribute("contenteditable") === "true";

        try {
            if (isEditable) {
                await fillContentEditable(el, value);
                log(`  ✓ ContentEditable fill`);
                return true;
            }

            if (tag === "INPUT" || tag === "TEXTAREA") {
                // Clear the field first via select-all + delete
                el.focus();
                el.click();
                await sleep(rand(100, 200));
                el.select();
                await sleep(50);
                document.execCommand("delete", false, null);
                await sleep(100);

                // Use React native setter
                setNativeValue(el, value);
                el.dispatchEvent(new Event("blur", { bubbles: true }));
                await sleep(rand(150, 300));
                log(`  ✓ React setter fill (value now: "${el.value}")`);
                return true;
            }

            // Unknown element — try contentEditable approach
            await fillContentEditable(el, value);
            return true;
        } catch (err) {
            log(`  ✗ Fill error: ${err.message}`);
            return false;
        }
    }

    // === FIELD FINDERS ===
    // Facebook changes their DOM constantly. We use multiple strategies
    // and pick the first match.

    function getAllInputs() {
        return Array.from(document.querySelectorAll(
            'input[type="text"], input:not([type]), textarea, [contenteditable="true"][role="textbox"]'
        ));
    }

    function getVisibleInputs() {
        return getAllInputs().filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    // Find by aria-label (case insensitive partial match)
    function findByAria(keywords) {
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const all = getAllInputs();
            for (const el of all) {
                const label = (el.getAttribute("aria-label") || "").toLowerCase();
                if (label.includes(lower)) return el;
            }
            // Also check aria-labelledby
            const labelled = document.querySelectorAll(`[aria-label*="${kw}" i]`);
            for (const el of labelled) {
                if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
                    el.getAttribute("contenteditable") === "true") return el;
            }
        }
        return null;
    }

    // Find by placeholder text
    function findByPlaceholder(keywords) {
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const all = getAllInputs();
            for (const el of all) {
                const ph = (el.getAttribute("placeholder") || "").toLowerCase();
                if (ph.includes(lower)) return el;
            }
        }
        return null;
    }

    // Find by nearby label/span text (walks up DOM to find the input near a label)
    function findNearLabel(keywords) {
        const spans = document.querySelectorAll("label, span");
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            for (const span of spans) {
                const txt = span.textContent.trim().toLowerCase();
                if (!txt.includes(lower)) continue;
                // Walk up to find a container, then look for an input inside it
                let container = span.parentElement;
                for (let i = 0; i < 5 && container; i++) {
                    const input = container.querySelector(
                        'input[type="text"], input:not([type]), textarea, [contenteditable="true"][role="textbox"]'
                    );
                    if (input && input !== span) return input;
                    container = container.parentElement;
                }
            }
        }
        return null;
    }

    // Find by position — Facebook's create listing form has fields in a predictable order:
    // Title is first, Price is second, then Description further down
    function findByPosition(index) {
        const inputs = getVisibleInputs();
        // Filter out hidden/tiny inputs (Facebook has hidden ones)
        const real = inputs.filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 50 && rect.height > 10;
        });
        return real[index] || null;
    }

    // === MASTER FIELD FINDERS ===

    function findTitleField() {
        log("Looking for Title field...");
        return findByAria(["title", "what are you selling"])
            || findByPlaceholder(["title", "what are you selling"])
            || findNearLabel(["title"])
            || findByPosition(0);
    }

    function findPriceField() {
        log("Looking for Price field...");
        return findByAria(["price"])
            || findByPlaceholder(["price"])
            || findNearLabel(["price"])
            || findByPosition(1);
    }

    function findDescriptionField() {
        log("Looking for Description field...");
        // Description is often a textarea or contenteditable further down the form
        const byAria = findByAria(["description", "describe your item"]);
        if (byAria) return byAria;

        const byPlaceholder = findByPlaceholder(["description", "describe"]);
        if (byPlaceholder) return byPlaceholder;

        const byLabel = findNearLabel(["description"]);
        if (byLabel) return byLabel;

        // Fallback: find all textareas (not inputs) — description is usually a textarea
        const textareas = Array.from(document.querySelectorAll("textarea")).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 50 && rect.height > 10;
        });
        if (textareas.length > 0) return textareas[0];

        // Fallback: contenteditable textbox that isn't the title
        const editables = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 50 && rect.height > 20;
        });
        // Return the last/largest one (title is usually first, description is further down)
        if (editables.length > 1) return editables[editables.length - 1];
        if (editables.length === 1) return editables[0];

        // Last resort: third visible input
        return findByPosition(2);
    }

    // === DROPDOWN FILL (Category, Condition, etc.) ===
    // Facebook uses custom dropdowns. Strategy:
    // 1. Find the dropdown trigger near the label and click to open it
    // 2. Look for a search/filter input inside the opened popup and type the value
    // 3. Wait for filtered results, then click the first matching option
    // 4. Fallback: if no search input, just scan for the option text and click it

    async function fillDropdown(labelKeywords, optionText) {
        const optionLower = optionText.toLowerCase();

        // Find the dropdown trigger
        let trigger = findDropdownTrigger(labelKeywords);
        if (!trigger) {
            log(`  Dropdown trigger not found for: ${labelKeywords.join(", ")}`);
            return false;
        }

        log(`  Found dropdown trigger: <${trigger.tagName}> role="${trigger.getAttribute("role")}" text="${trigger.textContent.trim().substring(0, 30)}"`);

        // Click to open
        trigger.scrollIntoView({ block: "center" });
        await sleep(rand(200, 400));
        trigger.click();
        await sleep(rand(600, 1000));

        // Look for a search/type-ahead input inside any popup/dialog that appeared
        const searchInput = findPopupSearchInput();
        if (searchInput) {
            log(`  Found search input in popup — typing "${optionText}"`);
            await smartFill(searchInput, optionText);
            await sleep(rand(600, 1000)); // wait for search results to filter

            // Click the first matching option
            const picked = await pickOption(optionLower);
            if (picked) return true;

            // Wait a bit more and try again
            await sleep(500);
            const picked2 = await pickOption(optionLower);
            if (picked2) return true;
        } else {
            log(`  No search input found, scanning options directly`);
            // Try to pick from whatever options are visible
            const picked = await pickOption(optionLower);
            if (picked) return true;
            await sleep(500);
            const picked2 = await pickOption(optionLower);
            if (picked2) return true;
        }

        // Close dropdown if we couldn't pick
        document.body.click();
        await sleep(200);
        return false;
    }

    function findDropdownTrigger(labelKeywords) {
        for (const kw of labelKeywords) {
            const lower = kw.toLowerCase();

            // Look for aria-label on combobox/button
            const ariaEls = document.querySelectorAll(
                `[aria-label*="${kw}" i][role="combobox"], [aria-label*="${kw}" i][role="button"], [aria-label*="${kw}" i][role="listbox"]`
            );
            if (ariaEls.length > 0) return ariaEls[0];

            // Look for a label/span near a clickable element
            const allSpans = document.querySelectorAll("label, span");
            for (const span of allSpans) {
                const txt = span.textContent.trim().toLowerCase();
                if (!txt.includes(lower) || txt.length > 40) continue;
                let container = span.parentElement;
                for (let i = 0; i < 6 && container; i++) {
                    const candidate = container.querySelector(
                        '[role="combobox"], [role="button"], [role="listbox"], [tabindex="0"]'
                    );
                    if (candidate && candidate.getBoundingClientRect().width > 30) return candidate;
                    container = container.parentElement;
                }
            }
        }
        return null;
    }

    function findPopupSearchInput() {
        // After clicking a dropdown, Facebook often shows a dialog/popup with a search input.
        // Look for inputs inside elements with role="dialog", role="listbox", or high z-index containers.
        const popupInputs = document.querySelectorAll(
            '[role="dialog"] input, [role="listbox"] input, [role="combobox"] input'
        );
        for (const input of popupInputs) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 30 && rect.height > 10) return input;
        }

        // Fallback: find any input that just appeared (wasn't in the form area)
        // Check for inputs with aria-label containing "search" or "filter"
        const searchInputs = document.querySelectorAll(
            'input[aria-label*="search" i], input[aria-label*="filter" i], input[placeholder*="search" i], input[placeholder*="filter" i]'
        );
        for (const input of searchInputs) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 30 && rect.height > 10) return input;
        }

        // Last resort: look for any newly visible input that's in a fixed/absolute positioned container
        const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (const input of allInputs) {
            const rect = input.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 10) continue;
            let el = input.parentElement;
            for (let i = 0; i < 8 && el; i++) {
                const style = window.getComputedStyle(el);
                if (style.position === "fixed" || style.position === "absolute" ||
                    parseInt(style.zIndex) > 100) {
                    return input;
                }
                el = el.parentElement;
            }
        }

        return null;
    }

    async function pickOption(optionLower) {
        // Find all option-like elements currently visible
        const candidates = document.querySelectorAll(
            '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="listbox"] [role="option"]'
        );

        for (const opt of candidates) {
            const rect = opt.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;
            const txt = opt.textContent.trim().toLowerCase();
            if (txt.includes(optionLower) || optionLower.includes(txt)) {
                log(`  Clicking option: "${opt.textContent.trim()}"`);
                opt.scrollIntoView({ block: "center" });
                await sleep(rand(100, 250));
                opt.click();
                await sleep(rand(300, 500));
                return true;
            }
        }

        // Fallback: match any visible element in a popup
        const allEls = document.querySelectorAll("div, span, li");
        for (const el of allEls) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 30 || rect.height < 15 || el.children.length > 5) continue;
            const txt = el.textContent.trim().toLowerCase();
            if (txt === optionLower || txt.includes(optionLower)) {
                const style = window.getComputedStyle(el);
                const pStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : {};
                const isPopup = style.position === "fixed" || style.position === "absolute"
                    || pStyle.position === "fixed" || pStyle.position === "absolute"
                    || parseInt(style.zIndex) > 1;
                if (isPopup || rect.top > 0) {
                    log(`  Clicking fallback match: "${el.textContent.trim()}"`);
                    el.click();
                    await sleep(rand(300, 500));
                    return true;
                }
            }
        }

        return false;
    }

    // === MAIN FILL LOGIC ===

    async function fillMarketplaceForm(listing) {
        const results = { filled: [], skipped: [], debug: [] };

        // Dump all visible inputs for debugging
        const visibleInputs = getVisibleInputs();
        log(`Found ${visibleInputs.length} visible input(s) on page:`);
        visibleInputs.forEach((el, i) => {
            const info = `  [${i}] <${el.tagName}> aria-label="${el.getAttribute("aria-label") || ""}" placeholder="${el.getAttribute("placeholder") || ""}" role="${el.getAttribute("role") || ""}"`;
            log(info);
            results.debug.push(info);
        });

        // --- TITLE ---
        const titleField = findTitleField();
        if (titleField && listing.name) {
            log(`Title field found: <${titleField.tagName}> aria="${titleField.getAttribute("aria-label")}"`);
            const ok = await smartFill(titleField, listing.name);
            (ok ? results.filled : results.skipped).push("title");
        } else {
            log("Title field NOT found");
            results.skipped.push("title");
        }

        await sleep(rand(400, 700));

        // --- PRICE ---
        const priceField = findPriceField();
        if (priceField && listing.price) {
            log(`Price field found: <${priceField.tagName}> aria="${priceField.getAttribute("aria-label")}"`);
            // Facebook price field takes whole numbers only — strip decimals and non-digits
            const priceWhole = listing.price.replace(/[^0-9]/g, "").replace(/^0+/, "") || "0";
            const ok = await smartFill(priceField, priceWhole);
            (ok ? results.filled : results.skipped).push("price");
        } else {
            log(`Price field NOT found (price value: "${listing.price}")`);
            results.skipped.push("price");
        }

        await sleep(rand(400, 700));

        // --- CATEGORY (click-based dropdown) ---
        try {
            const catFilled = await fillDropdown(
                ["category", "categor"],
                "Clothing & Shoes"
            );
            if (catFilled) {
                results.filled.push("category");
                log("Category filled: Clothing & Shoes");
            } else {
                results.skipped.push("category");
                log("Category dropdown not found or could not select");
            }
        } catch (err) {
            log(`Category error: ${err.message}`);
            results.skipped.push("category");
        }

        await sleep(rand(400, 700));

        // --- CONDITION (click-based dropdown) ---
        try {
            const condFilled = await fillDropdown(
                ["condition"],
                "Used - Good"
            );
            if (condFilled) {
                results.filled.push("condition");
                log("Condition filled: Used - Good");
            } else {
                results.skipped.push("condition");
                log("Condition dropdown not found or could not select");
            }
        } catch (err) {
            log(`Condition error: ${err.message}`);
            results.skipped.push("condition");
        }

        await sleep(rand(400, 700));

        // --- DESCRIPTION ---
        const descField = findDescriptionField();
        const fullDesc = [listing.description, listing.hashtags].filter(Boolean).join("\n\n");
        if (descField && fullDesc) {
            log(`Description field found: <${descField.tagName}> aria="${descField.getAttribute("aria-label")}"`);
            const ok = await smartFill(descField, fullDesc);
            (ok ? results.filled : results.skipped).push("description");
        } else {
            log("Description field NOT found");
            results.skipped.push("description");
        }

        return results;
    }

    // === MESSAGE LISTENER ===
    // Remove any existing listener from prior injection, then add fresh
    if (window.__flipstack_listener) {
        chrome.runtime.onMessage.removeListener(window.__flipstack_listener);
    }

    window.__flipstack_listener = (message, sender, sendResponse) => {
        if (message.action === "fill" && message.listing) {
            fillMarketplaceForm(message.listing).then(results => {
                if (results.filled.length > 0) {
                    sendResponse({
                        success: true,
                        filled: results.filled,
                        skipped: results.skipped,
                        debug: results.debug,
                    });
                } else {
                    sendResponse({
                        success: false,
                        error: `Could not find form fields. Open browser console (F12) and look for [FlipStack] logs. Make sure the form is fully loaded.`,
                        skipped: results.skipped,
                        debug: results.debug,
                    });
                }
            }).catch(err => {
                sendResponse({ success: false, error: err.message });
            });
            return true; // async response
        }
    };

    chrome.runtime.onMessage.addListener(window.__flipstack_listener);
    log("Content script loaded — ready to fill fields");
})();
