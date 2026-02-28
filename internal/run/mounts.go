package run

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/paths"
)

// addWorktreeMount detects git worktrees and mounts the main .git directory.
func addWorktreeMount(cmd *[]string, absProjectPath, gitPath string) {
	data, err := os.ReadFile(gitPath)
	if err != nil {
		log.Warnf("Worktree detection failed: %v", err)
		return
	}

	content := strings.TrimSpace(string(data))
	gitdirRe := regexp.MustCompile(`^gitdir:\s*(.+)$`)
	match := gitdirRe.FindStringSubmatch(content)
	if match == nil {
		return
	}

	// Resolve relative to project dir, then find the main .git root.
	// gitdir points to .git/worktrees/<name>, we need the parent .git dir.
	worktreeGitDir := filepath.Join(absProjectPath, match[1])
	worktreeGitDir = filepath.Clean(worktreeGitDir)
	normalizedWorktree := strings.ReplaceAll(worktreeGitDir, "\\", "/")

	worktreesIdx := strings.Index(normalizedWorktree, "/.git/worktrees/")
	if worktreesIdx == -1 {
		return
	}

	mainGitDir := worktreeGitDir[:worktreesIdx+5] // include /.git
	dockerGitDir, err := paths.ResolveForDocker(mainGitDir)
	if err != nil {
		log.Warnf("Worktree mount path resolution failed: %v", err)
		return
	}

	containerGitDir := paths.DriveLetterToContainerPath(dockerGitDir)

	// Only mount if not already under project path
	if !strings.HasPrefix(mainGitDir, absProjectPath) {
		*cmd = append(*cmd, "-v", dockerGitDir+":"+containerGitDir+":rw")
		log.Debugf("Worktree detected: mounting main .git at %s", containerGitDir)
	}
}

// addMinimalMounts adds only essential files for a vanilla Claude Code experience.
// Used with --fresh flag for clean slate testing.
func addMinimalMounts(cmd *[]string, claudeConfig, dockerClaudeConfig string) {
	uid, gid := GetHostUserIds()

	// Ephemeral .claude directory (tmpfs, lost on container exit)
	*cmd = append(*cmd, "--tmpfs",
		fmt.Sprintf("/ccbox/.claude:rw,size=64m,uid=%d,gid=%d,mode=0755", uid, gid))

	// Mount only essential files for auth and preferences
	essentialFiles := []string{".credentials.json", "settings.json", "settings.local.json"}
	for _, f := range essentialFiles {
		hostFile := filepath.Join(claudeConfig, f)
		if _, err := os.Stat(hostFile); err == nil {
			dockerPath, resolveErr := paths.ResolveForDocker(hostFile)
			if resolveErr == nil {
				*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude/"+f+":rw")
			}
		}
	}

	// Mount .claude.json onboarding state (both locations)
	homeDir := filepath.Dir(claudeConfig)
	mountClaudeJson(cmd, homeDir, claudeConfig)

	// Signal minimal mount mode
	*cmd = append(*cmd, "-e", config.Env.MinimalMount+"=1")
}

// addClaudeJsonMount mounts the ~/.claude.json file for non-fresh mode.
func addClaudeJsonMount(cmd *[]string, claudeConfig string) {
	homeDir := filepath.Dir(claudeConfig)
	claudeJsonHome := filepath.Join(homeDir, ".claude.json")

	// Create empty file if missing (Docker would create a directory instead)
	if _, err := os.Stat(claudeJsonHome); os.IsNotExist(err) {
		_ = os.MkdirAll(homeDir, 0755)
		_ = os.WriteFile(claudeJsonHome, []byte("{}"), 0644)
	}

	dockerPath, err := paths.ResolveForDocker(claudeJsonHome)
	if err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude.json:rw")
	}
	// .claude/.claude.json is already available via the .claude/ directory mount
}

// mountClaudeJson mounts both .claude.json locations for minimal mount mode.
func mountClaudeJson(cmd *[]string, homeDir, claudeConfig string) {
	// Mount 1: ~/.claude.json -> /ccbox/.claude.json
	claudeJsonHome := filepath.Join(homeDir, ".claude.json")
	if _, err := os.Stat(claudeJsonHome); os.IsNotExist(err) {
		_ = os.MkdirAll(homeDir, 0755)
		_ = os.WriteFile(claudeJsonHome, []byte("{}"), 0644)
	}
	if dockerPath, err := paths.ResolveForDocker(claudeJsonHome); err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude.json:rw")
	}

	// Mount 2: ~/.claude/.claude.json -> /ccbox/.claude/.claude.json
	claudeJsonConfig := filepath.Join(claudeConfig, ".claude.json")
	if _, err := os.Stat(claudeJsonConfig); os.IsNotExist(err) {
		_ = os.MkdirAll(claudeConfig, 0755)
		_ = os.WriteFile(claudeJsonConfig, []byte("{}"), 0644)
	}
	if dockerPath, err := paths.ResolveForDocker(claudeJsonConfig); err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude/.claude.json:rw")
	}
}

// addReadOnlyRoot enables read-only root filesystem with tmpfs overlays
// for directories that need write access.
func addReadOnlyRoot(cmd *[]string) {
	*cmd = append(*cmd, "--read-only")
	overlays := map[string]string{
		"/etc":           "rw,size=8m,mode=755",
		"/root":          "rw,size=8m,mode=700",
		"/usr/local/bin": "rw,size=16m,mode=755",
		"/ccbox/.cache":  "rw,size=256m,mode=755",
		"/ccbox/.npm":    "rw,size=64m,mode=755",
		"/ccbox/.local":  "rw,size=32m,mode=755",
		"/ccbox/.config": "rw,size=16m,mode=755",
	}
	for path, opts := range overlays {
		*cmd = append(*cmd, "--tmpfs", path+":"+opts)
	}
}
