(function () {
  let html5QrCode = null;
  let isScanning = false;

  async function startScanner(onDetected) {
    const modal = document.getElementById("scannerModal");
    const statusEl = document.getElementById("scannerStatus");
    modal.classList.remove("hidden");

    if (typeof Html5Qrcode === "undefined") {
      statusEl.textContent = "ספריית הסריקה לא נטענה — בדוק חיבור לאינטרנט.";
      return;
    }

    if (!window.isSecureContext) {
      statusEl.textContent = "מצלמה דורשת חיבור מאובטח (HTTPS / GitHub Pages).";
      return;
    }

    try {
      statusEl.textContent = "מפעיל מצלמה אחורית...";
      html5QrCode = new Html5Qrcode("qrReader");
      const formats = [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.EAN_8,
      ];

      isScanning = true;
      await html5QrCode.start(
        { facingMode: "environment" },
        {
          fps: 12,
          qrbox: { width: 280, height: 130 },
          formatsToSupport: formats,
        },
        (decodedText) => {
          if (navigator.vibrate) navigator.vibrate(60);
          stopScanner();
          onDetected(decodedText);
        },
        () => {}
      );
      statusEl.textContent = "כוון את המצלמה אל הברקוד (EAN-13 / UPC-A / Code-128)";
    } catch (err) {
      statusEl.textContent = "לא ניתן לפתוח מצלמה — אשר הרשאת מצלמה בדפדפן.";
      isScanning = false;
    }
  }

  async function stopScanner() {
    const modal = document.getElementById("scannerModal");
    modal.classList.add("hidden");
    if (html5QrCode && isScanning) {
      try {
        await html5QrCode.stop();
        html5QrCode.clear();
      } catch (_) {}
    }
    isScanning = false;
  }

  window.BarcodeScanner = { startScanner, stopScanner };
})();
