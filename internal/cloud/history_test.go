package cloud

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common/hexutil"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/wallet"
)

func TestHistorySignIn(t *testing.T) {
	w, err := wallet.Generate()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	msg, err := HistorySignInMessage("https://imference.com", w.Address(), now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(msg, "\n")
	if lines[0] != "imference.com wants you to sign in with your Ethereum account:" ||
		lines[1] != w.Address().Hex() || lines[3] != HistorySignInStatement ||
		lines[5] != "URI: https://imference.com/history" ||
		lines[9] != "Issued At: 2026-11-02T10:00:00Z" || lines[10] != "Expiration Time: 2026-11-02T11:00:00Z" {
		t.Fatalf("message:\n%s", msg)
	}
	sig, err := w.SignPersonal(msg)
	if err != nil {
		t.Fatal(err)
	}
	got, err := wallet.RecoverPersonalSigner(msg, hexutil.MustDecode(sig))
	if err != nil || got != w.Address() {
		t.Fatalf("recovered %s, %v", got.Hex(), err)
	}
}

func TestHistoryRequest(t *testing.T) {
	var seen *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		_, _ = w.Write([]byte(`{"data":[{"request_id":"r1","status":"done","outputs":[{"kind":"image","url":"https://b/x.png"}],"expired":false}],"next_cursor":"9","retention_hours":24}`))
	}))
	defer srv.Close()
	c := New(logbus.New())
	c.SetBaseURL(srv.URL)

	page, err := c.History(context.Background(), "", WalletAuthHeader("m", "0x01"), "12", 30)
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != "9" || len(page.Data) != 1 || page.Data[0].Outputs[0].URL != "https://b/x.png" {
		t.Fatalf("page %+v", page)
	}
	if seen.URL.Path != "/history" || seen.URL.Query().Get("cursor") != "12" || seen.URL.Query().Get("limit") != "30" {
		t.Fatalf("request %s", seen.URL)
	}
	raw, _ := base64.StdEncoding.DecodeString(seen.Header.Get("X-Wallet-Auth"))
	var body map[string]string
	if json.Unmarshal(raw, &body) != nil || body["message"] != "m" || seen.Header.Get("Authorization") != "" {
		t.Fatalf("headers %v", seen.Header)
	}

	if _, err := c.History(context.Background(), "key", "", "", 0); err != nil || seen.Header.Get("Authorization") != "Bearer key" {
		t.Fatalf("api key: %v %v", err, seen.Header)
	}
}
