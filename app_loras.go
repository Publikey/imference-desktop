package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"imference-desktop-go/internal/loras"
	"imference-desktop-go/internal/modelfetch"
	"imference-desktop-go/internal/types"
)

// maxLorasPerGeneration stays below the engine's per-pipe adapter cache
// (MAX_CACHED_LORAS, default 5): a request stacking more than the cache holds
// would evict its own adapters.
const maxLorasPerGeneration = 4

// loraDownloads holds the catalog codes being downloaded, so a double click
// can't start the same transfer twice.
var loraDownloads sync.Map

// lorasDir is where catalog LoRAs are downloaded (next to the models cache:
// regenerable assets, not roamable config). Local imports stay where they are.
func lorasDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate UserCacheDir: %w", err)
	}
	return filepath.Join(cache, "imference-desktop-go", "loras"), nil
}

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
	saved, err := a.upsertLora(entry)
	if err != nil {
		return types.Settings{}, err
	}
	a.bus.Info("app", "LoRA added", map[string]any{
		"path": path, "family": info.Family, "reason": info.Reason,
	})
	return saved, nil
}

// upsertLora puts entry first in the library, replacing any entry with the
// same path.
func (a *App) upsertLora(entry types.LoraEntry) (types.Settings, error) {
	s := a.settings.Get()
	kept := []types.LoraEntry{entry}
	for _, l := range s.Loras {
		if l.Path != entry.Path {
			kept = append(kept, l)
		}
	}
	s.Loras = kept
	return a.settings.Save(s)
}

// RemoveLora drops a LoRA from the library. A local import's file is left on
// disk; a downloaded catalog LoRA's file (Managed) is deleted.
func (a *App) RemoveLora(path string) (types.Settings, error) {
	s := a.settings.Get()
	kept := s.Loras[:0:0]
	for _, l := range s.Loras {
		if l.Path != path {
			kept = append(kept, l)
			continue
		}
		if l.Managed && isInLorasDir(l.Path) {
			if err := os.Remove(l.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				a.bus.Warn("app", "could not delete LoRA file", map[string]any{"path": l.Path, "err": err.Error()})
			}
		}
	}
	s.Loras = kept
	return a.settings.Save(s)
}

