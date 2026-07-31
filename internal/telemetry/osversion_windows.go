package telemetry

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// osVersion returns "major.minor.build" (e.g. "10.0.26100" — build ≥22000 is
// Windows 11). RtlGetNtVersionNumbers reads the real kernel version, immune to
// the compatibility-shim lies of GetVersionEx.
func osVersion() string {
	major, minor, build := windows.RtlGetNtVersionNumbers()
	return fmt.Sprintf("%d.%d.%d", major, minor, build)
}
