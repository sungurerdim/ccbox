package bridge

import (
	"context"
	"strings"
	"time"

	"github.com/sungur/ccbox/internal/docker"
)

// DiscoverSessions lists Claude Code sessions inside a running container by
// looking for JSONL conversation files under the well-known session directory.
func DiscoverSessions(ctx context.Context, containerID string) []Session {
	result, err := docker.Exec(ctx, containerID, []string{
		"find", "/ccbox/.claude/projects",
		"-name", "*.jsonl",
		"-type", "f",
	})
	if err != nil || result.ExitCode != 0 {
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
