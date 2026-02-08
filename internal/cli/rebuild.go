package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/generate"
	"github.com/sungur/ccbox/internal/log"
)

var rebuildCmd = &cobra.Command{
	Use:   "rebuild",
	Short: "Rebuild Docker images with latest Claude Code",
	Long:  "Rebuilds ccbox Docker images. Default: rebuild base only. Use --stack or --all to rebuild more.",
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		stackName, _ := cmd.Flags().GetString("stack")
		all, _ := cmd.Flags().GetBool("all")
		noCache, _ := cmd.Flags().GetBool("no-cache")

		if err := docker.EnsureRunning(ctx, 30*time.Second); err != nil {
			return fmt.Errorf("docker is not running")
		}

		var stacksToRebuild []config.LanguageStack

		switch {
		case all:
			// Find all installed ccbox images and rebuild each.
			images, err := docker.ListCcboxImages(ctx)
			if err != nil {
				return fmt.Errorf("failed to list images: %w", err)
			}
			if len(images) == 0 {
				log.Warn("No ccbox images found. Building base image.")
				stacksToRebuild = []config.LanguageStack{config.StackBase}
			} else {
				seen := make(map[config.LanguageStack]bool)
				for _, img := range images {
					for _, tag := range img.RepoTags {
						// Tags look like "ccbox_python:latest"
						name := tag
						if idx := strings.Index(name, ":"); idx >= 0 {
							name = name[:idx]
						}
						name = strings.TrimPrefix(name, "ccbox_")
						name = strings.TrimPrefix(name, "ccbox/")
						stack, ok := config.ParseStack(name)
						if ok && !seen[stack] {
							seen[stack] = true
							stacksToRebuild = append(stacksToRebuild, stack)
						}
					}
				}
				if len(stacksToRebuild) == 0 {
					log.Warn("No recognized stacks in installed images. Building base.")
					stacksToRebuild = []config.LanguageStack{config.StackBase}
				}
			}

		case stackName != "":
			stack, err := config.CreateStack(stackName)
			if err != nil {
				return err
			}
			// Also rebuild parent dependency if it has one.
			if parent := config.StackDependencies[stack]; parent != "" {
				stacksToRebuild = append(stacksToRebuild, parent)
			}
			stacksToRebuild = append(stacksToRebuild, stack)

		default:
			stacksToRebuild = []config.LanguageStack{config.StackBase}
		}

		log.Infof("Rebuilding %d image(s)...", len(stacksToRebuild))
		log.Newline()

		var failed []string
		for _, stack := range stacksToRebuild {
			tag := config.GetImageName(string(stack))
			log.Cyan("Building " + tag + "...")

			// Generate Dockerfile and build files for the stack.
			buildDir, err := generate.WriteBuildFiles(stack)
			if err != nil {
				log.Errorf("Failed to generate build files for %s: %v", tag, err)
				failed = append(failed, string(stack))
				continue
			}

			err = docker.Build(ctx, buildDir, tag, docker.BuildOptions{
				NoCache: noCache,
			})
			if err != nil {
				log.Errorf("Failed to build %s: %v", tag, err)
				failed = append(failed, string(stack))
				continue
			}
			log.Success("Built " + tag)
		}

		log.Newline()
		if len(failed) > 0 {
			log.Errorf("Failed to rebuild: %s", strings.Join(failed, ", "))
			return fmt.Errorf("%d stack(s) failed to build", len(failed))
		}

		log.Success("All images rebuilt successfully")
		return nil
	},
}

func init() {
	rebuildCmd.Flags().StringP("stack", "s", "", "Rebuild a specific stack (e.g., python, go, rust)")
	rebuildCmd.Flags().Bool("all", false, "Rebuild all installed ccbox images")
	rebuildCmd.Flags().Bool("no-cache", false, "Build without Docker cache")
}
