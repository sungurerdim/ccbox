package docker

import (
	"context"
	"fmt"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/filters"

	"github.com/sungur/ccbox/internal/log"
)

// PruneContainers removes all stopped ccbox containers and returns the
// number of containers successfully removed.
func PruneContainers(ctx context.Context) (int, error) {
	containers, err := ListCcbox(ctx)
	if err != nil {
		return 0, fmt.Errorf("list ccbox containers: %w", err)
	}

	removed := 0
	for _, c := range containers {
		// Skip running containers -- only remove exited/dead ones
		if c.State == "running" {
			continue
		}
		if err := Remove(ctx, c.ID, true); err != nil {
			log.Dim(fmt.Sprintf("Failed to remove container %s: %v", c.ID[:12], err))
			continue
		}
		removed++
	}
	return removed, nil
}

// PruneImages removes all ccbox images that are not currently in use by a
// running container. Returns the number of images successfully removed.
func PruneImages(ctx context.Context) (int, error) {
	images, err := ListCcboxImages(ctx)
	if err != nil {
		return 0, fmt.Errorf("list ccbox images: %w", err)
	}

	removed := 0
	for _, img := range images {
		name := img.ID
		if len(img.RepoTags) > 0 {
			name = img.RepoTags[0]
		}
		if err := RemoveImage(ctx, name, false); err != nil {
			// Image may be in use by a container; skip without failing
			log.Dim(fmt.Sprintf("Skipped image %s: %v", name, err))
			continue
		}
		removed++
	}
	return removed, nil
}

// PruneVolumes removes all unused Docker volumes. This is not scoped to
// ccbox specifically because Docker does not support volume labeling by
// default. The caller should confirm with the user before invoking this.
func PruneVolumes(ctx context.Context) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	report, err := cli.VolumesPrune(ctx, filters.NewArgs())
	if err != nil {
		return fmt.Errorf("prune volumes: %w", err)
	}

	if len(report.VolumesDeleted) > 0 {
		log.Dim(fmt.Sprintf("Pruned %d volumes (%.1f MB reclaimed)",
			len(report.VolumesDeleted),
			float64(report.SpaceReclaimed)/1024/1024))
	}

	return nil
}

// PruneBuilder removes Docker build cache entries. The cacheAge parameter
// specifies the minimum age of entries to remove using Docker's duration
// syntax (e.g. "24h", "72h", "168h"). An empty cacheAge removes all
// build cache regardless of age.
func PruneBuilder(ctx context.Context, cacheAge string) error {
	cli, err := NewClient()
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}

	opts := types.BuildCachePruneOptions{
		All: true,
	}

	if cacheAge != "" {
		f := filters.NewArgs()
		f.Add("until", cacheAge)
		opts.Filters = f
	}

	report, err := cli.BuildCachePrune(ctx, opts)
	if err != nil {
		return fmt.Errorf("prune build cache: %w", err)
	}

	if report != nil && report.SpaceReclaimed > 0 {
		log.Dim(fmt.Sprintf("Pruned build cache (%.1f MB reclaimed)",
			float64(report.SpaceReclaimed)/1024/1024))
	}

	return nil
}

// RemoveAllCcbox performs a comprehensive cleanup of all ccbox-related
// Docker resources in order:
//  1. Stop all running ccbox containers
//  2. Remove all ccbox containers (running, stopped, exited)
//  3. Remove all ccbox images
//  4. (deep only) Prune unused volumes and all build cache
//
// Errors are collected rather than causing early termination, so the
// cleanup is as thorough as possible even when individual operations fail.
func RemoveAllCcbox(ctx context.Context, deep bool) error {
	var errs []string

	// Phase 1: Stop all running ccbox containers
	containers, err := ListCcbox(ctx)
	if err != nil {
		return fmt.Errorf("list ccbox containers: %w", err)
	}

	for _, c := range containers {
		if c.State == "running" {
			if err := Stop(ctx, c.ID, 10); err != nil {
				errs = append(errs, fmt.Sprintf("stop %s: %v", c.ID[:12], err))
			}
		}
	}

	// Phase 2: Remove all ccbox containers (now all should be stopped)
	removedContainers, err := pruneAllContainers(ctx)
	if err != nil {
		errs = append(errs, fmt.Sprintf("prune containers: %v", err))
	} else if removedContainers > 0 {
		log.Dim(fmt.Sprintf("Removed %d containers", removedContainers))
	}

	// Phase 3: Remove all ccbox images with force (containers are gone)
	images, err := ListCcboxImages(ctx)
	if err != nil {
		errs = append(errs, fmt.Sprintf("list images: %v", err))
	} else {
		removedImages := 0
		for _, img := range images {
			name := img.ID
			if len(img.RepoTags) > 0 {
				name = img.RepoTags[0]
			}
			if err := RemoveImage(ctx, name, true); err != nil {
				errs = append(errs, fmt.Sprintf("remove image %s: %v", name, err))
				continue
			}
			removedImages++
		}
		if removedImages > 0 {
			log.Dim(fmt.Sprintf("Removed %d images", removedImages))
		}
	}

	// Phase 4: Deep cleanup (volumes and builder cache)
	if deep {
		if err := PruneVolumes(ctx); err != nil {
			errs = append(errs, fmt.Sprintf("prune volumes: %v", err))
		}
		if err := PruneBuilder(ctx, ""); err != nil {
			errs = append(errs, fmt.Sprintf("prune builder: %v", err))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("cleanup completed with errors:\n  %s", strings.Join(errs, "\n  "))
	}

	return nil
}

// pruneAllContainers removes ALL ccbox containers regardless of state.
// This is used during full cleanup after containers have been stopped.
func pruneAllContainers(ctx context.Context) (int, error) {
	containers, err := ListCcbox(ctx)
	if err != nil {
		return 0, fmt.Errorf("list ccbox containers: %w", err)
	}

	removed := 0
	for _, c := range containers {
		if err := Remove(ctx, c.ID, true); err != nil {
			log.Dim(fmt.Sprintf("Failed to remove container %s: %v", c.ID[:12], err))
			continue
		}
		removed++
	}
	return removed, nil
}
