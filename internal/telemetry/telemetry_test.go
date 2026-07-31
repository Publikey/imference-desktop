package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

func testRecorder(t *testing.T, s types.Settings) *Recorder {
	t.Helper()
	r := New(func() types.Settings { return s }, logbus.New())
	// Never touch the real UserConfigDir state from tests.
	r.path = filepath.Join(t.TempDir(), "telemetry.json")
	r.state = state{}
	return r
}

func boolPtr(b bool) *bool { return &b }

func TestRecordAccumulatesAndPersists(t *testing.T) {
	r := testRecorder(t, types.Settings{})

	r.RecordLocalGeneration("sdxl-base", "sdxl", 2*time.Second, false)
	r.RecordLocalGeneration("sdxl-base", "sdxl", 4*time.Second, false)
	r.RecordLocalGeneration("sdxl-base", "sdxl", 0, true)
	r.RecordLocalGeneration("zimage", "zimage", time.Second, false)

	day := time.Now().Format("2006-01-02")
	c := r.state.Days[day]["sdxl-base|sdxl"]
	if c == nil || c.Count != 2 || c.Errors != 1 || c.TotalDurMS != 6000 {
		t.Fatalf("unexpected counters: %+v", c)
	}
	if r.state.Days[day]["zimage|zimage"].Count != 1 {
		t.Fatal("second model not counted")
	}

	// Persisted and reloadable.
	data, err := os.ReadFile(r.path)
	if err != nil {
		t.Fatalf("state not persisted: %v", err)
	}
	var reloaded state
	if err := json.Unmarshal(data, &reloaded); err != nil {
		t.Fatalf("state not valid JSON: %v", err)
	}
	if reloaded.Days[day]["sdxl-base|sdxl"].Count != 2 {
		t.Fatal("reloaded state lost counters")
	}
}

func TestCustomModelCodeIsAnonymized(t *testing.T) {
	r := testRecorder(t, types.Settings{})

	// Custom checkpoints carry the user's FILENAME in the model code — it must
	// never reach the counters, whatever the caller passes.
	r.RecordLocalGeneration("custom:myVerySecretProject_v3.safetensors", "anima", time.Second, false)
	r.RecordLocalGeneration("custom:other_file.safetensors", "anima", time.Second, false)

	day := time.Now().Format("2006-01-02")
	c := r.state.Days[day]["custom|anima"]
	if c == nil || c.Count != 2 {
		t.Fatalf("custom generations not collapsed into the 'custom' bucket: %+v", r.state.Days[day])
	}
	for key := range r.state.Days[day] {
		if strings.Contains(key, "safetensors") {
			t.Fatalf("filename leaked into counters: %q", key)
		}
	}
}

func TestDisabledRecordsNothing(t *testing.T) {
	r := testRecorder(t, types.Settings{SendAnonymousStats: boolPtr(false)})
	r.RecordLocalGeneration("sdxl-base", "sdxl", time.Second, false)
	if len(r.state.Days) != 0 {
		t.Fatal("disabled recorder accumulated counters")
	}
	if _, err := os.Stat(r.path); !os.IsNotExist(err) {
		t.Fatal("disabled recorder wrote a state file")
	}
}

func TestOptOutWipesEverything(t *testing.T) {
	r := testRecorder(t, types.Settings{})
	r.RecordLocalGeneration("sdxl-base", "sdxl", time.Second, false)
	r.state.InstallID = "0f0e0d0c-0b0a-4908-8706-050403020100"
	r.persistLocked()

	r.OnSettingsSaved(types.Settings{}, types.Settings{SendAnonymousStats: boolPtr(false)})

	if r.state.InstallID != "" || len(r.state.Days) != 0 {
		t.Fatalf("state not wiped: %+v", r.state)
	}
	if _, err := os.Stat(r.path); !os.IsNotExist(err) {
		t.Fatal("state file survived opt-out")
	}
}

func TestSendPostsAndFlushesPastDays(t *testing.T) {
	var got payload
	received := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/telemetry" {
			t.Errorf("unexpected path %s", req.URL.Path)
		}
		if err := json.NewDecoder(req.Body).Decode(&got); err != nil {
			t.Errorf("bad payload: %v", err)
		}
		received = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// The env override both redirects the endpoint and unlocks sending from a
	// "dev"-versioned test binary.
	t.Setenv("IMFERENCE_TELEMETRY_URL", srv.URL+"/api/telemetry")

	r := testRecorder(t, types.Settings{})
	r.endpoint = srv.URL + "/api/telemetry"
	today := time.Now().Format("2006-01-02")
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	r.state.Days = map[string]map[string]*counters{
		yesterday: {"sdxl-base|sdxl": {ModelCode: "sdxl-base", Engine: "sdxl", Count: 3, Errors: 1, TotalDurMS: 9000}},
		today:     {"zimage|zimage": {ModelCode: "zimage", Engine: "zimage", Count: 1, TotalDurMS: 500}},
	}

	r.send(context.Background())

	if !received {
		t.Fatal("nothing POSTed")
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(got.InstallID) {
		t.Errorf("install_id is not a v4 UUID: %q", got.InstallID)
	}
	if len(got.Days) != 2 || got.Days[0].Date != yesterday || got.Days[1].Date != today {
		t.Fatalf("unexpected days: %+v", got.Days)
	}
	if m := got.Days[0].Models[0]; m.Count != 3 || m.Errors != 1 || m.AvgDurationMS != 3000 {
		t.Fatalf("unexpected model usage: %+v", m)
	}

	// Yesterday flushed, today retained (cumulative), install id stable.
	if _, ok := r.state.Days[yesterday]; ok {
		t.Fatal("past day not flushed after 200")
	}
	if _, ok := r.state.Days[today]; !ok {
		t.Fatal("today must survive the flush")
	}
	id := r.state.InstallID
	r.send(context.Background())
	if r.state.InstallID != id {
		t.Fatal("install id must be stable across sends")
	}
}

func TestSendSkipsWhenDisabled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("disabled recorder must not POST")
	}))
	defer srv.Close()
	t.Setenv("IMFERENCE_TELEMETRY_URL", srv.URL)

	r := testRecorder(t, types.Settings{SendAnonymousStats: boolPtr(false)})
	r.endpoint = srv.URL
	r.send(context.Background())
}
