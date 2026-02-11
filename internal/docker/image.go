package docker

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/pkg/jsonmessage"
)

// BuildOptions configures how a Docker image is built.
type BuildOptions struct {
	NoCache    bool
	BuildArgs  map[string]*string
	Labels     map[string]string
	Target     string // multi-stage build target
	Dockerfile string // relative path within the build context (default: "Dockerfile")
}

// Build creates a Docker image from the contents of buildDir.
// The directory is archived into a tar stream and sent to the Docker daemon's
// build API. Build output (layer progress, step output) is streamed to stdout.
func Build(ctx context.Context, buildDir string, tag string, opts BuildOptions) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	// Validate build directory
	info, err := os.Stat(buildDir)
	if err != nil {
		return fmt.Errorf("stat build directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", buildDir)
	}

	// Create a tar archive of the build context
	buildContext, err := createBuildContext(buildDir)
	if err != nil {
		return fmt.Errorf("create build context: %w", err)
	}
	defer buildContext.Close()

	dockerfile := opts.Dockerfile
	if dockerfile == "" {
		dockerfile = "Dockerfile"
	}

	buildOpts := types.ImageBuildOptions{
		Tags:        []string{tag},
		Dockerfile:  dockerfile,
		NoCache:     opts.NoCache,
		BuildArgs:   opts.BuildArgs,
		Labels:      opts.Labels,
		Target:      opts.Target,
		Remove:      true,                // remove intermediate containers after build
		ForceRemove: true,                // remove intermediate containers even on failure
		Version:     types.BuilderBuildKit, // required for RUN --mount=type=cache
	}

	resp, err := cli.ImageBuild(ctx, buildContext, buildOpts)
	if err != nil {
		return fmt.Errorf("build image: %w", err)
	}
	defer resp.Body.Close()

	// Parse and stream the JSON-encoded build output. This surfaces build
	// progress to the user and returns the first build error encountered.
	if err := readBuildOutput(resp.Body); err != nil {
		return err
	}

	return nil
}

// readBuildOutput decodes the JSON message stream from Docker's build API.
// Supports both legacy builder and BuildKit output formats.
func readBuildOutput(reader io.Reader) error {
	fd := os.Stdout.Fd()
	return jsonmessage.DisplayJSONMessagesStream(reader, os.Stdout, fd, true, nil)
}

// createBuildContext creates a tar archive of the build directory contents,
// streamed through an io.Pipe for memory efficiency. The tar is written in
// a background goroutine; the caller reads from the returned ReadCloser.
func createBuildContext(buildDir string) (io.ReadCloser, error) {
	pr, pw := io.Pipe()

	go func() {
		tw := tar.NewWriter(pw)
		walkErr := filepath.Walk(buildDir, func(path string, fi os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			// Compute the relative path within the build context
			relPath, err := filepath.Rel(buildDir, path)
			if err != nil {
				return fmt.Errorf("relative path for %s: %w", path, err)
			}

			// Skip the root directory entry
			if relPath == "." {
				return nil
			}

			// Docker expects POSIX paths in tar headers
			relPath = filepath.ToSlash(relPath)

			header, err := tar.FileInfoHeader(fi, "")
			if err != nil {
				return fmt.Errorf("tar header for %s: %w", relPath, err)
			}
			header.Name = relPath

			if err := tw.WriteHeader(header); err != nil {
				return fmt.Errorf("write tar header for %s: %w", relPath, err)
			}

			// Only copy file contents for regular files (not directories)
			if fi.IsDir() {
				return nil
			}

			f, err := os.Open(path)
			if err != nil {
				return fmt.Errorf("open %s: %w", relPath, err)
			}
			defer f.Close()

			if _, err := io.Copy(tw, f); err != nil {
				return fmt.Errorf("copy %s: %w", relPath, err)
			}

			return nil
		})

		// Close tar writer to flush remaining data, then close the pipe.
		// Any error from Walk or Close is propagated to the pipe reader.
		twErr := tw.Close()
		if walkErr != nil {
			pw.CloseWithError(walkErr)
		} else {
			pw.CloseWithError(twErr)
		}
	}()

	return pr, nil
}

// Exists returns true if a Docker image with the given name (or name:tag)
// exists in the local image store.
func Exists(ctx context.Context, name string) bool {
	cli, err := NewClient()
	if err != nil {
		return false
	}

	_, err = cli.ImageInspect(ctx, name)
	return err == nil
}

// ListCcboxImages returns all locally cached images whose repository name
// matches the "ccbox*" reference pattern.
func ListCcboxImages(ctx context.Context) ([]image.Summary, error) {
	cli, err := NewClient()
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}

	f := filters.NewArgs()
	f.Add("reference", "ccbox*")

	images, err := cli.ImageList(ctx, image.ListOptions{
		Filters: f,
	})
	if err != nil {
		return nil, fmt.Errorf("list images: %w", err)
	}
	return images, nil
}

// RemoveImage deletes a Docker image by name or ID. When force is true, the
// image is removed even if containers reference it. Child images (layers
// shared with other images) are pruned automatically.
func RemoveImage(ctx context.Context, name string, force bool) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	_, err = cli.ImageRemove(ctx, name, image.RemoveOptions{
		Force:         force,
		PruneChildren: true,
	})
	if err != nil {
		return fmt.Errorf("remove image %s: %w", name, err)
	}
	return nil
}

// ImageInfo returns a human-readable summary string for an image,
// including its tags and size in megabytes.
func ImageInfo(img image.Summary) string {
	var tags string
	if len(img.RepoTags) > 0 {
		tags = strings.Join(img.RepoTags, ", ")
	} else {
		tags = "<none>"
	}
	sizeMB := float64(img.Size) / 1024 / 1024
	return fmt.Sprintf("%s (%.1f MB)", tags, sizeMB)
}
