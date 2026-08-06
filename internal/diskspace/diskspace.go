// Package diskspace reports free space on the volume holding a directory, and
// measures how much a directory tree occupies.
//
// The model cache enforces two different limits and they are NOT the same
// thing: the quota is a housekeeping target (exceeding it just triggers
// eviction), while free disk space is a hard wall — a download that would eat
// into the reserve fails before touching the network.
package diskspace

import (
	"io/fs"
	"path/filepath"
)

// DirSize sums the regular files under root, recursively. Per-entry errors are
// ignored on purpose (permissions, or a file deleted mid-walk): an approximate
// total is far more useful here than a hard failure, since this only ever feeds
// a storage readout.
//
// Callers should treat this as SLOW — an engine venv holds tens of thousands of
// files — and keep it off any hot path.
func DirSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry: skip, keep walking
		}
		if d.IsDir() {
			return nil
		}
		if info, ierr := d.Info(); ierr == nil {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
