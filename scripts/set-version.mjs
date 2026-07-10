// Patches build/config.yml's info.version from a tag passed as arg 1.
// Cross-platform (runs on the Windows / macOS / Ubuntu CI runners via Node).
// Usage: node scripts/set-version.mjs v1.2.3   ->   info.version "1.2.3"
//
// Wails v3 keeps the packaged-app version in build/config.yml (info.version);
// the in-app version string is embedded from internal/version/version.txt,
// which this script also rewrites (see below).
import { readFileSync, writeFileSync } from "node:fs";

const raw = process.argv[2] || "0.0.0";
// Sanitise to a numeric MAJOR.MINOR.PATCH: the NSIS installer template does
// `VIFileVersion "${INFO_PRODUCTVERSION}.0"` (build/windows/nsis/project.nsi),
// which requires a strict X.X.X.X — a raw tag like "0.2.0-rc1" (pre-release
// suffix) or "1.2" (too few parts) makes makensis abort. Drop the leading "v",
// drop any pre-release/build metadata after the first "-"/"+", and normalise to
// exactly three numeric components. The GitHub Release keeps the full tag name
// (the release job uses github.ref_name, not this value).
const version = raw
  .replace(/^v/, "")
  .split(/[-+]/)[0]
  .split(".")
  .map((n) => parseInt(n, 10) || 0)
  .concat(0, 0)
  .slice(0, 3)
  .join(".");
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

// Also stamp the version embedded in the Go binary (internal/version reads
// this via go:embed). Committed as "dev"; only CI rewrites it before building,
// so local builds keep reporting "dev" and skip the update check.
const embedPath = "internal/version/version.txt";
writeFileSync(embedPath, `${version}\n`);

console.log(`build/config.yml info.version -> ${version}`);
console.log(`${embedPath} -> ${version}`);
