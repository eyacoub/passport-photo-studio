import { message, localizedError } from "./i18n.js";

let worker;
let nextId = 0;
const pending = new Map();
let cachedForeground;

function resetWorker(error) {
  for (const task of pending.values()) task.reject(error);
  pending.clear();
  worker?.terminate();
  worker = undefined;
  cachedForeground = undefined;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./background-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    if (data.progress) {
      const { key, current, total } = data.progress;
      const percent = total > 0 ? message("{value}%", {value: Math.round(current / total * 100)}) : "";
      task.onProgress(key.startsWith("fetch:")
        ? message("Loading local AI model…{percent}", {percent})
        : "Removing background on this device…");
      return;
    }
    if (data.error) {
      // The AI library caches initialization promises, including failures.
      // Restart it so retry can recover from an interrupted model download.
      resetWorker(localizedError("Local background removal failed: {error}. Restart the local app to check its model files, then retry.", {error: data.error}));
    } else {
      pending.delete(data.id);
      task.resolve(data.foreground);
    }
  };
  worker.onerror = () => {
    resetWorker(localizedError("The background-removal worker stopped. Retry in a current browser."));
  };
  return worker;
}

async function createForeground(source, onProgress) {
  const image = await new Promise(resolve => source.toBlob(resolve, "image/png"));
  if (!image) throw localizedError("Could not read the photo. Please upload it again.");
  const activeWorker = getWorker();
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => resetWorker(localizedError("Background processing took too long. Retry with a smaller photo.")), 300_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
      onProgress,
    });
    activeWorker.postMessage({ id, image, publicPath: new URL("./ai/", window.location.href).href });
  });
}

export async function removeBackgroundLocally(source, color, revision, onProgress = () => {}) {
  if (!cachedForeground || cachedForeground.revision !== revision) {
    const promise = createForeground(source, onProgress);
    const entry = { revision, promise };
    cachedForeground = entry;
    promise.catch(() => {
      if (cachedForeground === entry) cachedForeground = undefined;
    });
  }
  // Keep the transparent foreground so color changes don't run AI again.
  const foreground = await cachedForeground.promise;
  const bitmap = await createImageBitmap(foreground);
  try {
    const result = document.createElement("canvas");
    result.width = source.width;
    result.height = source.height;
    const ctx = result.getContext("2d");
    ctx.fillStyle = `#${color}`;
    ctx.fillRect(0, 0, result.width, result.height);
    ctx.drawImage(bitmap, 0, 0, result.width, result.height);
    return result;
  } finally {
    bitmap.close();
  }
}
