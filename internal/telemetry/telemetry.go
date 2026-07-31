// Package telemetry accumulates and ships anonymous usage stats for the
// desktop app. The full outbound payload is documented in the README — it is
// the entire privacy contract: a random install UUID (crypto/rand, never
// derived from the machine), app version, OS/arch, UI language, GPU, and
// per-day/per-model local-generation counters. No prompts, no images, no
// paths, and NEVER the API key or any authenticated identifier — the POST is
// deliberately unauthenticated so the server cannot join it to a cloud user.
//
// Counters are cumulative per (day, model) and persisted to telemetry.json
// next to settings.json; the server upserts with GREATEST so re-sending the
// same day never double-counts. Days before today are dropped after a 200.
// Opting out (settings.sendAnonymousStats=false) stops accumulation AND wipes
// the state file including the install id — opting back in starts from a
// fresh identity.
package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/gpu"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/version"
)

const (
	defaultEndpoint = "https://imference.com/api/telemetry"
	appDirName      = "imference-desktop-go"
	fileName        = "telemetry.json"

	// startupDelay keeps the first send off the boot path (window paint, engine
	// probing); sendEvery re-flushes long-running sessions.
	startupDelay = 15 * time.Second
	sendEvery    = 6 * time.Hour
	sendTimeout  = 15 * time.Second
)

// Recorder owns the counter state + the background sender. All methods are
// goroutine-safe and every one of them no-ops when the user opted out.
type Recorder struct {
	getSettings func() types.Settings
	bus         *logbus.Bus
	http        *http.Client
	endpoint    string

	mu    sync.Mutex
	path  string
	state state

	gpuOnce sync.Once
	gpuInfo gpu.Info
}

// state is the on-disk shape of telemetry.json. Wiped entirely on opt-out.
type state struct {
	InstallID  string                          `json:"installId,omitempty"`
	UILanguage string                          `json:"uiLanguage,omitempty"`
	Days       map[string]map[string]*counters `json:"days,omitempty"` // date → modelCode|engine → counters
}

type counters struct {
	ModelCode  string `json:"modelCode"`
	Engine     string `json:"engine,omitempty"`
	Count      int    `json:"count"`  // successful generations
	Errors     int    `json:"errors"` // failed generations
	TotalDurMS int64  `json:"totalDurMs,omitempty"`
}

