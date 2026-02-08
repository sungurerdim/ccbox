//go:build linux

package fuse

import (
	"sync"
	"time"
)

const (
	RCacheSlots   = 256
	RCacheMaxSize = 4 * 1024 * 1024 // 4MB max per entry
	SCacheSlots   = 512
	NegCacheSize  = 64
	NegCacheTTL   = 2 * time.Second
)

// rcacheEntry holds a transformed file's content keyed by path + mtime.
type rcacheEntry struct {
	path     string
	mtimeSec int64
	mtimeNs  int64
	data     []byte
	seq      uint64
}

// ReadCache is an LRU cache for transformed file contents.
type ReadCache struct {
	mu    sync.RWMutex
	slots [RCacheSlots]*rcacheEntry
	seq   uint64
}

// Lookup returns cached transformed data if path and mtime match.
func (rc *ReadCache) Lookup(path string, mtimeSec, mtimeNs int64) ([]byte, bool) {
	rc.mu.RLock()
	for i := range rc.slots {
		e := rc.slots[i]
		if e != nil && e.mtimeSec == mtimeSec && e.mtimeNs == mtimeNs && e.path == path {
			rc.mu.RUnlock()
			// Bump sequence under write lock
			rc.mu.Lock()
			rc.seq++
			e.seq = rc.seq
			rc.mu.Unlock()
			return e.data, true
		}
	}
	rc.mu.RUnlock()
	return nil, false
}

// Insert stores transformed content, evicting the LRU entry if needed.
func (rc *ReadCache) Insert(path string, mtimeSec, mtimeNs int64, data []byte) {
	if len(data) > RCacheMaxSize {
		return
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()

	// Find empty or LRU slot
	lru := 0
	var minSeq uint64 = ^uint64(0)
	for i := range rc.slots {
		if rc.slots[i] == nil {
			lru = i
			break
		}
		if rc.slots[i].seq < minSeq {
			minSeq = rc.slots[i].seq
			lru = i
		}
	}

	copied := make([]byte, len(data))
	copy(copied, data)
	rc.seq++
	rc.slots[lru] = &rcacheEntry{
		path:     path,
		mtimeSec: mtimeSec,
		mtimeNs:  mtimeNs,
		data:     copied,
		seq:      rc.seq,
	}
}

// Invalidate removes all cache entries for the given path.
func (rc *ReadCache) Invalidate(path string) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	for i := range rc.slots {
		if rc.slots[i] != nil && rc.slots[i].path == path {
			rc.slots[i] = nil
		}
	}
}

// scacheEntry tracks files that don't need transformation.
type scacheEntry struct {
	path     string
	mtimeSec int64
	mtimeNs  int64
}

// SkipCache remembers files where quick-scan found no mapping patterns.
type SkipCache struct {
	mu    sync.RWMutex
	slots [SCacheSlots]*scacheEntry
	idx   int
}

// Lookup returns true if file was previously found to need no transformation.
func (sc *SkipCache) Lookup(path string, mtimeSec, mtimeNs int64) bool {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	for i := range sc.slots {
		e := sc.slots[i]
		if e != nil && e.mtimeSec == mtimeSec && e.mtimeNs == mtimeNs && e.path == path {
			return true
		}
	}
	return false
}

// Insert marks a file as not needing transformation.
func (sc *SkipCache) Insert(path string, mtimeSec, mtimeNs int64) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	// Find empty or round-robin
	slot := -1
	for i := range sc.slots {
		if sc.slots[i] == nil {
			slot = i
			break
		}
	}
	if slot < 0 {
		slot = sc.idx % SCacheSlots
		sc.idx++
	}
	sc.slots[slot] = &scacheEntry{
		path:     path,
		mtimeSec: mtimeSec,
		mtimeNs:  mtimeNs,
	}
}

// Invalidate removes all skip-cache entries for the given path.
func (sc *SkipCache) Invalidate(path string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	for i := range sc.slots {
		if sc.slots[i] != nil && sc.slots[i].path == path {
			sc.slots[i] = nil
		}
	}
}

// negCacheEntry tracks ENOENT results.
type negCacheEntry struct {
	path    string
	expires time.Time // monotonic
}

// NegCache is a negative dentry cache to avoid repeated lstat for non-existent paths.
type NegCache struct {
	mu    sync.RWMutex
	slots [NegCacheSize]*negCacheEntry
	idx   int
}

// Lookup returns true if path was recently found to not exist.
func (nc *NegCache) Lookup(path string) bool {
	now := time.Now()
	nc.mu.RLock()
	defer nc.mu.RUnlock()
	for i := range nc.slots {
		e := nc.slots[i]
		if e != nil && e.expires.After(now) && e.path == path {
			return true
		}
	}
	return false
}

// Insert records that path does not exist.
func (nc *NegCache) Insert(path string) {
	nc.mu.Lock()
	defer nc.mu.Unlock()
	slot := nc.idx % NegCacheSize
	nc.idx++
	nc.slots[slot] = &negCacheEntry{
		path:    path,
		expires: time.Now().Add(NegCacheTTL),
	}
}

// Invalidate removes neg-cache entries matching path.
func (nc *NegCache) Invalidate(path string) {
	nc.mu.Lock()
	defer nc.mu.Unlock()
	for i := range nc.slots {
		if nc.slots[i] != nil && nc.slots[i].path == path {
			nc.slots[i] = nil
		}
	}
}
