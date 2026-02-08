//go:build linux

package fuse

import (
	"bytes"
)

// ApplyDirMap performs string replacement of directory names in a buffer.
// toContainer=true: native_name → container_name (read direction)
// toContainer=false: container_name → native_name (write direction)
// Returns nil if no changes were made.
func ApplyDirMap(buf []byte, dirMappings []DirMapping, toContainer bool) []byte {
	if len(dirMappings) == 0 || len(buf) == 0 {
		return nil
	}

	// Pre-calculate max growth
	extraAlloc := 256
	for _, dm := range dirMappings {
		var diff int
		if toContainer {
			if len(dm.ContainerName) > len(dm.NativeName) {
				diff = len(dm.ContainerName) - len(dm.NativeName)
			}
		} else {
			if len(dm.NativeName) > len(dm.ContainerName) {
				diff = len(dm.NativeName) - len(dm.ContainerName)
			}
		}
		extraAlloc += diff * 8
	}

	out := make([]byte, 0, len(buf)+extraAlloc)
	i := 0
	anyChange := false

	for i < len(buf) {
		// Look for "/segment" or "\\segment" boundary
		isSep := buf[i] == '/' || (buf[i] == '\\' && i+1 < len(buf) && buf[i+1] == '\\')
		if isSep {
			sepLen := 1
			if buf[i] == '\\' {
				sepLen = 2
			}

			matched := false
			for _, dm := range dirMappings {
				var find, repl string
				if toContainer {
					find = dm.NativeName
					repl = dm.ContainerName
				} else {
					find = dm.ContainerName
					repl = dm.NativeName
				}

				after := i + sepLen
				if after+len(find) <= len(buf) && bytes.Equal(buf[after:after+len(find)], []byte(find)) {
					// Check boundary
					nextPos := after + len(find)
					next := byte(0)
					if nextPos < len(buf) {
						next = buf[nextPos]
					}
					if next == 0 || next == '/' || next == '\\' || next == '"' || next == ',' || next == '}' || next == ']' {
						out = append(out, buf[i:i+sepLen]...)
						out = append(out, repl...)
						i = nextPos
						matched = true
						anyChange = true
						break
					}
				}
			}
			if !matched {
				out = append(out, buf[i])
				i++
			}
		} else {
			out = append(out, buf[i])
			i++
		}
	}

	if !anyChange {
		return nil
	}
	return out
}
