package modelcache

import (
	"testing"
	"time"
)

const gb = int64(1) << 30

func at(daysAgo int) time.Time {
	return time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC).AddDate(0, 0, -daysAgo)
}

func keys(p Plan) string {
	out := ""
	for i, k := range p.Evict {
		if i > 0 {
			out += ","
		}
		out += k
	}
	return out
}

func TestPlanEvictionNoopUnderQuota(t *testing.T) {
	cands := []Candidate{{Key: "a", Bytes: 5 * gb, LastUsed: at(9)}}
	got := PlanEviction(cands, 5*gb, 5*gb, 100*gb)
	if len(got.Evict) != 0 || got.Freed != 0 || got.Shortfall != 0 {
		t.Errorf("expected empty plan, got %+v", got)
	}
}

func TestPlanEvictionExactBoundaryDoesNotEvict(t *testing.T) {
	// current + incoming == quota: fits exactly, nothing to do.
	got := PlanEviction([]Candidate{{Key: "a", Bytes: 5 * gb, LastUsed: at(9)}}, 15*gb, 5*gb, 20*gb)
	if len(got.Evict) != 0 {
		t.Errorf("evicted at the exact boundary: %+v", got)
	}
}

func TestPlanEvictionStopsAsSoonAsItFits(t *testing.T) {
	cands := []Candidate{
		{Key: "old", Bytes: 6 * gb, LastUsed: at(30)},
		{Key: "mid", Bytes: 6 * gb, LastUsed: at(20)},
		{Key: "new", Bytes: 6 * gb, LastUsed: at(1)},
	}
	got := PlanEviction(cands, 18*gb, 6*gb, 20*gb) // need 4 GB → one file is enough
	if keys(got) != "old" {
		t.Errorf("Evict = %q, want \"old\"", keys(got))
	}
	if got.Shortfall != 0 {
		t.Errorf("Shortfall = %d, want 0", got.Shortfall)
	}
}

func TestPlanEvictionNeverTouchesProtected(t *testing.T) {
	cands := []Candidate{
		// The active model is the oldest AND the largest — still untouchable.
		{Key: "active", Bytes: 40 * gb, LastUsed: at(365), Protected: true},
		{Key: "target", Bytes: 7 * gb, LastUsed: at(300), Protected: true},
		{Key: "other", Bytes: 5 * gb, LastUsed: at(2)},
	}
	got := PlanEviction(cands, 52*gb, 7*gb, 20*gb)
	if keys(got) != "other" {
		t.Errorf("Evict = %q, want only \"other\"", keys(got))
	}
	if got.Shortfall <= 0 {
		t.Error("expected a shortfall once only protected files remain")
	}
}

func TestPlanEvictionOrphansGoFirst(t *testing.T) {
	cands := []Candidate{
		{Key: "known-ancient", Bytes: 5 * gb, LastUsed: at(400)},
		{Key: "orphan-fresh", Bytes: 5 * gb, LastUsed: at(1), Orphan: true},
	}
	got := PlanEviction(cands, 10*gb, 5*gb, 10*gb)
	if len(got.Evict) == 0 || got.Evict[0] != "orphan-fresh" {
		t.Errorf("Evict = %q, want orphan first", keys(got))
	}
}

func TestPlanEvictionLRUOrderThenSizeThenKey(t *testing.T) {
	cands := []Candidate{
		{Key: "c", Bytes: 1 * gb, LastUsed: at(5)},
		{Key: "a", Bytes: 2 * gb, LastUsed: at(5)}, // same date, bigger → first
		{Key: "b", Bytes: 2 * gb, LastUsed: at(5)}, // same date and size → key order
		{Key: "z", Bytes: 9 * gb, LastUsed: at(1)},
	}
	got := PlanEviction(cands, 14*gb, 10*gb, 10*gb) // need 14 GB → everything
	if keys(got) != "a,b,c,z" {
		t.Errorf("Evict = %q, want \"a,b,c,z\"", keys(got))
	}
}

