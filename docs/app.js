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

  // XLSX export is generated locally. No catalog or customer data leaves this page.
  let managerExportItems = [];
  let feedGeneratedAt = "";
  let managerExportButton = null;
  let managerExportStatus = null;

  function exportDateValue(promotion, key) {
    return promotion && promotion.verified === true ? String(promotion[key] || "") : "";
  }

  function exportComparisonRows() {
    const rows = [];
    managerExportItems.forEach(({ product, assessment }) => {
      managerFilteredOffers(assessment).forEach((offer) => {
        const direction = offer._managerGap === null ? "לא חושב" : Math.abs(offer._managerGap) <= 0.005 ? "מחיר זהה" : offer._managerGap > 0 ? "אנחנו יקרים יותר" : "אנחנו זולים יותר";
        rows.push([
          String(product.sku || ""), (product.barcodes || []).join(", "), product.brand || "", product.name || "",
          Number.isFinite(Number(product.our_price)) && Number(product.our_price) > 0 ? Number(product.our_price) : null,
          offer.store_name || "", offer.title || "", Number(offer.price), offer._managerGap,
          offer._managerGap === null ? null : offer._managerGap / Number(product.our_price), direction,
          offer.in_stock === true ? "במלאי" : "אזל במלאי", offer.importer_status === "official" ? "יבואן רשמי" : "יבואן לא אומת (?)",
          [offer.anomaly_flag ? (offer.anomaly_warning || "פער חריג, נדרשת בדיקת דגם וחבילה") : "", clearanceCollisionText(product)].filter(Boolean).join(" | "),
          offer.scraped_at || "", product.source_url || "", offer.url || "",
          exportDateValue(offer.promotion, "starts_on"), exportDateValue(offer.promotion, "ends_on"), exportDateValue(offer.promotion, "terms"),
          exportDateValue(product.promotion, "starts_on"), exportDateValue(product.promotion, "ends_on"), exportDateValue(product.promotion, "terms")
        ]);
      });
    });
    return rows;
  }

  function updateManagerExport() {
    if (!managerExportButton) return;
    const rows = exportComparisonRows();
    const productCount = new Set(rows.map((row) => row[0])).size;
    managerExportButton.disabled = !rows.length;
    managerExportButton.style.opacity = rows.length ? "1" : "0.5";
    managerExportStatus.textContent = rows.length ? `${rows.length} השוואות מ-${productCount} מוצרים לייצוא, שורה לכל מתחרה, כולל כל התוצאות שמעבר לעמוד הנוכחי` : "אין השוואות מתאימות לייצוא בסינון הנוכחי";
  }

  function xlsxXml(value) {
    return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function xlsxColumn(index) {
    let value = index + 1, out = "";
    while (value) { value--; out = String.fromCharCode(65 + value % 26) + out; value = Math.floor(value / 26); }
    return out;
  }

  function xlsxSheet(rows, widths, metadata = false) {
    const last = `${xlsxColumn(Math.max(0, widths.length - 1))}${Math.max(1, rows.length)}`;
    const body = rows.map((row, r) => `<row r="${r + 1}" ht="${r === 0 ? 42 : Math.max(32, ...row.map((value, c) => String(value == null ? '' : value).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(10, widths[c] * 0.85))), 0) * 15 + 6))}" customHeight="1">${row.map((value, c) => {
      const cell = `${xlsxColumn(c)}${r + 1}`;
      const style = r === 0 ? 1 : !metadata && [4, 7, 8].includes(c) ? 2 : !metadata && c === 9 ? 3 : 0;
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${cell}" s="${style}"><v>${value}</v></c>`;
      // Inline strings preserve leading zeros and never turn source text into formulas.
      return `<c r="${cell}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xlsxXml(value)}</t></is></c>`;
    }).join("")}</row>`).join("");
    const hyperlinks = [];
    if (!metadata) rows.slice(1).forEach((row, i) => [15, 16].forEach((c) => {
      if (/^https?:\/\//i.test(String(row[c] || ""))) hyperlinks.push({ ref: `${xlsxColumn(c)}${i + 2}`, target: row[c] });
    }));
    return {
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane xSplit="${metadata ? 0 : 4}" ySplit="1" topLeftCell="${metadata ? 'A2' : 'E2'}" activePane="${metadata ? 'bottomLeft' : 'bottomRight'}" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="32"/><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${body}</sheetData>${!metadata ? `<autoFilter ref="A1:${last}"/>` : ''}${hyperlinks.length ? `<hyperlinks>${hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : ''}<printOptions horizontalCentered="0"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9"/></worksheet>`,
      rels: hyperlinks.length ? `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hyperlinks.map((h, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xlsxXml(h.target)}" TargetMode="External"/>`).join("")}</Relationships>` : null
    };
  }

  function xlsxZip(files) {
    const encoder = new TextEncoder();
    const crcTable = Array.from({ length: 256 }, (_, i) => { let n = i; for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
    const crc = (data) => { let value = 0xFFFFFFFF; for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xFFFFFFFF) >>> 0; };
    const locals = [], central = []; let offset = 0;
    const header = (size) => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
    for (const [name, text] of Object.entries(files)) {
      const filename = encoder.encode(name), data = encoder.encode(text), checksum = crc(data);
      const local = header(30); local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true); local.view.setUint16(12, 0x21, true); local.view.setUint32(14, checksum, true); local.view.setUint32(18, data.length, true); local.view.setUint32(22, data.length, true); local.view.setUint16(26, filename.length, true);
      locals.push(local.bytes, filename, data);
      const entry = header(46); entry.view.setUint32(0, 0x02014b50, true); entry.view.setUint16(4, 20, true); entry.view.setUint16(6, 20, true); entry.view.setUint16(8, 0x800, true); entry.view.setUint16(14, 0x21, true); entry.view.setUint32(16, checksum, true); entry.view.setUint32(20, data.length, true); entry.view.setUint32(24, data.length, true); entry.view.setUint16(28, filename.length, true); entry.view.setUint32(42, offset, true);
      central.push(entry.bytes, filename); offset += 30 + filename.length + data.length;
    }
    const centralSize = central.reduce((sum, a) => sum + a.length, 0), end = header(22), count = Object.keys(files).length;
    end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, count, true); end.view.setUint16(10, count, true); end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
    return new Blob([...locals, ...central, end.bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function buildManagerWorkbook(rows) {
    const headings = ["מק״ט", "ברקודים", "מותג", "שם המוצר שלנו", "מחיר שלנו כולל מע״מ (ILS)", "רשת מתחרה", "שם המוצר אצל המתחרה", "מחיר מתחרה כולל מע״מ (ILS)", "פער בש״ח: שלנו פחות המתחרה", "פער באחוזים ממחירנו", "כיוון הפער", "מלאי אצל המתחרה", "סטטוס יבואן", "אזהרה לבדיקה", "נבדק במקור", "קישור למוצר שלנו", "קישור למתחרה", "מבצע מתחרה: תחילה", "מבצע מתחרה: סיום", "תנאי מבצע מתחרה שתועדו", "מבצע בנדא: תחילה", "מבצע בנדא: סיום", "תנאי מבצע בנדא שתועדו"];
    const directionLabels = { all: "כל כיווני הפער", "ours-higher": "אנחנו יקרים יותר", "ours-lower": "אנחנו זולים יותר", equal: "מחיר זהה" };
    const meta = [["פרטי הייצוא", "ערך"], ["חיפוש", searchInput.value.trim() || "ללא"], ["כיוון הפער", directionLabels[managerDirection.value]], ["פער מינימלי בערך מוחלט", `${managerGapRange.value}%`], ["מלאי בלבד", managerStockOnly.checked ? "כן" : "לא"], ["מספר השוואות", rows.length], ["מספר מוצרים עם השוואה", new Set(rows.map((r) => r[0])).size], ["נתונים נוצרו", feedGeneratedAt], ["הייצוא נוצר בשעון ישראל", formatIsraelTime(new Date().toISOString())], ["מטבע", "ILS, כולל מע״מ"], ["משמעות הפער", "מחיר שלנו פחות מחיר המתחרה. פער חיובי: אנחנו יקרים יותר. אחוז הפער מחושב ביחס למחיר שלנו."], ["היקף", "כל ההשוואות המתאימות לסינון, גם מעבר ל-100 המוצרים הראשונים. מוצרים ללא השוואה מתאימה אינם נכללים."], ["תאריכי מבצע", "תאריך ריק פירושו שלא תועד תוקף מאומת, לא הוכחה שאין מבצע. תאריכי priceValidUntil כלליים לא משמשים כתוקף מבצע."], ["הסתייגויות", "אזהרות מחיר, יבואן לא מאומת ומלאי נשמרו. יש לבדוק את המקור לפני שינוי מחיר. הייצוא לא משנה מחירים או נתונים."]];
    const groups = new Map();
    rows.forEach((row) => { const items = groups.get(row[0]) || []; items.push(row); groups.set(row[0], items); });
    const marketRows = [["מק״ט", "שם המוצר", "מחיר שלנו כולל מע״מ (ILS)", "מספר רשתות בסינון", "כל מחירי המתחרים בסינון", "הפער מול כל מתחרה"]];
    groups.forEach((offers, sku) => marketRows.push([sku, offers[0][3], offers[0][4], new Set(offers.map((r) => r[5])).size,
      offers.map((r) => `${r[5]}: ${formatPreciseILS(r[7])}`).join("\n"),
      offers.map((r) => `${r[5]}: ${r[10]}${r[8] === null ? "" : `, ${formatPreciseILS(Math.abs(r[8]))} (${(Math.abs(r[9]) * 100).toFixed(1)}%)`}`).join("\n")
    ]));
    const multiple = Array.from(groups.values()).filter((items) => new Set(items.map((r) => r[5])).size > 1).length;
    meta.push(["מצב בדיקת מציאון", clearanceStatus ? clearanceStatus.textContent : "לא נטען"], ["כיסוי מידע תוקף מבצעים", promotionInfoStatus ? promotionInfoStatus.textContent : "לא נטען"], ["קריאת הקובץ", "בגיליון השוואות: שורה נפרדת לכל מוצר ומתחרה. בגיליון תמונת שוק למוצר: כל המתחרים של אותו מוצר יחד. כל הגיליונות מכבדים את הסינון."], ["מוצרים עם כמה רשתות בסינון", multiple], ["מוצרים עם רשת אחת בסינון", groups.size - multiple], ["מגבלת הכיסוי", "מוצר עם רשת אחת משקף הצעה מאומתת אחת בנתונים ובסינון הנוכחי. אין בכך הוכחה שאין רשתות נוספות, והסריקה המלאה טרם הושלמה."]);
    const sheets = [xlsxSheet([headings, ...rows], [23, 27, 17, 49, 20, 20, 49, 22, 22, 20, 24, 21, 25, 49, 28, 49, 49, 24, 24, 49, 24, 24, 49]), xlsxSheet(meta, [34, 100], true), xlsxSheet(marketRows, [23, 49, 23, 22, 55, 70], true)];
    const files = {
      "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="השוואות" sheetId="1" r:id="rId1"/><sheet name="פרטי הייצוא" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1" readingOrder="2"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1" readingOrder="2"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" readingOrder="2"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" readingOrder="2"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    };
    files["[Content_Types].xml"] = files["[Content_Types].xml"].replace("</Types>", '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    files["xl/workbook.xml"] = files["xl/workbook.xml"].replace('<sheet name="פרטי הייצוא"', '<sheet name="תמונת שוק למוצר" sheetId="3" r:id="rId3"/><sheet name="פרטי הייצוא"');
    files["xl/_rels/workbook.xml.rels"] = files["xl/_rels/workbook.xml.rels"].replace('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"', 'Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"').replace("</Relationships>", '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>');
    sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheet.xml; if (sheet.rels) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = sheet.rels; });
    return xlsxZip(files);
  }

  function initManagerExport() {
    if (!isManagerView) return;
    const panel = document.createElement("div"); panel.className = "manager-export";
    panel.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:14px 0;";
    managerExportButton = document.createElement("button"); managerExportButton.id = "managerExportExcel"; managerExportButton.type = "button"; managerExportButton.className = "btn-scan"; managerExportButton.textContent = "ייצוא השוואות ל-Excel"; managerExportButton.disabled = true;
    managerExportStatus = document.createElement("span"); managerExportStatus.id = "managerExportStatus"; managerExportStatus.setAttribute("role", "status"); managerExportStatus.setAttribute("aria-live", "polite"); managerExportStatus.style.cssText = "font-size:13px;color:#64748b;flex:1;min-width:180px;";
    panel.append(managerExportButton, managerExportStatus);
    document.querySelector("#managerPanel .manager-controls").before(panel);
    managerExportButton.addEventListener("click", () => {
      try {
        const rows = exportComparisonRows(); if (!rows.length) return;
        const blob = buildManagerWorkbook(rows), href = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = href; a.download = `benda-comparisons-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}Z.xlsx`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
        managerExportStatus.textContent = `הוכן קובץ Excel עם ${rows.length} השוואות לפי הסינון הנוכחי`;
      } catch (_) { managerExportStatus.textContent = "הייצוא לא הצליח. יש לרענן את העמוד ולנסות שוב."; }
    });
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


  // Clearance is a separate condition lookup, never a competitor-price catalog.
  let clearanceProducts = [];
  let clearanceBySku = new Map();
  let clearanceStatus = null;
  let clearanceResults = null;

  function clearanceCollisionText(product) {
    return clearanceBySku.has(normalizeCode(product.sku)) ? "קיים גם רישום מציאון למק״ט זה באתר בנדא. אין להסיק מכך שהמוצר הרגיל הוא מציאון; יש לוודא את מצב הפריט." : "";
  }

  function clearanceCollisionHtml(product) {
    const text = clearanceCollisionText(product);
    if (!text) return "";
    const listing = clearanceBySku.get(normalizeCode(product.sku))[0];
    return `<div class="price-box clearance-collision" style="margin:10px 0"><div class="price-sub">${escapeHtml(text)} <a href="${escapeHtml(listing.source_url)}" target="_blank" rel="noopener">לרישום המציאון בבנדא ↗</a></div></div>`;
  }

  function renderClearanceCard(product) {
    const shared = allProducts.some((p) => normalizeCode(p.sku) === product._sku);
    return `<article class="card clearance-card" data-clearance-id="${escapeHtml(product.id)}">
      <span class="badge badge-check">מציאון באתר בנדא</span>
      <h2 class="card-title" style="margin-top:10px">${escapeHtml(product.name)}</h2>
      <div class="card-meta"><span>מק״ט: <bdi>${escapeHtml(product.sku)}</bdi></span>${product.barcodes.length ? `<span>ברקוד: <bdi>${escapeHtml(product.barcodes.join(", "))}</bdi></span>` : ""}</div>
      <p class="price-sub">סימון מפורש בשם המוצר באתר בנדא. מוצג לזיהוי מצב הפריט בלבד, ללא השוואת מתחרים.</p>
      ${shared ? '<p class="price-sub">אותו מק״ט מופיע גם בקטלוג הרגיל. יש לוודא איזה פריט נסרק; הרישום הרגיל לא סומן מחדש כמציאון.</p>' : ""}
      <p class="price-sub">המחיר והברקודים יושלמו מהמחירון. לא הוסק מצב המוצר מגובה המחיר.</p>
      <div class="card-footer"><a class="link-btn" href="${escapeHtml(product.source_url)}" target="_blank" rel="noopener">לרישום המציאון בבנדא ↗</a></div>
    </article>`;
  }

  function renderClearanceQuery(rawQuery) {
    if (!clearanceResults) return 0;
    let matches = [];
    if (!isManagerView && activeCategory === "CLEARANCE" && !rawQuery) {
      matches = clearanceProducts;
    } else if (rawQuery) {
      const regularSkus = new Set(allProducts.filter((p) => searchRank(p, rawQuery) !== null).map((p) => normalizeCode(p.sku)));
      matches = clearanceProducts.filter((p) => searchRank(p, rawQuery) !== null || regularSkus.has(p._sku));
      matches.sort((a, b) => (searchRank(a, rawQuery) ?? 10) - (searchRank(b, rawQuery) ?? 10));
    }
    clearanceResults.classList.toggle("hidden", !matches.length);
    clearanceResults.innerHTML = matches.length ? `<div style="grid-column:1/-1"><strong>זיהוי מציאון: ${matches.length === 1 ? "רישום אחד" : `${matches.length} רישומים`}</strong><p class="price-sub">התראות מצב פריט בלבד. אינן משתתפות בהשוואות או במסנן מחיר המתחרה.</p></div>${matches.map(renderClearanceCard).join("")}` : "";
    return matches.length;
  }

  async function initClearance() {
    clearanceStatus = document.createElement("div");
    clearanceStatus.id = "clearanceStatus";
    clearanceStatus.className = "price-sub";
    clearanceStatus.style.marginTop = "10px";
    clearanceStatus.setAttribute("role", "status");
    clearanceStatus.textContent = "טוען זיהוי מציאון מאתר בנדא...";
    document.querySelector(".search-panel").appendChild(clearanceStatus);
    clearanceResults = document.createElement("section");
    clearanceResults.id = "clearanceResults";
    clearanceResults.className = "results-grid hidden";
    clearanceResults.setAttribute("aria-label", "זיהוי מציאון, ללא השוואת מחירים");
    resultsGrid.before(clearanceResults);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("data/clearance.json", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Clearance source unavailable");
      const payload = await response.json();
      if (!Array.isArray(payload.products) || payload.product_count !== payload.products.length) throw new Error("Invalid clearance data");
      clearanceProducts = payload.products.map((product) => {
        const url = new URL(product.source_url);
        if (url.origin !== "https://www.bendastore.co.il" || !String(product.name).includes("מציאון") || product.label_evidence !== "product_title" || product.is_clearance !== true) throw new Error("Unverified clearance label");
        return buildSearchIndex({ ...product, barcodes: Array.isArray(product.barcodes) ? product.barcodes.map(String) : [], competitors: [] });
      });
      clearanceBySku = new Map();
      clearanceProducts.forEach((product) => { const items = clearanceBySku.get(product._sku) || []; items.push(product); clearanceBySku.set(product._sku, items); });
      clearanceStatus.textContent = `זיהוי מציאון: ${clearanceProducts.length} ${clearanceProducts.length === 1 ? "רישום שסומן" : "רישומים שסומנו"} במפורש באתר בנדא. נבדק: ${payload.source_checked_at ? formatIsraelTime(payload.source_checked_at) : payload.source_checked_on || "לא צוין"}. חיפוש לפי מק״ט או שם; ברקודים יושלמו מהמחירון. `;
      if (!isManagerView && clearanceProducts.length) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "link-btn"; button.style.minHeight = "44px";
        button.textContent = "הצג מציאון";
        button.addEventListener("click", () => { activeCategory = "CLEARANCE"; searchInput.value = ""; onlyCheaperToggle.checked = false; applyFilter(); });
        clearanceStatus.appendChild(button);
      }
    } catch (error) {
      clearanceProducts = []; clearanceBySku = new Map();
      clearanceStatus.textContent = "בדיקת מציאון אינה זמינה כרגע. אין בכך אישור שהפריט אינו מציאון; יש לבדוק באתר בנדא.";
    } finally {
      clearTimeout(timeout);
      if (allProducts.length) applyFilter();
    }
  }

  function renderCard(p) {
    const saleBadge = p.is_on_sale ? `<span class="badge badge-sale">מחיר מבצע</span>` : "";
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
              ${promotionHtml(c.promotion)}
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
          <div class="card-top">${thumbHtml(p.sku, p.name)}<div class="card-top-text">
            <h2 class="card-title">${escapeHtml(p.name)}</h2>
            <div class="card-meta">
              ${skuText ? `<span>${escapeHtml(skuText)}</span>` : ""}
              ${barcodeText ? `<span>${escapeHtml(barcodeText)}</span>` : ""}
              <span>מקור: ${escapeHtml(p.source_name)}</span>
            </div>
          </div></div>
          ${p.source_url ? `<a class="link-btn" href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">דף שלנו ↗</a>` : ""}
        </div>

        ${clearanceCollisionHtml(p)}
        ${supplierPromotionHtml(p)}
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
        ${offer.anomaly_flag ? '<span class="badge badge-check">פער חריג לבדיקה</span>' : ""}
        <small>${escapeHtml(offer.title)}</small>
        ${promotionHtml(offer.promotion)}
        ${offer.anomaly_flag ? `<div class="anomaly-banner">${escapeHtml(offer.anomaly_warning || "פער חריג, יש לוודא התאמת דגם וחבילה לפני שינוי מחיר")}</div>` : ""}
        <small>נבדק: ${escapeHtml(formatIsraelTime(offer.scraped_at))}</small>
      </div>`;
    }).join("");
    return `<article class="card manager-card" data-sku="${escapeHtml(product.sku)}">
      <div class="card-top">${thumbHtml(product.sku, product.name)}<div class="card-top-text"><h2 class="card-title">${escapeHtml(product.name)}</h2>
      <div class="card-meta"><span>מק"ט: <bdi>${escapeHtml(product.sku)}</bdi></span>${product.brand ? `<span>${escapeHtml(product.brand)}</span>` : ""}
        ${(product.barcodes || []).length ? `<span>ברקוד: <bdi>${escapeHtml(product.barcodes.join(", "))}</bdi></span>` : ""}</div></div></div>
      ${clearanceCollisionHtml(product)}
      ${supplierPromotionHtml(product)}
      <div class="manager-prices"><div class="manager-price"><span>המחיר שלנו, כולל מע״מ</span><strong>${formatPreciseILS(product.our_price)}</strong></div>
        <div class="manager-price"><span>רשתות שעוברות את הסינון</span><strong>${new Set(displayedOffers.map((offer) => offer.store_id || offer.store_name)).size}</strong></div></div>
      <div class="manager-offers" aria-label="כל המתחרים המתאימים לסינון">
        <strong>כל המתחרים המתאימים (${displayedOffers.length}/${assessment.eligible.length})</strong>
        <p class="price-sub">כל מתחרה בשורה נפרדת, עם המחיר והפער מולנו. לא רק הזול או היקר ביותר.</p>
        ${offers || '<div class="manager-gap is-clear is-equal">אין השוואה מתאימה בסינון הנוכחי.</div>'}
      </div>
      ${product.source_url ? `<div class="card-footer"><a class="link-btn" href="${escapeHtml(product.source_url)}" target="_blank" rel="noopener">דף המוצר שלנו ↗</a></div>` : ""}
    </article>`;
  }

  function applyManagerFilter() {
    categoryHome.classList.add("hidden");
    categoryChips.classList.add("hidden");
    const rawQuery = searchInput.value.trim();
    const clearanceMatches = renderClearanceQuery(rawQuery);
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
    managerExportItems = filtered;
    updateManagerExport();
    const visible = filtered.slice(0, managerVisibleLimit);
    resultCount.textContent = `מציג ${visible.length} מתוך ${filtered.length} מוצרים${rawQuery ? " בחיפוש בכל הקטלוג" : ""}`;
    resultsGrid.innerHTML = visible.length ? visible.map((item) => renderManagerCard(item.product)).join("") : '<div class="empty-state">לא נמצאו מוצרים לסינון הנוכחי.</div>';
    document.getElementById("managerPagination").classList.toggle("hidden", visible.length >= filtered.length);
    document.getElementById("managerLoadMore").textContent = `הצג עוד ${Math.min(100, filtered.length - visible.length)} מוצרים`;
  }

  function applyFilter() {
    if (isManagerView) { applyManagerFilter(); return; }
    const rawQuery = searchInput.value.trim();
    const clearanceMatches = renderClearanceQuery(rawQuery);
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
    if (!rawQuery && activeCategory === "CLEARANCE") {
      resultCount.textContent = `${clearanceProducts.length} רישומי מציאון, ללא השוואת מחירים`;
      resultsGrid.innerHTML = "";
      return;
    }

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
      ? clearanceMatches ? `נמצאו ${filtered.length} מוצרי קטלוג ו-${clearanceMatches} ${clearanceMatches === 1 ? "רישום מציאון נפרד" : "רישומי מציאון נפרדים"}` : `חיפוש בכל הקטלוג: נמצאו ${filtered.length} תוצאות`
      : `מציג ${filtered.length} מוצרים`;

    if (!filtered.length && clearanceMatches) {
      resultsGrid.innerHTML = "";
      return;
    }
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



  function supplierPromotionHtml(product) {
    const items = product.supplier_promotions || [];
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const regular = product.supplier_regular_price;
    if (!items.length) return '';
    return `<div class="price-sub" style="margin:10px 0;padding:12px;background:#eff6ff;border-radius:9px;color:#1e3a8a">${items.map(p => {
      const live = product.our_price;
      const state = p.state || (p.starts_on && p.starts_on > today ? 'upcoming' : p.ends_on && p.ends_on < today ? 'expired' : 'unverified');
      const label = state === 'upcoming' ? 'מבצע עתידי, טרם באתר (המחיר עכשיו הוא מחיר האתר)' : state === 'expired' ? 'מבצע בנדא הסתיים' : state === 'verified' ? 'מבצע בנדא בתוקף ומאומת באתר' : 'מבצע לפי הקובץ, לא אומת באתר (המחיר שלנו נשאר מחיר האתר)';
      return `<div style="margin-top:8px"><strong>${label}: ${formatPreciseILS(p.price_ils)} כולל מע״מ</strong><div>${p.starts_on ? 'מ-'+escapeHtml(p.starts_on)+' · ' : 'תחילה לא צוינה · '}עד ${escapeHtml(p.ends_on)}</div><div>${escapeHtml(p.source_label)}${p.vat_note ? ' · '+escapeHtml(p.vat_note) : ''}${p.date_note ? ' · '+escapeHtml(p.date_note) : ''}</div></div>`;
    }).join('')}</div>`;
  }
  let productImages = {};
  async function loadProductImages() {
    try { const r = await fetch('product-images.json', {cache:'no-store'}); if (r.ok) productImages = await r.json(); } catch (e) { productImages = {}; }
  }
  function thumbHtml(sku, name) {
    const u = productImages[sku];
    return u ? `<img class="card-thumb" src="${escapeHtml(u)}" alt="${escapeHtml(name || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  }
  async function loadSupplierPromotions() {
    try {
      const response = await fetch('supplier-promotions.json', {cache:'no-store'});
      if (!response.ok) throw new Error('Supplier data unavailable');
      const data = await response.json();
      if (data.schema_version !== 1 || !Array.isArray(data.catalog) || !Array.isArray(data.offers)) throw new Error('Invalid supplier data');
      const products = new Map(allProducts.map(p => [p.sku,p]));
      data.catalog.forEach(r => { const p=products.get(r.our_sku); if(p && Number.isFinite(r.regular_price_ils) && r.regular_price_ils>0) p.supplier_regular_price=r.regular_price_ils; });
      const validDate = v => v === null || typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().slice(0,10)===v;
      data.offers.forEach(r => { const p=products.get(r.our_sku); if(!p || r.verified!==true || !Number.isFinite(r.price_ils) || r.price_ils<=0 || !validDate(r.starts_on) || !validDate(r.ends_on) || !r.ends_on || r.starts_on && r.starts_on>r.ends_on) return; (p.supplier_promotions ||= []).push(r); p.promotion=r; });
      const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      allProducts.forEach(p => {
        const live = p.our_price;
        const offers = p.supplier_promotions || [];
        offers.forEach(r => {
          r.state = r.starts_on && r.starts_on > today ? 'upcoming'
            : r.ends_on < today ? 'expired'
            : (Number.isFinite(live) && live <= r.price_ils + 0.5 ? 'verified' : 'unverified');
        });
        // The live Benda site price (prices.json) is the source of truth for our price. A promo file entry is only a hint.
        if (p.supplier_regular_price && Number.isFinite(live) && live < p.supplier_regular_price - 0.5 && p.is_on_sale) p.regular_price = p.supplier_regular_price;
        p.promotion = offers.find(r => r.state === 'verified');
      });
    } catch(error) {
      const note=document.createElement('div');note.className='price-sub';note.textContent='מידע מבצעי בנדא אינו זמין. המחיר המוצג נשמר, יש לבדוק מול המחירון.';document.querySelector('.search-panel').appendChild(note);
    }
  }

  let promotionInfoStatus = null;
  function promotionText(promotion) {
    if (!promotion || promotion.verified !== true) return "";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const start = promotion.starts_on || "", end = promotion.ends_on || "";
    const label = start && start > today ? "מבצע עתידי" : end && end < today ? "תוקף המבצע שהוצג הסתיים, המחיר דורש בדיקה" : "מבצע ברשת";
    const dates = !start && !end ? "תוקף לא צוין בעמוד המוצר שנבדק" : [start ? `מתאריך ${start}` : "תחילת המבצע לא צוינה", end ? `עד ${end}` : "סיום המבצע לא צוין"].join(" · ");
    return `${label} · ${dates}${promotion.conditions ? ` · ${promotion.conditions}` : ""}`;
  }
  function promotionHtml(promotion) {
    const text = promotionText(promotion);
    if (!text) return "";
    return `<div class="promotion-note price-sub" style="margin-top:8px;color:#854d0e;background:#fffbeb;padding:8px;border-radius:8px"><strong>${escapeHtml(text)}</strong>${promotion.regular_price_ils ? `<div>מחיר רגיל שצוין: ${formatPreciseILS(promotion.regular_price_ils)}</div>` : ""}<div>מידע המבצע נבדק: ${escapeHtml(formatIsraelTime(promotion.checked_at))}</div></div>`;
  }
  async function loadPromotions() {
    if (isManagerView) {
      promotionInfoStatus = document.createElement("div");
      promotionInfoStatus.id = "promotionInfoStatus";
      promotionInfoStatus.className = "price-sub";
      promotionInfoStatus.setAttribute("role", "status");
      document.querySelector(".search-panel").appendChild(promotionInfoStatus);
      promotionInfoStatus.textContent = "טוען מידע על תוקף מבצעים...";
    }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("data/promotions.json", {cache:"no-store", signal:controller.signal});
      if (!response.ok) throw new Error("Promotion data unavailable");
      const payload = await response.json();
      const checked = Date.parse(payload.checked_at), age = Date.now() - checked;
      if (![1, 2].includes(payload.schema_version) || !Array.isArray(payload.offers) || !Array.isArray(payload.checks) || !Number.isFinite(checked) || age < -300000 || age > 36*3600000) throw new Error("Stale or invalid promotion data");
      const lookup = new Map();
      allProducts.forEach(p => (p.competitors || []).forEach(o => lookup.set([p.sku,o.store_id,o.url].join("|"),o)));
      const binding = p => {
        const offer = lookup.get([p.our_sku,p.store_id,p.url || p.product_url].join("|"));
        return offer && Number.isFinite(Number(p.price_ils ?? p.price_vat)) && Math.abs(Number(offer.price)-Number(p.price_ils ?? p.price_vat)) < 0.005 ? offer : null;
      };
      let attached = 0;
      payload.offers.forEach(p => {
        const offer = binding(p);
        const validDate = value => value === null || value === "" || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value);
        const time = Date.parse(p.checked_at);
        if (!offer || p.verified !== true || p.source_url !== offer.url || !validDate(p.starts_on) || !validDate(p.ends_on) || p.starts_on && p.ends_on && p.starts_on > p.ends_on || !Number.isFinite(time) || Date.now()-time > 36*3600000 || time > Date.now()+300000) return;
        if (p.conditions != null && typeof p.conditions !== "string" || p.date_status === "explicit_end_stock_limited" && !String(p.conditions || "").trim()) return;
        if (p.regular_price_ils != null && (!Number.isFinite(Number(p.regular_price_ils)) || Number(p.regular_price_ils) <= Number(offer.price))) return;
        offer.promotion = {...p}; attached++;
      });
      const checkedCount = payload.checks.filter(p => binding(p) && Number.isFinite(Date.parse(p.checked_at)) && Date.now() - Date.parse(p.checked_at) <= 36*3600000 && Date.parse(p.checked_at) <= Date.now()+300000).length;
      if (promotionInfoStatus) promotionInfoStatus.textContent = `מידע תוקף מבצעים: נבדקו ${checkedCount} עמודי הצעות בלבד, לא כל השוק. מספר הצעות המבצע עם מידע המשויך למחיר הנוכחי: ${attached}. תוקף שלא אותר נשאר לא ידוע. עדכון נתוני המבצעים: ${formatIsraelTime(payload.checked_at)}.`;
    } catch (error) {
      if (promotionInfoStatus) promotionInfoStatus.textContent = "מידע תוקף המבצעים אינו זמין או דורש בדיקה מחדש. אין להסיק מכך שאין מבצע. המחירים נשארו ללא שינוי.";
    } finally { clearTimeout(timeout); }
  }

  async function init() {
    try {
      const resp = await fetch("data/prices.json", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();
      feedGeneratedAt = payload.generated_at || "";

      syncMeta.textContent = `סריקה אחרונה: ${formatIsraelTime(payload.generated_at)} • ${payload.product_count} מוצרים`;
      modeBadge.textContent = payload.mode === "sheet" ? "מסונכרן Google Sheets" : payload.mode === "demo" ? "מצב הדגמה" : "מסונכרן";
      renderHealth(payload.stores || []);

      allProducts = (payload.products || []).map(buildSearchIndex);
      await loadPromotions();
      await loadSupplierPromotions();
      await loadProductImages();
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

  initManagerExport();
  initClearance();
  init();
})();
