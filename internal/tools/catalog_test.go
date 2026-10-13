package tools

import (
	"encoding/json"
	"testing"
)

func TestEmbeddedCatalogParses(t *testing.T) {
	c, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	if c.Version != 1 {
		t.Errorf("catalog version = %d, want 1", c.Version)
	}
	// The tools the gallery menus reference must exist.
	for _, id := range []string{
		"upscale", "vary", "remove-background", "erase-object", "segment", "outpaint",
		"inpaint", "restore-faces", "describe", "resize", "crop", "convert", "strip-metadata",
		"video-trim", "video-convert", "video-concat", "interpolate", "instruct-edit",
	} {
		if _, ok := c.Get(id); !ok {
			t.Errorf("catalog lacks %q", id)
		}
	}
	for _, tool := range c.Tools {
		if tool.Name == "" || tool.Category == "" || len(tool.Inputs) == 0 || len(tool.Outputs) == 0 {
			t.Errorf("%s: incomplete entry %+v", tool.ID, tool)
		}
		if len(c.Raw(tool.ID)) == 0 {
			t.Errorf("%s: no raw JSON", tool.ID)
		}
	}
}

func TestInstructEditEntry(t *testing.T) {
	c, _ := Builtin()
	ie, ok := c.Get("instruct-edit")
	if !ok {
		t.Fatal("no instruct-edit")
	}
	if !ie.IsGeneration() || !ie.CloudAvailable || ie.Runtimes.CloudQueue != "generation" || ie.MCPName != "edit_with_instructions" {
		t.Errorf("instruct-edit = %+v", ie)
	}
	refs, ok := ie.Input("references")
	if !ok || !refs.Multiple || refs.MaxItems != 2 || refs.Required {
		t.Errorf("references input = %+v", refs)
	}
	if img, _ := ie.Input("image"); !img.Required || ie.Inputs[0].Name != "image" {
		t.Errorf("image input must come first and be required: %+v", ie.Inputs)
	}
	var names []string
	for _, p := range ie.Params {
		names = append(names, p.Name)
	}
	want := []string{"model", "instruction", "negative_prompt", "steps", "guidance", "keep_size", "seed"}
	if len(names) != len(want) {
		t.Fatalf("params = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("params = %v, want %v", names, want)
		}
	}
	if ins, _ := ie.Param("instruction"); !ins.Required || ins.MaxLength != 2000 {
		t.Errorf("instruction = %+v", ins)
	}
	if ks, _ := ie.Param("keep_size"); ks.Type != "bool" || ks.Default != true {
		t.Errorf("keep_size = %+v", ks)
	}
	if ie.Runtimes.MinVRAMGB != 12 || ie.Runtimes.MinRAMGB != 64 {
		t.Errorf("runtimes = %+v", ie.Runtimes)
	}
}

func TestCatalogKeepsManifestOrder(t *testing.T) {
	c, _ := Builtin()
	up, _ := c.Get("upscale")
	var names []string
	for _, p := range up.Params {
		names = append(names, p.Name)
	}
	if got, want := names, []string{"scale", "model", "tile"}; len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("upscale params order = %v, want %v", got, want)
	}
	scale, _ := up.Param("scale")
	if scale.Type != "enum" || len(scale.Values) != 2 || scale.Default != float64(4) {
		t.Errorf("upscale.scale = %+v", scale)
	}
	tile, _ := up.Param("tile")
	if tile.Min == nil || tile.Max == nil || *tile.Max != 1024 {
		t.Errorf("upscale.tile bounds = %+v", tile)
	}
	if !up.Runtimes.SlowOnCPU || up.Runtimes.CloudQueue != "tools-light" || up.Credits != 4 {
		t.Errorf("upscale runtimes/cost = %+v %v", up.Runtimes, up.Credits)
	}
	vary, _ := c.Get("vary")
	if !vary.IsGeneration() || !vary.Runtimes.NeedsEngine {
		t.Error("vary must be a generation tool")
	}
	concat, _ := c.Get("video-concat")
	in, _ := concat.Input("videos")
	if !in.Multiple || in.MinItems != 2 {
		t.Errorf("video-concat input = %+v", in)
	}
}

func TestParseCatalogSkipsUnavailableAndRejectsDuplicates(t *testing.T) {
	doc := `{"version":1,"tools":[
	 {"id":"a","name":"A","category":"image","inputs":{"image":{"type":"image","required":true}},"params":{},"outputs":{"image":{"type":"image"}},"runtimes":{"local":["cpu"],"cloud_queue":null},"cost":{"credits":1}},
	 {"id":"b","available":false,"inputs":{},"params":{},"outputs":{},"runtimes":{}}]}`
	c, err := ParseCatalog([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Tools) != 1 || c.Tools[0].ID != "a" || c.Tools[0].Runtimes.CloudQueue != "" {
		t.Fatalf("got %+v", c.Tools)
	}
	dup := `{"version":1,"tools":[{"id":"a","inputs":{},"params":{},"outputs":{}},{"id":"a","inputs":{},"params":{},"outputs":{}}]}`
	if _, err := ParseCatalog([]byte(dup)); err == nil {
		t.Fatal("duplicate ids must fail")
	}
	if _, err := ParseCatalog([]byte(`{"version":1,"tools":[]}`)); err == nil {
		t.Fatal("empty catalog must fail")
	}
}

func TestToolJSONIsCamelCase(t *testing.T) {
	c, _ := Builtin()
	up, _ := c.Get("upscale")
	b, _ := json.Marshal(up)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"id", "mcpName", "inputs", "params", "outputs", "runtimes", "credits", "cloudAvailable"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q in %s", k, b)
		}
	}
}
