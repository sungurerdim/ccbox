//go:build linux

package fuse

import (
	"bytes"
	"sync"
	"syscall"
)

const quickScanSize = 64 * 1024

var scanBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, quickScanSize)
		return &b
	},
}

// QuickScanHasMappings reads the first 64KB of a file descriptor and checks
// if any mapping patterns exist. Returns true if transform is likely needed.
func QuickScanHasMappings(fd int, mappings []PathMapping, dirMappings []DirMapping) bool {
	bufp := scanBufPool.Get().(*[]byte)
	defer scanBufPool.Put(bufp)
	buf := *bufp

	n, err := syscall.Pread(fd, buf, 0)
	if err != nil || n <= 0 {
		return false
	}
	data := buf[:n]

	// Check path mappings
	for i := range mappings {
		m := &mappings[i]
		// Drive letter pattern (e.g. "C:" or "c:")
		if m.Drive != 0 && !m.IsUNC && !m.IsWSL {
			upper := m.Drive & 0xDF // to uppercase (Drive is always lowercase)
			lower := m.Drive | 0x20
			for j := 0; j < n-1; j++ {
				if (data[j] == upper || data[j] == lower) && data[j+1] == ':' {
					return true
				}
			}
		}
		// "to" pattern (container path)
		if len(m.To) > 0 && len(m.To) <= n {
			if bytes.Contains(data, []byte(m.To)) {
				return true
			}
		}
		// WSL /mnt/ prefix
		if m.IsWSL && n >= 5 {
			if bytes.Contains(data, []byte("/mnt/")) {
				return true
			}
		}
		// UNC \\\\ prefix
		if m.IsUNC && n >= 2 {
			if bytes.Contains(data, []byte("\\\\")) {
				return true
			}
		}
	}

	// Check dir mappings
	for i := range dirMappings {
		if bytes.Contains(data, []byte(dirMappings[i].NativeName)) {
			return true
		}
		if bytes.Contains(data, []byte(dirMappings[i].ContainerName)) {
			return true
		}
	}

	return false
}


