(function () {
  let allProducts = [];

  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("clearBtn");
  const scanBtn = document.getElementById("scanBtn");
  const closeScannerBtn = document.getElementById("closeScannerBtn");
  const onlyCheaperToggle = document.getElementById("onlyCheaperToggle");
  const resultsGrid = document.getElementById("resultsGrid");
  const resultCount = document.getElementById("resultCount");
  const syncMeta = document.getElementById("syncMeta");
  const modeBadge = document.getElementById("modeBadge");
  const storeHealthBar = document.getElementById("storeHealthBar");

  function formatILS(num) {
    if (num === null || num === undefined || Number.isNaN(Number(num))) return "—";
    return `₪${Math.round(Number(num)).toLocaleString("he-IL")}`;
  }

  function formatIsraelTime(iso) {
    if (!iso) return "לא ידוע";
    try {
      return new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
  }

  function normalizeCode(str) {
    return String(str || "").replace(/[\s\-]+/g, "").trim().toUpperCase();
  }

  function barcodeMatches(queryNorm, barcodes) {
    if (!queryNorm || !Array.isArray(barcodes)) return false;
    const strippedQuery = queryNorm.replace(/^0+/, "");
    return barcodes.some((bc) => {
      const nb = normalizeCode(bc);
      if (!nb) return false;
      return nb === queryNorm || nb.replace(/^0+/, "") === strippedQuery;
    });
  }

  function buildSearchIndex(product) {
    const sku = normalizeCode(product.sku);
    const bcs = (product.barcodes || []).map(normalizeCode);
    const hay = `${product.name || ""} ${product.brand || ""} ${product.sku || ""} ${bcs.join(" ")}`.toLowerCase();
    return { ...product, _sku: sku, _bcs: bcs, _hay: hay };
  }

  function zapUrl(name) {
    return `https://www.zap.co.il/search.aspx?keyword=${encodeURIComponent(name)}`;
  }

  function googleUrl(name) {
    return `https://www.google.com/search?q=${encodeURIComponent(name + " יבואן רשמי מחיר")}`;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderHealth(stores) {
    storeHealthBar.innerHTML = (stores || [])
      .map((s) => {
        const cls = s.status === "ok" ? "ok" : s.status === "stale" ? "stale" : "error";
        const dateNote = s.status === "stale" && s.last_ok_at ? ` (${formatIsraelTime(s.last_ok_at)})` : "";
        return `<span class="health-pill ${cls}" title="${escapeHtml(s.message || s.status_label)}">
          <span class="dot"></span>
          <span>${escapeHtml(s.store_name)}: ${escapeHtml(s.status_label)}${escapeHtml(dateNote)}</span>
        </span>`;
      })
      .join("");
  }

  function renderCard(p) {
    const saleBadge = p.is_on_sale ? `<span class="badge badge-sale">מחיר מבצע באתר</span>` : "";
    const best = p.best_in_stock_match;
    const cheapest = p.cheapest_overall;

    let matchBoxHtml = "";
    if (best) {
      const cheaper = best.diff_ils < 0;
      const diffText = cheaper
        ? `זול מאיתנו ב-${formatILS(Math.abs(best.diff_ils))} (${Math.abs(best.diff_pct)}%)`
        : best.diff_ils === 0
        ? "זהה למחיר שלנו"
        : `יקר מאיתנו ב-${formatILS(best.diff_ils)} (+${best.diff_pct}%)`;
      matchBoxHtml = `
        <div class="price-box ${cheaper ? "match-ok" : ""}">
          <div class="price-label">
            <span>המחיר הזול ביותר להשוואה (במלאי)</span>
            <span class="badge badge-official">${escapeHtml(best.store_name)}</span>
          </div>
          <div class="price-value">${formatILS(best.price)}</div>
          <div class="price-sub">${escapeHtml(diffText)}</div>
        </div>`;
    } else if (cheapest && !cheapest.in_stock) {
      matchBoxHtml = `
        <div class="price-box match-warn">
          <div class="price-label">
            <span>אין מתחרה מאושר במלאי</span>
            <span class="badge badge-oos">אזל במלאי</span>
          </div>
          <div class="price-value">${formatILS(cheapest.price)}</div>
          <div class="price-sub">${escapeHtml(cheapest.store_name)} — אין במלאי אצל המתחרה</div>
        </div>`;
    } else if (cheapest && cheapest.needs_seller_check) {
      matchBoxHtml = `
        <div class="price-box match-warn">
          <div class="price-label">
            <span>נדרשת בדיקת מוכר לפני השוואה</span>
            <span class="badge badge-check">לבדיקה</span>
          </div>
          <div class="price-value">${formatILS(cheapest.price)}</div>
          <div class="price-sub">${escapeHtml(cheapest.store_name)} — בדוק יבואן/חבילה בקישור</div>
        </div>`;
    } else {
      matchBoxHtml = `
        <div class="price-box">
          <div class="price-label"><span>השוואת שוק</span></div>
          <div class="price-value">—</div>
          <div class="price-sub">לא נמצא מתחרה מאושר בסריקה — בדוק בזאפ/גוגל</div>
        </div>`;
    }

    const compsHtml = (p.competitors || [])
      .map((c) => {
        const stockBadge = c.in_stock
          ? `<span class="badge badge-official">במלאי</span>`
          : `<span class="badge badge-oos">אין במלאי אצל המתחרה</span>`;
        const importerBadge =
          c.importer_status === "official"
            ? `<span class="badge badge-official">יבואן רשמי</span>`
            : `<span class="badge badge-check">לבדיקת מוכר (יבואן לא ודאי)</span>`;
        const anomalyHtml = c.anomaly_flag
          ? `<div class="anomaly-banner">${escapeHtml(c.anomaly_warning)}</div>`
          : "";

        return `
          <div class="comp-row ${c.in_stock ? "" : "is-oos"}">
            <div class="comp-info">
              <div class="comp-top">
                <span>${escapeHtml(c.store_name)}</span>
                ${stockBadge}
                ${importerBadge}
              </div>
              <small style="color:#64748b">${escapeHtml(c.title)}</small>
              ${anomalyHtml}
            </div>
            <div class="comp-actions">
              <span class="comp-price">${formatILS(c.price)}</span>
              <a class="link-btn primary" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">פתיחה באתר ↗</a>
            </div>
          </div>`;
      })
      .join("");

    const barcodeText = (p.barcodes || []).length ? `ברקוד: ${p.barcodes.join(", ")}` : "ללא ברקוד";
    const skuText = p.sku ? `מק״ט: ${p.sku}` : "";

    return `
      <article class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${escapeHtml(p.name)}</h2>
            <div class="card-meta">
              ${skuText ? `<span>${escapeHtml(skuText)}</span>` : ""}
              <span>${escapeHtml(barcodeText)}</span>
              <span>מקור: ${escapeHtml(p.source_name)}</span>
            </div>
          </div>
          ${p.source_url ? `<a class="link-btn" href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">דף שלנו ↗</a>` : ""}
        </div>

        <div class="price-grid">
          <div class="price-box ours">
            <div class="price-label">
              <span>המחיר שלנו (כולל מע״מ)</span>
              ${saleBadge}
            </div>
            <div class="price-value">${formatILS(p.our_price)}</div>
            <div class="price-sub">${p.regular_price && p.is_on_sale ? `מחיר רגיל: ${formatILS(p.regular_price)}` : escapeHtml(p.source_name)}</div>
          </div>
          ${matchBoxHtml}
        </div>

        ${compsHtml ? `<div class="comp-list">${compsHtml}</div>` : ""}

        <div class="card-footer">
          <a class="link-btn" href="${zapUrl(p.name)}" target="_blank" rel="noopener">🔎 בדוק בזאפ</a>
          <a class="link-btn" href="${googleUrl(p.name)}" target="_blank" rel="noopener">🌐 בדוק בגוגל</a>
        </div>
      </article>`;
  }

  function applyFilter() {
    const rawQuery = searchInput.value.trim();
    clearBtn.classList.toggle("hidden", !rawQuery);
    const onlyCheaper = onlyCheaperToggle.checked;

    const queryNormCode = normalizeCode(rawQuery);
    const words = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);

    const filtered = allProducts.filter((p) => {
      if (onlyCheaper && !(p.best_in_stock_match && p.best_in_stock_match.diff_ils < 0)) {
        return false;
      }
      if (!rawQuery) return true;
      if (barcodeMatches(queryNormCode, p._bcs)) return true;
      if (p._sku && p._sku === queryNormCode) return true;
      return words.every((w) => p._hay.includes(w));
    });

    resultCount.textContent = `מציג ${filtered.length} מתוך ${allProducts.length} מוצרים`;

    if (!filtered.length) {
      resultsGrid.innerHTML = `
        <div class="empty-state">
          <p><strong>לא נמצא מוצר תואם בסריקה עבור "${escapeHtml(rawQuery)}"</strong></p>
          <p style="color:#64748b;font-size:0.9rem">ניתן לפתוח בדיקה מהירה בזאפ או בגוגל בלחיצה אחת:</p>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
            <a class="link-btn primary" href="${zapUrl(rawQuery)}" target="_blank" rel="noopener">🔎 חפש בזאפ</a>
            <a class="link-btn" href="${googleUrl(rawQuery)}" target="_blank" rel="noopener">🌐 חפש בגוגל</a>
          </div>
        </div>`;
      return;
    }

    resultsGrid.innerHTML = filtered.slice(0, 80).map(renderCard).join("");
  }

  async function init() {
    try {
      const resp = await fetch("data/prices.json", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();

      syncMeta.textContent = `סריקה אחרונה: ${formatIsraelTime(payload.generated_at)} • ${payload.product_count} מוצרים`;
      modeBadge.textContent = payload.mode === "demo" ? "מצב הדגמה" : payload.mode === "full" ? "קטלוג מלא" : "מצב DJI";
      renderHealth(payload.stores || []);

      allProducts = (payload.products || []).map(buildSearchIndex);
      applyFilter();
    } catch (err) {
      syncMeta.textContent = "שגיאה בטעינת נתוני prices.json";
      resultsGrid.innerHTML = `<div class="empty-state">לא ניתן לטעון את קובץ הנתונים. הפעל את ה-GitHub Action ליצירת <code>docs/data/prices.json</code>.</div>`;
    }
  }

  searchInput.addEventListener("input", applyFilter);
  onlyCheaperToggle.addEventListener("change", applyFilter);
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchInput.focus();
    applyFilter();
  });

  scanBtn.addEventListener("click", () => {
    window.BarcodeScanner.startScanner((code) => {
      searchInput.value = code;
      applyFilter();
    });
  });
  closeScannerBtn.addEventListener("click", () => window.BarcodeScanner.stopScanner());

  init();
})();
