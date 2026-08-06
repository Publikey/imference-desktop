// Package modelcache manages the on-disk cache of downloaded model weights:
// how files are named, which ones to evict when the cache outgrows its quota,
// and an index tying each file back to the catalog model it came from.
//
// The app used to keep exactly one checkpoint — switching models deleted the
// previous one, so coming back meant re-downloading several GB. This package
// replaces that with a size-bounded cache: keep everything until the quota is
// reached, then evict least-recently-used. The active model is never a
// candidate, and user-supplied checkpoints never enter the index at all.
package modelcache

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"path"
	"strings"
	"unicode"
)

// IndexFileName is the index that lives alongside the weights, inside the
// managed models directory (see store.go for why it isn't under UserConfigDir).
const IndexFileName = "index.json"

const (
	ext         = ".safetensors"
	maxSlugRune = 48
	hashLen     = 8
)

// Slug normalises a model code into a safe filename component: lowercase,
// [a-z0-9-_] kept, everything else collapsed to '-', truncated. Truncation and
// collisions are harmless because FileName always appends a hash of the full
// identity — the slug exists only so a human can recognise the file.
func Slug(modelCode string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(modelCode)) {
		switch {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)), r == '_':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	s := strings.Trim(b.String(), "-")
	if r := []rune(s); len(r) > maxSlugRune {
		s = strings.Trim(string(r[:maxSlugRune]), "-")
	}
	if s == "" {
		return "model"
	}
	return s
}

// URLHash is a short digest of a weights URL, stored on an index entry so a
// catalog re-point (same model code, new weights) is detectable.
func URLHash(modelURL string) string {
	if modelURL == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(modelURL))
	return hex.EncodeToString(sum[:])[:hashLen]
}

// FileName is the canonical cache filename for a catalog model:
//
//	<slug(modelCode)>-<hash(modelCode + NUL + modelURL)><ext>
//
// The hash covers BOTH the code and the URL. Code alone would re-serve stale
// weights when the catalog re-points a model (the reuse rule is size-based and
// would not notice); URL alone would lose the file→model mapping the picker
// badge and the storage screen need. Together they encode identity *and*
// version — a changed upstream URL yields a new key, hence a fresh download.
//
// The hash suffix also defuses two filename hazards for free: slug truncation
// collisions, and Windows reserved device names (nul-1a2b3c4d.safetensors is
// not NUL).
func FileName(modelCode, modelURL string) string {
	sum := sha256.Sum256([]byte(modelCode + "\x00" + modelURL))
	return Slug(modelCode) + "-" + hex.EncodeToString(sum[:])[:hashLen] + ext
}

// LegacyFileName reproduces the pre-cache naming rule exactly: the URL's
// basename when it ends in .safetensors, otherwise a fixed fallback.
//
// This is the migration contract with files already on disk — it must keep
// matching the historical behaviour of app.sdxlModelPath forever, so a user
// upgrading never re-downloads weights they already have. Do not "improve" it.
func LegacyFileName(modelURL string) string {
	if u, err := url.Parse(modelURL); err == nil {
		if base := path.Base(u.Path); base != "" && base != "." && base != "/" && strings.HasSuffix(base, ext) {
			return base
		}
	}
	return "model" + ext
}

// IsSafeKey validates a cache key received from the frontend before it is
// joined onto the models directory. Rejects anything with a path separator, a
// parent traversal, the index file itself, or a non-weights extension.
func IsSafeKey(key string) bool {
	if key == "" || key == IndexFileName {
		return false
	}
	if strings.ContainsAny(key, `/\`) || strings.Contains(key, "..") {
		return false
	}
	return strings.HasSuffix(key, ext)
}

// IsWeightsFile reports whether a directory entry name is a weights file the
// cache may index (i.e. not the index itself).
func IsWeightsFile(name string) bool {
	return name != IndexFileName && strings.HasSuffix(name, ext)
}
