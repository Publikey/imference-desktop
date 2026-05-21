//go:build !windows

package sidecar

import "syscall"

// hideWindowAttr is a no-op on non-Windows platforms — there's no console
// to hide. POC is Windows-only but compiling on other OSes shouldn't break.
func hideWindowAttr() *syscall.SysProcAttr {
	return nil
}
