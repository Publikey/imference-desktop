//go:build windows

package sidecar

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobObject wraps a Windows Job Object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// When the handle is closed — explicitly via close(), or implicitly when the
// owning process dies (Ctrl+C, X button, Task Manager hard kill, crash) — the
// kernel terminates every process assigned to the job. This is the only way
// on Windows to guarantee a spawned child can't outlive its parent.
//
// Compare to Unix: there we'd use prctl(PR_SET_PDEATHSIG, SIGKILL) on the
// child, or put it in a new process group and SIGKILL the group on parent
// shutdown. No equivalent in Windows without Job Objects.
type jobObject struct {
	handle windows.Handle
}

// newJobKillOnClose creates a Job Object whose KillOnJobClose flag is set.
// Returns an error if the syscall fails (very rare — would mean a kernel-level
// resource exhaustion).
func newJobKillOnClose() (*jobObject, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("sidecar: CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		h,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("sidecar: SetInformationJobObject: %w", err)
	}
	return &jobObject{handle: h}, nil
}

// assign puts the process with the given PID under the job's umbrella. Must
// be called immediately after Cmd.Start() — the child can do anything before
// being assigned, including spawning its own grandchildren that escape the
// job.
func (j *jobObject) assign(pid int) error {
	ph, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(pid),
	)
	if err != nil {
		return fmt.Errorf("sidecar: OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(ph)
	if err := windows.AssignProcessToJobObject(j.handle, ph); err != nil {
		return fmt.Errorf("sidecar: AssignProcessToJobObject: %w", err)
	}
	return nil
}

// close releases the job handle, which on Windows triggers
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — the kernel immediately kills every
// process still assigned to the job. Idempotent.
func (j *jobObject) close() {
	if j == nil || j.handle == 0 {
		return
	}
	_ = windows.CloseHandle(j.handle)
	j.handle = 0
}
