package bridge

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Session represents a Claude Code session inside a container.
type Session struct {
	ID        string
	Project   string
	CreatedAt time.Time
}

// ContainerInfo represents a running ccbox container.
type ContainerInfo struct {
	ID       string
	Name     string
	Project  string
	Stack    string
	Status   string
	Sessions []Session
}

// FlatItem is either a container header or a session entry for navigation.
type FlatItem struct {
	IsContainer     bool
	Container       *ContainerInfo
	Session         *Session
	ParentContainer *ContainerInfo
}

// BridgeModel is the main bubbletea model for bridge mode.
type BridgeModel struct {
	containers    []ContainerInfo
	flatItems     []FlatItem
	currentIndex  int
	statusMessage string
	statusExpiry  time.Time
	width         int
	height        int
	quitting      bool

	// Config for launching new containers.
	projectPath string
	ccboxArgs   []string
}

// BridgeOptions holds configuration for starting bridge mode.
type BridgeOptions struct {
	Path      string
	CcboxArgs []string
}

// NewBridgeModel creates the initial model.
func NewBridgeModel(opts BridgeOptions) BridgeModel {
	return BridgeModel{
		projectPath: opts.Path,
		ccboxArgs:   opts.CcboxArgs,
	}
}

// Init returns initial commands to fetch data and start the tick loop.
func (m BridgeModel) Init() tea.Cmd {
	return tea.Batch(
		refreshData(),
		tickEvery(5*time.Second),
	)
}
