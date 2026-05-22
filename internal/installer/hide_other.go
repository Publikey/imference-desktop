//go:build !windows

package installer

import "syscall"

func hideWindowAttr() *syscall.SysProcAttr {
	return nil
}
