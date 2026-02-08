package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/log"
)

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Completely remove ccbox: containers, images, config, and temp files",
	Long: `Completely remove all ccbox resources from the system:
  - All ccbox containers (running + stopped)
  - All ccbox images
  - Docker build cache
  - Global config (~/.ccbox/)
  - Temporary files

The binary itself cannot be removed automatically.
Its location will be printed so you can remove it manually.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		yes, _ := cmd.Flags().GetBool("yes")

		if !yes {
			log.Yellow("This will completely remove ccbox:")
			log.Info("  - All ccbox containers (running + stopped)")
			log.Info("  - All ccbox images")
			log.Info("  - Docker build cache")
			log.Info("  - Global config (~/.ccbox/)")
			log.Info("  - Temporary files")
			log.Newline()
			log.Yellow("Proceed? [y/N] ")

			var answer string
			fmt.Scanln(&answer)
			if answer != "y" && answer != "Y" {
				log.Info("Aborted.")
				return nil
			}
		}

		if err := docker.EnsureRunning(ctx, 30*time.Second); err != nil {
			log.Warnf("Docker is not running, skipping Docker cleanup: %v", err)
		} else {
			log.Dim("Stopping and removing containers...")
			log.Dim("Removing images...")
			log.Dim("Pruning build cache...")
			if err := docker.RemoveAllCcbox(ctx, true); err != nil {
				log.Warnf("Docker cleanup completed with errors: %v", err)
			}
		}

		log.Dim("Removing config (~/.ccbox/)...")
		removeConfigDir()

		log.Dim("Removing temp files...")
		cleanTempFiles()

		log.Newline()
		log.Success("Uninstall complete")

		if exe, err := os.Executable(); err == nil {
			log.Dim(fmt.Sprintf("To remove the binary: rm %s", exe))
		}

		return nil
	},
}

// removeConfigDir removes the global ccbox config directory (~/.ccbox/).
func removeConfigDir() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Warnf("Could not determine home directory: %v", err)
		return
	}

	configDir := filepath.Join(home, ".ccbox")
	if _, err := os.Stat(configDir); os.IsNotExist(err) {
		return
	}

	if err := os.RemoveAll(configDir); err != nil {
		log.Warnf("Failed to remove config directory %s: %v", configDir, err)
	}
}
