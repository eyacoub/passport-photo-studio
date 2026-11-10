import { removeBackground } from "@imgly/background-removal";

const modelCacheName = "passport-ai-chunks-v1";
const networkFetch = self.fetch.bind(self);
let modelDirectory;
let modelCache;
let activeId;
let modelReady = false;
let downloadedBytes = 0;
let reportedMegabytes = -1;
let activeDownloads = 0;
const downloadQueue = [];

function reportDownload(bytes) {
  downloadedBytes += bytes;
  const megabytes = Math.floor(downloadedBytes / 1_000_000);
  if (megabytes === reportedMegabytes) return;
  reportedMegabytes = megabytes;
  self.postMessage({ id: activeId, progress: { key: "download", megabytes } });
}

async function downloadChunk(input, options, cache) {
  // Limit simultaneous network reads and reuse any existing HTTP-cached copy.
  if (activeDownloads >= 6) await new Promise(resolve => downloadQueue.push(resolve));
  else activeDownloads++;
  try {
    const response = await networkFetch(input, { ...options, cache: "force-cache" });
    if (response.status !== 200) throw new Error(`AI file download failed (HTTP ${response.status})`);

    const reader = response.body?.getReader();
    const parts = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        reportDownload(value.byteLength);
      }
    }
    // Keep the browser's network stream single-consumer. Inference and cache
    // storage each read the completed blob instead of teeing the live stream.
    const blob = reader ? new Blob(parts) : await response.blob();
    if (!reader) reportDownload(blob.size);
    if (cache && blob.size) void cache.put(input, new Response(blob)).catch(() => {});
    return new Response(blob);
  } finally {
    const next = downloadQueue.shift();
    if (next) next();
    else activeDownloads--;
  }
}

// IMG.LY fetches the model in this worker. Cache only immutable AI chunks;
// the manifest still comes from the site so updates can select new hashes.
self.fetch = async (input, options) => {
  if (!modelDirectory || typeof input !== "string" || !input.startsWith(modelDirectory)
    || !/^[a-f0-9]{64}$/.test(input.slice(modelDirectory.length))) {
    return networkFetch(input, options);
  }

  modelCache ??= self.caches?.open(modelCacheName).catch(() => null);
  const cache = await modelCache;
  const cached = await cache?.match(input, { ignoreVary: true }).catch(() => null);
  if (cached) return cached;

  return downloadChunk(input, options, cache);
};

// Serialize inference so overlapping clicks reuse the model safely.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, image, publicPath } }) => {
  queue = queue.then(async () => {
    try {
      modelDirectory = publicPath;
      activeId = id;
      if (!modelReady) self.postMessage({ id, progress: { key: "model" } });
      const foreground = await removeBackground(image, {
        // Use the higher-quality model; the small quantized model loses fine edges.
        model: "isnet_fp16",
        publicPath,
        device: "cpu",
        output: { format: "image/png" },
        progress: key => {
          if (key.startsWith("compute:")) {
            modelReady = true;
            self.postMessage({ id: activeId, progress: { key: "compute" } });
          }
        },
      });
      self.postMessage({ id, foreground });
    } catch (error) {
      self.postMessage({ id, error: String(error?.message || error) });
    }
  });
};
