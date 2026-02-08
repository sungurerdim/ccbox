package docker

// Singleton Docker client with health check and auto-start

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	dockerclient "github.com/docker/docker/client"
	"github.com/sungur/ccbox/internal/log"
)

var (
	instance *dockerclient.Client
	once     sync.Once
	initErr  error
)

// NewClient returns a singleton Docker client
func NewClient() (*dockerclient.Client, error) {
	once.Do(func() {
		instance, initErr = dockerclient.NewClientWithOpts(
			dockerclient.FromEnv,
			dockerclient.WithAPIVersionNegotiation(),
		)
	})
	return instance, initErr
}

// CheckHealth checks if Docker daemon is responsive
func CheckHealth(ctx context.Context) bool {
	cli, err := NewClient()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = cli.Ping(ctx)
	return err == nil
}

// AutoStart tries to start Docker Desktop based on platform
func AutoStart() bool {
	switch runtime.GOOS {
	case "windows":
		// Try docker desktop start command
		cmd := exec.Command("docker", "desktop", "start")
		if err := cmd.Run(); err == nil {
			return true
		}
		// Try Docker Desktop executable
		programFiles := os.Getenv("PROGRAMFILES")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		dockerExe := filepath.Join(programFiles, "Docker", "Docker", "Docker Desktop.exe")
		if _, err := os.Stat(dockerExe); err == nil {
			cmd := exec.Command(dockerExe)
			_ = cmd.Start() // Start detached
			return true
		}
	case "darwin":
		cmd := exec.Command("open", "-a", "Docker")
		if err := cmd.Run(); err == nil {
			return true
		}
	}
	return false
}

// EnsureRunning checks Docker health, tries auto-start, waits up to timeout
func EnsureRunning(ctx context.Context, timeout time.Duration) error {
	if CheckHealth(ctx) {
		return nil
	}

	log.Dim("Docker not running, attempting to start...")
	if !AutoStart() {
		return fmt.Errorf("docker is not running and could not be started")
	}

	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	elapsed := 0
	for range ticker.C {
		elapsed++
		if CheckHealth(ctx) {
			log.Success("Docker started successfully")
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("docker did not start within %v", timeout)
		}
		if elapsed%5 == 0 {
			log.Dim(fmt.Sprintf("Waiting for Docker... (%ds)", elapsed))
		}
	}
	return fmt.Errorf("docker startup interrupted")
}
