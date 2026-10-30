//go:build web

package main

import (
	"net/http"
	"testing"
	"time"
)

// A generation answers 202 at once and its response is collected from
// web/call/wait, only by the session that started it, and only once.
func TestLongCallsAnswerPendingThenCollect(t *testing.T) {
	api, _ := mockAPI(t)
	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})

	code, m := c.post("/web/call", map[string]any{"methodName": "main.App.GenerateCloud",
		"args": []any{map[string]any{"prompt": "a red fox", "width": 512, "height": 512}}}, true)
	id, _ := m["pending"].(string)
	if code != http.StatusAccepted || id == "" {
		t.Fatalf("GenerateCloud should answer 202 {pending}: %d %v", code, m)
	}

	other := newClient(t, hs.URL)
	other.post("/web/login", map[string]string{"apiKey": "good-1"}, true) // same user, other session
	if code, _ := other.post("/web/call/wait", map[string]any{"id": id}, true); code != http.StatusNotFound {
		t.Fatalf("another session collected the run: %d", code)
	}
	if code, _ := c.post("/web/call/wait", map[string]any{"id": id}, false); code != http.StatusForbidden {
		t.Fatalf("wait without the CSRF header: %d", code)
	}

	for code == http.StatusAccepted {
		code, m = c.post("/web/call/wait", map[string]any{"id": id}, true)
	}
	if code != http.StatusOK || m["result"] == nil {
		t.Fatalf("collected response: %d %v", code, m)
	}
	if code, _ := c.post("/web/call/wait", map[string]any{"id": id}, true); code != http.StatusNotFound {
		t.Fatalf("a response is collected once: %d", code)
	}
	srv.mu.Lock()
	n := len(srv.calls)
	srv.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d calls left after collection", n)
	}
}

func TestSweepCallsDropsUncollectedResponses(t *testing.T) {
	srv, _ := startServer(t, "")
	now := time.Now()
	done := make(chan struct{})
	close(done)
	srv.calls["old"] = &asyncCall{sid: "s", done: done, finished: now.Add(-asyncKeep - time.Second)}
	srv.calls["fresh"] = &asyncCall{sid: "s", done: done, finished: now}
	srv.calls["running"] = &asyncCall{sid: "s", done: make(chan struct{})}
	srv.sweepCalls(now)
	if _, ok := srv.calls["old"]; ok || len(srv.calls) != 2 {
		t.Fatalf("after sweep: %v", srv.calls)
	}
}
