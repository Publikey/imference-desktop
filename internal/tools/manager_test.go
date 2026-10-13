package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"imference-desktop-go/internal/logbus"
)

func fakeLaunch(t *testing.T, extraEnv ...string) func() (LaunchConfig, error) {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	script, _ := filepath.Abs(filepath.Join("testdata", "fake_tools_sidecar.py"))
	return func() (LaunchConfig, error) {
		return LaunchConfig{Python: py, Script: script, Env: append(os.Environ(), extraEnv...)}, nil
	}
}

type progressLog struct {
	mu  sync.Mutex
	evs []Progress
}

func (p *progressLog) add(ev Progress) {
	p.mu.Lock()
	p.evs = append(p.evs, ev)
	p.mu.Unlock()
}

func (p *progressLog) stages(job string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, e := range p.evs {
		if e.JobID == job {
			out = append(out, e.Stage)
		}
	}
	return out
}

func TestManagerRunsAndReportsProgress(t *testing.T) {
	var prog progressLog
	m := NewManager(logbus.New(), fakeLaunch(t), prog.add)
	defer m.Stop()
	out := t.TempDir()
	res, err := m.Run(context.Background(), EngineRequest{
		JobID: "job1", ToolID: "copy", Inputs: map[string]any{"image": "/in.png"},
		Params: map[string]any{"scale": 2}, OutputDir: out,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ToolID != "copy" || len(res.Outputs) != 1 || res.Outputs[0].Width != 8 {
		t.Fatalf("result %+v", res)
	}
	if _, serr := os.Stat(res.Outputs[0].Path); serr != nil {
		t.Fatalf("output not written: %v", serr)
	}
	got := strings.Join(prog.stages("job1"), ",")
	if got != "starting,running,encoding" {
		t.Errorf("stages = %s", got)
	}
	if p := m.CachedProbe(); p == nil || len(p.Providers) != 1 || !p.FFmpeg {
		t.Errorf("probe not cached: %+v", p)
	}
	// A second run reuses the process (no "starting").
	if _, err := m.Run(context.Background(), EngineRequest{JobID: "job2", ToolID: "copy", OutputDir: out}); err != nil {
		t.Fatal(err)
	}
	if s := prog.stages("job2"); len(s) == 0 || s[0] == "starting" {
		t.Errorf("job2 stages = %v", s)
	}
}

func TestManagerTypedErrors(t *testing.T) {
	m := NewManager(logbus.New(), fakeLaunch(t), nil)
	defer m.Stop()
	_, err := m.Run(context.Background(), EngineRequest{JobID: "j", ToolID: "oom", OutputDir: t.TempDir()})
	if err == nil || err.Code != CodeOOM || !CloudRetryable(err) {
		t.Fatalf("oom: %v", err)
	}
	// A crash fails the run as internal and the next run restarts the sidecar.
	_, err = m.Run(context.Background(), EngineRequest{JobID: "j2", ToolID: "crash", OutputDir: t.TempDir()})
	if err == nil || err.Code != CodeInternal {
		t.Fatalf("crash: %v", err)
	}
	if _, err := m.Run(context.Background(), EngineRequest{JobID: "j3", ToolID: "copy", OutputDir: t.TempDir()}); err != nil {
		t.Fatalf("run after crash: %v", err)
	}
}

func TestManagerStartFailureIsUnsupportedRuntime(t *testing.T) {
	m := NewManager(logbus.New(), fakeLaunch(t, "FAKE_FAIL_LOAD=1"), nil)
	_, err := m.Run(context.Background(), EngineRequest{JobID: "j", ToolID: "copy", OutputDir: t.TempDir()})
	if err == nil || err.Code != CodeUnsupportedRuntime || !strings.Contains(err.Message, "no engine") {
		t.Fatalf("got %v", err)
	}
}

func TestManagerCancelKillsRunningTool(t *testing.T) {
	m := NewManager(logbus.New(), fakeLaunch(t), nil)
	defer m.Stop()
	done := make(chan *Error, 1)
	go func() {
		_, err := m.Run(context.Background(), EngineRequest{JobID: "slow1", ToolID: "slow", OutputDir: t.TempDir()})
		done <- err
	}()
	// Wait until the run is in flight.
	deadline := time.Now().Add(10 * time.Second)
	for {
		m.mu.Lock()
		running := m.jobID == "slow1" && m.proc != nil
		m.mu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run never started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // let the payload reach the child
	if !m.Cancel("slow1") {
		t.Fatal("Cancel did not find the running job")
	}
	select {
	case err := <-done:
		if err == nil || err.Code != CodeCancelled {
			t.Fatalf("got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not stop the run")
	}
	if m.Running() {
		t.Error("process should be gone after cancel")
	}
}

func TestManagerIdleStopReleasesFirst(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "ops.log")
	m := NewManager(logbus.New(), fakeLaunch(t, "FAKE_LOG="+logFile), nil)
	m.IdleTimeout = 200 * time.Millisecond
	if _, err := m.Run(context.Background(), EngineRequest{JobID: "j", ToolID: "copy", OutputDir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for m.Running() {
		if time.Now().After(deadline) {
			t.Fatal("sidecar never stopped when idle")
		}
		time.Sleep(50 * time.Millisecond)
	}
	ops, _ := os.ReadFile(logFile)
	if got := strings.Fields(string(ops)); strings.Join(got, ",") != "probe,run,release" {
		t.Fatalf("ops = %v, want probe,run,release", got)
	}
}

func TestParseProgressLine(t *testing.T) {
	id, st, f, ok := ParseProgressLine(`IMTOOL_PROGRESS {"task_id":"a","stage":"loading","fraction":0.25}`)
	if !ok || id != "a" || st != "loading" || f != 0.25 {
		t.Fatalf("got %s %s %v %v", id, st, f, ok)
	}
	if _, _, _, ok := ParseProgressLine("INFO something"); ok {
		t.Fatal("plain log parsed as progress")
	}
	if _, _, _, ok := ParseProgressLine("IMTOOL_PROGRESS {bad"); ok {
		t.Fatal("bad json parsed")
	}
}
