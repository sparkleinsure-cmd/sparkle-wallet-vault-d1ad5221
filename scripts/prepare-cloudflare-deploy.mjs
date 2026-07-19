import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicIndexPath = path.join(rootDir, ".output", "public", "index.html");
const workerEntryPath = path.join(rootDir, ".output", "server", "index.mjs");

// Nitro treats index.html as a public asset by default. For the Cloudflare
// Worker this would bypass TanStack Start's SSR handler and serve the empty
// static Capacitor shell instead.
fs.rmSync(publicIndexPath, { force: true });

const workerEntry = fs.readFileSync(workerEntryPath, "utf8");
const indexAssetPattern = /\t"\/index\.html": \{[\s\S]*?\n\t\},\n/;
const preparedWorkerEntry = workerEntry.replace(indexAssetPattern, "");

if (preparedWorkerEntry === workerEntry) {
  throw new Error("Could not remove index.html from Nitro's Cloudflare public-asset manifest.");
}

fs.writeFileSync(workerEntryPath, preparedWorkerEntry);
