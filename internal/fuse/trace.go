//go:build linux

package fuse

import (
	"fmt"
	"os"
	"sync"
)

const traceLogPath = "/run/ccbox-fuse-trace.log"

// Tracer provides leveled logging for FUSE operations.
type Tracer struct {
	mu    sync.Mutex
	fp    *os.File
	level int
}

// NewTracer creates a tracer with the given level.
// Level 0 = off, 1 = transform ops only, 2 = all ops.
func NewTracer(level int) *Tracer {
	t := &Tracer{level: level}
	if level > 0 {
		fp, err := os.OpenFile(traceLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err == nil {
			t.fp = fp
		}
	}
	return t
}

// Log writes a trace message at level 2 (all operations).
func (t *Tracer) Log(format string, args ...any) {
	if t.level < 2 || t.fp == nil {
		return
	}
	t.mu.Lock()
	fmt.Fprintf(t.fp, "[fuse] "+format+"\n", args...)
	t.mu.Unlock()
}

// TX writes a trace message at level 1 (transform operations).
func (t *Tracer) TX(format string, args ...any) {
	if t.level < 1 || t.fp == nil {
		return
	}
	t.mu.Lock()
	fmt.Fprintf(t.fp, "[fuse:tx] "+format+"\n", args...)
	t.mu.Unlock()
}

// Close closes the trace log file.
func (t *Tracer) Close() {
	if t.fp != nil {
		t.fp.Close()
	}
}
