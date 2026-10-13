package sidecar

import (
	"strings"
	"testing"

	"imference-desktop-go/internal/logbus"
)

// Generation tools (vary / inpaint / outpaint) report named stages on stderr;
// they reach the tool listener and never the log.
func TestStreamStderrRoutesToolProgress(t *testing.T) {
	m := New("", "", nil, logbus.New())
	var got []string
	m.SetToolProgressListener(func(job, stage string, f float64) {
		got = append(got, job+":"+stage)
	})
	m.streamStderr(strings.NewReader("INFO loading\n" +
		`IMTOOL_PROGRESS {"task_id":"j1","stage":"running","fraction":0.05}` + "\n" +
		`IMTOOL_PROGRESS {"task_id":"j1","stage":"encoding","fraction":1}` + "\n"))
	if strings.Join(got, ",") != "j1:running,j1:encoding" {
		t.Fatalf("got %v", got)
	}
}
