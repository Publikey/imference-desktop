// Package tools is the Desktop side of the editing tools (imference_engine.tools):
// the catalog, hardware badging, local/cloud routing, the tools sidecar process
// and the local HTTP API for agents. It is Wails-free — app.go wires events and
// bindings — so everything here is unit-testable.
//
// The catalog is a copy of `python -m imference_engine.tools export` embedded
// at build time (catalog.json). Re-export it whenever the engine manifests
// change (see CONTRIBUTING.md); TestEmbeddedCatalogParses guards the shape.
package tools

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
)

//go:embed catalog.json
var embeddedCatalog []byte

// Catalog is the parsed public catalog ({"version", "tools": [...]}).
type Catalog struct {
	Version int    `json:"version"`
	Tools   []Tool `json:"tools"`
	byID    map[string]int
	raw     map[string]json.RawMessage
}

// Tool is one catalog entry in the renderer's (camelCase) shape. Inputs,
// params and outputs keep the manifest order — the dialog builds its form from
// it — which is why they are lists here and not maps.
type Tool struct {
	ID             string       `json:"id"`
	Version        string       `json:"version"`
	Name           string       `json:"name"`
	Description    string       `json:"description"`
	Category       string       `json:"category"` // image | video | generation
	MCPName        string       `json:"mcpName"`
	Inputs         []InputSpec  `json:"inputs"`
	Params         []ParamSpec  `json:"params"`
	Outputs        []OutputSpec `json:"outputs"`
	Runtimes       Runtimes     `json:"runtimes"`
	Credits        float64      `json:"credits"` // 0 on generation tools = the price of the model
	CloudAvailable bool         `json:"cloudAvailable"`
	WeightsMB      float64      `json:"weightsMb"`
	// Weights are the tool's weight files: which param value fetches each one
	// and whether it is already in the local cache (App.ListTools sets Cached).
	Weights []WeightFile `json:"weights"`
}

// WeightFile is one weight of a tool (the engine export's weight_files).
type WeightFile struct {
	Path   string         `json:"-"`
	SizeMB float64        `json:"sizeMb"`
	When   map[string]any `json:"when,omitempty"`
	Cached bool           `json:"cached"`
}

type InputSpec struct {
	Name          string  `json:"name"`
	Type          string  `json:"type"` // image | mask | video
	Required      bool    `json:"required"`
	Multiple      bool    `json:"multiple"`
	MinItems      int     `json:"minItems,omitempty"`
	MaxItems      int     `json:"maxItems,omitempty"`
	MaxMegapixels float64 `json:"maxMegapixels,omitempty"`
	MaxMB         float64 `json:"maxMb,omitempty"`
	MaxSeconds    float64 `json:"maxSeconds,omitempty"`
	Description   string  `json:"description,omitempty"`
}

