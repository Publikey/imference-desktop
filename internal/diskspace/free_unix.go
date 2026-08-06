//go:build !windows

package diskspace

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// FreeBytes returns the space available to an unprivileged user on the
// filesystem holding dir.
//
// Bavail (not Bfree) is the right field: Bfree includes blocks reserved for
// root, which we can't use. The explicit int64 casts are load-bearing — Bsize
// is int64 on Linux but int32 on Darwin, so the arithmetic won't compile on
// both without them.
func FreeBytes(dir string) (int64, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, fmt.Errorf("diskspace: mkdir %s: %w", dir, err)
	}
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, fmt.Errorf("diskspace: statfs %s: %w", dir, err)
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
