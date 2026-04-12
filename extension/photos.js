const params = new URLSearchParams(window.location.search);
const photos = JSON.parse(params.get("photos") || "[]");
const name = params.get("name") || "Listing";

document.getElementById("listing-name").textContent = name;
document.title = `FlipStack — ${name} Photos`;

const grid = document.getElementById("photos-grid");
photos.forEach((url, i) => {
    const card = document.createElement("div");
    card.className = "photo-card";
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Photo ${i + 1}`;
    img.draggable = true;
    const label = document.createElement("div");
    label.className = "photo-label";
    label.textContent = `Photo ${i + 1}`;
    card.appendChild(img);
    card.appendChild(label);
    grid.appendChild(card);
});