// isInLorasDir guards the delete: only files inside the managed folder go.
func isInLorasDir(path string) bool {
	dir, err := lorasDir()
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// ListCatalogLoras returns every curated LoRA the local engine can run, whatever
// the active model: the picker shows them all and marks which ones fit (engine
// + catalog family, same rule as validateLoras) so the catalog reads as a whole.
func (a *App) ListCatalogLoras() ([]types.CatalogLora, error) {
	return a.cloud.ListLoras(a.ctx, "", true)
}

// ListCloudLoras returns every curated LoRA imference runs in the cloud; the
// picker marks which ones fit the selected cloud model. Nothing is downloaded:
// imference applies them on its workers (and re-checks compatibility).
func (a *App) ListCloudLoras() ([]types.CatalogLora, error) {
	return a.cloud.ListLoras(a.ctx, "", false)
}

// DownloadCatalogLora downloads a curated LoRA into the managed folder, checks
// its SHA256 and header, and adds it to the library with the catalog's
// pre-config. Returns immediately; progress streams on "lora:progress"
// ({done:true} ends it, with error set on failure).
func (a *App) DownloadCatalogLora(code string) error {
	all, err := a.cloud.ListLoras(a.ctx, "", true)
	if err != nil {
		return err
	}
	var chosen *types.CatalogLora
	for i := range all {
		if all[i].Code == code {
			chosen = &all[i]
			break
		}
	}
	if chosen == nil {
		return fmt.Errorf("LoRA %q is not in the catalog", code)
	}
	if _, busy := loraDownloads.LoadOrStore(code, true); busy {
		return fmt.Errorf("LoRA %q is already downloading", code)
	}
	dir, err := lorasDir()
	if err != nil {
		loraDownloads.Delete(code)
		return err
	}

	emit := func(p types.LoraProgress) {
		if a.app != nil {
			a.app.Event.Emit("lora:progress", p)
		}
	}
	go func() {
		defer loraDownloads.Delete(code)
		entry, err := fetchCatalogLora(a.ctx, modelfetch.New(a.bus), *chosen, dir, func(pct int) {
			emit(types.LoraProgress{Code: code, Percent: pct})
		})
		if err == nil {
			_, err = a.upsertLora(entry)
		}
		if err != nil {
			a.bus.Error("app", "catalog LoRA download failed", map[string]any{"code": code, "err": err.Error()})
			emit(types.LoraProgress{Code: code, Done: true, Error: err.Error()})
			return
		}
		a.bus.Info("app", "catalog LoRA downloaded", map[string]any{"code": code, "path": entry.Path})
		emit(types.LoraProgress{Code: code, Percent: 100, Done: true})
	}()
	return nil
}

// fetchCatalogLora downloads l into dir as <code>.safetensors and returns its
// library entry. The file is verified against the catalog SHA256 (removed on a
// mismatch) and its header must be a LoRA for the catalog's engine.
func fetchCatalogLora(ctx context.Context, f *modelfetch.Fetcher, l types.CatalogLora, dir string,
	onPercent func(int)) (types.LoraEntry, error) {
	if l.URL == "" {
		return types.LoraEntry{}, errors.New("catalog entry has no download URL")
	}
	dest := filepath.Join(dir, safeFileStem(l.Code)+".safetensors")
	minBytes := l.SizeBytes
	if minBytes <= 0 {
		minBytes = 1
	}
	if _, err := f.Fetch(ctx, l.URL, dest, minBytes, func(p modelfetch.Progress) {
		if onPercent != nil {
			onPercent(p.Percent)
		}
	}); err != nil {
		return types.LoraEntry{}, err
	}
	if l.SHA256 != "" {
		sum, err := fileSHA256(dest)
		if err != nil {
			return types.LoraEntry{}, err
		}
		if !strings.EqualFold(sum, l.SHA256) {
			_ = os.Remove(dest)
			return types.LoraEntry{}, fmt.Errorf("downloaded file doesn't match the catalog SHA256 (got %s…)", sum[:12])
		}
	}
	info, err := loras.Inspect(dest)
	if err != nil {
		_ = os.Remove(dest)
		return types.LoraEntry{}, fmt.Errorf("downloaded file is not a LoRA: %w", err)
	}
	if !loras.Compatible(info.Family, l.Engine) {
		_ = os.Remove(dest)
		return types.LoraEntry{}, fmt.Errorf("downloaded file is a %s LoRA, the catalog says %s", info.Family, l.Engine)
	}
	fi, err := os.Stat(dest)
	if err != nil {
		return types.LoraEntry{}, err
	}
	te := info.TextEncoderTrained
	if l.TextEncoderTrained != nil {
		te = *l.TextEncoderTrained
	}
	wd, wmin, wmax := l.WeightDefault, l.WeightMin, l.WeightMax
	return types.LoraEntry{
		Path:                  dest,
		Name:                  l.Name,
		Family:                info.Family,
		SizeBytes:             fi.Size(),
		TriggerWords:          l.TriggerWords, // the catalog's curated list, not a header guess
		TextEncoderTrained:    te,
		CatalogCode:           l.Code,
		Managed:               true,
		Image:                 l.Image,
		CompatibleFamilyCodes: l.CompatibleFamilyCodes,
		WeightDefault:         &wd,
		WeightMin:             &wmin,
		WeightMax:             &wmax,
	}, nil
}

// safeFileStem keeps a catalog code usable as a file name.
func safeFileStem(code string) string {
	var b strings.Builder
	for _, r := range code {
		if r == '-' || r == '_' || r == '.' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "lora"
	}
	return b.String()
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// validateLoras checks a local request's LoRAs before they reach the sidecar:
// the backend must support them, each file must be a library entry that still
// exists, its family must match the model (the catalog families when both
// sides know them, else the architecture) and its weight must sit within the
// catalog bounds. Names are filled from the library for the saved metadata.
func (a *App) validateLoras(req *types.GenerationRequest) error {
	if len(req.Loras) == 0 {
		return nil
	}
	s := a.settings.Get()
	backend, familyCode := "", ""
	if s.LocalModel != nil {
		backend, familyCode = s.LocalModel.BackendType, s.LocalModel.FamilyCode
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
		if familyCode != "" && len(entry.CompatibleFamilyCodes) > 0 && !contains(entry.CompatibleFamilyCodes, familyCode) {
			return fmt.Errorf("LoRA %s is made for %s models, not %s", entry.Name,
				strings.Join(entry.CompatibleFamilyCodes, "/"), familyCode)
		}
		if entry.WeightMin != nil && ref.Weight < *entry.WeightMin {
			return fmt.Errorf("LoRA %s weight %.2f is below its minimum %.2f", entry.Name, ref.Weight, *entry.WeightMin)
		}
		if entry.WeightMax != nil && ref.Weight > *entry.WeightMax {
			return fmt.Errorf("LoRA %s weight %.2f is above its maximum %.2f", entry.Name, ref.Weight, *entry.WeightMax)
		}
		req.Loras[i].Name = entry.Name
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
