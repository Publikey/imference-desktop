package telemetry

import (
	"os"
	"strings"
)

// osVersion returns "<ID> <VERSION_ID>" from /etc/os-release ("ubuntu 24.04").
// Distro + release is the granularity that matters for support decisions;
// kernel versions would be noise.
func osVersion() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	var id, ver string
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := strings.CutPrefix(line, "ID="); ok {
			id = strings.Trim(v, `"`)
		}
		if v, ok := strings.CutPrefix(line, "VERSION_ID="); ok {
			ver = strings.Trim(v, `"`)
		}
	}
	return strings.TrimSpace(id + " " + ver)
}
