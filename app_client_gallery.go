package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"

	"imference-desktop-go/internal/types"
)

// ClientGalleryItem is a finished cloud result waiting for the browser to save
// it into the user's gallery folder (web build, client gallery).
type ClientGalleryItem struct {
	JobID  string                 `json:"jobId"`
	Result types.GenerationResult `json:"result"`
}

// outboxAdd persists a resumed cloud result until the browser takes it, so a
// generation that finishes while every tab is closed is not lost.
func (a *App) outboxAdd(jobID string, result types.GenerationResult) {
	if a.outboxPath == "" {
		return
	}
	a.outboxMu.Lock()
	defer a.outboxMu.Unlock()
	items := a.outboxLoadLocked()
	items = append(items, ClientGalleryItem{JobID: jobID, Result: result})
	if err := a.outboxWriteLocked(items); err != nil {
		a.bus.Warn("app", "gallery outbox not written", map[string]any{"err": err.Error()})
	}
}

// TakeClientGalleryOutbox returns and clears the results waiting for the
// browser (web build). Always an empty list on the desktop.
func (a *App) TakeClientGalleryOutbox() []ClientGalleryItem {
	if a.outboxPath == "" {
		return []ClientGalleryItem{}
	}
	a.outboxMu.Lock()
	defer a.outboxMu.Unlock()
	items := a.outboxLoadLocked()
	if len(items) > 0 {
		if err := os.Remove(a.outboxPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			a.bus.Warn("app", "gallery outbox not cleared", map[string]any{"err": err.Error()})
		}
	}
	return items
}

func (a *App) outboxLoadLocked() []ClientGalleryItem {
	items := []ClientGalleryItem{}
	raw, err := os.ReadFile(a.outboxPath)
	if err != nil {
		return items
	}
	_ = json.Unmarshal(raw, &items)
	return items
}

func (a *App) outboxWriteLocked(items []ClientGalleryItem) error {
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	tmp := a.outboxPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.outboxPath)
}
