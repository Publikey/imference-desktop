//go:build !windows

package sidecar

// jobObject is a no-op on non-Windows platforms. Unix gets equivalent
// guarantees via prctl(PR_SET_PDEATHSIG) — not wired here because the POC
// is Windows-only, but the API surface stays uniform so Manager doesn't
// need build-tagged branches.
type jobObject struct{}

func newJobKillOnClose() (*jobObject, error) { return &jobObject{}, nil }
func (j *jobObject) assign(_ int) error      { return nil }
func (j *jobObject) close()                  {}
