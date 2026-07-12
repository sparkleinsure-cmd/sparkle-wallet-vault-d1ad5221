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

const indexHtmlPath = path.join(targetDir, "index.html");
if (!fs.existsSync(indexHtmlPath)) {
  const assetsDir = path.join(targetDir, "assets");
  const jsFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((file) => file.endsWith(".js")).sort()
    : [];
  const cssFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((file) => file.endsWith(".css")).sort()
    : [];

  const entryJs =
    jsFiles.find((file) => /^index-.*\.js$/.test(file)) ||
    jsFiles.find((file) => /^app-.*\.js$/.test(file)) ||
    jsFiles[0] ||
    null;

  const entryCss =
    cssFiles.find((file) => /^styles-.*\.css$/.test(file)) ||
    cssFiles.find((file) => /^app-.*\.css$/.test(file)) ||
    cssFiles[0] ||
    null;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#ffffff" />
    ${entryCss ? `<link rel="stylesheet" href="/assets/${entryCss}" />` : ""}
  </head>
  <body>
    <div id="root"></div>
    ${entryJs ? `<script type="module" src="/assets/${entryJs}"></script>` : ""}
  </body>
</html>
`;

  fs.writeFileSync(indexHtmlPath, html);
  console.log(`Created ${indexHtmlPath}`);
} else {
  console.log(`Found existing ${indexHtmlPath}`);
}