func TestPlanEvictionShortfallWithNothingEvictable(t *testing.T) {
	got := PlanEviction(nil, 10*gb, 15*gb, 20*gb)
	if len(got.Evict) != 0 {
		t.Errorf("Evict = %q, want empty", keys(got))
	}
	if got.Shortfall != 5*gb {
		t.Errorf("Shortfall = %d, want %d", got.Shortfall, 5*gb)
	}
}

// An incoming model bigger than the whole quota must not panic and must not
// leave the caller thinking it succeeded.
func TestPlanEvictionIncomingExceedsQuota(t *testing.T) {
	cands := []Candidate{{Key: "a", Bytes: 3 * gb, LastUsed: at(9)}}
	got := PlanEviction(cands, 3*gb, 30*gb, 10*gb)
	if keys(got) != "a" {
		t.Errorf("Evict = %q, want \"a\"", keys(got))
	}
	if got.Shortfall != 20*gb {
		t.Errorf("Shortfall = %d, want %d", got.Shortfall, 20*gb)
	}
}

// A zero/negative quota means "unset", not "evict everything".
func TestPlanEvictionZeroQuotaUsesDefault(t *testing.T) {
	cands := []Candidate{{Key: "a", Bytes: 5 * gb, LastUsed: at(9)}}
	for _, q := range []int64{0, -1} {
		if got := PlanEviction(cands, 5*gb, 5*gb, q); len(got.Evict) != 0 {
			t.Errorf("quota=%d evicted %q, want nothing", q, keys(got))
		}
	}
}

func TestBuildCandidatesProtectsActiveAndTarget(t *testing.T) {
	entries := []Entry{
		{Key: "active.safetensors", Bytes: gb, ModelCode: "m1", LastUsedAt: at(1).Format(time.RFC3339)},
		{Key: "target.safetensors", Bytes: gb, ModelCode: "m2", LastUsedAt: at(2).Format(time.RFC3339)},
		{Key: "free.safetensors", Bytes: gb, ModelCode: "m3", LastUsedAt: at(3).Format(time.RFC3339)},
		{Key: "orphan.safetensors", Bytes: gb, LastUsedAt: at(4).Format(time.RFC3339)},
	}
	got := BuildCandidates(entries, "active.safetensors", "target.safetensors")
	want := map[string]struct{ prot, orph bool }{
		"active.safetensors": {true, false},
		"target.safetensors": {true, false},
		"free.safetensors":   {false, false},
		"orphan.safetensors": {false, true},
	}
	for _, c := range got {
		w := want[c.Key]
		if c.Protected != w.prot || c.Orphan != w.orph {
			t.Errorf("%s: protected=%v orphan=%v, want %v/%v", c.Key, c.Protected, c.Orphan, w.prot, w.orph)
		}
	}
}

// An unparseable timestamp must not make an entry immortal.
func TestBuildCandidatesBadTimestampSortsOldest(t *testing.T) {
	entries := []Entry{
		{Key: "bad.safetensors", Bytes: gb, ModelCode: "m1", LastUsedAt: "not-a-date"},
		{Key: "good.safetensors", Bytes: gb, ModelCode: "m2", LastUsedAt: at(999).Format(time.RFC3339)},
	}
	got := PlanEviction(BuildCandidates(entries, "", ""), 2*gb, gb, 2*gb)
	if len(got.Evict) == 0 || got.Evict[0] != "bad.safetensors" {
		t.Errorf("Evict = %q, want the undated entry first", keys(got))
	}
}

// Nothing is protected when there is no active model and no download.
func TestBuildCandidatesEmptyKeysProtectNothing(t *testing.T) {
	entries := []Entry{{Key: "a.safetensors", ModelCode: "m", LastUsedAt: at(1).Format(time.RFC3339)}}
	for _, c := range BuildCandidates(entries, "", "") {
		if c.Protected {
			t.Errorf("%s protected with empty active/target keys", c.Key)
		}
	}
}
