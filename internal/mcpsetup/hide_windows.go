//go:build windows

package mcpsetup

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps child consoles (node, claude) from flashing a window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
