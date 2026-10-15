package main

// The Engine surface (panel / bar): what runs where — the GPU, and what the
// tools sidecar keeps warm next to the generation model.

import (
	"context"
	"time"

	"imference-desktop-go/internal/gpu"
	"imference-desktop-go/internal/tools"
)

// EngineStatusInfo is App.EngineStatus.
type EngineStatusInfo struct {
	GPUName   string            `json:"gpuName"`
	GPUVendor string            `json:"gpuVendor"`
	VRAMGiB   float64           `json:"vramGiB"`
	ToolsUp   bool              `json:"toolsUp"`
	ToolsBusy bool              `json:"toolsBusy"`
	ToolsWarm []tools.WarmModel `json:"toolsWarm"`
}

// EngineStatus reports the GPU and the tools' warm models. Cheap: no sidecar
// start, no wait on a running tool (toolsBusy, toolsWarm nil then).
func (a *App) EngineStatus() EngineStatusInfo {
	out := EngineStatusInfo{ToolsWarm: []tools.WarmModel{}}
	if a.cloudOnly {
		return out
	}
	a.gpuOnce.Do(func() { a.gpu = gpu.Detect(context.Background()) })
	out.GPUName, out.GPUVendor, out.VRAMGiB = a.gpu.Name, string(a.gpu.Vendor), a.gpu.VRAMGiB
	if a.tools == nil {
		return out
	}
	out.ToolsUp = a.tools.Running()
	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Second)
	defer cancel()
	warm, busy, err := a.tools.Loaded(ctx)
	out.ToolsBusy = busy
	if err == nil && warm != nil {
		out.ToolsWarm = warm
	} else if err == nil {
		out.ToolsWarm = nil
	}
	return out
}
