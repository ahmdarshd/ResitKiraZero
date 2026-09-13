/**
 * Thin IndexedDB wrapper. Two stores:
 *  - "receipts": one record per (receipt, category) pair — a receipt that
 *    matches 3 categories produces 3 records sharing the same groupId, so
 *    the receipt image itself is only stored once via imageBlobId pointing
 *    into the "images" store.
 *  - "images": raw image blobs, deduped by groupId.
 *  - "settings": key/value app settings (Gemini key, refresh URL, category cache).
 */
const DB_NAME = "tax-relief-checker";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("receipts")) {
        const store = db.createObjectStore("receipts", { keyPath: "id", autoIncrement: true });
        store.createIndex("categoryId", "categoryId", { unique: false });
        store.createIndex("groupId", "groupId", { unique: false });
        store.createIndex("year", "year", { unique: false });
      }
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "groupId" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

const Db = {
  async saveSetting(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = tx(db, "settings", "readwrite");
      t.objectStore("settings").put({ key, value });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async getSetting(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, "settings", "readonly").objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Saves one image blob plus one or more receipt records (one per matched
   * category). Returns the groupId used.
   */
  async saveReceiptGroup({ imageBlob, merchant, date, amount, year, categories, sourceText, confirmed }) {
    const db = await openDb();
    const groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const t = tx(db, ["receipts", "images"], "readwrite");
      if (imageBlob) {
        t.objectStore("images").put({ groupId, blob: imageBlob });
      }
      const receiptStore = t.objectStore("receipts");
      const catList = categories.length ? categories : [{ categoryId: "uncategorized", label: "Uncategorized", confidence: 0 }];
      for (const cat of catList) {
        receiptStore.add({
          groupId,
          merchant: merchant || "Unknown merchant",
          date: date || new Date().toISOString().slice(0, 10),
          amount: amount ?? null,
          year: year || new Date().getFullYear(),
          categoryId: cat.categoryId,
          categoryLabel: cat.label,
          confidence: cat.confidence ?? null,
          matchedKeywords: cat.matchedKeywords || [],
          sourceText: sourceText || "",
          confirmed: !!confirmed,
          createdAt: new Date().toISOString()
        });
      }
      t.oncomplete = () => resolve(groupId);
      t.onerror = () => reject(t.error);
    });
  },

  async getAllReceipts() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, "receipts", "readonly").objectStore("receipts").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getImage(groupId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = tx(db, "images", "readonly").objectStore("images").get(groupId);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteReceiptRecord(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = tx(db, "receipts", "readwrite");
      t.objectStore("receipts").delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async deleteGroup(groupId) {
    const db = await openDb();
    const all = await this.getAllReceipts();
    const ids = all.filter(r => r.groupId === groupId).map(r => r.id);
    return new Promise((resolve, reject) => {
      const t = tx(db, ["receipts", "images"], "readwrite");
      const rs = t.objectStore("receipts");
      ids.forEach(id => rs.delete(id));
      t.objectStore("images").delete(groupId);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async updateReceiptRecord(id, patch) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = tx(db, "receipts", "readwrite");
      const store = t.objectStore("receipts");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) return reject(new Error("Record not found"));
        store.put({ ...rec, ...patch });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
};
