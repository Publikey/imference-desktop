package modelcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Store is a goroutine-safe JSON index of the cached weight files. It mirrors
// internal/cloudjobs.Store's shape (mutex, whole-file rewrite, tmp+rename) with
// one deliberate difference: the directory is injected rather than derived from
// os.UserConfigDir, which keeps it testable against t.TempDir().
//
// The index lives INSIDE the models directory, not with the settings:
//   - deleting settings.json leaves the cache description intact;
//   - wiping UserCacheDir takes the index and the weights together, so we never
//     end up with an index describing files a cleanup removed.
//
// The index is never the source of truth — Reconcile always lets the disk win.
type Store struct {
	mu      sync.Mutex
	dir     string
	path    string
	entries []Entry
	now     func() time.Time
}

// Entry is one cached weights file. Key is the filename inside dir and is the
// primary key. ModelCode is "" for a file whose provenance we couldn't
// establish (pre-cache leftover, or catalog unavailable at reconcile time).
type Entry struct {
	Key        string `json:"key"`
	ModelCode  string `json:"modelCode,omitempty"`
	ModelName  string `json:"modelName,omitempty"`
	URLHash    string `json:"urlHash,omitempty"`
	Bytes      int64  `json:"bytes"`
	AddedAt    string `json:"addedAt"`
	LastUsedAt string `json:"lastUsedAt"`
}

// CatalogRef is the subset of a catalog model Relabel needs.
type CatalogRef struct {
	ModelCode string
	ModelName string
	ModelURL  string
}

// Report summarises a Reconcile pass, for the log bus.
type Report struct {
	Indexed      int
	Dropped      int
	PartsRemoved int
	Orphans      int
	TotalBytes   int64
}

type indexFile struct {
	Version int     `json:"version"`
	Entries []Entry `json:"entries"`
}

const indexVersion = 1

// New opens (or starts) the index for the given models directory.
func New(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("modelcache: empty directory")
	}
	s := &Store{
		dir:  dir,
		path: filepath.Join(dir, IndexFileName),
		now:  time.Now,
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && len(data) == 0) {
		s.entries = nil
		return nil
	}
	if err != nil {
		return fmt.Errorf("modelcache: read %s: %w", s.path, err)
	}
	var f indexFile
	if jerr := json.Unmarshal(data, &f); jerr != nil {
		// A corrupt index must never wedge the app: start empty and let
		// Reconcile rebuild it from what's actually on disk.
		s.entries = nil
		return nil
	}
	s.entries = f.Entries
	return nil
}

// flush writes the current entries. Caller holds the mutex.
func (s *Store) flush() error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("modelcache: mkdir: %w", err)
	}
	data, err := json.MarshalIndent(indexFile{Version: indexVersion, Entries: s.entries}, "", "  ")
	if err != nil {
		return fmt.Errorf("modelcache: marshal: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("modelcache: write: %w", err)
	}
	return os.Rename(tmp, s.path) // atomic replace
}

// Dir returns the managed models directory.
func (s *Store) Dir() string { return s.dir }

// Path resolves a cache key to its absolute file path.
func (s *Store) Path(key string) string { return filepath.Join(s.dir, key) }

// List returns a copy of the entries, most recently used first.
func (s *Store) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, len(s.entries))
	copy(out, s.entries)
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastUsedAt > out[j].LastUsedAt })
	return out
}

// Get returns the entry for a key.
func (s *Store) Get(key string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.entries {
		if e.Key == key {
			return e, true
		}
	}
	return Entry{}, false
}

// Put upserts an entry by Key.
func (s *Store) Put(e Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.putLocked(e)
	return s.flush()
}

func (s *Store) putLocked(e Entry) {
	for i := range s.entries {
		if s.entries[i].Key == e.Key {
			// AddedAt records when the file first landed — an upsert (a
			// re-activation, a size correction) must not rewrite history.
			if s.entries[i].AddedAt != "" {
				e.AddedAt = s.entries[i].AddedAt
			}
			s.entries[i] = e
			return
		}
	}
	s.entries = append(s.entries, e)
}

// Touch marks an entry as just used — the LRU signal. No-op for unknown keys.
func (s *Store) Touch(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.entries {
		if s.entries[i].Key == key {
			s.entries[i].LastUsedAt = s.now().UTC().Format(time.RFC3339)
			return s.flush()
		}
	}
	return nil
}

// Delete drops an entry from the INDEX only. Removing the file is the caller's
// job (and must succeed first, so the index never overstates free space).
func (s *Store) Delete(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.entries[:0]
	changed := false
	for _, e := range s.entries {
		if e.Key == key {
			changed = true
			continue
		}
		kept = append(kept, e)
	}
	s.entries = kept
	if !changed {
		return nil
	}
	return s.flush()
}

