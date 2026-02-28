// Package upgrade provides self-update functionality for ccbox using GitHub releases.
package upgrade

import (
	"context"
	"fmt"
	"os"
	"runtime"

	"github.com/creativeprojects/go-selfupdate"
)

const (
	repoOwner = "sungur"
	repoName  = "ccbox"
)

// UpdateInfo holds information about an available update.
type UpdateInfo struct {
	Version string
	Notes   string
	release *selfupdate.Release
}

// CheckUpdate checks GitHub releases for a version newer than currentVersion.
// Returns nil (no error) if already up to date. Returns UpdateInfo if an update is available.
func CheckUpdate(ctx context.Context, currentVersion string) (*UpdateInfo, error) {
	source, err := selfupdate.NewGitHubSource(selfupdate.GitHubConfig{})
	if err != nil {
		return nil, fmt.Errorf("failed to create GitHub source: %w", err)
	}

	updater, err := selfupdate.NewUpdater(selfupdate.Config{
		Source: source,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create updater: %w", err)
	}

	latest, found, err := updater.DetectLatest(ctx, selfupdate.ParseSlug(repoOwner+"/"+repoName))
	if err != nil {
		return nil, fmt.Errorf("failed to detect latest version: %w", err)
	}
	if !found {
		return nil, nil
	}

	// "dev" is always considered outdated so updates are always offered during development.
	if currentVersion != "dev" && !latest.GreaterThan(currentVersion) {
		return nil, nil
	}

	return &UpdateInfo{
		Version: latest.Version(),
		Notes:   latest.ReleaseNotes,
		release: latest,
	}, nil
}

// PerformUpdate downloads and applies the update described by info.
func PerformUpdate(ctx context.Context, info *UpdateInfo) error {
	if info == nil || info.release == nil {
		return fmt.Errorf("no update information available")
	}

	source, err := selfupdate.NewGitHubSource(selfupdate.GitHubConfig{})
	if err != nil {
		return fmt.Errorf("failed to create GitHub source: %w", err)
	}

	updater, err := selfupdate.NewUpdater(selfupdate.Config{
		Source: source,
	})
	if err != nil {
		return fmt.Errorf("failed to create updater: %w", err)
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to determine executable path: %w", err)
	}

	if err := updater.UpdateTo(ctx, info.release, exe); err != nil {
		return fmt.Errorf("failed to apply update: %w", err)
	}

	return nil
}

// VersionString returns a formatted version string with optional build metadata.
func VersionString(version, commit, date string) string {
	s := "ccbox " + version
	if commit != "" {
		short := commit
		if len(short) > 7 {
			short = short[:7]
		}
		s += " (" + short + ")"
	}
	if date != "" {
		s += " built " + date
	}
	s += " " + runtime.GOOS + "/" + runtime.GOARCH
	return s
}
