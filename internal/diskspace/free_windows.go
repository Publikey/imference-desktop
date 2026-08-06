//go:build windows

package diskspace

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// FreeBytes returns the space available to the calling user on the volume that
// holds dir.
//
// Two details matter: GetDiskFreeSpaceEx needs an EXISTING directory (so we
// create it first), and we report freeBytesAvailableToCaller rather than the
// volume's total free bytes — under a disk quota those differ, and the caller's
// figure is the one that governs whether a write succeeds.
func FreeBytes(dir string) (int64, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, fmt.Errorf("diskspace: mkdir %s: %w", dir, err)
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, fmt.Errorf("diskspace: path %s: %w", dir, err)
	}
	var freeToCaller, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeToCaller, &total, &totalFree); err != nil {
		return 0, fmt.Errorf("diskspace: GetDiskFreeSpaceEx %s: %w", dir, err)
	}
	return int64(freeToCaller), nil
}
