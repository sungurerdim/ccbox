package docker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-units"
)

// RunConfig defines the configuration for creating and running a container.
// It maps directly to Docker's container.Config and container.HostConfig,
// providing a flattened interface for callers.
type RunConfig struct {
	Name         string
	Image        string
	Cmd          []string
	Env          []string
	Binds        []string // volume mounts in "host:container:mode" format
	WorkingDir   string
	Tty          bool
	OpenStdin    bool
	AttachStdout bool
	AttachStderr bool
	AttachStdin  bool
	CapDrop      []string
	CapAdd       []string
	Privileged   bool
	PidsLimit    int64 // 0 means no limit
	Memory       int64 // bytes, 0 means no limit
	NanoCPUs     int64 // 1e9 = 1 CPU
	ShmSize      int64 // bytes
	Tmpfs        map[string]string
	DNS          []string
	DNSOptions   []string
	Init         *bool
	AutoRemove   bool
	LogConfig    container.LogConfig
	Ulimits      []*units.Ulimit
	SecurityOpt  []string
}

// ExecResult holds the output and exit code from a command executed
// inside a running container.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// ListCcbox returns all containers (running and stopped) whose name
// matches the "ccbox" filter.
func ListCcbox(ctx context.Context) ([]container.Summary, error) {
	cli, err := NewClient()
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}

	f := filters.NewArgs()
	f.Add("name", "ccbox")

	containers, err := cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: f,
	})
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	return containers, nil
}

// Run creates a container from the given config, attaches to its I/O streams,
// starts it, and blocks until the container exits. It returns the exit code.
//
// I/O streaming behavior:
//   - TTY mode: raw byte stream copied to os.Stdout
//   - Non-TTY mode: multiplexed stream demuxed via stdcopy to os.Stdout/os.Stderr
//   - Stdin: copied from os.Stdin when AttachStdin and OpenStdin are both true
//
// The caller is responsible for forwarding OS signals (SIGINT, SIGTERM) to the
// container if graceful shutdown is desired. Use Stop() with the returned
// container ID for that purpose.
func Run(ctx context.Context, cfg RunConfig) (int, error) {
	cli, err := NewClient()
	if err != nil {
		return -1, fmt.Errorf("docker client: %w", err)
	}

	// Build container configuration
	containerCfg := &container.Config{
		Image:        cfg.Image,
		Cmd:          cfg.Cmd,
		Env:          cfg.Env,
		WorkingDir:   cfg.WorkingDir,
		Tty:          cfg.Tty,
		OpenStdin:    cfg.OpenStdin,
		AttachStdout: cfg.AttachStdout,
		AttachStderr: cfg.AttachStderr,
		AttachStdin:  cfg.AttachStdin,
	}

	// Build host configuration
	var pidsLimit *int64
	if cfg.PidsLimit > 0 {
		pidsLimit = &cfg.PidsLimit
	}

	hostCfg := &container.HostConfig{
		Binds:      cfg.Binds,
		CapDrop:    cfg.CapDrop,
		CapAdd:     cfg.CapAdd,
		Privileged: cfg.Privileged,
		Resources: container.Resources{
			PidsLimit: pidsLimit,
			Memory:    cfg.Memory,
			NanoCPUs:  cfg.NanoCPUs,
			Ulimits:   cfg.Ulimits,
		},
		ShmSize:     cfg.ShmSize,
		Tmpfs:       cfg.Tmpfs,
		DNS:         cfg.DNS,
		DNSOptions:  cfg.DNSOptions,
		Init:        cfg.Init,
		AutoRemove:  cfg.AutoRemove,
		LogConfig:   cfg.LogConfig,
		SecurityOpt: cfg.SecurityOpt,
	}

	// Create the container
	created, err := cli.ContainerCreate(ctx, containerCfg, hostCfg, nil, nil, cfg.Name)
	if err != nil {
		return -1, fmt.Errorf("create container: %w", err)
	}
	containerID := created.ID

	// If creation succeeds but later steps fail, clean up the container
	// (unless AutoRemove is set, in which case Docker handles it).
	removeOnFail := func() {
		if !cfg.AutoRemove {
			_ = cli.ContainerRemove(context.Background(), containerID, container.RemoveOptions{Force: true})
		}
	}

	// Attach to the container BEFORE starting it so we don't miss any output.
	// The Docker daemon buffers output, and attaching first guarantees we
	// capture everything from the start.
	attachOpts := container.AttachOptions{
		Stream: true,
		Stdin:  cfg.AttachStdin,
		Stdout: cfg.AttachStdout,
		Stderr: cfg.AttachStderr,
	}

	hijacked, err := cli.ContainerAttach(ctx, containerID, attachOpts)
	if err != nil {
		removeOnFail()
		return -1, fmt.Errorf("attach container: %w", err)
	}
	defer hijacked.Close()

	// Start the container
	if err := cli.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		removeOnFail()
		return -1, fmt.Errorf("start container: %w", err)
	}

	// Stream container output to host stdout/stderr
	outputDone := make(chan error, 1)
	go func() {
		if cfg.Tty {
			// TTY mode: single raw byte stream
			_, err := io.Copy(os.Stdout, hijacked.Reader)
			outputDone <- err
		} else {
			// Non-TTY mode: Docker multiplexes stdout and stderr into a
			// single stream with 8-byte headers. StdCopy demultiplexes them.
			_, err := stdcopy.StdCopy(os.Stdout, os.Stderr, hijacked.Reader)
			outputDone <- err
		}
	}()

	// Stream host stdin to container (if configured)
	if cfg.AttachStdin && cfg.OpenStdin {
		go func() {
			defer hijacked.CloseWrite() //nolint:errcheck // best-effort close on stdin copy
			_, _ = io.Copy(hijacked.Conn, os.Stdin)
		}()
	}

	// Wait for the container to exit
	waitCh, errCh := cli.ContainerWait(ctx, containerID, container.WaitConditionNotRunning)
	select {
	case <-ctx.Done():
		return -1, ctx.Err()
	case err := <-errCh:
		if err != nil {
			return -1, fmt.Errorf("wait for container: %w", err)
		}
		return -1, fmt.Errorf("unexpected nil error from container wait")
	case result := <-waitCh:
		// Drain remaining output before returning
		<-outputDone
		if result.Error != nil {
			return int(result.StatusCode), fmt.Errorf("container error: %s", result.Error.Message)
		}
		return int(result.StatusCode), nil
	}
}

