//go:build windows

package installer

import "syscall"

// hideWindowAttr suppresses the console flash when pip/python are spawned.
// Same intent as sidecar/hide_windows.go — duplicated rather than shared
// because a 3-line helper isn't worth a common package.
func hideWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
