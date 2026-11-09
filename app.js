import { initializeLanguage, bindText, bindAttribute, message, localizedError } from "./i18n.js";
import { removeBackgroundLocally } from "./background.js";

/* AI Passport & ID Photo (static, browser-only)
   - Camera capture + local BlazeFace face validation
   - Background removal on this device (IMG.LY + ONNX Runtime)
   - Preserve original colors and texture
   - A4 print sheet generator + JPG/PDF export
*/

(() => {
  "use strict";

  // --- Constants (print) ---
  const MM_PER_INCH = 25.4;
  // Keep the A4 sheet at 300DPI for mobile performance.
  // Render the passport crop at higher DPI for sharper output (then downsample onto the sheet).
  const SHEET_DPI = 300;
  const PHOTO_DPI = 450;
  const A4_MM = { w: 210, h: 297 };
  const PHOTO_SIZES = {
    "35x45": { w: 35, h: 45 },
    "40x40": { w: 40, h: 40 },
    "50x30": { w: 50, h: 30 },
    "120x80": { w: 120, h: 80 },
  };
  const SHEET_LAYOUT = {
    maxCols: 5, // user requested: 5 photos per row
    marginMm: 5,
    gapMm: 1,
  };

  const pxFromMm = (mm, dpi) => Math.round((mm / MM_PER_INCH) * dpi);
  const SHEET_PX = { w: pxFromMm(A4_MM.w, SHEET_DPI), h: pxFromMm(A4_MM.h, SHEET_DPI) };


  const BG_COLORS = { white: "FFFFFF", gray: "D0D0D0" };

  // --- Elements ---
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const video = /** @type {HTMLVideoElement} */ ($("video"));
  const cameraSelect = /** @type {HTMLSelectElement} */ ($("cameraSelect"));
  const btnStart = /** @type {HTMLButtonElement} */ ($("btnStart"));
  const btnStop = /** @type {HTMLButtonElement} */ ($("btnStop"));
  const btnCapture = /** @type {HTMLButtonElement} */ ($("btnCapture"));
  const btnRetake = /** @type {HTMLButtonElement} */ ($("btnRetake"));
  const btnUpload = /** @type {HTMLButtonElement} */ ($("btnUpload"));
  const fileInput = /** @type {HTMLInputElement} */ ($("fileInput"));
  const validationMsg = $("validationMsg");
  const statusPill = $("statusPill");
  const cameraHint = $("cameraHint");

  const qtyInput = /** @type {HTMLInputElement} */ ($("qty"));
  const photoSizeSelect = /** @type {HTMLSelectElement} */ ($("photoSize"));
  const selectedSize = () => PHOTO_SIZES[photoSizeSelect.value];
  const btnDownloadJpg = /** @type {HTMLButtonElement} */ ($("btnDownloadJpg"));
  const btnDownloadPdf = /** @type {HTMLButtonElement} */ ($("btnDownloadPdf"));

  const workCanvas = /** @type {HTMLCanvasElement} */ ($("workCanvas"));
  const maskCanvas = /** @type {HTMLCanvasElement} */ ($("maskCanvas"));
  const photoCanvas = /** @type {HTMLCanvasElement} */ ($("photoCanvas"));
  const sheetCanvasPreview = /** @type {HTMLCanvasElement} */ ($("sheetCanvasPreview"));

  const photoMeta = $("photoMeta");
  const sheetMeta = $("sheetMeta");
  const btnApplyBg = /** @type {HTMLButtonElement} */ ($("btnApplyBg"));

  const btnAddPhoto = $("btnAddPhoto");
  const sheetPeople = $("sheetPeople");
  const sheetMessage = $("sheetMessage");
  const sheetEntries = [];
  let currentPhotoReady = false;
  let photoRevision = 0;
  let backgroundRequest = 0;
  let nextPerson = 1;
  let backgroundBusy = false;

  function invalidateCurrentPhoto() {
    currentPhotoReady = false;
    photoRevision++;
    enable(btnAddPhoto, false);
  }

  // --- State ---
  /** @type {MediaStream | null} */
  let stream = null;
  /** @type {string | null} */
  let activeDeviceId = null;
  let detectionTimer = null;
  let isDetecting = false;
  let lastValidation = { ok: false, reason: "No camera running.", severity: "info" };

  let faceModelLoading = null;

  // Fast detection frame (downscaled) to keep iPhone responsive.
  const detectCanvas = document.createElement("canvas");
  /** @type {number} */
  const DETECT_MAX_W = 360;

  // Keep an unprocessed crop so backgrounds can be re-applied without stacking filters.
  const rawPhotoCanvas = document.createElement("canvas");
  let hasRawPhoto = false;
  // Segment the full frame before the passport crop to retain subject context.
  const backgroundSourceCanvas = document.createElement("canvas");
  let backgroundFace = null;
  let backgroundCrop = null;

  const STORAGE = {
    rawPhoto: "passport_raw_photo_v1",
    bgColor: "passport_bg_color",
  };

  let blazeModel = null;

  // Full-res sheet used for export (A4 @ 300dpi)
  const sheetCanvasFull = document.createElement("canvas");
  sheetCanvasFull.width = SHEET_PX.w;
  sheetCanvasFull.height = SHEET_PX.h;

  // Track last valid quantity so empty typing doesn't "snap" instantly.
  let lastGoodQty = 4;

  // --- UI helpers ---
  function setStatus(text, kind = "info") {
    bindText(statusPill, text);
    const map = {
      info: "rgba(15,23,42,.04)",
      ok: "rgba(22,163,74,.14)",
      warn: "rgba(217,119,6,.14)",
      bad: "rgba(225,29,72,.14)",
    };
    statusPill.style.background = map[kind] || map.info;
    statusPill.style.borderColor =
      kind === "ok"
        ? "rgba(22,163,74,.35)"
        : kind === "warn"
          ? "rgba(217,119,6,.35)"
          : kind === "bad"
            ? "rgba(225,29,72,.35)"
            : "rgba(15,23,42,.12)";
  }

  function setValidation(text, kind = "info") {
    bindText(validationMsg, text);
    bindText($("processingMessage"), text);
    lastValidation = {
      ok: kind === "ok",
      reason: text,
      severity: kind,
    };
    setStatus(kind === "ok" ? "Face OK" : kind === "warn" ? "Adjust" : kind === "bad" ? "Blocked" : "Ready", kind);
  }

  function updateApplyBgUi() {
    if (btnApplyBg) enable(btnApplyBg, hasRawPhoto);
  }

  function getBackgroundColorHex() {
    const radio = document.querySelector('input[name="bgColor"]:checked');
    const v = radio?.getAttribute("value");
    return typeof v === "string" && /^[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : BG_COLORS.white;
  }

  async function restoreRawPhotoFromSession() {
    try {
      const dataUrl = sessionStorage.getItem(STORAGE.rawPhoto);
      if (!dataUrl) return false;

      const img = new Image();
      img.decoding = "async";
      img.src = dataUrl;

      if (img.decode) {
        try {
          await img.decode();
        } catch {
          await new Promise((res, rej) => {
            img.onload = () => res();
            img.onerror = () => rej(localizedError("Failed to load stored photo."));
          });
        }
      } else {
        await new Promise((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(localizedError("Failed to load stored photo."));
        });
      }

      backgroundSourceCanvas.width = img.naturalWidth;
      backgroundSourceCanvas.height = img.naturalHeight;
      backgroundSourceCanvas.getContext("2d").drawImage(img, 0, 0);
      hasRawPhoto = true;
      updatePhotoCrop();
      updateApplyBgUi();
      return true;
    } catch {
      return false;
    }
  }

  function enable(el, on) {
    el.disabled = !on;
  }

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
  }

  // Load a single, locally served face detector. Failed initialization can retry.
  async function initModelsOnce() {
    if (blazeModel) return;
    if (!faceModelLoading) {
      faceModelLoading = (async () => {
        setValidation("Loading face detector from this computer…", "info");
        if (!window.tf || !window.blazeface) throw localizedError("Face detection files are missing. Restart the local app to prepare them.");
        await window.tf.ready();
        blazeModel = await window.blazeface.load({
          modelUrl: new URL("./face/model.json", window.location.href).href,
          maxFaces: 2,
        });
      })();
    }
    try { await faceModelLoading; }
    finally { faceModelLoading = null; }
  }

  function setBackgroundBusy(busy) {
    backgroundBusy = busy;
    enable(btnApplyBg, hasRawPhoto && !busy);
    enable(btnUpload, !busy);
    enable(btnStart, !busy);
    enable(photoSizeSelect, !busy);
    enable(btnRetake, !busy && (hasRawPhoto || !!stream));
    if (busy) enable(btnCapture, false);
    document.querySelectorAll('input[name="bgColor"]').forEach(radio => { radio.disabled = busy; });
    bindText(btnApplyBg, busy ? "Removing background…" : "Apply Background");
  }

  async function applyBackgroundToCurrent() {
    if (backgroundBusy) return;
    if (!hasRawPhoto) {
      setValidation("No photo captured yet. Take Photo first.", "warn");
      return;
    }
    setBackgroundBusy(true);
    currentPhotoReady = false;
    enable(btnAddPhoto, false);
    const revision = photoRevision;
    const request = ++backgroundRequest;
    const bgHex = getBackgroundColorHex();
    const pctx = photoCanvas.getContext("2d", { willReadFrequently: true });
    setStatus("Processing…", "info");
    try {
      setValidation("Removing background on this device…", "info");
      const out = await removeBackgroundLocally(backgroundSourceCanvas, bgHex, revision, (message) => {
        if (revision === photoRevision && request === backgroundRequest) setValidation(message, "info");
      });
      if (revision !== photoRevision || request !== backgroundRequest) return;
      const { width, height } = photoCanvas;
      pctx.fillStyle = "#" + bgHex;
      pctx.fillRect(0, 0, width, height);
      const { sx, sy, sw, sh } = backgroundCrop;
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = "high";
      pctx.drawImage(out, sx, sy, sw, sh, 0, 0, width, height);
      // Preserve original face/clothing pixels: no contrast boost or sharpening.
      afterProcessSuccess({ note: "Background removed locally. Ready to add to your sheet." });
    } catch (e) {
      if (revision !== photoRevision || request !== backgroundRequest) return;
      const msg = e?.userMessage || String(e?.message || e || "Unknown error");
      setValidation(message("Background apply failed: {error}", {error: msg}), "bad");
      setStatus("Blocked", "bad");
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function detectNormFaceBox(source) {
    await initModelsOnce();
    const faces = await blazeModel.estimateFaces(source, false);
    if (!faces.length) return null;
    if (faces.length > 1) return "multiple";
    const [x1, y1] = faces[0].topLeft;
    const [x2, y2] = faces[0].bottomRight;
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    return { xCenter: (x1 + x2) / 2 / width, yCenter: (y1 + y2) / 2 / height,
      width: (x2 - x1) / width, height: (y2 - y1) / height, xmin: x1 / width, ymin: y1 / height };
  }

  function drawDetectFrameFromVideo() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, DETECT_MAX_W / vw);
    const w = Math.max(160, Math.round(vw * scale));
    const h = Math.max(160, Math.round(vh * scale));
    if (detectCanvas.width !== w) detectCanvas.width = w;
    if (detectCanvas.height !== h) detectCanvas.height = h;

    const ctx = detectCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    return detectCanvas;
  }

  // --- Camera ---
  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    cameraSelect.innerHTML = "";
    if (cams.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      bindText(opt, "No camera found");
      cameraSelect.appendChild(opt);
      enable(cameraSelect, false);
      return;
    }
    enable(cameraSelect, true);
    for (const cam of cams) {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      bindText(opt, cam.label || message("Camera ({id}…)", {id: cam.deviceId.slice(0, 6)}));
      cameraSelect.appendChild(opt);
    }
    if (activeDeviceId && cams.some((c) => c.deviceId === activeDeviceId)) {
      cameraSelect.value = activeDeviceId;
    }
  }

  function stopCamera() {
    if (detectionTimer) {
      clearInterval(detectionTimer);
      detectionTimer = null;
    }
    isDetecting = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    activeDeviceId = null;
    enable(btnStop, false);
    enable(btnCapture, false);
    enable(btnRetake, false);
    setValidation("No camera running.", "info");
    bindText(cameraHint, "Start camera to begin.");
  }

  async function startCamera(deviceId) {
    stopCamera();
    await initModelsOnce();

    setStatus("Starting camera…", "info");
    bindText(cameraHint, "Starting…");

    const constraints = {
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings?.() || {};
    activeDeviceId = settings.deviceId || deviceId || null;

    enable(btnStop, true);
    enable(btnRetake, true);

    // Refresh device labels after permission is granted
    try {
      await listCameras();
    } catch {
      // ignore
    }

    bindText(cameraHint, "Face detection running…");
    setValidation("Detecting face…", "info");

    detectionTimer = setInterval(() => {
      void validateLive();
    }, 220);
  }

  // --- Face detection / validation ---
  function validateFromNormBox(bb) {
    if (bb === "multiple") {
      return { ok: false, kind: "bad", msg: "Multiple faces detected. Only one person must be in frame." };
    }
    if (!bb) {
      return { ok: false, kind: "bad", msg: "No face detected. Please face the camera." };
    }

    const xOff = Math.abs(bb.xCenter - 0.5);
    const yOff = Math.abs(bb.yCenter - 0.45); // slightly above center is typical for head framing
    const faceH = bb.height;

    // Distance heuristics use the face height in the source frame.
    const TOO_FAR = 0.18;
    const TOO_CLOSE = 0.58;

    if (faceH < TOO_FAR) return { ok: false, kind: "warn", msg: "Face too far. Move closer to the camera." };
    if (faceH > TOO_CLOSE) return { ok: false, kind: "warn", msg: "Face too close. Move back slightly." };
    if (xOff > 0.14 || yOff > 0.20) return { ok: false, kind: "warn", msg: "Center your face inside the guide." };

    return { ok: true, kind: "ok", msg: "Face detected and correctly sized. You can take the photo." };
  }

  async function validateLive() {
    if (!stream) return;
    if (isDetecting) return;
    if (!video.videoWidth || !video.videoHeight) return;
    isDetecting = true;
    try {
      const frame = drawDetectFrameFromVideo() || video;
      const bb = await detectNormFaceBox(frame);
      if (!stream) return;

      const v = validateFromNormBox(bb);
      setValidation(v.msg, v.kind);
      enable(btnCapture, v.ok);
    } catch (e) {
      enable(btnCapture, false);
      setValidation(message("Face detection error. {error}", {error: e?.userMessage || e?.message || ""}), "bad");
    } finally {
      isDetecting = false;
    }
  }

  // --- Crop logic (auto, face-centered) ---
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function parseQtyLenient() {
    const s = String(qtyInput?.value ?? "").trim();
    if (!s) return null; // allow empty while typing
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  function normalizeQtyInInput() {
    const n = parseQtyLenient();
    const q = clamp(n ?? lastGoodQty, 1, Number(qtyInput.max));
    lastGoodQty = q;
    if (qtyInput) qtyInput.value = String(q);
    return q;
  }

  function computeCropRectFromFace(normFaceBox, srcW, srcH, aspect) {
    // Estimate crop height based on face box (bbox is roughly face region).
    // For passport photos, face region should occupy ~55% of photo height (heuristic).
    const desiredFaceFrac = 0.55;
    let cropH = (normFaceBox.height * srcH) / desiredFaceFrac;
    cropH = clamp(cropH, srcH * 0.45, srcH * 0.98);
    let cropW = cropH * aspect;
    if (cropW > srcW) {
      cropW = srcW;
      cropH = cropW / aspect;
    }

    const cx = normFaceBox.xCenter * srcW;
    const cy = normFaceBox.yCenter * srcH;

    // Shift up slightly so chin isn't too low
    const cyShifted = cy - cropH * 0.08;

    let sx = cx - cropW / 2;
    let sy = cyShifted - cropH / 2;

    sx = clamp(sx, 0, srcW - cropW);
    sy = clamp(sy, 0, srcH - cropH);

    return { sx, sy, sw: cropW, sh: cropH };
  }

  function updatePhotoCrop() {
    const { w, h } = selectedSize();
    const width = pxFromMm(w, PHOTO_DPI);
    const height = pxFromMm(h, PHOTO_DPI);
    photoCanvas.width = width;
    photoCanvas.height = height;
    if (!hasRawPhoto) return;

    const { width: srcW, height: srcH } = backgroundSourceCanvas;
    const aspect = w / h;
    if (backgroundFace) {
      backgroundCrop = computeCropRectFromFace(backgroundFace, srcW, srcH, aspect);
    } else {
      // A restored session only has the previously cropped image.
      const sw = Math.min(srcW, srcH * aspect);
      const sh = Math.min(srcH, srcW / aspect);
      backgroundCrop = { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
    }

    rawPhotoCanvas.width = width;
    rawPhotoCanvas.height = height;
    const rctx = rawPhotoCanvas.getContext("2d");
    rctx.imageSmoothingQuality = "high";
    const { sx, sy, sw, sh } = backgroundCrop;
    rctx.drawImage(backgroundSourceCanvas, sx, sy, sw, sh, 0, 0, width, height);
    photoCanvas.getContext("2d").drawImage(rawPhotoCanvas, 0, 0);
    bindText(photoMeta, message("{width}×{height}mm • {pxWidth}×{pxHeight}px @ {dpi}DPI", {
      width: w, height: h, pxWidth: width, pxHeight: height, dpi: PHOTO_DPI,
    }));
  }

  // --- Capture -> Process ---
  async function captureAndProcess() {
    if (!stream) return;
    if (!lastValidation.ok) {
      setValidation("Capture blocked. Fix the validation message first.", "bad");
      return;
    }

    // Pause live validation while processing
    if (detectionTimer) {
      clearInterval(detectionTimer);
      detectionTimer = null;
    }
    enable(btnCapture, false);
    setStatus("Processing…", "info");
    setValidation("Processing photo… (local background removal)", "info");

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) {
      setValidation("Camera not ready. Try again.", "bad");
      return;
    }

    workCanvas.width = srcW;
    workCanvas.height = srcH;
    const wctx = workCanvas.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(video, 0, 0, srcW, srcH);
    await processSourceCanvas(workCanvas);
  }

  async function processSourceCanvas(srcCanvas) {
    invalidateCurrentPhoto();
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;

    // Detect face (required for correct crop)
    const bb = await detectNormFaceBox(srcCanvas);

    const v = validateFromNormBox(bb);
    if (!v.ok) {
      setValidation(message("Blocked: {reason}", {reason: v.msg}), v.kind === "warn" ? "warn" : "bad");
      // Resume live validation only if camera is running
      if (stream && !detectionTimer) detectionTimer = setInterval(() => void validateLive(), 240);
      return;
    }

    backgroundSourceCanvas.width = srcW;
    backgroundSourceCanvas.height = srcH;
    backgroundSourceCanvas.getContext("2d").drawImage(srcCanvas, 0, 0);
    backgroundFace = bb;
    hasRawPhoto = true;
    updatePhotoCrop();
    updateApplyBgUi();

    // Persist RAW in this browser session so Apply Background remains clickable
    try {
      const dataUrl = rawPhotoCanvas.toDataURL("image/jpeg", 0.95);
      sessionStorage.setItem(STORAGE.rawPhoto, dataUrl);
    } catch {
      // ignore
    }

    await applyBackgroundToCurrent();
  }

  function afterProcessSuccess({ note }) {
    setValidation(message("Done. {note}", {note}), "ok");
    enable(qtyInput, true);
    currentPhotoReady = true;
    enable(btnAddPhoto, true);
    renderSheetAll();
  }

  // --- Sheet generation ---
  function columnsForSize(size) {
    const { marginMm, gapMm, maxCols } = SHEET_LAYOUT;
    return Math.min(maxCols, Math.floor((A4_MM.w - 2 * marginMm + gapMm) / (size.w + gapMm)));
  }

  function sheetRows(entries) {
    // Group equal sizes into rows to keep horizontal cuts straight.
    const groups = new Map();
    for (const { size, canvas, copies } of entries) {
      if (!groups.has(size)) groups.set(size, []);
      const photos = groups.get(size);
      for (let i = 0; i < copies; i++) photos.push(canvas);
    }

    const rows = [];
    for (const [size, photos] of groups) {
      const cols = columnsForSize(size);
      for (let i = 0; i < photos.length; i += cols) {
        rows.push({ size, photos: photos.slice(i, i + cols) });
      }
    }
    return rows;
  }

  function remainingCopies(size, rows) {
    const { marginMm, gapMm } = SHEET_LAYOUT;
    const usedHeight = rows.reduce((height, row) => height + row.size.h + gapMm, 0);
    const freeHeight = A4_MM.h - 2 * marginMm + gapMm - usedHeight;
    const cols = columnsForSize(size);
    const openSlots = rows.reduce((slots, row) =>
      row.size === size ? slots + cols - row.photos.length : slots, 0);
    return openSlots + cols * Math.floor(freeHeight / (size.h + gapMm));
  }

  function renderSheet(targetCanvas, rows) {
    const ctx = targetCanvas.getContext("2d");
    const { width, height } = targetCanvas;
    const pxPerMmX = width / A4_MM.w;
    const pxPerMmY = height / A4_MM.h;
    const { marginMm, gapMm } = SHEET_LAYOUT;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.18)";

    let y = marginMm;
    for (const { size, photos } of rows) {
      for (const [col, photo] of photos.entries()) {
        const x = marginMm + col * (size.w + gapMm);
        const bounds = [x * pxPerMmX, y * pxPerMmY, size.w * pxPerMmX, size.h * pxPerMmY];
        ctx.drawImage(photo, ...bounds);
        ctx.strokeRect(...bounds);
      }
      y += size.h + gapMm;
    }
  }

  function sheetPhotoCount() {
    return sheetEntries.reduce((count, entry) => count + entry.copies, 0);
  }

  function renderSheetAll() {
    const rows = sheetRows(sheetEntries);
    const count = sheetPhotoCount();
    renderSheet(sheetCanvasFull, rows);
    renderSheet(sheetCanvasPreview, rows);
    const size = rows[0]?.size ?? selectedSize();
    const people = sheetEntries.length;
    bindText(sheetMeta, rows.every(row => row.size === size)
      ? message("A4 • {people} people • {photos}/{max} photos • {width}×{height}mm", {
        people, photos: count, max: remainingCopies(size, []), width: size.w, height: size.h,
      })
      : message("A4 • {people} people • {photos} photos", { people, photos: count }));
    enable(btnDownloadJpg, count > 0);
    enable(btnDownloadPdf, count > 0);
  }

  function renderPeople() {
    sheetPeople.replaceChildren();
    for (const entry of sheetEntries) {
      const row = document.createElement("div");
      row.className = "sheetPerson";
      const thumbnail = document.createElement("img");
      thumbnail.src = entry.canvas.toDataURL("image/png");
      bindAttribute(thumbnail, "alt", message("Person {id}", {id: entry.id}));
      const label = document.createElement("label");
      const personLabel = document.createElement("span");
      bindText(personLabel, message("Person {id} copies ({width}×{height}mm)", {
        id: entry.id, width: entry.size.w, height: entry.size.h,
      }));
      label.appendChild(personLabel);
      const input = document.createElement("input");
      input.type = "number";
      input.className = "input";
      input.min = "1";
      const available = remainingCopies(entry.size, sheetRows(sheetEntries.filter(other => other !== entry)));
      input.max = String(available);
      input.value = String(entry.copies);
      const update = document.createElement("button");
      update.type = "button";
      update.className = "btn btn--primary";
      bindText(update, "Update copies");
      update.addEventListener("click", () => {
        const n = Number(input.value);
        entry.copies = Number.isFinite(n) ? clamp(Math.trunc(n), 1, available) : entry.copies;
        bindText(sheetMessage, "Copy count updated.");
        renderPeople();
      });
      label.appendChild(input);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--ghost";
      bindText(remove, "Remove");
      remove.addEventListener("click", () => {
        sheetEntries.splice(sheetEntries.indexOf(entry), 1);
        bindText(sheetMessage, message("Person {id} removed.", {id: entry.id}));
        renderPeople();
      });
      row.append(thumbnail, label, update, remove);
      sheetPeople.appendChild(row);
    }
    renderSheetAll();
  }

  function addCurrentPhoto() {
    if (!currentPhotoReady) return;
    const copies = normalizeQtyInInput();
    const size = selectedSize();
    const remaining = remainingCopies(size, sheetRows(sheetEntries));
    if (copies > remaining) {
      bindText(sheetMessage, message("Not enough room. Only {remaining} spaces remain. Reduce copies or remove photos.", {remaining}));
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = photoCanvas.width;
    canvas.height = photoCanvas.height;
    canvas.getContext("2d").drawImage(photoCanvas, 0, 0);
    sheetEntries.push({ id: nextPerson++, canvas, copies, size });
    bindText(sheetMessage, "Photo added. Upload or capture the next person to continue.");
    renderPeople();
  }

  // --- Download helpers ---
  const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let useDirectDownload = !isAppleMobile;

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function exportSheet(format) {
    const qty = sheetPhotoCount();
    if (!qty) return;
    const exportMessage = $("exportMessage");
    bindText(exportMessage, "");
    try {
      renderSheetAll();
      const name = `passport_sheet_${nowStamp()}_x${qty}.${format}`;
      let dataUrl = sheetCanvasFull.toDataURL("image/jpeg", 0.95);
      const type = format === "pdf" ? "application/pdf" : "image/jpeg";
      if (format === "pdf") {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        pdf.addImage(dataUrl, "JPEG", 0, 0, A4_MM.w, A4_MM.h, undefined, "FAST");
        // jsPDF's save() navigates to a blob URL, which can fail in Safari.
        dataUrl = pdf.output("datauristring", { filename: name });
      }

      if (!useDirectDownload && navigator.share && navigator.canShare) {
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
        const files = [new File([bytes], name, { type })];
        if (navigator.canShare({ files })) {
          try {
            await navigator.share({ files });
          } catch (error) {
            if (error.name !== "AbortError") {
              useDirectDownload = true;
              bindText(exportMessage, "Couldn’t open the share sheet. Tap Download again to save directly.");
            }
          }
          return;
        }
      }

      downloadDataUrl(dataUrl, name);
    } catch {
      bindText(exportMessage, "Couldn’t prepare the print sheet. Tap Download to try again.");
    }
  }

  // --- Wire up events ---
  async function boot() {
    initializeLanguage();
    for (const option of photoSizeSelect.options) {
      const { w, h } = PHOTO_SIZES[option.value];
      bindText(option, message("{width} × {height} mm", { width: w, height: h }));
    }
    // Remove the old saved API key and restore the background color.
    try {
      localStorage.removeItem("passport_removebg_key");

      const savedBgColor = localStorage.getItem(STORAGE.bgColor);
      if (savedBgColor) {
        const radio = document.querySelector(`input[name="bgColor"][value="${savedBgColor}"]`);
        if (radio) radio.checked = true;
      }
    } catch {
      // ignore
    }
    updateApplyBgUi();

    setStatus("Ready", "info");
    function updatePhotoSize() {
      const { w, h } = selectedSize();
      document.querySelector(".overlay__frame").style.setProperty("--photo-ratio", `${w} / ${h}`);
      qtyInput.max = String(remainingCopies(selectedSize(), []));
      normalizeQtyInInput();
      updatePhotoCrop();
    }
    updatePhotoSize();

    // Restore last captured photo (if any) so Apply Background is clickable after refresh.
    await restoreRawPhotoFromSession();

    // Device enumeration must not delay attaching the upload controls.
    void listCameras().catch(() => {});

    btnStart.addEventListener("click", async () => {
      try {
        const id = cameraSelect.value || null;
        enable(btnStart, false);
        await startCamera(id);
        enable(btnStart, true);
      } catch (e) {
        enable(btnStart, true);
        setValidation(message("Camera error: {error}", {error: e?.userMessage || e?.message || "Unable to start camera."}), "bad");
        setStatus("Blocked", "bad");
        bindText(cameraHint, "Camera blocked or unavailable.");
      }
    });

    btnStop.addEventListener("click", () => stopCamera());

    btnCapture.addEventListener("click", () => {
      void captureAndProcess();
    });

    btnRetake.addEventListener("click", () => {
      // Clear the working photo; keep photos already added to the sheet.
      invalidateCurrentPhoto();
      enable(qtyInput, false);
      bindText(photoMeta, "—");
      renderSheetAll();
      hasRawPhoto = false;
      updatePhotoCrop();
      updateApplyBgUi();
      try {
        sessionStorage.removeItem(STORAGE.rawPhoto);
      } catch {
        // ignore
      }
      if (stream) {
        setValidation("Detecting face…", "info");
        if (!detectionTimer) detectionTimer = setInterval(() => void validateLive(), 240);
      } else {
        setValidation("Cleared. Upload an image or start camera.", "info");
      }
    });

    if (btnApplyBg) {
      btnApplyBg.addEventListener("click", () => {
        void applyBackgroundToCurrent();
      });
    }

    if (btnUpload && fileInput) {
      btnUpload.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        invalidateCurrentPhoto();
        setStatus("Processing…", "info");
        setValidation("Loading image…", "info");

        // Stop camera to avoid confusion
        stopCamera();
        setValidation("Loading your image and face detector…", "info");
        enable(btnRetake, true);

        try {
          let bmp;
          try {
            bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
          } catch {
            bmp = await createImageBitmap(file);
          }

          // Scale to a safe working size (keep quality, avoid memory spikes)
          const maxSide = 2200;
          const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
          const w = Math.max(1, Math.round(bmp.width * scale));
          const h = Math.max(1, Math.round(bmp.height * scale));

          workCanvas.width = w;
          workCanvas.height = h;
          const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(bmp, 0, 0, w, h);

          await initModelsOnce();
          await processSourceCanvas(workCanvas);
        } catch (e) {
          const msg = e?.userMessage || String(e?.message || e || "Upload failed");
          setValidation(message("Upload failed: {error}", {error: msg}), "bad");
          setStatus("Blocked", "bad");
        } finally {
          // allow uploading same file again
          fileInput.value = "";
        }
      });
    }

    document.querySelectorAll('input[name="bgColor"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        try {
          localStorage.setItem(STORAGE.bgColor, getBackgroundColorHex());
        } catch {
          // ignore
        }
        if (hasRawPhoto) void applyBackgroundToCurrent();
      });
    });
    cameraSelect.addEventListener("change", async () => {
      if (!stream) return;
      try {
        await startCamera(cameraSelect.value);
      } catch (e) {
        setValidation(message("Camera switch error: {error}", {error: e?.userMessage || e?.message || ""}), "bad");
      }
    });

    qtyInput.addEventListener("change", normalizeQtyInInput);
    qtyInput.addEventListener("blur", normalizeQtyInInput);
    photoSizeSelect.addEventListener("change", () => {
      const wasReady = currentPhotoReady;
      updatePhotoSize();
      if (wasReady) void applyBackgroundToCurrent();
      renderSheetAll();
    });
    btnAddPhoto.addEventListener("click", addCurrentPhoto);
    renderSheetAll();
    btnDownloadJpg.addEventListener("click", () => void exportSheet("jpg"));
    btnDownloadPdf.addEventListener("click", () => void exportSheet("pdf"));

    enable(btnUpload, true);

    // Stop camera on page hide (mobile reliability)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" && stream) stopCamera();
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
})();