// Stop gracefully stops a running container. The timeout specifies how many
// seconds to wait before forcefully killing the process.
func Stop(ctx context.Context, id string, timeoutSec int) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	return cli.ContainerStop(ctx, id, container.StopOptions{
		Timeout: &timeoutSec,
	})
}

// Remove deletes a container. When force is true, a running container is
// killed before removal.
func Remove(ctx context.Context, id string, force bool) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	return cli.ContainerRemove(ctx, id, container.RemoveOptions{
		Force: force,
	})
}

// ExtractProjectName parses a ccbox container name in the format
// "ccbox_<projectname>_<suffix>" and extracts the project name portion.
// Docker prepends "/" to container names which is stripped automatically.
//
// Examples:
//
//	"/ccbox_myproject_a1b2c3" -> "myproject"
//	"/ccbox_my_app_a1b2c3"   -> "my_app"
//	"/ccbox_solo"             -> "solo"
//	"other_container"         -> "other_container"
func ExtractProjectName(containerName string) string {
	name := strings.TrimPrefix(containerName, "/")

	if !strings.HasPrefix(name, "ccbox_") {
		return name
	}

	// Strip the "ccbox_" prefix
	name = strings.TrimPrefix(name, "ccbox_")

	// The suffix is the last underscore-separated segment (typically a hash).
	// Split on the last "_" to separate project name from suffix.
	if idx := strings.LastIndex(name, "_"); idx > 0 {
		return name[:idx]
	}

	// No suffix found, return as-is
	return name
}

// Exec runs a command inside a running container and captures its output.
// This is used by bridge mode to execute commands in the sandbox without
// creating a new container.
func Exec(ctx context.Context, containerID string, cmd []string) (*ExecResult, error) {
	cli, err := NewClient()
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}

	// Create the exec instance
	execCfg := container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	}

	created, err := cli.ContainerExecCreate(ctx, containerID, execCfg)
	if err != nil {
		return nil, fmt.Errorf("create exec: %w", err)
	}

	// Attach to the exec instance to capture output
	resp, err := cli.ContainerExecAttach(ctx, created.ID, container.ExecStartOptions{})
	if err != nil {
		return nil, fmt.Errorf("attach exec: %w", err)
	}
	defer resp.Close()

	// Demultiplex stdout and stderr from the Docker stream
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, resp.Reader); err != nil {
		return nil, fmt.Errorf("read exec output: %w", err)
	}

	// Retrieve the exit code from the completed exec
	inspect, err := cli.ContainerExecInspect(ctx, created.ID)
	if err != nil {
		return nil, fmt.Errorf("inspect exec: %w", err)
	}

	return &ExecResult{
		ExitCode: inspect.ExitCode,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
	}, nil
}
