// Package logbus is the central log collector for the desktop app. Anything
// worth seeing in the in-app dev panel goes through Publish() — the bus
// keeps a bounded ring buffer (for late subscribers / clear/replay), writes
// each entry to stderr (so `wails dev` still shows it in the terminal), and
// emits a Wails event so the renderer's <LogPanel/> can stream them live.
//
// The bus is intentionally NOT tied to Wails at the package level — the
// emit hook is injected via SetEmitter() from app.go. Keeps this package
// unit-testable and the cloud/sidecar packages free of Wails imports.
package logbus

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Level mirrors what the renderer panel colors by. "trace" is for chatty
// inner-loop stuff we want available but not in the default view.
type Level string

const (
	LevelTrace Level = "trace"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

// Entry is the on-wire shape exposed to the renderer. JSON tags match
// frontend/src/lib/types.ts LogEntry.
type Entry struct {
	// Monotonically increasing per Bus instance. The renderer uses this as a
	// React key and to detect dropped entries.
	ID        uint64 `json:"id"`
	Timestamp string `json:"timestamp"` // RFC3339 with millisecond precision
	Level     Level  `json:"level"`
	Source    string `json:"source"` // free-form, e.g. "cloud", "sidecar", "app", "front"
	Message   string `json:"message"`
	Data      any    `json:"data,omitempty"`
}

// Emitter is the Wails Event.Emit shape (name, ...data), injected from app.go.
// We don't import Wails here on purpose.
type Emitter func(eventName string, data ...any)

const defaultBufferSize = 2000

// Bus is the singleton-ish log collector. Safe for concurrent Publish.
type Bus struct {
	mu       sync.Mutex
	ring     []Entry
	size     int
	head     int  // next write index
	full     bool // true once we've wrapped
	emitter  atomic.Pointer[Emitter]
	idSeq    atomic.Uint64
	eventTag string
}

// New creates a bus with the default capacity (2000 entries).
func New() *Bus {
	return NewWithSize(defaultBufferSize)
}

func NewWithSize(size int) *Bus {
	if size <= 0 {
		size = defaultBufferSize
	}
	return &Bus{
		ring:     make([]Entry, size),
		size:     size,
		eventTag: "log:entry",
	}
}

// SetEmitter wires a runtime.EventsEmit-shaped callback. Called after the
// Wails context is available (i.e. from App.startup).
func (b *Bus) SetEmitter(e Emitter) {
	b.emitter.Store(&e)
}

// Publish appends an entry, writes it to stderr, and emits a Wails event
// if the emitter has been wired. Never blocks; the channel-of-listeners
// pattern is intentionally avoided — the only listener is the webview and
// it's plenty fast.
func (b *Bus) Publish(level Level, source, message string, data any) {
	entry := Entry{
		ID:        b.idSeq.Add(1),
		Timestamp: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Level:     level,
		Source:    source,
		Message:   message,
		Data:      data,
	}

	b.mu.Lock()
	b.ring[b.head] = entry
	b.head = (b.head + 1) % b.size
	if b.head == 0 {
		b.full = true
	}
	b.mu.Unlock()

	// Mirror to stderr for `wails dev` terminal visibility. Compact JSON
	// for data so multi-line maps don't garbage up the terminal.
	if data != nil {
		raw, _ := json.Marshal(data)
		log.Printf("[%s/%s] %s data=%s", source, level, message, string(raw))
	} else {
		log.Printf("[%s/%s] %s", source, level, message)
	}

	if ep := b.emitter.Load(); ep != nil {
		(*ep)(b.eventTag, entry)
	}
}

// Convenience wrappers.
func (b *Bus) Trace(source, message string, data ...any) { b.Publish(LevelTrace, source, message, firstOrNil(data)) }
func (b *Bus) Info(source, message string, data ...any)  { b.Publish(LevelInfo, source, message, firstOrNil(data)) }
func (b *Bus) Warn(source, message string, data ...any)  { b.Publish(LevelWarn, source, message, firstOrNil(data)) }
func (b *Bus) Error(source, message string, data ...any) { b.Publish(LevelError, source, message, firstOrNil(data)) }

// Errorf publishes a formatted error message and returns it as an error,
// so call sites can do: return b.Errorf("cloud", "POST failed: %w", err).
func (b *Bus) Errorf(source, format string, args ...any) error {
	msg := fmt.Sprintf(format, args...)
	b.Publish(LevelError, source, msg, nil)
	return fmt.Errorf("%s", msg)
}

// Snapshot returns a copy of the current buffer in chronological order.
// Used by App.GetLogs() to seed the renderer panel on mount.
func (b *Bus) Snapshot() []Entry {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.full {
		out := make([]Entry, b.head)
		copy(out, b.ring[:b.head])
		return out
	}
	out := make([]Entry, b.size)
	copy(out, b.ring[b.head:])
	copy(out[b.size-b.head:], b.ring[:b.head])
	return out
}

// Clear wipes the buffer (the id counter keeps incrementing — the renderer
// uses it as a key and discontinuities just look like dropped entries,
// which is fine).
func (b *Bus) Clear() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ring = make([]Entry, b.size)
	b.head = 0
	b.full = false
}

func firstOrNil(args []any) any {
	if len(args) == 0 {
		return nil
	}
	return args[0]
}
