import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(projectRoot, "node_modules/@mediapipe/tasks-vision/wasm");
const targetRoot = resolve(projectRoot, "public/mediapipe/wasm");
const assets = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

await mkdir(targetRoot, { recursive: true });
await Promise.all(
  assets.map((asset) => copyFile(resolve(sourceRoot, asset), resolve(targetRoot, asset))),
);
