package telemetry

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// osVersion returns the macOS product version ("15.3"). sw_vers ships with
// every macOS; a hung call is bounded and degrades to "".
func osVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "sw_vers", "-productVersion").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
