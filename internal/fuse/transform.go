//go:build linux

package fuse

import (
	"strings"
	"unicode"
)

const transformHeadroom = 4 * 1024 * 1024

// TransformToContainer converts Windows/WSL/UNC paths in JSON content to Linux container paths.
// Returns nil if no transformation was needed.
func TransformToContainer(buf []byte, mappings []PathMapping, dirMappings []DirMapping) []byte {
	if len(buf) == 0 || len(mappings) == 0 {
		return nil
	}

	var b strings.Builder
	b.Grow(len(buf) + 4096)
	i := 0
	anyTransform := false

	for i < len(buf) {
		matched := false

		// Case 1: Drive letter pattern (C: or D:)
		if i+2 < len(buf) && isAlpha(buf[i]) && buf[i+1] == ':' {
			drive := toLowerByte(buf[i])
			for m := range mappings {
				if mappings[m].Drive == drive && !mappings[m].IsUNC && !mappings[m].IsWSL {
					pathbuf, ti := extractJSONPath(buf, i+2)
					// from is like "c:/Users/Sungur/.claude", skip drive prefix "c:"
					fromPath := mappings[m].From[2:]
					if strings.HasPrefix(pathbuf, fromPath) {
						b.WriteString(mappings[m].To)
						b.WriteString(pathbuf[len(fromPath):])
						i = ti
						matched = true
						anyTransform = true
						break
					}
				}
			}
		}

		// Case 2: UNC path (\\server\share or \\\\server\\share in JSON)
		if !matched && i+1 < len(buf) && buf[i] == '\\' && buf[i+1] == '\\' {
			for m := range mappings {
				if mappings[m].IsUNC {
					pathbuf, ti := extractJSONPath(buf, i)
					if strings.HasPrefix(pathbuf, mappings[m].From) {
						b.WriteString(mappings[m].To)
						b.WriteString(pathbuf[len(mappings[m].From):])
						i = ti
						matched = true
						anyTransform = true
						break
					}
				}
			}
		}

		// Case 3: WSL path (/mnt/d/...)
		if !matched && i+6 < len(buf) && buf[i] == '/' && buf[i+1] == 'm' &&
			buf[i+2] == 'n' && buf[i+3] == 't' && buf[i+4] == '/' && isAlpha(buf[i+5]) {
			for m := range mappings {
				if mappings[m].IsWSL {
					fromLen := len(mappings[m].From)
					if i+fromLen <= len(buf) && string(buf[i:i+fromLen]) == mappings[m].From {
						next := byte(0)
						if i+fromLen < len(buf) {
							next = buf[i+fromLen]
						}
						if next == 0 || next == '/' || next == '"' || next == ',' || next == '}' {
							b.WriteString(mappings[m].To)
							i += fromLen
							// Copy remainder
							for i < len(buf) && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isSpace(buf[i]) {
								b.WriteByte(buf[i])
								i++
							}
							matched = true
							anyTransform = true
							break
						}
					}
				}
			}
		}

		if !matched {
			b.WriteByte(buf[i])
			i++
		}
	}

	if !anyTransform {
		return nil
	}

	result := []byte(b.String())

	// Post-pass: apply dir_mapping (native_name → container_name)
	if dm := ApplyDirMap(result, dirMappings, true); dm != nil {
		return dm
	}
	return result
}

// TransformToHost converts Linux container paths in JSON content back to original host paths.
// Returns nil if no transformation was needed.
func TransformToHost(buf []byte, mappings []PathMapping, dirMappings []DirMapping) []byte {
	if len(buf) == 0 || len(mappings) == 0 {
		return nil
	}

	var b strings.Builder
	b.Grow(len(buf) + 4096)
	i := 0
	anyTransform := false

	for i < len(buf) {
		matched := false
		for m := range mappings {
			toLen := len(mappings[m].To)
			if i+toLen <= len(buf) && string(buf[i:i+toLen]) == mappings[m].To {
				next := byte(0)
				if i+toLen < len(buf) {
					next = buf[i+toLen]
				}
				if next == 0 || next == '/' || next == '"' || next == ',' || next == '}' || next == ']' {
					from := mappings[m].From
					useBackslash := len(from) >= 2 && from[1] == ':'
					isUNCOrig := len(from) >= 2 && from[0] == '/' && from[1] == '/'

					// Write original host path with JSON-escaped backslashes
					for j := 0; j < len(from); j++ {
						if from[j] == '/' && (useBackslash || isUNCOrig) {
							b.WriteByte('\\')
							b.WriteByte('\\')
						} else {
							b.WriteByte(from[j])
						}
					}
					i += toLen
					matched = true
					anyTransform = true

					// Copy remainder with same separator style
					for i < len(buf) && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isSpace(buf[i]) {
						if buf[i] == '/' && (useBackslash || isUNCOrig) {
							b.WriteByte('\\')
							b.WriteByte('\\')
						} else {
							b.WriteByte(buf[i])
						}
						i++
					}
					break
				}
			}
		}
		if !matched {
			b.WriteByte(buf[i])
			i++
		}
	}

	if !anyTransform {
		return nil
	}

	result := []byte(b.String())

	// Post-pass: apply dir_mapping (container_name → native_name)
	if dm := ApplyDirMap(result, dirMappings, false); dm != nil {
		return dm
	}
	return result
}

// extractJSONPath reads a path from JSON content starting at pos,
// normalizing backslash separators to forward slashes.
// Returns the normalized path string and the updated position.
func extractJSONPath(buf []byte, pos int) (string, int) {
	var pb strings.Builder
	pb.Grow(256)
	i := pos
	for i < len(buf) && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' {
		if buf[i] == '\\' {
			pb.WriteByte('/')
			i++
			if i < len(buf) && buf[i] == '\\' {
				i++ // skip second backslash in JSON escape
			}
		} else {
			pb.WriteByte(buf[i])
			i++
		}
	}
	return pb.String(), i
}

func isSpace(b byte) bool {
	return unicode.IsSpace(rune(b))
}
