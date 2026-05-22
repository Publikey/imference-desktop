// Package imagesink writes generated images to disk. Used by both cloud and
// local generation paths so saved files end up in one place regardless of
// where the bytes came from.
package imagesink

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
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
