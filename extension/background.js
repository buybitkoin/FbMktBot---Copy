// FlipStack AI — Background Service Worker
// Watches for tabs opening Facebook Marketplace with #flipstack=LISTING_ID
// and injects the content script + sends the listing ID to trigger auto-fill.

const FB_CREATE_PATTERN = "facebook.com/marketplace/create";
const FLIPSTACK_HASH = "#flipstack=";

// Track tabs we've already handled so we don't double-fire
const handledTabs = new Set();

// Listen for tab URL changes (covers new tabs and SPA navigation)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // We need the URL to be available and contain our marker
    const url = changeInfo.url || tab.url || "";
    if (!url.includes(FB_CREATE_PATTERN) || !url.includes(FLIPSTACK_HASH)) return;

    // Don't handle the same tab twice
    if (handledTabs.has(tabId)) return;
    handledTabs.add(tabId);

    // Extract listing ID from hash
    const hashIndex = url.indexOf(FLIPSTACK_HASH);
    const listingId = url.substring(hashIndex + FLIPSTACK_HASH.length).replace(/[^a-f0-9]/g, "");
    if (!listingId) return;

    console.log(`[FlipStack BG] Detected auto-fill request for listing: ${listingId} in tab ${tabId}`);

    // Wait for the page to be reasonably loaded
    await waitForTabLoad(tabId);

    // Inject the content script (in case manifest injection didn't fire)
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (err) {
        console.log(`[FlipStack BG] Script injection failed: ${err.message}`);
        handledTabs.delete(tabId);
        return;
    }

    // Give the content script a moment to initialize
    await sleep(1000);

    // Send the listing ID to the content script
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: "auto-fill",
            listingId: listingId,
        });
        console.log(`[FlipStack BG] Sent auto-fill message to tab ${tabId}`);
    } catch (err) {
        console.log(`[FlipStack BG] Message send failed: ${err.message}, retrying...`);
        // Retry after more time — Facebook SPA might still be loading
        await sleep(3000);
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ["content.js"],
            });
            await sleep(1000);
            await chrome.tabs.sendMessage(tabId, {
                action: "auto-fill",
                listingId: listingId,
            });
            console.log(`[FlipStack BG] Retry succeeded`);
        } catch (err2) {
            console.log(`[FlipStack BG] Retry also failed: ${err2.message}`);
        }
    }

    // Clean up after some time so the tab can be re-used
    setTimeout(() => handledTabs.delete(tabId), 30000);
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
    handledTabs.delete(tabId);
});

function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const check = async () => {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === "complete") {
                    // Extra wait for Facebook's SPA to render
                    await sleep(3000);
                    resolve();
                    return;
                }
            } catch {
                resolve();
                return;
            }
            setTimeout(check, 1000);
        };
        check();
        // Safety timeout — don't wait forever
        setTimeout(resolve, 20000);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
