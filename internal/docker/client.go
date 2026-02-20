package docker

// Singleton Docker client with health check and auto-start

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/sungur/ccbox/internal/log"
)

// DockerAPI defines the Docker Engine API methods used by ccbox.
// It is a subset of the Docker SDK's full client interface, enabling
// mock injection for testing via SetClientForTest.
type DockerAPI interface {
	Ping(ctx context.Context) (types.Ping, error)

	ContainerList(ctx context.Context, options container.ListOptions) ([]container.Summary, error)
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
	ContainerAttach(ctx context.Context, containerID string, options container.AttachOptions) (types.HijackedResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerInspect(ctx context.Context, containerID string) (container.InspectResponse, error)
	CopyToContainer(ctx context.Context, containerID string, dstPath string, content io.Reader, options container.CopyToContainerOptions) error
	ContainerExecCreate(ctx context.Context, containerID string, options container.ExecOptions) (container.ExecCreateResponse, error)
	ContainerExecAttach(ctx context.Context, execID string, options container.ExecAttachOptions) (types.HijackedResponse, error)
	ContainerExecInspect(ctx context.Context, execID string) (container.ExecInspect, error)

	ImageBuild(ctx context.Context, buildContext io.Reader, options types.ImageBuildOptions) (types.ImageBuildResponse, error)
	ImagePull(ctx context.Context, refStr string, options image.PullOptions) (io.ReadCloser, error)
	ImageTag(ctx context.Context, source string, target string) error
	ImageInspect(ctx context.Context, imageID string, options ...dockerclient.ImageInspectOption) (image.InspectResponse, error)
	ImageList(ctx context.Context, options image.ListOptions) ([]image.Summary, error)
	ImageRemove(ctx context.Context, imageID string, options image.RemoveOptions) ([]image.DeleteResponse, error)

	VolumesPrune(ctx context.Context, pruneFilter filters.Args) (volume.PruneReport, error)
	BuildCachePrune(ctx context.Context, opts types.BuildCachePruneOptions) (*types.BuildCachePruneReport, error)
}

var (
	instance DockerAPI
	once     sync.Once
	initErr  error
)

// NewClient returns a singleton Docker client implementing DockerAPI.
func NewClient() (DockerAPI, error) {
	once.Do(func() {
		instance, initErr = dockerclient.NewClientWithOpts(
			dockerclient.FromEnv,
			dockerclient.WithAPIVersionNegotiation(),
		)
	})
	return instance, initErr
}

// SetClientForTest replaces the singleton Docker client with the provided
// implementation. Intended for unit tests only — not safe for concurrent use.
func SetClientForTest(api DockerAPI) {
	instance = api
	initErr = nil
	once.Do(func() {}) // mark as initialized
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
