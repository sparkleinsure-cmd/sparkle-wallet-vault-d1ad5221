import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, ".output", "public");
const targetDir = path.join(rootDir, "dist");

if (!fs.existsSync(sourceDir)) {
  console.warn(`No build output found at ${sourceDir}`);
  process.exit(0);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

const copyRecursive = (src, dest) => {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

copyRecursive(sourceDir, targetDir);
console.log(`Copied ${sourceDir} -> ${targetDir}`);