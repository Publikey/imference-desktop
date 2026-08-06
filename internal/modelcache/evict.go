package modelcache

import (
	"sort"
	"time"
)

// DefaultQuotaBytes bounds the total size of the weights cache. Models run
// 2–7 GB, so this holds a comfortable working set without a laptop SSD filling
// up unnoticed. Overridable in Settings.
const DefaultQuotaBytes int64 = 100 << 30 // 100 GiB

// Candidate is one cached file offered to the eviction planner.
type Candidate struct {
	Key      string
	Bytes    int64
	LastUsed time.Time
	// Orphan marks a file with no known provenance (no model code) — a leftover
	// from an older build or an interrupted switch. Pure waste, evicted first.
	Orphan bool
	// Protected excludes the file from eviction entirely: the active model
	// (mmap'd by the running engine) and the download currently in flight.
	Protected bool
}

// Plan is the outcome of PlanEviction. Shortfall > 0 means even evicting
// everything evictable leaves the cache over quota once incoming lands.
type Plan struct {
	Evict     []string
	Freed     int64
	Shortfall int64
}

// PlanEviction decides which cached files to drop so that
// currentBytes - freed + incomingBytes fits within quotaBytes. It performs no
// I/O — the caller deletes the files and updates the index.
//
// Candidates are consumed orphans-first (pure waste, and never the active
// model), then least-recently-used, then largest-first so fewer deletions
// reclaim the same space, then by key for deterministic tests.
//
// A positive Shortfall is NOT an error: the caller should log it and proceed.
// The quota is a housekeeping target, not a wall — refusing a download because
// the active model alone exceeds the quota would wedge the app with no obvious
// remedy. Free disk space is the wall; that check lives at the call site.
func PlanEviction(cands []Candidate, currentBytes, incomingBytes, quotaBytes int64) Plan {
	if quotaBytes <= 0 {
		quotaBytes = DefaultQuotaBytes
	}
	need := currentBytes + incomingBytes - quotaBytes
	if need <= 0 {
		return Plan{}
	}

	evictable := make([]Candidate, 0, len(cands))
	for _, c := range cands {
		if !c.Protected {
			evictable = append(evictable, c)
		}
	}
	sort.Slice(evictable, func(i, j int) bool {
		a, b := evictable[i], evictable[j]
		if a.Orphan != b.Orphan {
			return a.Orphan // orphans first
		}
		if !a.LastUsed.Equal(b.LastUsed) {
			return a.LastUsed.Before(b.LastUsed) // least recently used first
		}
		if a.Bytes != b.Bytes {
			return a.Bytes > b.Bytes // bigger first: fewer deletions for the same space
		}
		return a.Key < b.Key
	})

	plan := Plan{}
	for _, c := range evictable {
		if plan.Freed >= need {
			break
		}
		plan.Evict = append(plan.Evict, c.Key)
		plan.Freed += c.Bytes
	}
	if plan.Freed < need {
		plan.Shortfall = need - plan.Freed
	}
	return plan
}

// BuildCandidates turns index entries into eviction candidates, protecting the
// active model and the download in flight. This is where the "never evict what
// the engine has open" guarantee is expressed — keep it a pure function so it
// stays under test. Either key may be "" (nothing active / nothing incoming).
func BuildCandidates(entries []Entry, activeKey, targetKey string) []Candidate {
	out := make([]Candidate, 0, len(entries))
	for _, e := range entries {
		lastUsed, err := time.Parse(time.RFC3339, e.LastUsedAt)
		if err != nil {
			// An unparseable timestamp must not make an entry immortal: treat it
			// as infinitely old so it is evicted before anything with a real date.
			lastUsed = time.Time{}
		}
		out = append(out, Candidate{
			Key:       e.Key,
			Bytes:     e.Bytes,
			LastUsed:  lastUsed,
			Orphan:    e.ModelCode == "",
			Protected: (activeKey != "" && e.Key == activeKey) || (targetKey != "" && e.Key == targetKey),
		})
	}
	return out
}
