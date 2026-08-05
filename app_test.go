package main

import (
	"testing"
	"time"

	"imference-desktop-go/internal/types"
)

// A pending cloud record must eventually die. The interesting cases are the
// boundary and the missing timestamp — an unparseable CreatedAt has to count as
// expired, otherwise the record is unbounded, which is the bug this guards.
func TestPendingCloudExpired(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }

	cases := []struct {
		name    string
		created string
		want    bool
	}{
		{"just enqueued", at(0), false},
		{"within budget", at(30 * time.Minute), false},
		{"just under the cap", at(pendingCloudMaxAge - time.Minute), false},
		{"just over the cap", at(pendingCloudMaxAge + time.Minute), true},
		{"stuck for days", at(4 * 24 * time.Hour), true},
		{"empty timestamp", "", true},
		{"garbage timestamp", "not-a-date", true},
		{"clock skew — created in the future", at(-time.Hour), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := pendingCloudExpired(types.PendingCloudJob{CreatedAt: c.created}, now)
			if got != c.want {
				t.Errorf("pendingCloudExpired(%q) = %v, want %v", c.created, got, c.want)
			}
		})
	}
}
