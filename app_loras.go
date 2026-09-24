package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"imference-desktop-go/internal/loras"
	"imference-desktop-go/internal/types"
)

// maxLorasPerGeneration stays below the engine's per-pipe adapter cache
// (MAX_CACHED_LORAS, default 5): a request stacking more than the cache holds
// would evict its own adapters.
const maxLorasPerGeneration = 4

// PickLoraFile opens the native file picker filtered to .safetensors and
// returns the chosen absolute path, or "" when the user cancels.
func (a *App) PickLoraFile() (string, error) {
	if a.app == nil {
		return "", errors.New("app not ready")
	}
	path, err := a.app.Dialog.OpenFile().
		SetTitle("Choose a LoRA (.safetensors)").
		AddFilter("Safetensors LoRA", "*.safetensors").
		PromptForSingleSelection()
	if err != nil {
		a.bus.Info("app", "PickLoraFile cancelled/failed", map[string]any{"err": err.Error()})
		return "", nil
	}
	return path, nil
}

// AddLora registers a LoRA file in the library (referenced in place — never
// copied, never deleted). Its family is read from the safetensors header so
// the UI can offer it only with compatible models.
func (a *App) AddLora(path string) (types.Settings, error) {
	if !strings.EqualFold(filepath.Ext(path), ".safetensors") {
		return types.Settings{}, errors.New("not a .safetensors file")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return types.Settings{}, fmt.Errorf("file not found: %s", path)
	}
	if fi.Size() >= customModelMinBytes {
		return types.Settings{}, errors.New("this file is too large to be a LoRA — use it as a custom model instead")
	}
	info, err := loras.Inspect(path)
	if err != nil {
		return types.Settings{}, fmt.Errorf("unreadable LoRA: %w", err)
	}

	base := filepath.Base(path)
	entry := types.LoraEntry{
		Path:               path,
		Name:               strings.TrimSuffix(base, filepath.Ext(base)),
		Family:             info.Family,
		SizeBytes:          fi.Size(),
		TriggerWords:       info.TriggerWords,
		TextEncoderTrained: info.TextEncoderTrained,
	}
	s := a.settings.Get()
	kept := []types.LoraEntry{entry} // upsert by path, newest first
	for _, l := range s.Loras {
		if l.Path != path {
			kept = append(kept, l)
		}
	}
	s.Loras = kept
	saved, err := a.settings.Save(s)
	if err != nil {
		return types.Settings{}, err
	}
	a.bus.Info("app", "LoRA added", map[string]any{
		"path": path, "family": info.Family, "reason": info.Reason,
	})
	return saved, nil
}

// RemoveLora drops a LoRA from the library. The file itself is left on disk.
func (a *App) RemoveLora(path string) (types.Settings, error) {
	s := a.settings.Get()
	kept := s.Loras[:0:0]
	for _, l := range s.Loras {
		if l.Path != path {
			kept = append(kept, l)
		}
	}
	s.Loras = kept
	return a.settings.Save(s)
}

// validateLoras checks a local request's LoRAs before they reach the sidecar:
// the backend must support them, each file must be a library entry that still
// exists, and its family must match the model. Names are filled from the
// library for the saved image metadata.
func (a *App) validateLoras(req *types.GenerationRequest) error {
	if len(req.Loras) == 0 {
		return nil
	}
	s := a.settings.Get()
	backend := ""
	if s.LocalModel != nil {
		backend = s.LocalModel.BackendType
	}
	if !loras.BackendSupports(backend) {
		return fmt.Errorf("LoRAs are not supported for %q models yet", backend)
	}
	if len(req.Loras) > maxLorasPerGeneration {
		return fmt.Errorf("at most %d LoRAs per generation", maxLorasPerGeneration)
	}
	library := make(map[string]types.LoraEntry, len(s.Loras))
	for _, l := range s.Loras {
		library[l.Path] = l
	}
	for i, ref := range req.Loras {
		entry, ok := library[ref.Path]
		if !ok {
			return fmt.Errorf("LoRA %s is not in the library", filepath.Base(ref.Path))
		}
		if _, err := os.Stat(ref.Path); err != nil {
			return fmt.Errorf("LoRA file missing: %s", ref.Path)
		}
		if !loras.Compatible(entry.Family, backend) {
			return fmt.Errorf("LoRA %s is for %s models, not %s", entry.Name, entry.Family, backend)
		}
		req.Loras[i].Name = entry.Name
	}
	return nil
}
