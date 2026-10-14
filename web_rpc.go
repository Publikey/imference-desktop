//go:build web

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"reflect"

	"imference-desktop-go/internal/types"
)

// webPolicy says what the web build does with each bound App method:
//
//	allow  — call it as-is (cloud-only paths)
//	stub   — answer an empty value (local-engine status reads, so the UI renders)
//	custom — a web-specific handler (settings sanitizing, the session's API key)
//
// A method that is not listed is refused: new local features stay off the web
// until someone decides otherwise.
var webAllow = map[string]bool{
	"GetVersion": true, "GenerateCloud": true, "ListPendingCloudJobs": true, "RecheckPendingCloud": true,
	"DropPendingCloudJob": true, "ListCloudModels": true, "SelectCloudModel": true,
	"ListSavedImages": true, "GalleryFacets": true, "DeleteSavedImage": true, "GetSavedImage": true,
	"GetLogs": true, "ClearLogs": true, "LogFromFrontend": true,
	"ListCloudLoras": true, "ListCatalogLoras": true,
	"ListTools": true, "GetToolsSettings": true, "CancelTool": true, "RunTool": true, "ListEditModels": true, "ToolGenModels": true,
	"TakeClientGalleryOutbox": true,
}

var webStub = map[string]bool{
	"GetSidecarStatus": true, "GetEngineInfo": true, "DetectPython": true, "ListLocalModels": true,
	"GetWalletInfo": true, "CheckForUpdate": true, "GetLocalAPIInfo": true, "ListCachedModels": true,
	"GetStorageInfo": true, "GetFolderSizes": true, "ReleaseTools": true, "CheckModelReadiness": true,
}

var errNotOnWeb = errors.New("not available in the web version")

// rpcMethod is one bound method, addressable by name and by Wails' numeric ID.
type rpcMethod struct {
	name string
	fn   reflect.Method
}

type rpcTable struct {
	byID   map[uint32]*rpcMethod
	byName map[string]*rpcMethod
}

// bindingID reproduces Wails v3's binding ID: FNV-32a of "main.App.<Method>"
// (checked against the generated frontend/bindings: AddLora -> 1589676372).
func bindingID(fqn string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(fqn))
	return h.Sum32()
}

func newRPCTable() *rpcTable {
	t := &rpcTable{byID: map[uint32]*rpcMethod{}, byName: map[string]*rpcMethod{}}
	typ := reflect.TypeOf(&App{})
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		rm := &rpcMethod{name: m.Name, fn: m}
		fqn := "main.App." + m.Name
		t.byID[bindingID(fqn)] = rm
		t.byName[fqn] = rm
	}
	return t
}

type rpcRequest struct {
	MethodID   uint32            `json:"methodID,omitempty"`
	MethodName string            `json:"methodName,omitempty"`
	Args       []json.RawMessage `json:"args"`
}

func (t *rpcTable) lookup(req rpcRequest) (*rpcMethod, error) {
	if req.MethodName != "" {
		if m := t.byName[req.MethodName]; m != nil {
			return m, nil
		}
		return nil, fmt.Errorf("unknown method %q", req.MethodName)
	}
	if m := t.byID[req.MethodID]; m != nil {
		return m, nil
	}
	return nil, fmt.Errorf("unknown method id %d", req.MethodID)
}

var (
	ctxType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errType = reflect.TypeOf((*error)(nil)).Elem()
)

// call runs method m on the user's App with JSON args, applying the policy.
func (u *webUser) call(ctx context.Context, m *rpcMethod, raw []json.RawMessage) (any, error) {
	if h := webCustom[m.name]; h != nil {
		return h(u, raw)
	}
	if webStub[m.name] {
		return zeroResult(m.fn.Type), nil
	}
	if !webAllow[m.name] {
		return nil, fmt.Errorf("%s: %w", m.name, errNotOnWeb)
	}
	return invoke(ctx, u.app, m.fn, raw)
}

func invoke(ctx context.Context, app *App, fn reflect.Method, raw []json.RawMessage) (any, error) {
	ft := fn.Type
	in := []reflect.Value{reflect.ValueOf(app)}
	ai := 0
	for i := 1; i < ft.NumIn(); i++ {
		pt := ft.In(i)
		if pt == ctxType {
			in = append(in, reflect.ValueOf(ctx))
			continue
		}
		v := reflect.New(pt)
		if ai < len(raw) && len(raw[ai]) > 0 && string(raw[ai]) != "null" {
			if err := json.Unmarshal(raw[ai], v.Interface()); err != nil {
				return nil, fmt.Errorf("%s: argument %d: %w", fn.Name, ai, err)
			}
		}
		ai++
		in = append(in, v.Elem())
	}
	out := fn.Func.Call(in)
	var result any
	for _, o := range out {
		if o.Type() == errType {
			if !o.IsNil() {
				return nil, o.Interface().(error)
			}
			continue
		}
		if result == nil {
			result = o.Interface()
		}
	}
	return result, nil
}

// zeroResult is an empty but well-formed value of the method's first result:
// [] for slices (never null — the UI maps over them), {} for structs.
func zeroResult(ft reflect.Type) any {
	if ft.NumOut() == 0 {
		return nil
	}
	t := ft.Out(0)
	if t == errType {
		return nil
	}
	switch t.Kind() {
	case reflect.Slice:
		return reflect.MakeSlice(t, 0, 0).Interface()
	case reflect.Map:
		return reflect.MakeMap(t).Interface()
	default:
		return reflect.Zero(t).Interface()
	}
}

// -------------------------------------------------------------- custom

var webCustom = map[string]func(u *webUser, raw []json.RawMessage) (any, error){
	"GetSettings": func(u *webUser, _ []json.RawMessage) (any, error) {
		return webSettings(u.app.GetSettings(), u), nil
	},
	// Only the cloud choices are writable from the browser: no server paths,
	// no payment mode switch (x402 needs a wallet the server must not hold),
	// and the API key stays the one the session logged in with.
	"SaveSettings": func(u *webUser, raw []json.RawMessage) (any, error) {
		var next types.Settings
		if len(raw) > 0 {
			if err := json.Unmarshal(raw[0], &next); err != nil {
				return nil, err
			}
		}
		cur := u.app.GetSettings()
		cur.CloudModel = next.CloudModel
		cur.CloudModelInfo = next.CloudModelInfo
		saved, err := u.app.SaveSettings(webSettings(cur, u))
		if err != nil {
			return nil, err
		}
		return webSettings(saved, u), nil
	},
	"SetToolsSettings": func(u *webUser, raw []json.RawMessage) (any, error) {
		return u.app.SetToolsSettings(types.ToolsSettings{Mode: "cloud", LocalAPIDisabled: true})
	},
	"GetCreditBalance": func(u *webUser, _ []json.RawMessage) (any, error) {
		return u.app.GetCreditBalance(u.apiKey), nil
	},
}

// webSettings forces the web invariants on a settings value.
func webSettings(s types.Settings, u *webUser) types.Settings {
	s.APIKey = u.apiKey
	s.PaymentMode = "credits"
	s.WalletAddress = ""
	s.PythonPath, s.SDXLPath, s.OutputDir = "", "", ""
	s.LocalModel = nil
	s.CustomModels = nil
	s.Loras = nil
	s.ModelCacheQuotaBytes, s.ModelCacheMinFreeBytes = 0, 0
	s.Tools = types.ToolsSettings{Mode: "cloud", LocalAPIDisabled: true}
	return s
}