// New loads (or initializes) the state file. Errors are non-fatal by design:
// telemetry must never stop the app from booting — a broken file starts fresh.
func New(getSettings func() types.Settings, bus *logbus.Bus) *Recorder {
	r := &Recorder{
		getSettings: getSettings,
		bus:         bus,
		http:        &http.Client{Timeout: sendTimeout},
		endpoint:    defaultEndpoint,
	}
	if env := os.Getenv("IMFERENCE_TELEMETRY_URL"); env != "" {
		r.endpoint = env // dev/test override; also unlocks sending from "dev" builds
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		bus.Warn("telemetry", "UserConfigDir unavailable — telemetry disabled", map[string]any{"err": err.Error()})
		return r
	}
	r.path = filepath.Join(dir, appDirName, fileName)

	data, err := os.ReadFile(r.path)
	if err == nil {
		if jsonErr := json.Unmarshal(data, &r.state); jsonErr != nil {
			bus.Warn("telemetry", "corrupt state file — starting fresh", map[string]any{"err": jsonErr.Error()})
			r.state = state{}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		bus.Warn("telemetry", "read state failed — starting fresh", map[string]any{"err": err.Error()})
	}
	return r
}

// enabled follows the settings tri-state: nil (never asked) counts as on.
func (r *Recorder) enabled() bool {
	s := r.getSettings()
	return s.SendAnonymousStats == nil || *s.SendAnonymousStats
}

// RecordLocalGeneration bumps the cumulative counters for today's (model,
// engine) bucket. dur may be 0 (unmeasured); failed generations count into
// Errors and contribute no duration.
//
// User-supplied checkpoints get their code collapsed to just "custom": their
// ModelCode embeds the checkpoint FILENAME ("custom:whatever_v3.safetensors"),
// which is user-chosen data — off-limits per the privacy contract (and can
// exceed the server's 64-char bound, which would 400 the whole payload
// forever). The engine survives: it's catalog data, and "custom anima
// checkpoints are popular" is the actionable signal anyway.
func (r *Recorder) RecordLocalGeneration(modelCode, engine string, dur time.Duration, failed bool) {
	if modelCode == "" || !r.enabled() || r.path == "" {
		return
	}
	if strings.HasPrefix(modelCode, "custom:") {
		modelCode = "custom"
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	day := time.Now().Format("2006-01-02")
	if r.state.Days == nil {
		r.state.Days = map[string]map[string]*counters{}
	}
	if r.state.Days[day] == nil {
		r.state.Days[day] = map[string]*counters{}
	}
	key := modelCode + "|" + engine
	c := r.state.Days[day][key]
	if c == nil {
		c = &counters{ModelCode: modelCode, Engine: engine}
		r.state.Days[day][key] = c
	}
	if failed {
		c.Errors++
	} else {
		c.Count++
		c.TotalDurMS += dur.Milliseconds()
	}
	r.persistLocked()
}

// SetUILanguage records the renderer's active language (it lives in
// localStorage, not settings.json, so the renderer pushes it here).
func (r *Recorder) SetUILanguage(code string) {
	if !r.enabled() || r.path == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state.UILanguage == code {
		return
	}
	r.state.UILanguage = code
	r.persistLocked()
}

// OnSettingsSaved reacts to the toggle: turning stats OFF wipes the whole
// state file, install id included — the promise is "off means we hold nothing".
// Turning back on starts from a fresh identity (new id minted lazily).
func (r *Recorder) OnSettingsSaved(prev, next types.Settings) {
	wasOn := prev.SendAnonymousStats == nil || *prev.SendAnonymousStats
	isOn := next.SendAnonymousStats == nil || *next.SendAnonymousStats
	if !wasOn || isOn {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.state = state{}
	if r.path != "" {
		if err := os.Remove(r.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			r.bus.Warn("telemetry", "opt-out wipe failed", map[string]any{"err": err.Error()})
		}
	}
	r.bus.Info("telemetry", "anonymous stats disabled — local state wiped", nil)
}

// Start launches the background sender: one send shortly after boot, then one
// every sendEvery. Returns immediately; the goroutine stops with ctx.
func (r *Recorder) Start(ctx context.Context) {
	go func() {
		select {
		case <-time.After(startupDelay):
		case <-ctx.Done():
			return
		}
		r.send(ctx)
		ticker := time.NewTicker(sendEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				r.send(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

// send builds and POSTs the payload, then drops fully-flushed past days.
// Failures are silent-by-design (a warn in the log bus, nothing user-facing):
// counters simply wait for the next attempt.
func (r *Recorder) send(ctx context.Context) {
	if !r.enabled() || r.path == "" {
		return
	}
	// Local dev builds never report — except against an explicit override URL.
	if version.Version == "dev" && os.Getenv("IMFERENCE_TELEMETRY_URL") == "" {
		return
	}

	// GPU probe once per process, on the sender goroutine (it shells out to
	// nvidia-smi / PowerShell, so it must stay off Record's hot path).
	r.gpuOnce.Do(func() { r.gpuInfo = gpu.Detect(ctx) })

	r.mu.Lock()
	if r.state.InstallID == "" {
		id, err := newUUID()
		if err != nil {
			r.mu.Unlock()
			return // no entropy, no telemetry
		}
		r.state.InstallID = id
		r.persistLocked()
	}
	payload := r.buildPayloadLocked()
	r.mu.Unlock()

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "imference-desktop-go/"+version.Version)

	resp, err := r.http.Do(req)
	if err != nil {
		r.bus.Warn("telemetry", "send failed — will retry later", map[string]any{"err": err.Error()})
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		r.bus.Warn("telemetry", "send rejected", map[string]any{"status": resp.StatusCode})
		return
	}

	// Acked: past days are final on the server (GREATEST upsert), drop them.
	// Today keeps accumulating and will be re-sent cumulatively.
	today := time.Now().Format("2006-01-02")
	r.mu.Lock()
	for day := range r.state.Days {
		if day < today {
			delete(r.state.Days, day)
		}
	}
	r.persistLocked()
	r.mu.Unlock()
	r.bus.Info("telemetry", "anonymous stats sent", map[string]any{"days": len(payload.Days)})
}

// ---------------------------------------------------------------------------
// wire payload (snake_case: the server contract in imference/models/telemetry.go)
// ---------------------------------------------------------------------------

type payload struct {
	InstallID  string       `json:"install_id"`
	AppVersion string       `json:"app_version"`
	OS         string       `json:"os"`
	OSVersion  string       `json:"os_version"`
	Arch       string       `json:"arch"`
	UILanguage string       `json:"ui_language"`
	GPU        payloadGPU   `json:"gpu"`
	Days       []payloadDay `json:"days"`
}

type payloadGPU struct {
	Vendor  string `json:"vendor"`
	Name    string `json:"name"`
	VRAMGiB int    `json:"vram_gib"`
}

type payloadDay struct {
	Date   string         `json:"date"`
	Models []payloadModel `json:"models"`
}

type payloadModel struct {
	ModelCode     string `json:"model_code"`
	Engine        string `json:"engine"`
	Count         int    `json:"count"`
	Errors        int    `json:"errors"`
	AvgDurationMS int    `json:"avg_duration_ms"`
}

func (r *Recorder) buildPayloadLocked() payload {
	p := payload{
		InstallID:  r.state.InstallID,
		AppVersion: version.Version,
		OS:         runtime.GOOS,
		OSVersion:  osVersion(),
		Arch:       runtime.GOARCH,
		UILanguage: r.state.UILanguage,
		GPU: payloadGPU{
			Vendor:  string(r.gpuInfo.Vendor),
			Name:    r.gpuInfo.Name,
			VRAMGiB: int(r.gpuInfo.VRAMGiB + 0.5),
		},
		Days: []payloadDay{},
	}
	days := make([]string, 0, len(r.state.Days))
	for day := range r.state.Days {
		days = append(days, day)
	}
	sort.Strings(days)
	for _, day := range days {
		pd := payloadDay{Date: day}
		keys := make([]string, 0, len(r.state.Days[day]))
		for k := range r.state.Days[day] {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c := r.state.Days[day][k]
			avg := 0
			if c.Count > 0 {
				avg = int(c.TotalDurMS / int64(c.Count))
			}
			pd.Models = append(pd.Models, payloadModel{
				ModelCode:     c.ModelCode,
				Engine:        c.Engine,
				Count:         c.Count,
				Errors:        c.Errors,
				AvgDurationMS: avg,
			})
		}
		p.Days = append(p.Days, pd)
	}
	return p
}

// persistLocked writes the state atomically (same temp+rename dance as the
// settings store). Caller holds r.mu.
func (r *Recorder) persistLocked() {
	if r.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		return
	}
	data, err := json.MarshalIndent(r.state, "", "  ")
	if err != nil {
		return
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, r.path)
}

// newUUID mints a random RFC 4122 v4 UUID from crypto/rand — the whole
// anonymity story rests on this never touching machine identifiers.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
