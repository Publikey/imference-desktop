//go:build !windows

package gpu

import "syscall"

// hideWindowAttr is a no-op on non-Windows platforms — there's no console
// to hide.
func hideWindowAttr() *syscall.SysProcAttr {
	return nil
}
