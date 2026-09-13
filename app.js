// ---------- State ----------
let activeCategories = DEFAULT_LHDN_CATEGORIES;
let pendingReview = null; // { imageBlob, merchant, date, amount, matches, sourceText }

// ---------- Init ----------
(async function init() {
  await loadSettingsIntoForm();
  await loadCategoryCache();
  updateNetBadge();
  renderLedger();
  wireEvents();
  registerServiceWorker();
})();

function wireEvents() {
  window.addEventListener("online", updateNetBadge);
  window.addEventListener("offline", updateNetBadge);

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.getElementById("settingsBtn").addEventListener("click", () => switchView("settings"));

  document.getElementById("fileInput").addEventListener("change", onFileSelected);

  document.getElementById("reviewCancel").addEventListener("click", closeReviewModal);
  document.getElementById("reviewSave").addEventListener("click", saveReviewedReceipt);

  document.getElementById("geminiKey").addEventListener("change", e => Db.saveSetting("geminiKey", e.target.value));
  document.getElementById("geminiModel").addEventListener("change", e => Db.saveSetting("geminiModel", e.target.value));
  document.getElementById("refreshUrl").addEventListener("change", e => Db.saveSetting("refreshUrl", e.target.value));
  document.getElementById("refreshNowBtn").addEventListener("click", refreshLhdnList);

  document.getElementById("yearFilter").addEventListener("change", renderLedger);
}

function switchView(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "ledger") renderLedger();
}

// ---------- Connectivity ----------
function updateNetBadge() {
  const el = document.getElementById("netStatus");
  const online = navigator.onLine;
  el.textContent = online ? "online — Gemini" : "offline — local matching";
  el.className = "net-badge " + (online ? "online" : "offline");
}

// ---------- Settings ----------
async function loadSettingsIntoForm() {
  const key = await Db.getSetting("geminiKey");
  const model = await Db.getSetting("geminiModel");
  const refreshUrl = await Db.getSetting("refreshUrl");
  if (key) document.getElementById("geminiKey").value = key;
  document.getElementById("geminiModel").value = model || "gemini-2.5-flash";
  if (!model) await Db.saveSetting("geminiModel", "gemini-2.5-flash");
  if (refreshUrl) document.getElementById("refreshUrl").value = refreshUrl;
  document.getElementById("bundledVersion").textContent = LHDN_DATA_VERSION;

  const lastRefreshed = await Db.getSetting("lhdnLastRefreshed");
  if (lastRefreshed) {
    document.getElementById("refreshedInfo").textContent = `Last refreshed online: ${new Date(lastRefreshed).toLocaleString()}`;
  }
}

async function loadCategoryCache() {
  const cached = await Db.getSetting("lhdnCategories");
  activeCategories = cached && cached.length ? cached : DEFAULT_LHDN_CATEGORIES;
}

