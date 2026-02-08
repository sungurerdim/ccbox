package bridge

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
)

// RunBridgeMode starts the interactive bridge TUI. It blocks until the user
// quits or an unrecoverable error occurs.
func RunBridgeMode(opts BridgeOptions) error {
	model := NewBridgeModel(opts)
	p := tea.NewProgram(model, tea.WithAltScreen())

	finalModel, err := p.Run()
	if err != nil {
		return fmt.Errorf("bridge mode error: %w", err)
	}

	_ = finalModel
	return nil
}
