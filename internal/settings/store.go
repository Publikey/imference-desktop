// Package settings persists user-facing config (API key, Python venv path,
// SDXL weights path, cloud model_code) to a JSON file under the user's OS
// config directory.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sync"

	"imference-desktop-go/internal/types"
)

const appDirName = "imference-desktop-go"
const fileName = "settings.json"

// Store is goroutine-safe — Wails may invoke bound methods from multiple
// goroutines and the sidecar manager reads the path on every restart, so
// every access goes through the mutex.
type Store struct {
	mu    sync.RWMutex
	path  string
	cache types.Settings
}

// New loads existing settings from disk (or returns defaults if the file is
// missing). It does NOT fail when the file is missing — first-boot users
// start with empty settings and use the SettingsDialog to fill them in.
func New() (*Store, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("settings: locate UserConfigDir: %w", err)
	}
	path := filepath.Join(dir, appDirName, fileName)

	s := &Store{path: path}
	if err := s.reload(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) reload() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		s.cache = types.Settings{} // defaults: all empty
		return nil
	}
	if err != nil {
		return fmt.Errorf("settings: read %s: %w", s.path, err)
	}
	var parsed types.Settings
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("settings: parse %s: %w", s.path, err)
	}
	s.cache = parsed
	return nil
}

// Get returns a copy of the current settings.
func (s *Store) Get() types.Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cache
}

// Save overwrites the on-disk file with the given settings (atomic via
// write-temp + rename). Returns the saved value for symmetry with the
// frontend, which echoes the response into its local state.
func (s *Store) Save(next types.Settings) (types.Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return types.Settings{}, fmt.Errorf("settings: mkdir: %w", err)
	}

	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return types.Settings{}, fmt.Errorf("settings: marshal: %w", err)
	}

	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return types.Settings{}, fmt.Errorf("settings: write tmp: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return types.Settings{}, fmt.Errorf("settings: rename tmp: %w", err)
	}

	s.cache = next
	return s.cache, nil
}

// SidecarConfigChanged tells the caller whether a Save() should trigger a
// sidecar restart. pythonPath/sdxlPath change the interpreter or weights, and
// the engine-runtime knobs only take effect at engine load() — all three need a
// restart. apiKey and cloudModel are read fresh on every cloud request, so they
// don't. (LocalModel changes go through SelectLocalModel, which restarts itself.)
func SidecarConfigChanged(prev, next types.Settings) bool {
	return prev.PythonPath != next.PythonPath ||
		prev.SDXLPath != next.SDXLPath ||
		!reflect.DeepEqual(prev.EngineRuntime, next.EngineRuntime)
}
