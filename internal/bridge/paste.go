package bridge

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/sungur/ccbox/internal/clipboard"
	"github.com/sungur/ccbox/internal/docker"
)

// pasteToContainer copies data into a running container's .claude/input/ directory.
// The dataType determines the file extension: "image" -> .png, "text"/"voice" -> .txt.
func pasteToContainer(c ContainerInfo, data []byte, dataType string) statusMsg {
	ext := ".txt"
	if dataType == "image" {
		ext = ".png"
	}
	filename := fmt.Sprintf("paste-%d%s", time.Now().UnixMilli(), ext)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Build tar archive with the file for Docker CopyToContainer
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)

	header := &tar.Header{
		Name: filepath.ToSlash(filepath.Join(".claude", "input", filename)),
		Mode: 0644,
		Size: int64(len(data)),
	}
	if err := tw.WriteHeader(header); err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}
	if _, err := tw.Write(data); err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}
	if err := tw.Close(); err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}

	// Use Docker SDK to copy into container's working directory
	cli, err := docker.NewClient()
	if err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}

	// Inspect container to find its working directory
	inspect, err := cli.ContainerInspect(ctx, c.ID)
	if err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}
	workDir := inspect.Config.WorkingDir
	if workDir == "" {
		workDir = "/ccbox"
	}

	if err := cli.CopyToContainer(ctx, c.ID, workDir, &buf, container.CopyToContainerOptions{}); err != nil {
		return statusMsg{message: "Paste failed: " + err.Error()}
	}

	return statusMsg{message: fmt.Sprintf("Pasted %s (%d bytes)", dataType, len(data))}
}

// readClipboardImage reads an image from the system clipboard.
func readClipboardImage() ([]byte, error) {
	return clipboard.ReadImage()
}

// readClipboardText reads text from the system clipboard.
func readClipboardText() (string, error) {
	return clipboard.ReadText()
}
