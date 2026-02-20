package bridge

import (
	"context"
	"strings"
	"time"

	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/log"
)

// CheckHealth checks if the container entrypoint has completed successfully
// by testing for the health marker file (/tmp/ccbox-healthy).
func CheckHealth(ctx context.Context, containerID string) bool {
	result, err := docker.Exec(ctx, containerID, []string{
		"test", "-f", "/tmp/ccbox-healthy",
	})
	return err == nil && result.ExitCode == 0
}

// DiscoverSessions lists Claude Code sessions inside a running container by
// looking for JSONL conversation files under the well-known session directory.
func DiscoverSessions(ctx context.Context, containerID string) []Session {
	result, err := docker.Exec(ctx, containerID, []string{
		"find", "/ccbox/.claude/projects",
		"-name", "*.jsonl",
		"-type", "f",
	})
	if err != nil || result.ExitCode != 0 {
		shortID := containerID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		log.Debugf("Session discovery failed for %s: err=%v exit=%d", shortID, err, result.ExitCode)
		return nil
	}

	output := strings.TrimSpace(result.Stdout)
	if output == "" {
		return nil
	}

	var sessions []Session
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Path format: /ccbox/.claude/projects/<project>/<session-id>.jsonl
		parts := strings.Split(line, "/")
		if len(parts) < 2 {
			continue
		}

		sessionFile := parts[len(parts)-1]
		projectDir := parts[len(parts)-2]
		sessionID := strings.TrimSuffix(sessionFile, ".jsonl")

		sessions = append(sessions, Session{
			ID:        sessionID,
			Project:   projectDir,
			CreatedAt: time.Now(), // Approximate; could stat the file for mtime.
		})
	}
	return sessions
}
