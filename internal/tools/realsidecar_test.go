package tools

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"imference-desktop-go/internal/logbus"
)

// TestRealToolsSidecar drives sidecar/tools_main.py with the real engine
// (runqy-python + imference-engine[tools] importable by python3). Skipped
// otherwise. resize needs no weights, so it runs offline.
func TestRealToolsSidecar(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	if out, err := exec.Command(py, "-c", "import runqy_python, imference_engine.tools").CombinedOutput(); err != nil {
		t.Skipf("engine with tools not importable: %s", out)
	}
	script, _ := filepath.Abs(filepath.Join("..", "..", "sidecar", "tools_main.py"))
	dir := t.TempDir()
	src := filepath.Join(dir, "in.png")
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for x := 0; x < 64; x++ {
		for y := 0; y < 48; y++ {
			img.Set(x, y, color.RGBA{200, 10, 10, 255})
		}
	}
	f, _ := os.Create(src)
	_ = png.Encode(f, img)
	f.Close()

	var prog progressLog
	m := NewManager(logbus.New(), func() (LaunchConfig, error) {
		return LaunchConfig{Python: py, Script: script, Env: append(os.Environ(), "PYTHONUNBUFFERED=1",
			"TOOLS_MODEL_CACHE="+filepath.Join(dir, "weights"))}, nil
	}, prog.add)
	defer m.Stop()

	res, terr := m.Run(context.Background(), EngineRequest{
		JobID: "real-1", ToolID: "resize", Inputs: map[string]any{"image": src},
		Params: map[string]any{"width": float64(32)}, OutputDir: filepath.Join(dir, "out"),
	})
	if terr != nil {
		t.Fatal(terr)
	}
	o := res.Outputs[0]
	if o.Width != 32 || o.Height != 24 || o.Type != "image" {
		t.Fatalf("output %+v", o)
	}
	if _, err := os.Stat(o.Path); err != nil {
		t.Fatal(err)
	}
	if p := m.CachedProbe(); p == nil || len(p.Providers) == 0 {
		t.Fatalf("probe %+v", p)
	}
	stages := prog.stages("real-1")
	if len(stages) < 2 || stages[0] != "starting" {
		t.Fatalf("stages %v", stages)
	}

	// Typed engine error.
	_, terr = m.Run(context.Background(), EngineRequest{JobID: "real-2", ToolID: "resize",
		Inputs: map[string]any{"image": src}, Params: map[string]any{"bogus": 1}, OutputDir: dir})
	if terr == nil || terr.Code != CodeInvalidInput {
		t.Fatalf("expected invalid_input, got %v", terr)
	}
	if err := m.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
}
