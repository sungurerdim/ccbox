package fuse

import (
	"testing"
	"time"
)

// --- ReadCache ---

func TestReadCacheInsertAndLookup(t *testing.T) {
	rc := &ReadCache{}

	data := []byte("transformed content")
	rc.Insert("/path/file.json", 1000, 500, data)

	got, ok := rc.Lookup("/path/file.json", 1000, 500)
	if !ok {
		t.Fatal("expected cache hit")
	}
	if string(got) != "transformed content" {
		t.Errorf("got %q, want %q", string(got), "transformed content")
	}
}

func TestReadCacheMiss(t *testing.T) {
	rc := &ReadCache{}

	rc.Insert("/path/file.json", 1000, 500, []byte("data"))

	// Different path
	if _, ok := rc.Lookup("/other/file.json", 1000, 500); ok {
		t.Error("different path should miss")
	}

	// Different mtime
	if _, ok := rc.Lookup("/path/file.json", 1001, 500); ok {
		t.Error("different mtimeSec should miss")
	}

	// Different mtime ns
	if _, ok := rc.Lookup("/path/file.json", 1000, 501); ok {
		t.Error("different mtimeNs should miss")
	}
}

func TestReadCacheInvalidate(t *testing.T) {
	rc := &ReadCache{}

	rc.Insert("/path/a.json", 100, 0, []byte("a"))
	rc.Insert("/path/b.json", 200, 0, []byte("b"))

	rc.Invalidate("/path/a.json")

	if _, ok := rc.Lookup("/path/a.json", 100, 0); ok {
		t.Error("invalidated entry should miss")
	}
	if _, ok := rc.Lookup("/path/b.json", 200, 0); ok != true {
		t.Error("non-invalidated entry should hit")
	}
}

func TestReadCacheEviction(t *testing.T) {
	rc := &ReadCache{}

	// Fill all slots
	for i := 0; i < RCacheSlots; i++ {
		rc.Insert("/path/"+string(rune('A'+i%26))+".json", int64(i), 0, []byte("data"))
	}

	// Insert one more - should evict LRU
	rc.Insert("/path/new.json", 9999, 0, []byte("new"))

	// New entry should be found
	if _, ok := rc.Lookup("/path/new.json", 9999, 0); !ok {
		t.Error("newly inserted entry should be found")
	}
}

func TestReadCacheMaxSize(t *testing.T) {
	rc := &ReadCache{}

	// Exceed max size
	huge := make([]byte, RCacheMaxSize+1)
	rc.Insert("/huge.json", 100, 0, huge)

	if _, ok := rc.Lookup("/huge.json", 100, 0); ok {
		t.Error("oversized entry should not be cached")
	}
}

func TestReadCacheDataIsolation(t *testing.T) {
	rc := &ReadCache{}

	original := []byte("original data")
	rc.Insert("/file.json", 100, 0, original)

	// Mutate original
	original[0] = 'X'

	got, ok := rc.Lookup("/file.json", 100, 0)
	if !ok {
		t.Fatal("expected hit")
	}
	if got[0] == 'X' {
		t.Error("cache should hold independent copy")
	}
}

// --- SkipCache ---

func TestSkipCacheInsertAndLookup(t *testing.T) {
	sc := &SkipCache{}

	sc.Insert("/path/data.json", 1000, 500)

	if !sc.Lookup("/path/data.json", 1000, 500) {
		t.Error("expected skip cache hit")
	}
}

func TestSkipCacheMiss(t *testing.T) {
	sc := &SkipCache{}

	sc.Insert("/path/data.json", 1000, 500)

	if sc.Lookup("/path/other.json", 1000, 500) {
		t.Error("different path should miss")
	}
	if sc.Lookup("/path/data.json", 1001, 500) {
		t.Error("different mtime should miss")
	}
}

func TestSkipCacheInvalidate(t *testing.T) {
	sc := &SkipCache{}

	sc.Insert("/path/a.json", 100, 0)
	sc.Insert("/path/b.json", 200, 0)

	sc.Invalidate("/path/a.json")

	if sc.Lookup("/path/a.json", 100, 0) {
		t.Error("invalidated entry should miss")
	}
	if !sc.Lookup("/path/b.json", 200, 0) {
		t.Error("non-invalidated entry should hit")
	}
}

func TestSkipCacheRoundRobin(t *testing.T) {
	sc := &SkipCache{}

	// Fill all slots
	for i := 0; i < SCacheSlots; i++ {
		sc.Insert("/path/"+string(rune('A'+i%26))+".json", int64(i), 0)
	}

	// Insert beyond capacity - should use round-robin
	sc.Insert("/path/new.json", 9999, 0)

	if !sc.Lookup("/path/new.json", 9999, 0) {
		t.Error("newly inserted entry should be found")
	}
}

// --- NegCache ---

func TestNegCacheInsertAndLookup(t *testing.T) {
	nc := &NegCache{}

	nc.Insert("/nonexistent/path")

	if !nc.Lookup("/nonexistent/path") {
		t.Error("expected neg cache hit")
	}
}

func TestNegCacheMiss(t *testing.T) {
	nc := &NegCache{}

	nc.Insert("/nonexistent/path")

	if nc.Lookup("/other/path") {
		t.Error("different path should miss")
	}
}

func TestNegCacheTTLExpiry(t *testing.T) {
	nc := &NegCache{}

	// Insert with a very short effective TTL
	nc.mu.Lock()
	slot := nc.idx % NegCacheSize
	nc.idx++
	nc.slots[slot] = &negCacheEntry{
		path:    "/expired/path",
		expires: time.Now().Add(-1 * time.Second), // already expired
	}
	nc.mu.Unlock()

	if nc.Lookup("/expired/path") {
		t.Error("expired entry should miss")
	}
}

func TestNegCacheInvalidate(t *testing.T) {
	nc := &NegCache{}

	nc.Insert("/path/a")
	nc.Insert("/path/b")

	nc.Invalidate("/path/a")

	if nc.Lookup("/path/a") {
		t.Error("invalidated entry should miss")
	}
	if !nc.Lookup("/path/b") {
		t.Error("non-invalidated entry should hit")
	}
}
