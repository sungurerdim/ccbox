// Package git provides git credential detection and identity resolution.
package git

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/sungur/ccbox/internal/log"
)

// Credentials holds git authentication token and identity information.
type Credentials struct {
	// Token is the GitHub personal access token (may be empty).
	Token string
	// Name is the git user name for commits.
	Name string
	// Email is the git user email for commits.
	Email string
}

// GetCredentials retrieves git credentials from the host system.
//
// Priority for token:
//  1. GITHUB_TOKEN or GH_TOKEN environment variable
//  2. gh CLI auth token
//  3. git credential helper
//
// Priority for identity:
//  1. GitHub API via gh CLI (most accurate)
//  2. git config user.name/email (fallback)
func GetCredentials() Credentials {
	var creds Credentials
	ghAvailable := false

	// 1. Check environment variables for token
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		creds.Token = token
		log.Debug("GitHub token: from GITHUB_TOKEN env")
	} else if token := os.Getenv("GH_TOKEN"); token != "" {
		creds.Token = token
		log.Debug("GitHub token: from GH_TOKEN env")
	}

	// 2. Try gh CLI for token (if not found in env)
	if creds.Token == "" {
		token, ok := getGHAuthToken()
		if ok {
			creds.Token = token
			ghAvailable = true
			log.Debug("GitHub token: from gh CLI")
		}
	}

	// 3. If gh CLI works, get identity from GitHub API (most accurate)
	if ghAvailable {
		name, email, ok := getGHIdentity()
		if ok {
			if name != "" {
				creds.Name = name
			}
			if email != "" {
				creds.Email = email
			}
			if creds.Name != "" || creds.Email != "" {
				log.Debug("Git identity: from GitHub API")
			}
		}
	}

	// 4. Try git credential helper for token (if still not found)
	if creds.Token == "" {
		token, ok := getGitCredentialToken()
		if ok {
			creds.Token = token
			log.Debug("GitHub token: from git credential helper")
		}
	}

	// 5. Fallback to git config for identity
	if creds.Name == "" || creds.Email == "" {
		name := getGitConfigValue("user.name")
		email := getGitConfigValue("user.email")
		if creds.Name == "" && name != "" {
			creds.Name = name
		}
		if creds.Email == "" && email != "" {
			creds.Email = email
		}
		if name != "" || email != "" {
			log.Debug("Git identity: from git config")
		}
	}

	return creds
}

// getGitConfigValue retrieves a single git config value.
// Returns empty string on any error.
func getGitConfigValue(key string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "config", "--global", key)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return sanitizeEnvValue(strings.TrimSpace(string(out)))
}

// getGHAuthToken retrieves a GitHub token from the gh CLI.
func getGHAuthToken() (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "gh", "auth", "token")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", false
	}
	return token, true
}

// getGHIdentity retrieves name and email from the GitHub API via gh CLI.
func getGHIdentity() (name, email string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "gh", "api", "user", "--jq", ".name, .email")
	out, err := cmd.Output()
	if err != nil {
		return "", "", false
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) >= 1 && lines[0] != "null" {
		name = strings.TrimSpace(lines[0])
	}
	if len(lines) >= 2 && lines[1] != "null" {
		email = strings.TrimSpace(lines[1])
	}
	return name, email, true
}

// getGitCredentialToken retrieves a GitHub token from the git credential helper.
// Uses the git credential fill command with stdin input.
func getGitCredentialToken() (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "credential", "fill")
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")

	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = nil

	if err := cmd.Run(); err != nil {
		return "", false
	}

	// Parse output for password= line
	for _, line := range strings.Split(stdout.String(), "\n") {
		if strings.HasPrefix(line, "password=") {
			token := strings.TrimPrefix(line, "password=")
			token = strings.TrimSpace(token)
			if token != "" {
				return token, true
			}
		}
	}
	return "", false
}

// sanitizeEnvValue cleans a string for safe use in Docker environment variables.
// Removes newlines, null bytes, and trims whitespace.
func sanitizeEnvValue(value string) string {
	// Remove newlines
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	// Remove null bytes
	value = strings.ReplaceAll(value, "\x00", "")
	return strings.TrimSpace(value)
}
