//go:build windows

package gpu

import "syscall"

// hideWindowAttr stops a console window from popping up when we spawn
// nvidia-smi / powershell. Equivalent to Electron's `windowsHide: true`.
func hideWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