type ParamSpec struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"` // int | float | bool | string | enum | points
	Default     any      `json:"default,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Min         *float64 `json:"min,omitempty"`
	Max         *float64 `json:"max,omitempty"`
	Values      []any    `json:"values,omitempty"`
	MaxLength   int      `json:"maxLength,omitempty"`
	Pattern     string   `json:"pattern,omitempty"`
	MaxItems    int      `json:"maxItems,omitempty"`
	Description string   `json:"description,omitempty"`
}

type OutputSpec struct {
	Name   string `json:"name"`
	Type   string `json:"type"` // image | mask | video | text | json
	Format string `json:"format,omitempty"`
}

type Runtimes struct {
	Local       []string `json:"local"` // cpu | cuda | mps | rocm | directml
	CloudQueue  string   `json:"cloudQueue,omitempty"`
	SlowOnCPU   bool     `json:"slowOnCpu,omitempty"`
	MinRAMGB    float64  `json:"minRamGb,omitempty"`
	MinVRAMGB   float64  `json:"minVramGb,omitempty"`
	NeedsEngine bool     `json:"needsEngine,omitempty"`
}

// IsGeneration reports whether the tool runs on a generation model (vary,
// inpaint, outpaint) — it goes to the generation sidecar, not the tools one.
func (t Tool) IsGeneration() bool { return t.Runtimes.NeedsEngine || t.Category == "generation" }

// Param returns the named param spec.
func (t Tool) Param(name string) (ParamSpec, bool) {
	for _, p := range t.Params {
		if p.Name == name {
			return p, true
		}
	}
	return ParamSpec{}, false
}

// Input returns the named input spec.
func (t Tool) Input(name string) (InputSpec, bool) {
	for _, in := range t.Inputs {
		if in.Name == name {
			return in, true
		}
	}
	return InputSpec{}, false
}

// wire mirrors one exported tool (snake_case, maps).
type wireTool struct {
	ID          string          `json:"id"`
	Version     string          `json:"version"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Category    string          `json:"category"`
	MCPName     string          `json:"mcp_name"`
	Inputs      json.RawMessage `json:"inputs"`
	Params      json.RawMessage `json:"params"`
	Outputs     json.RawMessage `json:"outputs"`
	Runtimes    struct {
		Local       []string `json:"local"`
		CloudQueue  *string  `json:"cloud_queue"`
		SlowOnCPU   bool     `json:"slow_on_cpu"`
		MinRAMGB    float64  `json:"min_ram_gb"`
		MinVRAMGB   float64  `json:"min_vram_gb"`
		NeedsEngine bool     `json:"needs_engine"`
	} `json:"runtimes"`
	Cost struct {
		Credits float64 `json:"credits"`
	} `json:"cost"`
	Available      *bool   `json:"available"`
	CloudAvailable bool    `json:"cloud_available"`
	WeightsMB      float64 `json:"weights_mb"`
	WeightFiles    []struct {
		Path   string         `json:"path"`
		SizeMB float64        `json:"size_mb"`
		When   map[string]any `json:"when"`
	} `json:"weight_files"`
}

type wireInput struct {
	Type          string  `json:"type"`
	Required      bool    `json:"required"`
	Multiple      bool    `json:"multiple"`
	MinItems      int     `json:"min_items"`
	MaxItems      int     `json:"max_items"`
	MaxMegapixels float64 `json:"max_megapixels"`
	MaxMB         float64 `json:"max_mb"`
	MaxSeconds    float64 `json:"max_seconds"`
	Description   string  `json:"description"`
}

type wireParam struct {
	Type        string   `json:"type"`
	Default     any      `json:"default"`
	Required    bool     `json:"required"`
	Min         *float64 `json:"min"`
	Max         *float64 `json:"max"`
	Values      []any    `json:"values"`
	MaxLength   int      `json:"max_length"`
	Pattern     string   `json:"pattern"`
	MaxItems    int      `json:"max_items"`
	Description string   `json:"description"`
}

type wireOutput struct {
	Type   string `json:"type"`
	Format string `json:"format"`
}

