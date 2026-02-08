package cli

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/log"
)

var stacksCmd = &cobra.Command{
	Use:   "stacks",
	Short: "List available language stacks with descriptions and sizes",
	RunE: func(cmd *cobra.Command, args []string) error {
		filter, _ := cmd.Flags().GetString("filter")

		var stacks []config.LanguageStack
		if filter != "" {
			stacks = config.FilterStacks(filter)
		} else {
			values := config.GetStackValues()
			for _, v := range values {
				s, ok := config.ParseStack(v)
				if ok {
					stacks = append(stacks, s)
				}
			}
		}

		if len(stacks) == 0 {
			log.Warn("No stacks found matching: " + filter)
			return nil
		}

		// Group stacks by category.
		categories := groupStacksByCategory(stacks)

		// Find max name length for alignment.
		maxName := 0
		for _, s := range stacks {
			if len(string(s)) > maxName {
				maxName = len(string(s))
			}
		}

		log.Bold("Available Stacks")
		log.Newline()

		for _, cat := range categories {
			log.Yellow(cat.name)
			for _, stack := range cat.stacks {
				info := config.StackInfoMap[stack]
				parent := config.StackDependencies[stack]

				name := log.Style.Cyan(fmt.Sprintf("  %-*s", maxName+2, string(stack)))
				desc := info.Description
				if parent != "" {
					desc += log.Style.Dim(fmt.Sprintf(" (extends %s)", string(parent)))
				}
				size := log.Style.Dim(fmt.Sprintf("  %d MB", info.SizeMB))
				log.Raw(name + "  " + desc + size)
			}
			log.Newline()
		}

		log.Dim(fmt.Sprintf("%d stack(s) available", len(stacks)))
		return nil
	},
}

func init() {
	stacksCmd.Flags().StringP("filter", "f", "", "Filter stacks by name, category, or description")
}

// categoryGroup holds a category name and its stacks.
type categoryGroup struct {
	name   string
	stacks []config.LanguageStack
}

// groupStacksByCategory groups stacks into ordered categories.
func groupStacksByCategory(stacks []config.LanguageStack) []categoryGroup {
	// Define category order and assign stacks to categories based on dependency.
	categoryOf := func(s config.LanguageStack) string {
		switch s {
		case config.StackBase:
			return "Core"
		case config.StackData, config.StackAI:
			return "Data Science / AI"
		case config.StackWeb, config.StackFullstack:
			return "Web Development"
		case config.StackCpp, config.StackSystems:
			return "Systems"
		case config.StackGame:
			return "Game Development"
		case config.StackDart, config.StackMobile:
			return "Mobile"
		default:
			return "Languages"
		}
	}

	categoryOrder := []string{
		"Core", "Languages", "Web Development",
		"Data Science / AI", "Systems", "Game Development", "Mobile",
	}

	grouped := make(map[string][]config.LanguageStack)
	for _, s := range stacks {
		cat := categoryOf(s)
		grouped[cat] = append(grouped[cat], s)
	}

	var result []categoryGroup
	for _, cat := range categoryOrder {
		if items, ok := grouped[cat]; ok && len(items) > 0 {
			result = append(result, categoryGroup{name: cat, stacks: items})
		}
	}

	return result
}
