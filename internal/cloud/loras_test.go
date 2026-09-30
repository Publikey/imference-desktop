package cloud

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"imference-desktop-go/internal/logbus"
)

func TestListLoras(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		if r.URL.Query().Get("model") == "nope" {
			http.Error(w, `{"error":"unknown model: nope"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"loras":[
			{"lora_code":"detail-tweaker-xl","name":"Detail Tweaker XL","im_engine":"sdxl","model_family_code":"sdxl",
			 "compatible_family_codes":["sdxl"],"lora_url":"https://cdn/x.safetensors","sha256":"AB","size_bytes":228452344,
			 "trigger_words":[],"text_encoder_trained":true,"weight_default":1.5,"weight_min":-3,"weight_max":3,"im_local":true},
			{"lora_code":"cloud-only","name":"C","im_engine":"sdxl","model_family_code":"sdxl","compatible_family_codes":["sdxl"],
			 "lora_url":"u","trigger_words":[],"weight_default":1,"weight_min":0,"weight_max":1,"im_local":false}
		]}`))
	}))
	defer srv.Close()
	c := New(logbus.New())
	c.base = srv.URL

	list, err := c.ListLoras(t.Context(), "cyberrealistic-xl")
	if err != nil {
		t.Fatal(err)
	}
	if gotQuery != "model=cyberrealistic-xl" {
		t.Errorf("query = %q", gotQuery)
	}
	if len(list) != 1 {
		t.Fatalf("im_local=false must be dropped, got %d loras", len(list))
	}
	l := list[0]
	if l.Code != "detail-tweaker-xl" || l.WeightDefault != 1.5 || l.WeightMin != -3 || l.WeightMax != 3 ||
		l.SizeBytes != 228452344 || l.TextEncoderTrained == nil || !*l.TextEncoderTrained {
		t.Errorf("unexpected mapping: %+v", l)
	}

	if _, err := c.ListLoras(t.Context(), "nope"); !errors.Is(err, ErrUnknownModel) {
		t.Errorf("unknown model: want ErrUnknownModel, got %v", err)
	}
}
