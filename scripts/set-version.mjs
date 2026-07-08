// Patches build/config.yml's info.version from a tag passed as arg 1.
// Cross-platform (runs on the Windows / macOS / Ubuntu CI runners via Node).
// Usage: node scripts/set-version.mjs v1.2.3   ->   info.version "1.2.3"
//
// Wails v3 keeps the packaged-app version in build/config.yml (info.version);
// the in-app main.Version string is injected separately at build time via
// `wails3 build -ldflags "-X main.Version=<tag>"`.
import { readFileSync, writeFileSync } from "node:fs";

const raw = process.argv[2] || "0.0.0";
const version = raw.replace(/^v/, ""); // strip a leading "v" from the git tag
const path = "build/config.yml";

const src = readFileSync(path, "utf8");
// Replace the `version: "..."` line inside the top-level `info:` block. The
// trailing comment after the value is preserved.
const next = src.replace(/^(\s*version:\s*)"[^"]*"/m, `$1"${version}"`);
if (next === src) {
  console.error(`set-version: could not find an info.version line in ${path}`);
  process.exit(1);
}
writeFileSync(path, next);

console.log(`build/config.yml info.version -> ${version}`);