// TotalBytes is the cache's indexed size.
func (s *Store) TotalBytes() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for _, e := range s.entries {
		n += e.Bytes
	}
	return n
}

// Reconcile aligns the index with what's actually on disk: indexes unknown
// weight files, drops entries whose file is gone, corrects stale sizes, and
// removes leftover .part files (there is no resume, and no download can be in
// flight at startup, so a .part is pure waste).
//
// protected holds absolute paths that must never be indexed — user-supplied
// checkpoints referenced in place. Keeping them out of the index is stronger
// than flagging them: the eviction planner can't see what isn't there, which
// covers the edge case of a custom checkpoint living inside the models dir.
func (s *Store) Reconcile(protected map[string]bool) (Report, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rep := Report{}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return rep, fmt.Errorf("modelcache: mkdir: %w", err)
	}
	dirents, err := os.ReadDir(s.dir)
	if err != nil {
		return rep, fmt.Errorf("modelcache: read dir: %w", err)
	}

	onDisk := map[string]int64{}
	for _, de := range dirents {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		full := filepath.Join(s.dir, name)

		if strings.HasSuffix(name, ".part") {
			if os.Remove(full) == nil {
				rep.PartsRemoved++
			}
			continue
		}
		if !IsWeightsFile(name) || protected[full] {
			continue
		}
		fi, ferr := de.Info()
		if ferr != nil {
			continue
		}
		onDisk[name] = fi.Size()

		if _, known := s.getLocked(name); !known {
			stamp := fi.ModTime().UTC().Format(time.RFC3339)
			s.putLocked(Entry{Key: name, Bytes: fi.Size(), AddedAt: stamp, LastUsedAt: stamp})
			rep.Indexed++
		}
	}

	// Drop vanished files (deleted by hand) and correct sizes that drifted.
	kept := s.entries[:0]
	for _, e := range s.entries {
		size, present := onDisk[e.Key]
		if !present {
			rep.Dropped++
			continue
		}
		if e.Bytes != size {
			e.Bytes = size
		}
		if e.ModelCode == "" {
			rep.Orphans++
		}
		rep.TotalBytes += e.Bytes
		kept = append(kept, e)
	}
	s.entries = kept

	return rep, s.flush()
}

func (s *Store) getLocked(key string) (Entry, bool) {
	for _, e := range s.entries {
		if e.Key == key {
			return e, true
		}
	}
	return Entry{}, false
}

// Relabel attaches catalog identity to orphaned entries and migrates legacy
// filenames to the canonical scheme, renaming the file on disk. Returns the
// renames performed (old key → new key) so the caller can re-point any setting
// holding the old path.
//
// Best-effort by design: it needs the catalog, so an offline launch simply
// skips it and the files stay usable under their legacy names until next time.
// A failed rename keeps the entry under its old key rather than losing it.
func (s *Store) Relabel(models []CatalogRef) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Both naming schemes point at the same catalog entry.
	byName := map[string]CatalogRef{}
	for _, m := range models {
		if m.ModelURL == "" {
			continue
		}
		byName[FileName(m.ModelCode, m.ModelURL)] = m
		if legacy := LegacyFileName(m.ModelURL); legacy != "" {
			// Canonical wins if both map to the same name (can't happen today,
			// but the fallback name is shared by every URL without a basename).
			if _, taken := byName[legacy]; !taken {
				byName[legacy] = m
			}
		}
	}

	renamed := map[string]string{}
	changed := false
	for i := range s.entries {
		e := s.entries[i]
		ref, ok := byName[e.Key]
		if !ok {
			continue
		}
		canonical := FileName(ref.ModelCode, ref.ModelURL)

		if e.Key != canonical {
			if err := os.Rename(filepath.Join(s.dir, e.Key), filepath.Join(s.dir, canonical)); err != nil {
				// Keep the legacy name — still perfectly usable.
				if e.ModelCode == "" {
					s.entries[i].ModelCode, s.entries[i].ModelName = ref.ModelCode, ref.ModelName
					s.entries[i].URLHash = URLHash(ref.ModelURL)
					changed = true
				}
				continue
			}
			renamed[e.Key] = canonical
			s.entries[i].Key = canonical
			changed = true
		}
		if s.entries[i].ModelCode != ref.ModelCode || s.entries[i].URLHash != URLHash(ref.ModelURL) {
			s.entries[i].ModelCode, s.entries[i].ModelName = ref.ModelCode, ref.ModelName
			s.entries[i].URLHash = URLHash(ref.ModelURL)
			changed = true
		}
	}
	if !changed {
		return renamed, nil
	}
	return renamed, s.flush()
}
