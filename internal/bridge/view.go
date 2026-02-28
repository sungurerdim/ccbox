package bridge

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// --- Styles ---

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.AdaptiveColor{Light: "#5B41DF", Dark: "#7B61FF"}).
			MarginBottom(1)

	containerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#008866", Dark: "#00D4AA"}).
			Bold(true)

	sessionStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#666666", Dark: "#888888"}).
			PaddingLeft(4)

	selectedStyle = lipgloss.NewStyle().
			Background(lipgloss.AdaptiveColor{Light: "#D0D0D0", Dark: "#333333"}).
			Foreground(lipgloss.AdaptiveColor{Light: "#000000", Dark: "#FFFFFF"})

	statusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#B8860B", Dark: "#FFD700"})

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#888888", Dark: "#555555"}).
			MarginTop(1)

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#999999", Dark: "#666666"})

	healthyStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#008800", Dark: "#00FF00"})

	initStyle = lipgloss.NewStyle().
			Foreground(lipgloss.AdaptiveColor{Light: "#B8860B", Dark: "#FFD700"})
)

// --- View ---

func (m BridgeModel) View() string {
	if m.quitting {
		return ""
	}

	var b strings.Builder

	// Header.
	b.WriteString(titleStyle.Render("ccbox bridge"))
	b.WriteString("\n")

	// Container list.
	if len(m.flatItems) == 0 {
		b.WriteString(dimStyle.Render("  No containers running. Press 'n' to start one."))
		b.WriteString("\n")
	} else {
		for i, item := range m.flatItems {
			var line string
			if item.IsContainer {
				c := item.Container
				name := c.Name
				if len(name) > 30 {
					name = name[:30] + "..."
				}
				stack := c.Stack
				if stack == "" {
					stack = "-"
				}
				healthIndicator := initStyle.Render("○")
				if c.Healthy {
					healthIndicator = healthyStyle.Render("●")
				}
				line = fmt.Sprintf("  %s %s  %s  %s",
					healthIndicator,
					containerStyle.Render(name),
					dimStyle.Render(stack),
					dimStyle.Render(c.Status),
				)
			} else {
				s := item.Session
				sessionID := s.ID
				if len(sessionID) > 8 {
					sessionID = sessionID[:8]
				}
				line = sessionStyle.Render(
					fmt.Sprintf("  |-- %s (%s)", s.Project, sessionID),
				)
			}

			if i == m.currentIndex {
				line = selectedStyle.Render(line)
			}
			b.WriteString(line)
			b.WriteString("\n")
		}
	}

	// Activity indicators.
	if m.isRecording {
		b.WriteString("\n")
		b.WriteString(statusStyle.Render("[REC] Recording audio..."))
		b.WriteString("\n")
	} else if m.isPasting {
		b.WriteString("\n")
		b.WriteString(statusStyle.Render("[PASTE] Sending to container..."))
		b.WriteString("\n")
	}

	// Status message.
	if m.statusMessage != "" {
		b.WriteString("\n")
		b.WriteString(statusStyle.Render(m.statusMessage))
		b.WriteString("\n")
	}

	// Controls.
	b.WriteString("\n")
	b.WriteString(helpStyle.Render("n:new  s:stop  v:voice  p:paste  enter:attach  q:quit"))

	return b.String()
}
