package imagesink

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"imference-desktop-go/internal/types"
)

func TestSaveFileWithMetaMovesAndNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "gallery")
	var paths []string
	for i := 0; i < 3; i++ {
		src := filepath.Join(dir, "tool-out.PNG")
		if err := os.WriteFile(src, []byte{byte('a' + i)}, 0o644); err != nil {
			t.Fatal(err)
		}
		p, metaErr, err := SaveFileWithMeta(src, "tool", 0, out, types.GenerationMeta{Source: "tool", Tool: "upscale"})
		if err != nil || metaErr != nil {
			t.Fatal(err, metaErr)
		}
		if _, err := os.Stat(src); !os.IsNotExist(err) {
			t.Error("source should be moved")
		}
		if !strings.HasSuffix(p, "_tool_0.png") {
			t.Errorf("name %s", p)
		}
		paths = append(paths, p)
	}
	seen := map[string]bool{}
	for i, p := range paths {
		if seen[p] {
			t.Fatalf("duplicate path %s", p)
		}
		seen[p] = true
		b, _ := os.ReadFile(p)
		if string(b) != string(rune('a'+i)) {
			t.Errorf("%s holds %q", p, b)
		}
		raw, err := os.ReadFile(p + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var m types.GenerationMeta
		_ = json.Unmarshal(raw, &m)
		if m.Tool != "upscale" || m.Source != "tool" {
			t.Errorf("meta %+v", m)
		}
	}
}
