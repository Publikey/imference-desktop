package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/usageping"
)

type fakePing struct {
	value string
	sent  int
}

func (f *fakePing) Header() (string, func()) {
	if f.value == "" {
		return "", nil
	}
	return f.value, func() { f.sent++ }
}

// The ping rides on the catalog request, and only counts as sent once the
// server has answered it.
func TestCatalogRequestCarriesUsagePing(t *testing.T) {
	var got []string
	status := http.StatusInternalServerError
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/models" {
			got = append(got, r.Header.Get(usageping.HeaderName))
		}
		w.WriteHeader(status)
		w.Write([]byte(`{"models":[]}`))
	}))
	defer srv.Close()

	c := New(logbus.New())
	c.SetBaseURL(srv.URL)
	ping := &fakePing{value: "p=d&v=1.4.2&os=linux&arch=amd64"}
	c.SetUsagePing(ping)

	if _, err := c.fetchCatalog(context.Background()); err == nil {
		t.Fatal("expected the HTTP 500 to fail the fetch")
	}
	if ping.sent != 0 {
		t.Error("a failed catalog request must not mark the ping as sent")
	}

	status = http.StatusOK
	if _, err := c.fetchCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ping.sent != 1 {
		t.Errorf("ping marked sent %d times, want 1", ping.sent)
	}
	if len(got) != 2 || got[0] != ping.value || got[1] != ping.value {
		t.Errorf("headers received: %q", got)
	}

	// Nothing to announce (already pinged today, or pings off): no header.
	ping.value = ""
	c.catalog = nil
	if _, err := c.fetchCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got[2] != "" {
		t.Errorf("header sent with no ping due: %q", got[2])
	}
}
