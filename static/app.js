const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const listingsContainer = document.getElementById("listings-container");
const emptyMsg = document.getElementById("empty-msg");
const toast = document.getElementById("toast");

let selectedFiles = [];

// --- Drag & Drop ---
dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    addFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
});

function addFiles(fileList) {
    for (const f of fileList) {
        if (f.type.startsWith("image/")) {
            selectedFiles.push(f);
        }
    }
    renderPreviews();
    uploadBtn.disabled = selectedFiles.length === 0;
}

function renderPreviews() {
    let container = dropzone.querySelector(".file-previews");
    if (!container) {
        container = document.createElement("div");
        container.className = "file-previews";
        dropzone.appendChild(container);
    }
    container.innerHTML = "";

    if (selectedFiles.length === 0) {
        container.remove();
        return;
    }

    selectedFiles.forEach((file, i) => {
        const div = document.createElement("div");
        div.className = "file-preview";
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        const btn = document.createElement("button");
        btn.className = "remove-preview";
        btn.textContent = "\u00d7";
        btn.onclick = (e) => {
            e.stopPropagation();
            selectedFiles.splice(i, 1);
            renderPreviews();
            uploadBtn.disabled = selectedFiles.length === 0;
        };
        div.appendChild(img);
        div.appendChild(btn);
        container.appendChild(div);
    });
}

// --- Upload ---
uploadBtn.addEventListener("click", async () => {
    if (selectedFiles.length === 0) return;

    const formData = new FormData();
    selectedFiles.forEach((f) => formData.append("photos", f));

    uploadBtn.disabled = true;
    uploadBtn.querySelector(".btn-text").hidden = true;
    uploadBtn.querySelector(".btn-loading").hidden = false;
    document.querySelector(".upload-section").classList.add("loading");

    try {
        const res = await fetch("/api/listings", {
            method: "POST",
            body: formData,
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || "Upload failed", true);
            return;
        }

        selectedFiles = [];
        renderPreviews();
        showToast("Listing created! AI drafted your name, description & hashtags.");
        loadListings();
    } catch (err) {
        showToast("Upload failed: " + err.message, true);
    } finally {
        uploadBtn.querySelector(".btn-text").hidden = false;
        uploadBtn.querySelector(".btn-loading").hidden = true;
        uploadBtn.disabled = false;
        document.querySelector(".upload-section").classList.remove("loading");
    }
});

// --- Load Listings ---
async function loadListings() {
    try {
        const res = await fetch("/api/listings");
        const listings = await res.json();

        if (listings.length === 0) {
            listingsContainer.innerHTML = "";
            listingsContainer.appendChild(emptyMsg);
            emptyMsg.hidden = false;
            return;
        }

        emptyMsg.hidden = true;
        listingsContainer.innerHTML = listings.map(renderListingCard).join("");
        attachListingEvents();
    } catch (err) {
        console.error("Failed to load listings:", err);
    }
}

