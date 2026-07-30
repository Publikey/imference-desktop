// Package cloudjobs persists in-flight cloud generations to disk so they
// survive an app close, crash, or poll timeout. A cloud generation's result
// lives server-side forever (retrievable by request_id), but the desktop only
// held the request_id in the memory of one blocking call — closing the app lost
// it, orphaning a paid-for generation. This store records each request_id at
// enqueue and drops it on completion; the app resumes any leftovers on launch.
package cloudjobs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"imference-desktop-go/internal/types"
)

const (
	appDirName = "imference-desktop-go"
	fileName   = "pending-cloud.json"
)

// Store is a goroutine-safe JSON-file list of pending cloud jobs. It mirrors
// internal/settings.Store's shape (UserConfigDir, mutex, whole-file rewrite) —
// the set is tiny (jobs in flight), so simplicity beats an embedded DB.
type Store struct {
	mu    sync.Mutex
	path  string
	cache []types.PendingCloudJob
}

func New() (*Store, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("cloudjobs: locate UserConfigDir: %w", err)
	}
	s := &Store{path: filepath.Join(dir, appDirName, fileName)}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		s.cache = nil
		return nil
	}
	if err != nil {
		return fmt.Errorf("cloudjobs: read %s: %w", s.path, err)
	}
	if len(data) == 0 {
		s.cache = nil
		return nil
	}
	if err := json.Unmarshal(data, &s.cache); err != nil {
		// A corrupt file shouldn't wedge the app — start clean (worst case we
		// lose the ability to resume, which is what corruption already means).
		s.cache = nil
	}
	return nil
}

// flush writes the current cache. Caller holds the mutex.
func (s *Store) flush() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("cloudjobs: mkdir: %w", err)
	}
	data, err := json.MarshalIndent(s.cache, "", "  ")
	if err != nil {
		return fmt.Errorf("cloudjobs: marshal: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("cloudjobs: write: %w", err)
	}
	return os.Rename(tmp, s.path) // atomic replace
}

// Add records a new pending job (replacing any with the same JobID).
func (s *Store) Add(job types.PendingCloudJob) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.cache[:0]
	for _, j := range s.cache {
		if j.JobID != job.JobID {
			kept = append(kept, j)
		}
	}
	s.cache = append(kept, job)
	return s.flush()
}

// Remove drops the job with the given id (no-op if absent).
func (s *Store) Remove(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.cache[:0]
	changed := false
	for _, j := range s.cache {
		if j.JobID == jobID {
			changed = true
			continue
		}
		kept = append(kept, j)
	}
	s.cache = kept
	if !changed {
		return nil
	}
	return s.flush()
}

// List returns a copy of the pending jobs.
func (s *Store) List() []types.PendingCloudJob {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]types.PendingCloudJob, len(s.cache))
	copy(out, s.cache)
	return out
}