async function refreshLhdnList() {
  const btn = document.getElementById("refreshNowBtn");
  const url = document.getElementById("refreshUrl").value.trim();
  if (!url) {
    alert("Enter a refresh URL first — a JSON file you host with an updated 'categories' array.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    const data = await refreshLhdnData(url);
    activeCategories = data.categories;
    await Db.saveSetting("lhdnCategories", activeCategories);
    await Db.saveSetting("lhdnLastRefreshed", new Date().toISOString());
    document.getElementById("refreshedInfo").textContent = `Last refreshed online: ${new Date().toLocaleString()}`;
    alert(`Relief list refreshed: ${activeCategories.length} categories loaded.`);
  } catch (e) {
    alert("Couldn't refresh: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh now";
  }
}

// ---------- Capture flow ----------
async function onFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const statusEl = document.getElementById("captureStatus");
  statusEl.hidden = false;
  statusEl.className = "capture-status";

  try {
    if (navigator.onLine) {
      const geminiKey = await Db.getSetting("geminiKey");
      const model = (await Db.getSetting("geminiModel")) || "gemini-2.5-flash";
      if (geminiKey) {
        statusEl.textContent = "Reading receipt with Gemini…";
        const result = await analyzeReceiptWithGemini({ apiKey: geminiKey, model, imageBlob: file, categories: activeCategories });
        openReviewModal({
          imageBlob: file,
          merchant: result.merchant,
          date: result.date,
          amount: result.amount,
          matches: (result.matches || []).map(m => {
            const cat = activeCategories.find(c => c.id === m.categoryId);
            return { categoryId: m.categoryId, label: cat ? cat.label : m.categoryId, confidence: m.confidence, matchedKeywords: [m.matchedItemText].filter(Boolean) };
          }),
          sourceText: (result.items || []).join(", "),
          viaGemini: true
        });
        statusEl.hidden = true;
        return;
      }
      statusEl.textContent = "Online, but no Gemini key set — using local matching instead.";
    } else {
      statusEl.textContent = "Offline — reading receipt locally…";
    }

    const text = await ocrImage(file);
    const matches = matchCategoriesOffline(text, activeCategories);
    openReviewModal({
      imageBlob: file,
      merchant: "",
      date: new Date().toISOString().slice(0, 10),
      amount: guessAmount(text),
      matches,
      sourceText: text.slice(0, 500),
      viaGemini: false
    });
    statusEl.hidden = true;
  } catch (err) {
    statusEl.textContent = "Couldn't process this receipt: " + err.message;
    statusEl.className = "capture-status error";
  }
}

function openReviewModal({ imageBlob, merchant, date, amount, matches, sourceText, viaGemini }) {
  pendingReview = { imageBlob, matches };
  document.getElementById("reviewImg").src = URL.createObjectURL(imageBlob);
  document.getElementById("reviewMerchant").value = merchant || "";
  document.getElementById("reviewDate").value = date || new Date().toISOString().slice(0, 10);
  document.getElementById("reviewAmount").value = amount ?? "";

  const wrap = document.getElementById("reviewCategories");
  wrap.innerHTML = "";
  if (!matches.length) {
    wrap.innerHTML = `<p class="empty-note">No LHDN category matched automatically. You can still save it as uncategorized, or check the receipt manually.</p>`;
  }
  matches.forEach((m, i) => {
    const row = document.createElement("label");
    row.className = "cat-option";
    row.innerHTML = `
      <input type="checkbox" data-idx="${i}" checked />
      <span>${m.label}</span>
      <span class="conf">${Math.round((m.confidence || 0) * 100)}% match</span>
    `;
    wrap.appendChild(row);
  });

  document.getElementById("reviewSourceNote").textContent = viaGemini
    ? "Read via Gemini."
    : `Read via on-device OCR — unconfirmed. ${sourceText ? "Detected text: " + sourceText.slice(0, 150) + "…" : ""}`;

  document.getElementById("reviewModal").hidden = false;
}

function closeReviewModal() {
  document.getElementById("reviewModal").hidden = true;
  pendingReview = null;
}

async function saveReviewedReceipt() {
  if (!pendingReview) return;
  const merchant = document.getElementById("reviewMerchant").value.trim();
  const date = document.getElementById("reviewDate").value;
  const amountRaw = document.getElementById("reviewAmount").value;
  const amount = amountRaw ? parseFloat(amountRaw) : null;

  const checked = [...document.querySelectorAll("#reviewCategories input[type=checkbox]:checked")]
    .map(cb => pendingReview.matches[parseInt(cb.dataset.idx, 10)]);

  const year = date ? new Date(date).getFullYear() : new Date().getFullYear();

  await Db.saveReceiptGroup({
    imageBlob: pendingReview.imageBlob,
    merchant,
    date,
    amount,
    year,
    categories: checked,
    confirmed: true
  });

  closeReviewModal();
  switchView("ledger");
}

// ---------- Ledger ----------
async function renderLedger() {
  const all = await Db.getAllReceipts();
  const years = [...new Set(all.map(r => r.year))].sort((a, b) => b - a);
  const yearSelect = document.getElementById("yearFilter");
  const currentYear = new Date().getFullYear();
  const yearOptions = years.length ? years : [currentYear];
  const prevSelection = yearSelect.value;
  yearSelect.innerHTML = yearOptions.map(y => `<option value="${y}">${y}</option>`).join("");
  yearSelect.value = yearOptions.includes(parseInt(prevSelection, 10)) ? prevSelection : String(yearOptions[0]);

  const selectedYear = parseInt(yearSelect.value, 10);
  const filtered = all.filter(r => r.year === selectedYear);

  const byCategory = new Map();
  for (const cat of activeCategories) byCategory.set(cat.id, { cat, receipts: [] });
  for (const r of filtered) {
    if (!byCategory.has(r.categoryId)) {
      byCategory.set(r.categoryId, { cat: { id: r.categoryId, label: r.categoryLabel || r.categoryId, cap: null, capNote: "" }, receipts: [] });
    }
    byCategory.get(r.categoryId).receipts.push(r);
  }

  const list = document.getElementById("ledgerList");
  list.innerHTML = "";
  const nonEmpty = [...byCategory.values()].filter(g => g.receipts.length > 0);

  if (!nonEmpty.length) {
    list.innerHTML = `<p class="empty-note">No receipts filed for ${selectedYear} yet. Capture one from the Capture tab.</p>`;
    return;
  }

  for (const group of nonEmpty) {
    const total = group.receipts.reduce((s, r) => s + (r.amount || 0), 0);
    const cap = group.cat.cap;
    const pct = cap ? Math.min((total / cap) * 100, 100) : 0;
    const overCap = cap && total > cap;

    const card = document.createElement("div");
    card.className = "ledger-cat" + (overCap ? " over-cap" : "");
    card.innerHTML = `
      <div class="ledger-cat-head">
        <div>
          <h3>${group.cat.label}</h3>
          <div style="font-size:0.75rem;color:var(--ink-soft)">${group.cat.capNote || ""}</div>
        </div>
        <div class="amounts">
          <div>RM ${total.toFixed(2)}${cap ? " / RM " + cap.toFixed(2) : ""}</div>
          <div>${group.receipts.length} receipt${group.receipts.length > 1 ? "s" : ""}</div>
        </div>
      </div>
      ${cap ? `<div class="cap-bar"><div class="cap-bar-fill" style="width:${pct}%"></div></div>` : ""}
      <div class="ledger-receipts" hidden></div>
    `;
    const head = card.querySelector(".ledger-cat-head");
    const receiptsWrap = card.querySelector(".ledger-receipts");
    head.addEventListener("click", () => { receiptsWrap.hidden = !receiptsWrap.hidden; });

    for (const r of group.receipts.sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
      const row = document.createElement("div");
      row.className = "ledger-receipt-row";
      const img = document.createElement("img");
      Db.getImage(r.groupId).then(blob => { if (blob) img.src = URL.createObjectURL(blob); });
      row.appendChild(img);
      row.innerHTML += `
        <div class="info">
          <strong>${r.merchant || "Unknown merchant"}</strong>
          <span>${r.date || ""} · RM ${(r.amount || 0).toFixed(2)}</span>
          ${!r.confirmed ? '<span class="unconfirmed">unconfirmed — from offline OCR</span>' : ""}
        </div>
        <button data-id="${r.id}">Remove</button>
      `;
      row.querySelector("button").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await Db.deleteReceiptRecord(r.id);
        renderLedger();
      });
      receiptsWrap.appendChild(row);
    }

    list.appendChild(card);
  }
}

// ---------- Service worker ----------
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Non-fatal — app still works online, just won't be installable/offline-cached.
    });
  }
}
