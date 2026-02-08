//go:build linux

// ccbox-fuse is a FUSE filesystem for transparent cross-platform path mapping.
// It transforms Windows/WSL/UNC paths in JSON/JSONL file contents bidirectionally.
//
// Usage:
//
//	ccbox-fuse -o source=/src,pathmap=...,dirmap=... /mountpoint
//	ccbox-fuse -f -o source=/src /mountpoint  (foreground)
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	ccboxfuse "github.com/sungur/ccbox/internal/fuse"
)

func main() {
	// Parse FUSE-style arguments: ccbox-fuse [-f] [-d] -o opts mountpoint
	args := os.Args[1:]
	var mountPoint string
	var opts string
	foreground := false

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-f":
			foreground = true
		case "-d":
			foreground = true // debug implies foreground
		case "-o":
			if i+1 < len(args) {
				i++
				if opts != "" {
					opts += ","
				}
				opts += args[i]
			}
		default:
			if !strings.HasPrefix(args[i], "-") {
				mountPoint = args[i]
			}
		}
	}

	if mountPoint == "" {
		fmt.Fprintf(os.Stderr, "Usage: ccbox-fuse [-f] -o source=<dir>[,pathmap=...][,dirmap=...] <mountpoint>\n")
		os.Exit(1)
	}

	// Parse comma-separated options
	var sourceDir, pathMap, dirMap string
	for _, opt := range strings.Split(opts, ",") {
		if strings.HasPrefix(opt, "source=") {
			sourceDir = opt[7:]
		} else if strings.HasPrefix(opt, "pathmap=") {
			pathMap = opt[8:]
		} else if strings.HasPrefix(opt, "dirmap=") {
			dirMap = opt[7:]
		}
		// allow_other, uid, gid are handled by FUSE mount options
	}

	if sourceDir == "" {
		fmt.Fprintf(os.Stderr, "Error: source not specified\n")
		os.Exit(1)
	}

	// Fall back to environment variables
	if pathMap == "" {
		pathMap = os.Getenv("CCBOX_PATH_MAP")
	}
	if dirMap == "" {
		dirMap = os.Getenv("CCBOX_DIR_MAP")
	}

	traceLevel := 0
	if t := os.Getenv("CCBOX_FUSE_TRACE"); t != "" {
		traceLevel, _ = strconv.Atoi(t)
	}

	extensions := os.Getenv("CCBOX_FUSE_EXTENSIONS")

	cfg := ccboxfuse.ParseConfig(sourceDir, pathMap, dirMap, extensions, traceLevel)
	trace := ccboxfuse.NewTracer(traceLevel)
	defer trace.Close()

	if traceLevel > 0 {
		trace.Log("Starting ccbox-fuse: source=%s pathmap=%s dirmap=%s", sourceDir, pathMap, dirMap)
	}

	server, err := ccboxfuse.NewCcboxFS(cfg, mountPoint, trace)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Mount failed: %v\n", err)
		os.Exit(1)
	}

	// Signal handling for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		server.Unmount()
	}()

	if !foreground {
		// Daemonize: not needed for container use, foreground is default
		// When called with -f, we stay in foreground
	}

	server.Wait()
}
