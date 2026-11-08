import { removeBackground } from "@imgly/background-removal";

// Serialize inference so overlapping clicks reuse the model safely.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, image, publicPath } }) => {
  queue = queue.then(async () => {
    try {
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
