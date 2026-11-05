// Builds the mobile web app into dist/web: web/ plus the shared
// src/formulary.js, with a build id stamped into the service worker.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "dist", "web");
const buildId = process.env.GITHUB_SHA?.slice(0, 12) || Date.now().toString(36);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(join(root, "web"), outDir, { recursive: true });
await cp(join(root, "src", "formulary.js"), join(outDir, "formulary.js"));

const swPath = join(outDir, "sw.js");
await writeFile(swPath, (await readFile(swPath, "utf8")).replaceAll("__BUILD__", buildId));

console.log(`Built ${outDir} (${buildId})`);
