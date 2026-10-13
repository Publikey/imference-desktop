// Package imagesink writes generated images to disk. Used by both cloud and
// local generation paths so saved files end up in one place regardless of
// where the bytes came from.
package imagesink

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"imference-desktop-go/internal/types"
)

// Save persists a base64 data URL ("data:image/...;base64,...") to baseDir.
// Returns the absolute path written. Creates baseDir (and parents) if missing.
//
// Filename: "<YYYYMMDD-HHMMSS>_<source>_<seed>.<ext>". Extension is derived
// from the data URL's MIME type — falls back to ".bin" if unknown.
func Save(dataURL, source string, seed int, baseDir string) (string, error) {
	mime, payload, ok := splitDataURL(dataURL)
	if !ok {
		return "", errors.New("imagesink: input is not a data URL")
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", fmt.Errorf("imagesink: decode base64: %w", err)
	}
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return "", fmt.Errorf("imagesink: mkdir %s: %w", baseDir, err)
	}
	name := fmt.Sprintf("%s_%s_%d%s",
		time.Now().Format("20060102-150405"),
		sanitize(source),
		seed,
		extFromMime(mime),
	)
	path := filepath.Join(baseDir, name)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return "", fmt.Errorf("imagesink: write %s: %w", path, err)
	}
	return path, nil
}

// SaveWithMeta writes the image (like Save) and a "<path>.json" sidecar holding
// the generation metadata. The image write is fatal on error; the sidecar write
// is best-effort — its error is returned as metaErr but the image path is still
// valid, so callers can log-and-continue.
func SaveWithMeta(dataURL, source string, seed int, baseDir string, meta types.GenerationMeta) (path string, metaErr error, err error) {
	path, err = Save(dataURL, source, seed, baseDir)
	if err != nil {
		return "", nil, err
	}
	data, mErr := json.MarshalIndent(meta, "", "  ")
	if mErr != nil {
		return path, fmt.Errorf("imagesink: marshal meta: %w", mErr), nil
	}
	if mErr := os.WriteFile(path+".json", data, 0o644); mErr != nil {
		return path, fmt.Errorf("imagesink: write meta %s.json: %w", path, mErr), nil
	}
	return path, nil, nil
}

// DefaultDir returns "<home>/Pictures/Imference". Falls back to "./imference-out"
// if UserHomeDir errors (vanishingly rare on Windows/macOS/Linux).
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", "imference-out")
	}
	return filepath.Join(home, "Pictures", "Imference")
}

func splitDataURL(s string) (mime, payload string, ok bool) {
	const prefix = "data:"
	if !strings.HasPrefix(s, prefix) {
		return "", "", false
	}
	body := s[len(prefix):]
	semi := strings.Index(body, ";")
	comma := strings.Index(body, ",")
	if semi < 0 || comma < 0 || semi > comma {
		return "", "", false
	}
	return body[:semi], body[comma+1:], true
}

func extFromMime(mime string) string {
	switch strings.ToLower(mime) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	// Video results (WAN cloud) arrive as data:video/... data-URLs and save
	// through the same sink — the extension drives the gallery's kind.
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	default:
		return ".bin"
	}
}

// sanitize keeps only safe characters in the source tag (defensive — current
// callers only pass "cloud" or "local", but if we ever expose model_code there
// we don't want path separators leaking into filenames).
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

// SaveFileWithMeta moves (or copies, across volumes) an existing media file —
// an editing-tool output — into baseDir under the gallery naming scheme
// "<YYYYMMDD-HHMMSS>_<source>_<seed><ext>", plus the "<path>.json" metadata
// sidecar. Unlike Save, a name already taken (two outputs in the same second)
// gets a "-2", "-3"… suffix on the timestamp instead of being overwritten.
// The extension comes from src. Same error contract as SaveWithMeta.
func SaveFileWithMeta(src, source string, seed int, baseDir string, meta types.GenerationMeta) (path string, metaErr error, err error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return "", nil, fmt.Errorf("imagesink: mkdir %s: %w", baseDir, err)
	}
	ext := strings.ToLower(filepath.Ext(src))
	if ext == ".jpeg" {
		ext = ".jpg"
	}
	ts := time.Now().Format("20060102-150405")
	for i := 1; ; i++ {
		stamp := ts
		if i > 1 {
			stamp = fmt.Sprintf("%s-%d", ts, i)
		}
		path = filepath.Join(baseDir, fmt.Sprintf("%s_%s_%d%s", stamp, sanitize(source), seed, ext))
		if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
			break
		}
		if i > 1000 {
			return "", nil, errors.New("imagesink: no free file name")
		}
	}
	if err := moveFile(src, path); err != nil {
		return "", nil, fmt.Errorf("imagesink: save %s: %w", path, err)
	}
	data, mErr := json.MarshalIndent(meta, "", "  ")
	if mErr != nil {
		return path, fmt.Errorf("imagesink: marshal meta: %w", mErr), nil
	}
	if mErr := os.WriteFile(path+".json", data, 0o644); mErr != nil {
		return path, fmt.Errorf("imagesink: write meta %s.json: %w", path, mErr), nil
	}
	return path, nil, nil
}

// moveFile renames src to dst, falling back to copy + remove across volumes.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	in.Close()
	_ = os.Remove(src)
	return nil
}
