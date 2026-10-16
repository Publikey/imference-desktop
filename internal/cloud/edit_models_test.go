package cloud

import (
	"testing"

	"imference-desktop-go/internal/types"
)

func TestNormalizeEditEngine(t *testing.T) {
	for _, in := range []string{"qwenimage-edit", "Qwen-Image-Edit", "qwen_image_edit"} {
		if got := normalizeEngine(in); got != EditBackend {
			t.Errorf("normalizeEngine(%q) = %q", in, got)
		}
	}
	if normalizeEngine("qwenimage") != "qwenimage" {
		t.Error("qwenimage must stay qwenimage")
	}
	if !IsImageBackend(EditBackend) || !IsSingleFileBackend(EditBackend) || SupportsRefImages(EditBackend) {
		t.Error("edit backend: a local single-file image backend without img2img reference slots")
	}
	if DefaultBaseModel(EditBackend) != "Qwen/Qwen-Image-Edit-2511" {
		t.Errorf("base = %s", DefaultBaseModel(EditBackend))
	}
	// Catalog row -> ModelInfo: an image model with no Generate reference slot.
	tr := true
	mi := toModelInfo(apiModel{ModelCode: "qwen-image-edit-2511", ImEngine: "qwenimage-edit", ImLocal: true,
		ModelURL: "https://x/m.safetensors", AcceptsImageInput: &tr}, true)
	if mi.BackendType != EditBackend || mi.RefImages != 0 || mi.ModelType != EditModelType || mi.BaseModel != "Qwen/Qwen-Image-Edit-2511" {
		t.Errorf("model info = %+v", mi)
	}
}

func TestEditModels(t *testing.T) {
	exposed := []types.ModelInfo{
		{ModelCode: "flux-dev", BackendType: "flux"},
		{ModelCode: "qwen-image-edit-2511", BackendType: EditBackend},
		{ModelCode: "seededit-pro", BackendType: ""}, // name says edit, backend exposed elsewhere: not picked
	}
	got := EditModels(exposed)
	if len(got) != 1 || got[0].ModelCode != "qwen-image-edit-2511" {
		t.Fatalf("exposed: %+v", got)
	}
	// Older catalog without the backend: fall back to "edit" in code/name, images only.
	legacy := []types.ModelInfo{
		{ModelCode: "flux-dev", BackendType: "flux"},
		{ModelCode: "qwen-image-edit-2511"},
		{ModelCode: "x", Name: "Some Edit Model"},
		{ModelCode: "video-edit", ModelType: "video"},
	}
	got = EditModels(legacy)
	if len(got) != 2 || got[0].ModelCode != "qwen-image-edit-2511" || got[1].ModelCode != "x" {
		t.Fatalf("legacy: %+v", got)
	}
	// model_type image-edit wins for any engine, and filters like the backend does.
	typed := []types.ModelInfo{
		{ModelCode: "flux-dev", BackendType: "flux", ModelType: "image"},
		{ModelCode: "future-edit", BackendType: "", ModelType: EditModelType},
		{ModelCode: "some-edit-ish", ModelType: "image"},
	}
	if got = EditModels(typed); len(got) != 1 || got[0].ModelCode != "future-edit" {
		t.Fatalf("typed: %+v", got)
	}
	if !IsEditModel(&types.ModelInfo{ModelCode: "z", BackendType: "flux", ModelType: EditModelType}) {
		t.Error("model_type image-edit is an edit model whatever the backend")
	}
	yes, no := true, false
	if !cloudImg2Img(apiModel{ModelType: "image", AcceptsImageInput: &yes}, "zimage") ||
		cloudImg2Img(apiModel{ModelType: "image", AcceptsImageInput: &no}, "krea2") ||
		cloudImg2Img(apiModel{ModelType: "image"}, "krea2") ||
		!cloudImg2Img(apiModel{ModelType: "image"}, "sdxl") ||
		cloudImg2Img(apiModel{ModelType: "image", ImEngine: "external", AcceptsImageInput: &yes}, normalizeEngine("external")) ||
		cloudImg2Img(apiModel{ModelType: "image-edit", AcceptsImageInput: &yes}, "") ||
		cloudImg2Img(apiModel{ModelType: "video", AcceptsImageInput: &yes}, "wan") {
		t.Error("cloudImg2Img: accepts_image_input on image models, else the backend")
	}
	if mediaKind(apiModel{ModelType: "image-edit"}, "") != EditModelType ||
		mediaKind(apiModel{ModelType: "image", ImEngine: "qwenimage-edit"}, EditBackend) != EditModelType ||
		mediaKind(apiModel{ModelType: "image"}, "flux") != "image" {
		t.Error("mediaKind: image-edit from the type or the edit backend")
	}
	if !IsEditModel(&types.ModelInfo{ModelCode: "qwen-image-edit-2511"}) || IsEditModel(&types.ModelInfo{ModelCode: "edit", BackendType: "flux"}) || IsEditModel(nil) {
		t.Error("IsEditModel")
	}
}
