// Package usageping lets imference.com count active installs without
// identifying any of them.
//
// The app fetches the model catalog (GET /api/models) even when it only runs
// locally. On the first fetch of a UTC day, that request carries one extra
// header saying which periods this is the install's first ping of:
//
//	X-Imference-Ping: p=dwmf&v=1.4.2&os=windows&arch=amd64
//
// d = first of the day, w = of the ISO week, m = of the month, f = first ever.
// The server sums those flags per day: daily, weekly and monthly active
// installs and new installs, exactly, with no install id. All this package
// keeps is the date of the last ping, in usage-ping.json next to settings.json.
//
// Nothing else is sent: no prompt, no model, no hardware, no id. It is off for
// dev builds, when the user turns it off in Settings, and when DO_NOT_TRACK is
// set in the environment.
package usageping

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"imference-desktop-go/internal/version"
)

// HeaderName is the header the ping travels in.
const HeaderName = "X-Imference-Ping"

const dayLayout = "2006-01-02"

// state is the whole on-disk memory of the ping.
type state struct {
	// LastPing is the UTC date (YYYY-MM-DD) of the last ping the server took.
	LastPing string `json:"lastPing,omitempty"`
	// NewInstall is true until the first ping of an install made with a build
	// that pings (an install upgraded from an older build isn't new).
	NewInstall bool `json:"newInstall,omitempty"`
}

// Pinger decides what, if anything, a catalog request should carry.
type Pinger struct {
	path     string
	disabled func() bool

	mu sync.Mutex
	st state

	// Overridden in tests.
	now     func() time.Time
	version string
}

// New reads the ping state at path. newInstall tells a first launch from an
// upgrade, when there is no state yet. disabled reports the user's opt-out; it
// is asked on every request, so a change in Settings applies at once.
func New(path string, newInstall bool, disabled func() bool) *Pinger {
	p := &Pinger{path: path, disabled: disabled, now: time.Now, version: version.Version}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &p.st) != nil {
		// Written now, so a first launch that never reaches the server is still
		// counted as a new install when its first ping gets through.
		p.st = state{NewInstall: newInstall}
		p.save()
	}
	return p
}

// Header returns the value to send with a catalog request, and the function to
// call once the server has answered it. It returns "" when there is nothing to
// send: pings are off, or today's is already done.
func (p *Pinger) Header() (value string, sent func()) {
	if p.version == "dev" || doNotTrack() || (p.disabled != nil && p.disabled()) {
		return "", nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	today := p.now().UTC()
	day := today.Format(dayLayout)
	if p.st.LastPing == day {
		return "", nil
	}

	periods := "d"
	last, err := time.Parse(dayLayout, p.st.LastPing)
	if err != nil || isoWeek(last) != isoWeek(today) {
		periods += "w"
	}
	if err != nil || last.Year() != today.Year() || last.Month() != today.Month() {
		periods += "m"
	}
	if p.st.NewInstall && p.st.LastPing == "" {
		periods += "f"
	}

	q := url.Values{}
	q.Set("p", periods)
	q.Set("v", p.version)
	q.Set("os", runtime.GOOS)
	q.Set("arch", runtime.GOARCH)
	return q.Encode(), func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.st = state{LastPing: day}
		p.save()
	}
}

func isoWeek(t time.Time) [2]int {
	y, w := t.ISOWeek()
	return [2]int{y, w}
}

// doNotTrack honors the DO_NOT_TRACK convention (consoledonottrack.com).
func doNotTrack() bool {
	v := os.Getenv("DO_NOT_TRACK")
	return v != "" && v != "0"
}

// save is best-effort: if the state can't be written, the app pings again at
// its next launch that day, which only costs a little accuracy.
func (p *Pinger) save() {
	data, err := json.Marshal(p.st)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(p.path), 0o755) != nil {
		return
	}
	tmp := p.path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, p.path)
}