// ParseCatalog decodes an exported catalog. Unavailable tools are dropped.
func ParseCatalog(data []byte) (*Catalog, error) {
	var doc struct {
		Version int               `json:"version"`
		Tools   []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("tools: parse catalog: %w", err)
	}
	if len(doc.Tools) == 0 {
		return nil, errors.New("tools: catalog has no tools")
	}
	c := &Catalog{Version: doc.Version, byID: map[string]int{}, raw: map[string]json.RawMessage{}}
	for _, raw := range doc.Tools {
		var w wireTool
		if err := json.Unmarshal(raw, &w); err != nil {
			return nil, fmt.Errorf("tools: parse tool: %w", err)
		}
		if w.ID == "" {
			return nil, errors.New("tools: catalog entry without id")
		}
		if w.Available != nil && !*w.Available {
			continue
		}
		if _, dup := c.byID[w.ID]; dup {
			return nil, fmt.Errorf("tools: duplicate tool id %q", w.ID)
		}
		t := Tool{
			ID: w.ID, Version: w.Version, Name: w.Name, Description: w.Description,
			Category: w.Category, MCPName: w.MCPName, Credits: w.Cost.Credits,
			CloudAvailable: w.CloudAvailable, WeightsMB: w.WeightsMB,
			Runtimes: Runtimes{
				Local: w.Runtimes.Local, SlowOnCPU: w.Runtimes.SlowOnCPU,
				MinRAMGB: w.Runtimes.MinRAMGB, MinVRAMGB: w.Runtimes.MinVRAMGB,
				NeedsEngine: w.Runtimes.NeedsEngine,
			},
		}
		if w.Runtimes.CloudQueue != nil {
			t.Runtimes.CloudQueue = *w.Runtimes.CloudQueue
		}
		t.Weights = []WeightFile{}
		for _, wf := range w.WeightFiles {
			t.Weights = append(t.Weights, WeightFile{Path: wf.Path, SizeMB: wf.SizeMB, When: wf.When})
		}
		if t.Runtimes.Local == nil {
			t.Runtimes.Local = []string{}
		}
		err := orderedEach(w.Inputs, func(name string, v json.RawMessage) error {
			var in wireInput
			if err := json.Unmarshal(v, &in); err != nil {
				return err
			}
			t.Inputs = append(t.Inputs, InputSpec{
				Name: name, Type: in.Type, Required: in.Required, Multiple: in.Multiple,
				MinItems: in.MinItems, MaxItems: in.MaxItems, MaxMegapixels: in.MaxMegapixels,
				MaxMB: in.MaxMB, MaxSeconds: in.MaxSeconds, Description: in.Description,
			})
			return nil
		})
		if err == nil {
			err = orderedEach(w.Params, func(name string, v json.RawMessage) error {
				var p wireParam
				if err := json.Unmarshal(v, &p); err != nil {
					return err
				}
				t.Params = append(t.Params, ParamSpec{
					Name: name, Type: p.Type, Default: p.Default, Required: p.Required,
					Min: p.Min, Max: p.Max, Values: p.Values, MaxLength: p.MaxLength,
					Pattern: p.Pattern, MaxItems: p.MaxItems, Description: p.Description,
				})
				return nil
			})
		}
		if err == nil {
			err = orderedEach(w.Outputs, func(name string, v json.RawMessage) error {
				var o wireOutput
				if err := json.Unmarshal(v, &o); err != nil {
					return err
				}
				t.Outputs = append(t.Outputs, OutputSpec{Name: name, Type: o.Type, Format: o.Format})
				return nil
			})
		}
		if err != nil {
			return nil, fmt.Errorf("tools: tool %s: %w", w.ID, err)
		}
		if t.Inputs == nil {
			t.Inputs = []InputSpec{}
		}
		if t.Params == nil {
			t.Params = []ParamSpec{}
		}
		if t.Outputs == nil {
			t.Outputs = []OutputSpec{}
		}
		c.byID[t.ID] = len(c.Tools)
		c.Tools = append(c.Tools, t)
		c.raw[t.ID] = raw
	}
	return c, nil
}

// orderedEach walks a JSON object's members in document order.
func orderedEach(obj json.RawMessage, fn func(name string, v json.RawMessage) error) error {
	if len(bytes.TrimSpace(obj)) == 0 || string(bytes.TrimSpace(obj)) == "null" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(obj))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return errors.New("expected a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		name, ok := tok.(string)
		if !ok {
			return errors.New("expected an object key")
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return err
		}
		if err := fn(name, v); err != nil {
			return err
		}
	}
	return nil
}

// Get returns a tool by id.
func (c *Catalog) Get(id string) (Tool, bool) {
	i, ok := c.byID[id]
	if !ok {
		return Tool{}, false
	}
	return c.Tools[i], true
}

// Raw returns the tool's exported JSON (the engine's snake_case shape), for
// the local HTTP API which mirrors the public catalog.
func (c *Catalog) Raw(id string) json.RawMessage { return c.raw[id] }

// IDs lists the tool ids, sorted.
func (c *Catalog) IDs() []string {
	ids := make([]string, 0, len(c.Tools))
	for _, t := range c.Tools {
		ids = append(ids, t.ID)
	}
	sort.Strings(ids)
	return ids
}

var (
	builtinOnce sync.Once
	builtin     *Catalog
	builtinErr  error
)

// Builtin returns the embedded catalog (parsed once).
func Builtin() (*Catalog, error) {
	builtinOnce.Do(func() { builtin, builtinErr = ParseCatalog(embeddedCatalog) })
	return builtin, builtinErr
}
