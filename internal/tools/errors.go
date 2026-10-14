package tools

import (
	"encoding/json"
	"errors"
	"strings"
)

// Error codes — the engine's ToolError vocabulary (docs/tools.md) plus two
// Desktop-only ones: "cancelled" (the user stopped the run) and "cloud" (the
// cloud request itself failed: auth, payment, network).
const (
	CodeInvalidInput       = "invalid_input"
	CodeTooLarge           = "too_large"
	CodeUnsupportedRuntime = "unsupported_runtime"
	CodeWeightsMissing     = "weights_missing"
	CodeOOM                = "oom"
	CodeTimeout            = "timeout"
	CodeInternal           = "internal"
	CodeCancelled          = "cancelled"
	CodeCloud              = "cloud"
)

// Error is a typed tool failure, returned to the renderer inside the run
// result (not as a rejected promise) so the UI can key off Code and offer the
// cloud — with its price — when CloudRetry is set. Never a silent fallback.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
	// Reason is the badge reason behind an unsupported_runtime (e.g.
	// edit_model_loaded): the UI explains it and offers the fix.
	Reason     string      `json:"reason,omitempty"`
	CloudRetry *CloudOffer `json:"cloudRetry,omitempty"`
}

// CloudOffer is what re-running in the cloud would cost.
type CloudOffer struct {
	Credits float64 `json:"credits"`
	USD     float64 `json:"usd"`
	Rail    string  `json:"rail"` // "credits" | "x402"
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

// NewError builds an Error.
func NewError(code, message string) *Error { return &Error{Code: code, Message: message} }

// AsError converts any error to *Error (internal when untyped).
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var te *Error
	if errors.As(err, &te) {
		return te
	}
	return &Error{Code: CodeInternal, Message: err.Error()}
}

// CloudRetryable reports whether running the same request in the cloud can
// succeed after this local failure: out of memory, a runtime this machine
// lacks, or weights that could not be fetched (mirror unreachable). A corrupt
// download (checksum) is retried locally instead, and client errors
// (invalid_input / too_large) fail the same way everywhere.
func CloudRetryable(e *Error) bool {
	if e == nil {
		return false
	}
	switch e.Code {
	case CodeOOM, CodeUnsupportedRuntime:
		return true
	case CodeWeightsMissing:
		return !strings.Contains(strings.ToLower(e.Message), "checksum")
	}
	return false
}

// parseEngineError decodes {"code","message","field"} from the sidecar.
func parseEngineError(raw json.RawMessage) *Error {
	var e Error
	if err := json.Unmarshal(raw, &e); err != nil || e.Code == "" {
		return &Error{Code: CodeInternal, Message: "tool failed: " + truncate(string(raw), 300)}
	}
	return &e
}
