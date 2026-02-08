package cli

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/upgrade"
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update ccbox to the latest version",
	Long:  "Checks GitHub releases for a newer version and optionally applies the update.",
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")

		log.Dim("Checking for updates...")

		info, err := upgrade.CheckUpdate(Version)
		if err != nil {
			return fmt.Errorf("failed to check for updates: %w", err)
		}

		if info == nil {
			log.Success("Already up to date (v" + Version + ")")
			return nil
		}

		log.Infof("New version available: %s -> %s", Version, info.Version)

		if !force {
			log.Info("Run with --force to apply the update automatically.")
			return nil
		}

		log.Dim("Downloading and applying update...")
		if err := upgrade.PerformUpdate(info); err != nil {
			return fmt.Errorf("update failed: %w", err)
		}

		log.Success("Updated to v" + info.Version)
		return nil
	},
}

func init() {
	updateCmd.Flags().Bool("force", false, "Apply update without confirmation")
}
