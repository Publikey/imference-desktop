// Package version exposes the app's own version, embedded at build time.
//
// The source of truth is version.txt next to this file. It is committed as
// "dev"; the release CI rewrites it via `node scripts/set-version.mjs <tag>`
// BEFORE building (same step that stamps build/config.yml), so shipped
// binaries embed the real X.X.X while local `wails3 dev`/`wails3 build` stay
// "dev". This avoids threading -ldflags through the platform Taskfiles that
// `wails3 package` controls.
package version

import (
	_ "embed"
	"strings"
)

//go:embed version.txt
var raw string

// Version is "dev" for local builds, "X.X.X" (no leading v) for releases.
var Version = strings.TrimSpace(raw)
