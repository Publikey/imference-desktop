//go:build windows

package sidecar

import "syscall"

// hideWindowAttr stops a console window from popping up when we spawn
// python.exe. Equivalent to Electron's `windowsHide: true`.
func hideWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
