(function () {
  let allProducts = [];
  const isManagerView = new URLSearchParams(window.location.search).get("view") === "manager" && Boolean(document.getElementById("managerPanel"));
  let managerVisibleLimit = 100;
  let activeCategory = null; // null = category home view (unless searching or toggle active)

  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("clearBtn");
  const scanBtn = document.getElementById("scanBtn");
  const closeScannerBtn = document.getElementById("closeScannerBtn");
  const onlyCheaperToggle = document.getElementById("onlyCheaperToggle");
  const categoryHome = document.getElementById("categoryHome");
  const categoryChips = document.getElementById("categoryChips");
  const resultsGrid = document.getElementById("resultsGrid");
  const resultCount = document.getElementById("resultCount");
  const syncMeta = document.getElementById("syncMeta");
  const modeBadge = document.getElementById("modeBadge");
  const storeHealthBar = document.getElementById("storeHealthBar");

  const healthPanel = document.getElementById("storeHealthPanel");
  const mobileHealth = window.matchMedia("(max-width: 700px)");
  if (healthPanel) {
    healthPanel.open = !mobileHealth.matches;
    mobileHealth.addEventListener("change", (event) => { healthPanel.open = !event.matches; });
  }
  const managerStockOnly = document.getElementById("managerStockOnly");
  const managerDirection = document.getElementById("managerDirection");
  const managerGapRange = document.getElementById("managerGapRange");
  if (isManagerView) {
    document.body.classList.add("manager-mode");
    document.getElementById("managerPanel").classList.remove("hidden");
    document.querySelector(".topbar h1").textContent = "בקרת מחירים | הנהלת האתר";
    document.title = "בקרת מחירים | קטלוג בנדא";
  }

  const CATEGORIES = [
    { id: "drones", title: "רחפנים", icon: "🚁" },
    { id: "cameras", title: "מצלמות וגימבלים", icon: "🎥" },
    { id: "audio", title: "מיקרופונים ואודיו", icon: "🎙️" },
    { id: "power", title: "סוללות, טעינה וכוח", icon: "🔋" },
    { id: "accessories", title: "תיקים, פילטרים ואביזרים", icon: "🎒" },
    { id: "home_other", title: "בית, גיימינג ושונות", icon: "🏠" },
  ];

  function classifyCategory(p) {
    const name = (p.name || "").toLowerCase();
    // Accessories & batteries checked first so "סוללה לרחפן Avata" goes to Power, not Drones
    if (/(סוללה|battery|charging|רכזת טעינה|בסיס טעינה|מטען|power station|תחנת כוח|bluetti)/.test(name)) {
      return "power";
    }
    if (/(תיק|מזוודה|פילטר|filter|פרופלור|propeller|תושבת|mount|מארז|case|מוט סלפי|extension rod|עדשה|lens|מסגרת|frame|רצועת|כיסוי|מגן|מגני|כבל|cable|קייס)/.test(name)) {
      return "accessories";
    }
    if (/(מיקרופון|mic |אוזניות|רמקול|shure|audio)/.test(name)) {
      return "audio";
    }
    if (/(שואב|romo|עכבר|מקלדת|גיימינג|ראוטר|router|מקרן)/.test(name)) {
      return "home_other";
    }
    if (/(מצלמ|osmo|pocket|action|ronin|rs ?[345]|גימבל|מייצב)/.test(name)) {
      return "cameras";
    }
    if (/(רחפן|mavic|mini [2345]|air [23]|avata|neo|lito|flip|fpv|air unit|goggles|שלט)/.test(name)) {
      return "drones";
    }
    return "home_other";
  }

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
    return String(str || "").replace(/[\s\p{Pd}\u2212]+/gu, "").trim().toUpperCase();
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

  function normalizeSearchText(value) {
    return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
      .toLowerCase().replace(/[׳״'’"]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function searchRank(product, query) {
    const code = normalizeCode(query);
    if (barcodeMatches(code, product._bcs)) return 0;
    if (product._sku && product._sku === code) return 1;
    const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (words.every((word) => product._nameSearch.includes(word))) return 2;
    if (code.length >= 3 && product._sku && product._sku.includes(code)) return 3;
    if (/^\d{4,}$/.test(code) && product._bcs.some((barcode) => barcode.includes(code))) return 4;
    if (words.every((word) => product._search.includes(word))) return 5;
    return null;
  }

  function buildSearchIndex(product) {
    const sku = normalizeCode(product.sku);
    const bcs = (product.barcodes || []).map(normalizeCode);
    const hay = `${product.name || ""} ${product.brand || ""} ${product.sku || ""} ${bcs.join(" ")}`.toLowerCase();
    return { ...product, _sku: sku, _bcs: bcs, _hay: hay, _search: normalizeSearchText(hay), _nameSearch: normalizeSearchText(product.name), _cat: classifyCategory(product) };
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
    const healthCounts = document.getElementById("healthSummaryCounts");
    if (healthCounts) healthCounts.textContent = `(${(stores || []).length})`;
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
      const isOfficial = best.importer_status === "official";
      const diffText = cheaper
        ? `זול מאיתנו ב-${formatILS(Math.abs(best.diff_ils))} (${Math.abs(best.diff_pct)}%)`
        : best.diff_ils === 0
        ? "זהה למחיר שלנו"
        : `יקר מאיתנו ב-${formatILS(best.diff_ils)} (+${best.diff_pct}%)`;

      const boxClass = !isOfficial ? "match-warn" : cheaper ? "match-ok" : "";
      const storeBadge = isOfficial
        ? `<span class="badge badge-official">${escapeHtml(best.store_name)} • יבואן רשמי</span>`
        : `<span class="badge badge-check">${escapeHtml(best.store_name)} • לוודא יבואן</span>`;
      const verifyNote = !isOfficial ? " — ⚠️ יש לוודא יבואן רשמי בקישור" : "";

      matchBoxHtml = `
        <div class="price-box ${boxClass}">
          <div class="price-label">
            <span>המחיר הזול ביותר להשוואה (במלאי)</span>
            ${storeBadge}
          </div>
          <div class="price-value">${formatILS(best.price)}</div>
          <div class="price-sub">${escapeHtml(diffText + verifyNote)}</div>
        </div>`;
    } else if (cheapest && !cheapest.in_stock) {
      matchBoxHtml = `
        <div class="price-box match-warn">
          <div class="price-label">
            <span>אין מתחרה במלאי</span>
            <span class="badge badge-oos">אזל במלאי</span>
          </div>
          <div class="price-value">${formatILS(cheapest.price)}</div>
          <div class="price-sub">${escapeHtml(cheapest.store_name)} — אין במלאי אצל המתחרה</div>
        </div>`;
    } else if (cheapest && cheapest.anomaly_flag) {
      matchBoxHtml = `
        <div class="price-box match-warn">
          <div class="price-label">
            <span>פער חריג — נדרשת בדיקה</span>
            <span class="badge badge-check">${escapeHtml(cheapest.store_name)}</span>
          </div>
          <div class="price-value">${formatILS(cheapest.price)}</div>
          <div class="price-sub">⚠️ פער חריג — יש לוודא התאמת דגם/חבילה בקישור</div>
        </div>`;
    } else {
      matchBoxHtml = `
        <div class="price-box">
          <div class="price-label"><span>השוואת שוק</span></div>
          <div class="price-value">—</div>
          <div class="price-sub">לא נמצא מתחרה בסריקה — בדוק בזאפ/גוגל</div>
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

    const barcodeText = (p.barcodes || []).length ? `ברקוד: ${p.barcodes.join(", ")}` : "";
    const skuText = p.sku ? `מק״ט: ${p.sku}` : "";

    return `
      <article class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${escapeHtml(p.name)}</h2>
            <div class="card-meta">
              ${skuText ? `<span>${escapeHtml(skuText)}</span>` : ""}
              ${barcodeText ? `<span>${escapeHtml(barcodeText)}</span>` : ""}
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

  function renderCategoryHome() {
    const cardsHtml = CATEGORIES.map((cat) => {
      const items = allProducts.filter((p) => p._cat === cat.id);
      if (!items.length) return "";
      const withComp = items.filter((p) => p.competitors && p.competitors.length).length;
      return `
        <button class="cat-card" type="button" data-cat="${cat.id}">
          <span class="cat-card-icon">${cat.icon}</span>
          <span class="cat-card-title">${cat.title}</span>
          <span class="cat-card-meta">${items.length} מוצרים • ${withComp} עם השוואת מתחרים</span>
        </button>`;
    }).join("");

    categoryHome.innerHTML =
      cardsHtml +
      `<button class="cat-card" type="button" data-cat="ALL">
        <span class="cat-card-icon">📋</span>
        <span class="cat-card-title">כל המוצרים</span>
        <span class="cat-card-meta">${allProducts.length} מוצרים בקטלוג</span>
      </button>`;

    categoryHome.querySelectorAll(".cat-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCategory = btn.getAttribute("data-cat");
        applyFilter();
      });
    });
  }

  function renderCategoryChips() {
    const chips = [
      `<button class="cat-chip ${activeCategory === null ? "active" : ""}" data-cat="HOME" type="button">⬅️ תתי-קטגוריות</button>`,
      ...CATEGORIES.filter((c) => allProducts.some((p) => p._cat === c.id)).map(
        (c) =>
          `<button class="cat-chip ${activeCategory === c.id ? "active" : ""}" data-cat="${c.id}" type="button">${c.icon} ${c.title}</button>`
      ),
      `<button class="cat-chip ${activeCategory === "ALL" ? "active" : ""}" data-cat="ALL" type="button">הכול</button>`,
    ];
    categoryChips.innerHTML = chips.join("");
    categoryChips.querySelectorAll(".cat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-cat");
        activeCategory = val === "HOME" ? null : val;
        applyFilter();
      });
    });
  }


  function managerAssessment(product, inStockOnly = false) {
    const ownPrice = Number(product.our_price);
    const eligible = (product.competitors || []).filter((offer) =>
      ["official", "unverified"].includes(offer.importer_status) &&
      Number.isFinite(Number(offer.price)) && Number(offer.price) > 0 &&
      (!inStockOnly || offer.in_stock === true)
    ).map((offer) => {
      const gap = Number.isFinite(ownPrice) && ownPrice > 0 ? Math.round((ownPrice - Number(offer.price)) * 100) / 100 : null;
      return { ...offer, _managerGap: gap, _managerPct: gap === null ? null : Math.abs(gap) / ownPrice * 100 };
    }).sort((a, b) => Math.abs(b._managerPct || 0) - Math.abs(a._managerPct || 0));
    return { eligible, hasCheaper: eligible.some((offer) => offer._managerGap > 0.005), hasHigher: eligible.some((offer) => offer._managerGap < -0.005) };
  }

  function managerFilteredOffers(assessment) {
    const minPercent = Number(managerGapRange.value);
    return assessment.eligible.filter((offer) => {
      if (offer._managerGap === null) return minPercent === 0 && managerDirection.value === "all";
      if (offer._managerPct + 0.0000001 < minPercent) return false;
      if (managerDirection.value === "ours-higher") return offer._managerGap > 0.005;
      if (managerDirection.value === "ours-lower") return offer._managerGap < -0.005;
      if (managerDirection.value === "equal") return Math.abs(offer._managerGap) <= 0.005;
      return true;
    });
  }

  function formatPreciseILS(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "לא צוין";
    return `₪${Number(value).toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
  }

  function managerGapText(offer) {
    if (offer._managerGap === null) return "מחיר שלנו חסר, לא חושב פער";
    if (Math.abs(offer._managerGap) <= 0.005) return "מחיר זהה";
    const percent = Math.round(offer._managerPct * 10) / 10;
    return `אנחנו ${offer._managerGap > 0 ? "יקרים" : "זולים"} יותר ב-${formatPreciseILS(Math.abs(offer._managerGap))}, פער ${percent}% ממחירנו`;
  }

  function managerGapClass(offer) {
    return !offer || offer._managerGap === null || Math.abs(offer._managerGap) <= 0.005 ? "is-clear is-equal" : offer._managerGap < 0 ? "is-lower" : "";
  }

  function renderManagerCard(product) {
    const assessment = managerAssessment(product, managerStockOnly.checked);
    const displayedOffers = managerFilteredOffers(assessment);
    const best = displayedOffers[0];
    const offers = displayedOffers.map((offer) => {
      const importer = offer.importer_status === "official" ? "יבואן רשמי" : "יבואן לא אומת (?)";
      return `<div class="manager-offer">
        <div class="manager-offer-head"><strong>${escapeHtml(offer.store_name)} · ${formatPreciseILS(offer.price)}</strong>
          <a class="link-btn" href="${escapeHtml(offer.url)}" target="_blank" rel="noopener">למקור ↗</a></div>
        <div class="manager-offer-gap ${managerGapClass(offer)}">${managerGapText(offer)}</div>
        <div class="manager-offer-badges"><span class="badge ${offer.importer_status === "official" ? "badge-official" : "badge-check"}">${importer}</span>
          <span class="badge ${offer.in_stock ? "badge-official" : "badge-oos"}">${offer.in_stock ? "במלאי" : "אזל במלאי"}</span></div>
        <small>${escapeHtml(offer.title)}</small>
        ${offer.anomaly_flag ? `<div class="anomaly-banner">${escapeHtml(offer.anomaly_warning || "פער חריג, יש לוודא התאמת דגם וחבילה לפני שינוי מחיר")}</div>` : ""}
        <small>נבדק: ${escapeHtml(formatIsraelTime(offer.scraped_at))}</small>
      </div>`;
    }).join("");
    return `<article class="card manager-card" data-sku="${escapeHtml(product.sku)}">
      <h2 class="card-title">${escapeHtml(product.name)}</h2>
      <div class="card-meta"><span>מק"ט: <bdi>${escapeHtml(product.sku)}</bdi></span>${product.brand ? `<span>${escapeHtml(product.brand)}</span>` : ""}
        ${(product.barcodes || []).length ? `<span>ברקוד: <bdi>${escapeHtml(product.barcodes.join(", "))}</bdi></span>` : ""}</div>
      <div class="manager-prices"><div class="manager-price"><span>המחיר שלנו, כולל מע"מ</span><strong>${formatPreciseILS(product.our_price)}</strong></div>
        <div class="manager-price"><span>מחיר מתחרה להשוואה</span><strong>${best ? formatPreciseILS(best.price) : "אין הצעה"}</strong></div></div>
      <div class="manager-gap ${managerGapClass(best)}">${best ? managerGapText(best) : "אין השוואה מתאימה בסריקה הקיימת"}</div>
      ${best ? `<div class="manager-offer-badges"><span class="badge ${best.importer_status === "official" ? "badge-official" : "badge-check"}">${escapeHtml(best.store_name)} · ${best.importer_status === "official" ? "יבואן רשמי" : "יבואן לא אומת (?)"}</span>
        <span class="badge ${best.in_stock ? "badge-official" : "badge-oos"}">${best.in_stock ? "במלאי" : "אזל במלאי"}</span>
        ${best.anomaly_flag ? '<span class="badge badge-check">פער חריג לבדיקה</span>' : ""}</div>` : ""}
      ${product.source_url ? `<div class="card-footer"><a class="link-btn" href="${escapeHtml(product.source_url)}" target="_blank" rel="noopener">דף המוצר שלנו ↗</a></div>` : ""}
      ${offers ? `<details class="manager-offers" open><summary>השוואות ומקורות (${displayedOffers.length}/${assessment.eligible.length}) ⌄</summary>${offers}</details>` : ""}
    </article>`;
  }

  function applyManagerFilter() {
    categoryHome.classList.add("hidden");
    categoryChips.classList.add("hidden");
    const rawQuery = searchInput.value.trim();
    clearBtn.classList.toggle("hidden", !rawQuery);
    const minPercent = Number(managerGapRange.value);
    document.getElementById("managerGapValue").textContent = `${minPercent}% ומעלה`;
    managerGapRange.setAttribute("aria-valuetext", `${minPercent}% ומעלה`);
    document.querySelectorAll("[data-gap]").forEach((button) => button.classList.toggle("active", Number(button.dataset.gap) === minPercent));
    const assessed = allProducts.map((product) => ({ product, assessment: managerAssessment(product, managerStockOnly.checked), rank: rawQuery ? searchRank(product, rawQuery) : 0 }));
    const higherCount = assessed.filter((item) => item.assessment.hasCheaper).length;
    const lowerCount = assessed.filter((item) => item.assessment.hasHigher).length;
    document.getElementById("managerSummary").innerHTML = `<div class="manager-stat"><strong>${allProducts.length.toLocaleString("he-IL")}</strong><span>מוצרים בקטלוג</span></div><div class="manager-stat"><strong>${higherCount}</strong><span>אנחנו יקרים יותר</span></div><div class="manager-stat"><strong>${lowerCount}</strong><span>אנחנו זולים יותר</span></div>`;
    const needsComparison = minPercent > 0 || managerDirection.value !== "all";
    const filtered = assessed.filter((item) => item.rank !== null && (!needsComparison || managerFilteredOffers(item.assessment).length > 0));
    filtered.sort((a, b) => rawQuery ? a.rank - b.rank : Math.max(0, ...managerFilteredOffers(b.assessment).map((offer) => offer._managerPct || 0)) - Math.max(0, ...managerFilteredOffers(a.assessment).map((offer) => offer._managerPct || 0)));
    const visible = filtered.slice(0, managerVisibleLimit);
    resultCount.textContent = `מציג ${visible.length} מתוך ${filtered.length} מוצרים${rawQuery ? " בחיפוש בכל הקטלוג" : ""}`;
    resultsGrid.innerHTML = visible.length ? visible.map((item) => renderManagerCard(item.product)).join("") : '<div class="empty-state">לא נמצאו מוצרים לסינון הנוכחי.</div>';
    document.getElementById("managerPagination").classList.toggle("hidden", visible.length >= filtered.length);
    document.getElementById("managerLoadMore").textContent = `הצג עוד ${Math.min(100, filtered.length - visible.length)} מוצרים`;
  }

  function applyFilter() {
    if (isManagerView) { applyManagerFilter(); return; }
    const rawQuery = searchInput.value.trim();
    clearBtn.classList.toggle("hidden", !rawQuery);
    const onlyCheaper = onlyCheaperToggle.checked;

    // Show clean category tiles when not searching, no category selected, and toggle is off
    if (!rawQuery && !onlyCheaper && activeCategory === null) {
      categoryHome.classList.remove("hidden");
      categoryChips.classList.add("hidden");
      resultsGrid.innerHTML = "";
      resultCount.textContent = `בחר קטגוריה או חפש מכל ${allProducts.length} המוצרים`;
      return;
    }

    categoryHome.classList.add("hidden");
    categoryChips.classList.remove("hidden");
    renderCategoryChips();

    const queryNormCode = normalizeCode(rawQuery);
    const words = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);

    const filtered = allProducts.filter((p) => {
      // Search ALWAYS searches across the ENTIRE catalog regardless of activeCategory
      if (!rawQuery && activeCategory && activeCategory !== "ALL" && p._cat !== activeCategory) {
        return false;
      }
      if (onlyCheaper && !(p.best_in_stock_match && p.best_in_stock_match.diff_ils < 0)) {
        return false;
      }
      if (!rawQuery) return true;
      return searchRank(p, rawQuery) !== null;
    });

    if (rawQuery) filtered.sort((a, b) => searchRank(a, rawQuery) - searchRank(b, rawQuery));
    // Prioritize items that actually have competitor offers when browsing a category
    if (!rawQuery) {
      filtered.sort((a, b) => (b.competitors?.length || 0) - (a.competitors?.length || 0));
    }

    resultCount.textContent = rawQuery
      ? `חיפוש בכל הקטלוג: נמצאו ${filtered.length} תוצאות`
      : `מציג ${filtered.length} מוצרים`;

    if (!filtered.length) {
      resultsGrid.innerHTML = `
        <div class="empty-state">
          <p><strong>לא נמצא מוצר תואם עבור "${escapeHtml(rawQuery)}"</strong></p>
          <p style="color:#64748b;font-size:0.9rem">ניתן לפתוח בדיקה מהירה בזאפ או בגוגל בלחיצה אחת:</p>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
            <a class="link-btn primary" href="${zapUrl(rawQuery)}" target="_blank" rel="noopener">🔎 חפש בזאפ</a>
            <a class="link-btn" href="${googleUrl(rawQuery)}" target="_blank" rel="noopener">🌐 חפש בגוגל</a>
          </div>
        </div>`;
      return;
    }

    resultsGrid.innerHTML = filtered.slice(0, 100).map(renderCard).join("");
  }

  async function init() {
    try {
      const resp = await fetch("data/prices.json", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();

      syncMeta.textContent = `סריקה אחרונה: ${formatIsraelTime(payload.generated_at)} • ${payload.product_count} מוצרים`;
      modeBadge.textContent = payload.mode === "sheet" ? "מסונכרן Google Sheets" : payload.mode === "demo" ? "מצב הדגמה" : "מסונכרן";
      renderHealth(payload.stores || []);

      allProducts = (payload.products || []).map(buildSearchIndex);
      renderCategoryHome();
      applyFilter();
    } catch (err) {
      syncMeta.textContent = "שגיאה בטעינת נתוני prices.json";
      resultsGrid.innerHTML = `<div class="empty-state">לא ניתן לטעון את קובץ הנתונים.</div>`;
    }
  }

  function resetManagerPage() { managerVisibleLimit = 100; applyFilter(); }
  searchInput.addEventListener("input", resetManagerPage);
  onlyCheaperToggle.addEventListener("change", resetManagerPage);
  managerStockOnly?.addEventListener("change", resetManagerPage);
  managerDirection?.addEventListener("change", resetManagerPage);
  managerGapRange?.addEventListener("input", resetManagerPage);
  document.querySelectorAll("[data-gap]").forEach((button) => button.addEventListener("click", () => { managerGapRange.value = button.dataset.gap; resetManagerPage(); }));
  document.getElementById("managerLoadMore")?.addEventListener("click", () => { managerVisibleLimit += 100; applyFilter(); });
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