function renderListingCard(listing) {
    const mainPhoto = listing.photos[0];
    const extraPhotos = listing.photos.slice(1);

    return `
    <div class="listing-card" data-id="${listing.id}">
        <div class="listing-header">
            <h3>Listing &mdash; ${listing.photos.length} photo${listing.photos.length !== 1 ? "s" : ""}</h3>
            <div class="listing-actions">
                <button class="btn btn-sm btn-add-photos" data-action="add-photos">+ Photos</button>
                <button class="btn btn-sm btn-save" data-action="save">Save</button>
                <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
            </div>
        </div>
        <div class="listing-body">
            <div class="listing-photos">
                ${mainPhoto ? `<img src="${mainPhoto.url}" alt="Listing photo" data-action="lightbox" data-url="${mainPhoto.url}">` : ""}
                ${extraPhotos.length > 0 ? `
                    <div class="photo-thumb-row">
                        ${extraPhotos.map(p => `
                            <img src="${p.url}" alt="Photo" data-action="lightbox" data-url="${p.url}">
                        `).join("")}
                    </div>
                ` : ""}
            </div>
            <div class="listing-fields">
                <div class="field-group">
                    <div class="field-label">
                        <label>Name / Title</label>
                        <button class="btn btn-sm btn-copy" data-action="copy" data-field="name">Copy</button>
                    </div>
                    <input type="text" data-field="name" value="${escapeAttr(listing.name)}">
                </div>
                <div class="field-group">
                    <div class="field-label">
                        <label>Description</label>
                        <button class="btn btn-sm btn-copy" data-action="copy" data-field="description">Copy</button>
                    </div>
                    <textarea data-field="description" rows="3">${escapeHtml(listing.description)}</textarea>
                </div>
                <div class="field-group">
                    <div class="field-label">
                        <label>Hashtags</label>
                        <button class="btn btn-sm btn-copy" data-action="copy" data-field="hashtags">Copy</button>
                    </div>
                    <textarea data-field="hashtags" rows="2">${escapeHtml(listing.hashtags)}</textarea>
                </div>
            </div>
        </div>
        <div class="copy-all-row">
            <button class="btn btn-sm btn-copy" data-action="copy-all">Copy All to Clipboard</button>
        </div>
    </div>`;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Events ---
function attachListingEvents() {
    document.querySelectorAll(".listing-card").forEach((card) => {
        const id = card.dataset.id;

        card.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action]");
            if (!btn) return;

            const action = btn.dataset.action;

            if (action === "copy") {
                const field = btn.dataset.field;
                const input = card.querySelector(`[data-field="${field}"]`);
                const val = input.tagName === "TEXTAREA" ? input.value : input.value;
                await copyText(val, btn);
            }

            if (action === "copy-all") {
                const name = card.querySelector('[data-field="name"]').value;
                const desc = card.querySelector('textarea[data-field="description"]').value;
                const tags = card.querySelector('textarea[data-field="hashtags"]').value;
                const full = `${name}\n\n${desc}\n\n${tags}`;
                await copyText(full, btn);
            }

            if (action === "save") {
                const name = card.querySelector('[data-field="name"]').value;
                const desc = card.querySelector('textarea[data-field="description"]').value;
                const tags = card.querySelector('textarea[data-field="hashtags"]').value;
                try {
                    await fetch(`/api/listings/${id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name, description: desc, hashtags: tags }),
                    });
                    showToast("Listing saved!");
                } catch (err) {
                    showToast("Save failed", true);
                }
            }

            if (action === "delete") {
                if (!confirm("Delete this listing and its photos?")) return;
                try {
                    await fetch(`/api/listings/${id}`, { method: "DELETE" });
                    showToast("Listing deleted");
                    loadListings();
                } catch (err) {
                    showToast("Delete failed", true);
                }
            }

            if (action === "add-photos") {
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = true;
                input.accept = "image/*";
                input.onchange = async () => {
                    const formData = new FormData();
                    for (const f of input.files) {
                        formData.append("photos", f);
                    }
                    try {
                        await fetch(`/api/listings/${id}/photos`, {
                            method: "POST",
                            body: formData,
                        });
                        showToast("Photos added!");
                        loadListings();
                    } catch (err) {
                        showToast("Failed to add photos", true);
                    }
                };
                input.click();
            }

            if (action === "lightbox") {
                const url = btn.dataset.url;
                openLightbox(url);
            }
        });
    });
}

async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove("copied");
        }, 1500);
        showToast("Copied to clipboard!");
    } catch {
        // Fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copied to clipboard!");
    }
}

// --- Lightbox ---
function openLightbox(url) {
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.innerHTML = `<img src="${url}">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
}

// --- Toast ---
function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.style.background = isError ? "#fa3e3e" : "#1c1e21";
    toast.hidden = false;
    toast.classList.add("show");
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => (toast.hidden = true), 300);
    }, 2500);
}

// --- Prompt Editor ---
const promptToggle = document.getElementById("prompt-toggle");
const promptBody = document.getElementById("prompt-body");
const promptArrow = document.getElementById("prompt-arrow");
const promptEditor = document.getElementById("prompt-editor");
const savePromptBtn = document.getElementById("save-prompt-btn");
const resetPromptBtn = document.getElementById("reset-prompt-btn");

promptToggle.addEventListener("click", () => {
    const isHidden = promptBody.hidden;
    promptBody.hidden = !isHidden;
    promptArrow.classList.toggle("open", isHidden);
});

async function loadPrompt() {
    try {
        const res = await fetch("/api/prompt");
        const data = await res.json();
        promptEditor.value = data.prompt;
    } catch (err) {
        console.error("Failed to load prompt:", err);
    }
}

savePromptBtn.addEventListener("click", async () => {
    try {
        const res = await fetch("/api/prompt", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptEditor.value }),
        });
        if (res.ok) {
            showToast("Prompt saved! New uploads will use this prompt.");
        } else {
            const data = await res.json();
            showToast(data.error || "Failed to save prompt", true);
        }
    } catch (err) {
        showToast("Failed to save prompt", true);
    }
});

resetPromptBtn.addEventListener("click", async () => {
    if (!confirm("Reset the prompt to the default? Your custom prompt will be lost.")) return;
    try {
        const res = await fetch("/api/prompt", { method: "DELETE" });
        const data = await res.json();
        if (res.ok) {
            promptEditor.value = data.prompt;
            showToast("Prompt reset to default.");
        }
    } catch (err) {
        showToast("Failed to reset prompt", true);
    }
});

// --- Init ---
loadListings();
loadPrompt();
