// Package clipboard provides cross-platform clipboard read operations.
//
// Uses platform-specific commands to read image and text data from the
// system clipboard. Supported platforms: Windows, macOS, Linux (X11 via xclip).
package clipboard

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"github.com/sungur/ccbox/internal/platform"
)

// pngMagic is the PNG file signature (first 8 bytes).
var pngMagic = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// ReadImage reads a PNG image from the system clipboard.
// Returns the raw PNG bytes or an error if no image is available or the
// platform is unsupported.
func ReadImage() ([]byte, error) {
	cmdArgs := platform.ClipboardImageCmd()
	if cmdArgs == nil {
		return nil, fmt.Errorf("clipboard image reading not supported on %s", platform.HostOSName())
	}

	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg != "" {
			return nil, fmt.Errorf("clipboard read failed: %s", errMsg)
		}
		return nil, fmt.Errorf("clipboard read failed: %w", err)
	}

	data := stdout.Bytes()
	if len(data) == 0 {
		return nil, fmt.Errorf("no image found in clipboard")
	}

	// Validate PNG magic bytes.
	if len(data) < 8 || !bytes.HasPrefix(data, pngMagic) {
		return nil, fmt.Errorf("clipboard data is not a valid PNG image")
	}

	return data, nil
}

// ReadText reads text from the system clipboard.
// Returns the clipboard text or an error if the platform is unsupported.
func ReadText() (string, error) {
	cmdArgs := platform.ClipboardTextCmd()
	if cmdArgs == nil {
		return "", fmt.Errorf("clipboard text reading not supported on %s", platform.HostOSName())
	}

	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg != "" {
			return "", fmt.Errorf("clipboard read failed: %s", errMsg)
		}
		return "", fmt.Errorf("clipboard read failed: %w", err)
	}

	return stdout.String(), nil
}
