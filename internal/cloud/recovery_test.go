package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"imference-desktop-go/internal/logbus"
)

func TestRecoveryEmail(t *testing.T) {
	linked := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/key/email" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer im_k" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`"access unauthorized"`))
			return
		}
		switch r.Method {
		case http.MethodGet:
			if linked == "" {
				_, _ = w.Write([]byte(`{"email_masked":null}`))
			} else {
				_, _ = w.Write([]byte(`{"email_masked":"` + linked + `"}`))
			}
		case http.MethodPost:
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["email"] == "bad" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"Enter a valid email address."}`))
				return
			}
			linked = "j***@example.com"
			_, _ = w.Write([]byte(`{"message":"Done: linked"}`))
		case http.MethodDelete:
			linked = ""
			_, _ = w.Write([]byte(`{"email_masked":null}`))
		}
	}))
	defer srv.Close()
	c := New(logbus.New())
	c.SetBaseURL(srv.URL)
	ctx := context.Background()

	if got, err := c.GetRecoveryEmail(ctx, "im_k"); err != nil || got != "" {
		t.Fatalf("none yet: %q %v", got, err)
	}
	if msg, err := c.AddRecoveryEmail(ctx, "im_k", " joe@example.com "); err != nil || msg != "Done: linked" {
		t.Fatalf("add: %q %v", msg, err)
	}
	if got, _ := c.GetRecoveryEmail(ctx, "im_k"); got != "j***@example.com" {
		t.Fatalf("after add: %q", got)
	}
	if _, err := c.AddRecoveryEmail(ctx, "im_k", "bad"); err == nil || err.Error() != "Enter a valid email address." {
		t.Fatalf("server error not surfaced: %v", err)
	}
	if err := c.RemoveRecoveryEmail(ctx, "im_k"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetRecoveryEmail(ctx, "im_other"); err == nil {
		t.Fatal("an unknown key must be an error")
	}
	if _, err := c.GetRecoveryEmail(ctx, ""); err == nil {
		t.Fatal("no key must be an error")
	}
}
