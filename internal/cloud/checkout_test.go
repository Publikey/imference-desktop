package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStartCardCheckout(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/credits/add" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"client_secret":"cs_1","publishable_key":"pk_1","api_key":"im_new"}`))
	}))
	defer srv.Close()

	// A buyer without a key: none is sent, the API's new key comes back.
	co, err := StartCardCheckout(context.Background(), nil, srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	if co.ClientSecret != "cs_1" || co.PublishableKey != "pk_1" || co.APIKey != "im_new" {
		t.Fatalf("checkout = %+v", co)
	}
	if gotAuth != "" {
		t.Fatalf("no key: Authorization = %q, want none", gotAuth)
	}
	if gotBody["ui"] != "embedded" || gotBody["quantity"] != float64(1) {
		t.Fatalf("body = %v", gotBody)
	}

	// A top-up: the key goes as a Bearer token.
	if _, err := StartCardCheckout(context.Background(), nil, srv.URL, "im_old"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer im_old" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

func TestStartCardCheckoutError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"checkout unavailable"}`))
	}))
	defer srv.Close()
	if _, err := StartCardCheckout(context.Background(), nil, srv.URL, ""); err == nil || err.Error() != "checkout unavailable" {
		t.Fatalf("err = %v, want the API's message", err)
	}
}
