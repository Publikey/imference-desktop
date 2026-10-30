//go:build web

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// Long calls outlive the HTTP requests the hosting allows: Azure Container
// Apps' ingress cuts a request at 240 s, and a generation queued behind others
// on the GPU workers can wait longer than that. POST web/call starts them and
// answers 202 {"pending": id} at once; the browser then long-polls POST
// web/call/wait {"id"} until the call's own response comes back, with the
// status and body web/call would have sent.
var asyncMethods = map[string]bool{"GenerateCloud": true, "RunTool": true, "RecheckPendingCloud": true}

const (
	// asyncWait is how long one web/call/wait holds before answering "still
	// pending": far below the ingress timeout.
	asyncWait = 25 * time.Second
	// asyncKeep is how long a finished call's response waits to be collected
	// (the tab was closed or reloaded meanwhile).
	asyncKeep = 10 * time.Minute
	// maxAsyncPerSession bounds the calls one session holds at once.
	maxAsyncPerSession = 200
)

// asyncCall is a long call started by web/call; done closes once status and
// body are set.
type asyncCall struct {
	sid      string // the session that started it: only it can collect the result
	done     chan struct{}
	status   int
	body     any
	finished time.Time
}

func (s *webServer) startAsync(w http.ResponseWriter, sid string, u *webUser, m *rpcMethod, args []json.RawMessage) {
	id := newSessionID()
	c := &asyncCall{sid: sid, done: make(chan struct{})}
	s.mu.Lock()
	n := 0
	for _, o := range s.calls {
		if o.sid == sid {
			n++
		}
	}
	if n >= maxAsyncPerSession {
		s.mu.Unlock()
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many runs in progress, wait for some to finish"})
		return
	}
	s.calls[id] = c
	s.mu.Unlock()
	go func() {
		// Not the request's context: the call goes on after web/call answers.
		status, body := callResponse(context.Background(), u, m, args)
		s.mu.Lock()
		c.status, c.body, c.finished = status, body, time.Now()
		s.mu.Unlock()
		close(c.done)
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"pending": id})
}

// wait answers a pending call's response once it is done, or 202 again after
// asyncWait.
func (s *webServer) wait(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	cookie, err := r.Cookie(sessionCookie)
	s.mu.Lock()
	c := s.calls[body.ID]
	s.mu.Unlock()
	if err != nil || c == nil || c.sid != cookie.Value {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "this run's result is no longer available"})
		return
	}
	s.userFor(r) // keeps the user from being evicted while its tab waits
	t := time.NewTimer(asyncWait)
	defer t.Stop()
	select {
	case <-c.done:
		s.mu.Lock()
		delete(s.calls, body.ID)
		s.mu.Unlock()
		writeJSON(w, c.status, c.body)
	case <-t.C:
		writeJSON(w, http.StatusAccepted, map[string]string{"pending": body.ID})
	case <-r.Context().Done():
	}
}

// sweepCalls drops finished responses nobody collected within asyncKeep.
func (s *webServer) sweepCalls(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, c := range s.calls {
		if !c.finished.IsZero() && now.Sub(c.finished) > asyncKeep {
			delete(s.calls, id)
		}
	}
}
