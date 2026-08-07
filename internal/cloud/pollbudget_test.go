package cloud

import (
	"testing"
	"time"
)

// One budget for the whole catalog. The split it replaced (10 min image / 20 min
// video) keyed off the media kind the SERVER reported at enqueue, and /generate
// classifies video by engine — so a video model on an engine it didn't know came
// back tagged "image" and its clip died mid-queue on the short budget. There is
// no kind in this decision any more, so that class of bug can't come back.
func TestPollBudgetIsUniform(t *testing.T) {
	// A busy queue is measured in tens of minutes; anything under half an hour
	// starts abandoning generations the user already paid for.
	if pollBudget < 30*time.Minute {
		t.Errorf("pollBudget = %v — too short for a loaded queue", pollBudget)
	}
	// The cap only exists so an unresolvable job can't be polled forever, and a
	// pending record is dropped at pendingCloudMaxAge (6 h) regardless. Well
	// inside that bound, so a timed-out job still gets later resume attempts.
	if pollBudget >= 6*time.Hour {
		t.Errorf("pollBudget = %v — must stay well inside the pending record's life", pollBudget)
	}
}

// The backoff is what makes a long budget cheap: without it, 45 minutes at one
// request a second is ~2700 status calls for a job that hasn't moved.
func TestEaseOffPolling(t *testing.T) {
	tk := time.NewTicker(pollInterval)
	defer tk.Stop()
	if eased := easeOffPolling(tk, time.Now(), false); eased {
		t.Error("eased immediately — the first seconds must stay fast so a cached result feels instant")
	}
	if eased := easeOffPolling(tk, time.Now().Add(-pollBackoffAfter-time.Second), false); !eased {
		t.Error("did not ease off after the backoff point")
	}
	// Re-arming a ticker on every tick would defeat the point; once eased, stay eased.
	if eased := easeOffPolling(tk, time.Now().Add(-time.Hour), true); !eased {
		t.Error("un-eased itself")
	}
	if pollIntervalBackoff <= pollInterval {
		t.Error("the backoff interval must be slower than the initial one")
	}
	if got := int(pollBudget / pollIntervalBackoff); got > 700 {
		t.Errorf("a full budget costs ~%d status requests — too chatty", got)
	}
}
