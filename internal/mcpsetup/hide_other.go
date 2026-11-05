//go:build !windows

package mcpsetup

import "os/exec"

func hideWindow(*exec.Cmd) {}
