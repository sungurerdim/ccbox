package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/log"
)

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Remove ccbox containers, images, and temp files",
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		deep, _ := cmd.Flags().GetBool("deep")
		yes, _ := cmd.Flags().GetBool("yes")

		if err := docker.EnsureRunning(ctx, 30*time.Second); err != nil {
			return fmt.Errorf("docker is not running")
		}

		if !yes {
			if deep {
				log.Yellow("This will remove ALL ccbox resources:")
				log.Info("  - All ccbox containers (running + stopped)")
				log.Info("  - All ccbox images (stacks + project images)")
				log.Info("  - Temporary build files")
			} else {
				log.Yellow("This will remove ccbox containers and images.")
			}
			// Auto-confirm for now. Interactive prompt can be added later.
		}

		log.Dim("Removing containers...")
		containersRemoved, _ := docker.PruneContainers(ctx)

		log.Dim("Removing images...")
		imagesRemoved, _ := docker.PruneImages(ctx)

		tempFilesRemoved := 0
		if deep {
			log.Dim("Removing temp files...")
			tempFilesRemoved = cleanTempFiles()
		}

		log.Newline()
		if deep {
			log.Success("Deep clean complete")
		} else {
			log.Success("Cleanup complete")
		}

		var parts []string
		if containersRemoved > 0 {
			parts = append(parts, fmt.Sprintf("%d container(s)", containersRemoved))
		}
		if imagesRemoved > 0 {
			parts = append(parts, fmt.Sprintf("%d image(s)", imagesRemoved))
		}
		if tempFilesRemoved > 0 {
			parts = append(parts, "temp files")
		}
		if len(parts) > 0 {
			log.Dim("Removed: " + strings.Join(parts, ", "))
		} else {
			log.Dim("Nothing to remove - already clean")
		}

		return nil
	},
}

func init() {
	cleanCmd.Flags().Bool("deep", false, "Deep clean: also remove temp build files")
	cleanCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompts")
}

// cleanTempFiles removes the ccbox temp directory tree.
// Returns 1 if files were removed, 0 otherwise.
func cleanTempFiles() int {
	tmpDir := filepath.Join(os.TempDir(), "ccbox")
	info, err := os.Stat(tmpDir)
	if err != nil || !info.IsDir() {
		return 0
	}
	if err := os.RemoveAll(tmpDir); err != nil {
		log.Warnf("Failed to remove temp directory %s: %v", tmpDir, err)
		return 0
	}
	return 1
}
