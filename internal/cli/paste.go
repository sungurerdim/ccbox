package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/clipboard"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/paths"
)

var pasteCmd = &cobra.Command{
	Use:   "paste",
	Short: "Paste clipboard image into a running container",
	Long:  "Reads a PNG image from the system clipboard and copies it into a running ccbox container at /tmp/clipboard.png.",
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		containerName, _ := cmd.Flags().GetString("name")

		if err := docker.EnsureRunning(ctx, 30*time.Second); err != nil {
			return fmt.Errorf("docker is not running")
		}

		// Read image from clipboard.
		log.Dim("Reading clipboard...")
		imgData, err := clipboard.ReadImage()
		if err != nil {
			return fmt.Errorf("failed to read clipboard image: %w", err)
		}
		if len(imgData) == 0 {
			return fmt.Errorf("no image found in clipboard")
		}

		// Write to temp file.
		tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ccbox-paste-%d.png", time.Now().UnixMilli()))
		if err := os.WriteFile(tmpFile, imgData, 0644); err != nil {
			return fmt.Errorf("failed to write temp file: %w", err)
		}
		defer os.Remove(tmpFile)

		// Copy to container via docker cp.
		destPath := "/tmp/clipboard.png"
		log.Dim("Copying to container...")
		cpCmd := exec.CommandContext(ctx, "docker", "cp", tmpFile, containerName+":"+destPath)
		cpCmd.Env = paths.GetDockerEnv()
		if err := cpCmd.Run(); err != nil {
			return fmt.Errorf("failed to copy to container %s: %w", containerName, err)
		}

		log.Success(fmt.Sprintf("Image pasted to %s:%s (%d bytes)", containerName, destPath, len(imgData)))
		return nil
	},
}

func init() {
	pasteCmd.Flags().StringP("name", "n", "", "Target container name (required)")
	_ = pasteCmd.MarkFlagRequired("name")
}
