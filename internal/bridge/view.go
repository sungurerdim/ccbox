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
			Foreground(lipgloss.Color("#7B61FF")).
			MarginBottom(1)

	containerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00D4AA")).
			Bold(true)

	sessionStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888")).
			PaddingLeft(4)

	selectedStyle = lipgloss.NewStyle().
			Background(lipgloss.Color("#333333")).
			Foreground(lipgloss.Color("#FFFFFF"))

	statusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFD700"))

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#555555")).
			MarginTop(1)

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666666"))
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
				line = fmt.Sprintf("  %s  %s  %s",
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
