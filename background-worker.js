import { removeBackground } from "@imgly/background-removal";

const modelCacheName = "passport-ai-chunks-v1";
const networkFetch = self.fetch.bind(self);
let modelDirectory;
let modelCache;

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

  const response = await networkFetch(input, options);
  if (cache && response.status === 200) {
    void cache.put(input, response.clone()).catch(() => {});
  }
  return response;
};

// Serialize inference so overlapping clicks reuse the model safely.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, image, publicPath } }) => {
  queue = queue.then(async () => {
    try {
      modelDirectory = publicPath;
      const foreground = await removeBackground(image, {
        // Use the higher-quality model; the small quantized model loses fine edges.
        model: "isnet_fp16",
        publicPath,
        device: "cpu",
        output: { format: "image/png" },
        progress: (key, current, total) => {
          self.postMessage({ id, progress: { key, current, total } });
        },
      });
      self.postMessage({ id, foreground });
    } catch (error) {
      self.postMessage({ id, error: String(error?.message || error) });
    }
  });
};
