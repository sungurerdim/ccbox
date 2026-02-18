// Package fuse implements a FUSE filesystem for transparent cross-platform
// path mapping in ccbox containers. It transforms Windows/WSL/UNC paths
// in JSON/JSONL file contents bidirectionally.
package fuse

import (
	"strings"
	"unicode"
)

const (
	MaxMappings    = 32
	MaxDirMappings = 32
	MaxExtensions  = 16
	MaxPathLen     = 4096
)

// PathMapping represents a host↔container path mapping.
type PathMapping struct {
	From  string // Original host path (normalized, forward slashes)
	To    string // Container mount path
	Drive byte   // Lowercase drive letter (0 if not a drive path)
	IsUNC bool   // UNC path (//server/share)
	IsWSL bool   // WSL path (/mnt/d/...)
}

// DirMapping represents a directory name encoding mapping.
type DirMapping struct {
	ContainerName string // e.g. -d-GitHub-ccbox
	NativeName    string // e.g. D--GitHub-ccbox
}

// Config holds the FUSE filesystem configuration.
type Config struct {
	SourceDir    string
	PathMappings []PathMapping
	DirMappings  []DirMapping
	Extensions   []string
	TraceLevel   int
}

// normalizePath converts backslashes to forward slashes and strips trailing slashes.
func normalizePath(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	for len(path) > 1 && path[len(path)-1] == '/' {
		path = path[:len(path)-1]
	}
	return path
}

// ParseConfig builds a Config from environment-style parameters.
func ParseConfig(sourceDir, pathMap, dirMap, extensions string, traceLevel int) *Config {
	cfg := &Config{
		SourceDir:  strings.TrimRight(sourceDir, "/"),
		TraceLevel: traceLevel,
	}
	cfg.parsePathMap(pathMap)
	cfg.parseDirMap(dirMap)
	cfg.parseExtensions(extensions)
	return cfg
}

func (c *Config) parsePathMap(pathMap string) {
	if pathMap == "" {
		return
	}
	for _, entry := range strings.Split(pathMap, ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		// Find the separator colon, skipping drive letter colon (e.g. C:/...)
		sep := entry
		offset := 0
		if len(sep) > 1 && sep[1] == ':' {
			offset = 2
			sep = sep[2:]
		}
		idx := strings.Index(sep, ":")
		if idx < 0 {
			continue
		}
		from := normalizePath(entry[:offset+idx])
		to := normalizePath(entry[offset+idx+1:])
		m := PathMapping{From: from, To: to}
		if len(from) > 1 && from[1] == ':' {
			m.Drive = toLowerByte(from[0])
		}
		if strings.HasPrefix(from, "//") {
			m.IsUNC = true
		}
		if strings.HasPrefix(from, "/mnt/") && len(from) > 5 && isAlpha(from[5]) {
			m.IsWSL = true
			m.Drive = toLowerByte(from[5])
		}
		c.PathMappings = append(c.PathMappings, m)
		if len(c.PathMappings) >= MaxMappings {
			break
		}
	}
}

func (c *Config) parseDirMap(dirMap string) {
	if dirMap == "" {
		return
	}
	for _, entry := range strings.Split(dirMap, ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		idx := strings.Index(entry, ":")
		if idx < 0 {
			continue
		}
		c.DirMappings = append(c.DirMappings, DirMapping{
			ContainerName: entry[:idx],
			NativeName:    entry[idx+1:],
		})
		if len(c.DirMappings) >= MaxDirMappings {
			break
		}
	}
}

func (c *Config) parseExtensions(ext string) {
	if ext == "" {
		c.Extensions = []string{".json", ".jsonl"}
		return
	}
	for _, e := range strings.Split(ext, ",") {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if e[0] != '.' {
			e = "." + e
		}
		c.Extensions = append(c.Extensions, e)
		if len(c.Extensions) >= MaxExtensions {
			break
		}
	}
}

// NeedsTransform checks if a file path has an extension that requires content transformation.
func (c *Config) NeedsTransform(path string) bool {
	if len(c.PathMappings) == 0 || len(c.Extensions) == 0 {
		return false
	}
	dot := strings.LastIndex(path, ".")
	if dot < 0 {
		return false
	}
	ext := strings.ToLower(path[dot:])
	for _, e := range c.Extensions {
		if ext == e {
			return true
		}
	}
	return false
}

func toLowerByte(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + 32
	}
	return b
}

func isAlpha(b byte) bool {
	return unicode.IsLetter(rune(b))
}
