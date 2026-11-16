package usageping

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testPinger(t *testing.T, newInstall bool) (*Pinger, *time.Time) {
	t.Helper()
	t.Setenv("DO_NOT_TRACK", "")
	p := New(filepath.Join(t.TempDir(), "cfg", "usage-ping.json"), newInstall, nil)
	p.version = "1.4.2"
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC) // a Monday
	p.now = func() time.Time { return now }
	return p, &now
}

// ping sends one catalog request and returns the periods it announced.
func ping(t *testing.T, p *Pinger) string {
	t.Helper()
	value, sent := p.Header()
	if value == "" {
		return ""
	}
	sent()
	q, err := url.ParseQuery(value)
	if err != nil {
		t.Fatal(err)
	}
	if q.Get("v") != "1.4.2" || q.Get("os") == "" || q.Get("arch") == "" || len(q) != 4 {
		t.Fatalf("unexpected header %q", value)
	}
	return q.Get("p")
}

func TestPeriods(t *testing.T) {
	p, now := testPinger(t, true)
	steps := []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC), "dwmf"}, // first ever (Monday)
		{time.Date(2026, 11, 16, 23, 0, 0, 0, time.UTC), ""},     // same day
		{time.Date(2026, 11, 17, 0, 5, 0, 0, time.UTC), "d"},     // next day, same week
		{time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC), "dw"},    // next week, same month
		{time.Date(2026, 12, 1, 9, 0, 0, 0, time.UTC), "dwm"},    // next week and month
		{time.Date(2026, 12, 2, 9, 0, 0, 0, time.UTC), "d"},      // same week, same month
		{time.Date(2027, 12, 2, 9, 0, 0, 0, time.UTC), "dwm"},    // a year later: same month number
	}
	for _, s := range steps {
		*now = s.at
		if got := ping(t, p); got != s.want {
			t.Errorf("%s: periods %q, want %q", s.at.Format(time.RFC3339), got, s.want)
		}
	}
}

func TestMonthChangeInsideAWeek(t *testing.T) {
	p, now := testPinger(t, false)
	*now = time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC) // Wednesday
	if got := ping(t, p); got != "dwm" {
		t.Errorf("upgraded install's first ping: %q, want dwm (not a new install)", got)
	}
	*now = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC) // Thursday, same ISO week
	if got := ping(t, p); got != "dm" {
		t.Errorf("periods %q, want dm", got)
	}
}

func TestUnansweredPingIsRetried(t *testing.T) {
	p, _ := testPinger(t, true)
	if value, _ := p.Header(); value == "" {
		t.Fatal("expected a ping")
	}
	// The request failed: sent() was not called, the next one asks again.
	if got := ping(t, p); got != "dwmf" {
		t.Errorf("retry announced %q, want dwmf", got)
	}
}

func TestStateSurvivesRestart(t *testing.T) {
	p, now := testPinger(t, true)
	// Offline first launch: no ping gets through, the install is still new.
	restarted := New(p.path, false, nil)
	restarted.version, restarted.now = p.version, p.now
	if got := ping(t, restarted); got != "dwmf" {
		t.Errorf("first ping after an offline first launch: %q, want dwmf", got)
	}
	again := New(p.path, true, nil)
	again.version, again.now = p.version, p.now
	if got := ping(t, again); got != "" {
		t.Errorf("pinged twice the same day across a restart: %q", got)
	}
	*now = now.Add(24 * time.Hour)
	if got := ping(t, again); got != "d" {
		t.Errorf("next day: %q, want d", got)
	}
	data, _ := os.ReadFile(p.path)
	if string(data) != `{"lastPing":"2026-11-17"}` {
		t.Errorf("state file holds %s, want only the last ping date", data)
	}
}

func TestOff(t *testing.T) {
	p, _ := testPinger(t, true)

	off := true
	p.disabled = func() bool { return off }
	if value, _ := p.Header(); value != "" {
		t.Errorf("pinged with the setting off: %q", value)
	}
	off = false

	t.Setenv("DO_NOT_TRACK", "1")
	if value, _ := p.Header(); value != "" {
		t.Errorf("pinged with DO_NOT_TRACK=1: %q", value)
	}
	t.Setenv("DO_NOT_TRACK", "0")

	p.version = "dev"
	if value, _ := p.Header(); value != "" {
		t.Errorf("pinged from a dev build: %q", value)
	}
	p.version = "1.4.2"

	if got := ping(t, p); got != "dwmf" {
		t.Errorf("back on: %q, want dwmf", got)
	}
}
