import { mkdir, readFile, writeFile, rename, stat, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const aiBase = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
async function download(url, relative, hash) {
  const path = resolve(root, "public", relative);
  try {
    if ((await stat(path)).size > 0 && (!hash || createHash("sha256").update(await readFile(path)).digest("hex") === hash)) return;
  } catch {}
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash && createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Checksum mismatch");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.part`, bytes);
      await rename(`${path}.part`, path);
      console.log(`Ready: ${relative}`);
      return;
    } catch (error) {
      if (attempt === 3) throw new Error(`Could not prepare ${relative}: ${error.message}`);
    }
  }
}

await download(`${aiBase}resources.json`, "ai/resources.json");
const resources = JSON.parse(await readFile(resolve(root, "public/ai/resources.json")));
const keys = ["/models/isnet_fp16", "/onnxruntime-web/ort-wasm-simd-threaded.mjs", "/onnxruntime-web/ort-wasm-simd-threaded.wasm"];
const chunks = keys.flatMap(key => {
  if (!resources[key]) throw new Error(`Missing resource ${key}`);
  return resources[key].chunks;
});
for (const chunk of chunks) {
  if (!/^[a-f0-9]{64}$/.test(chunk.hash) || chunk.name !== chunk.hash) {
    throw new Error("Unexpected model asset name");
  }
}
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < chunks.length) {
    const chunk = chunks[cursor++];
    await download(new URL(chunk.name, aiBase), `ai/${chunk.name}`, chunk.hash);
  }
}));

await Promise.all([
  download("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js", "vendor/tf.min.js"),
  download("https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.umd.js", "vendor/blazeface.min.js"),
  download("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js", "vendor/jspdf.umd.min.js"),
]);
console.log("Local background model and libraries are ready.");

const faceBase = "https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1/";
await download(`${faceBase}model.json?tfjs-format=file`, "face/model.json");
const face = JSON.parse(await readFile(resolve(root, "public/face/model.json")));
for (const path of face.weightsManifest.flatMap(group => group.paths)) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(path)) throw new Error("Unexpected model weight filename");
  await download(`${faceBase}${path}?tfjs-format=file`, `face/${path}`);
}
console.log("Local face detection is ready.");

await copyFile(resolve(root, "node_modules/coi-serviceworker/coi-serviceworker.js"), resolve(root, "public/coi-serviceworker.js"));
await mkdir(resolve(root, "public/licenses"), { recursive: true });
await copyFile(resolve(root, "node_modules/coi-serviceworker/LICENSE"), resolve(root, "public/licenses/coi-serviceworker-MIT.txt"));
await copyFile(resolve(root, "node_modules/@imgly/background-removal/LICENSE.md"), resolve(root, "public/licenses/background-removal-AGPL-3.0.txt"));
