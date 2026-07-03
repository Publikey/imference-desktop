// Patches wails.json's info.productVersion from a tag passed as arg 1.
// Cross-platform (runs on the Windows / macOS / Ubuntu CI runners via Node).
// Usage: node scripts/set-version.mjs v1.2.3   ->   productVersion "1.2.3"
import { readFileSync, writeFileSync } from "node:fs";

const raw = process.argv[2] || "0.0.0";
const version = raw.replace(/^v/, ""); // strip a leading "v" from the git tag
const path = "wails.json";

const cfg = JSON.parse(readFileSync(path, "utf8"));
cfg.info = { ...(cfg.info || {}), productVersion: version };
writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");

console.log(`wails.json info.productVersion -> ${version}`);
