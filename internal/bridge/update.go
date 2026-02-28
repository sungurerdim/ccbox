package bridge

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	dcontainer "github.com/docker/docker/api/types/container"
	dfilters "github.com/docker/docker/api/types/filters"
	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/voice"
)

// --- Message types ---

type refreshMsg struct {
	containers []ContainerInfo
}

type tickMsg time.Time

type containerStoppedMsg struct {
	name string
}

type newSessionMsg struct{}

type statusMsg struct {
	message string
}

// --- Update ---

func (m BridgeModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.quitting = true
			return m, tea.Quit

		case "up", "k":
			if m.currentIndex > 0 {
				m.currentIndex--
				m.selectedID = flatItemID(m.flatItems[m.currentIndex])
			}

		case "down", "j":
			if m.currentIndex < len(m.flatItems)-1 {
				m.currentIndex++
				m.selectedID = flatItemID(m.flatItems[m.currentIndex])
			}

		case "n":
			return m, launchNewContainer(m.projectPath, m.ccboxArgs)

		case "s":
			if m.currentIndex < len(m.flatItems) {
				item := m.flatItems[m.currentIndex]
				container := item.Container
				if !item.IsContainer {
					container = item.ParentContainer
				}
				if container != nil {
					return m, stopContainer(container.ID, container.Name)
				}
			}

		case "v":
			m.isRecording = true
			return m, sendVoice(m.containers)

		case "p":
			m.isPasting = true
			return m, sendPaste(m.containers)

		case "enter":
			if m.currentIndex < len(m.flatItems) {
				item := m.flatItems[m.currentIndex]
				if item.IsContainer && item.Container != nil {
					return m, openTerminalToContainer(item.Container.Name)
				}
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case refreshMsg:
		m.containers = msg.containers
		m.flatItems = buildFlatItems(m.containers)
		// Restore selection by ID to prevent index drift after refresh.
		if m.selectedID != "" {
			found := false
			for i, item := range m.flatItems {
				if flatItemID(item) == m.selectedID {
					m.currentIndex = i
					found = true
					break
				}
			}
			if !found {
				m.currentIndex = min(m.currentIndex, max(0, len(m.flatItems)-1))
				if len(m.flatItems) > 0 {
					m.selectedID = flatItemID(m.flatItems[m.currentIndex])
				}
			}
		} else if m.currentIndex >= len(m.flatItems) {
			m.currentIndex = max(0, len(m.flatItems)-1)
		}

	case tickMsg:
		return m, tea.Batch(refreshData(), tickEvery(5*time.Second))

	case containerStoppedMsg:
		m.statusMessage = "Stopped: " + msg.name
		m.statusExpiry = time.Now().Add(3 * time.Second)
		return m, refreshData()

	case newSessionMsg:
		return m, refreshData()

	case statusMsg:
		m.statusMessage = msg.message
		m.statusExpiry = time.Now().Add(3 * time.Second)
		m.isRecording = false
		m.isPasting = false
	}

	// Clear expired status.
	if !m.statusExpiry.IsZero() && time.Now().After(m.statusExpiry) {
		m.statusMessage = ""
	}

	return m, nil
}

// flatItemID returns a stable identifier for a flat item, used to preserve
// cursor selection across data refreshes.
func flatItemID(item FlatItem) string {
	if item.IsContainer && item.Container != nil {
		return "c:" + item.Container.ID
	}
	if item.Session != nil && item.ParentContainer != nil {
		return "s:" + item.ParentContainer.ID + ":" + item.Session.ID
	}
	return ""
}

// --- Flat item construction ---

func buildFlatItems(containers []ContainerInfo) []FlatItem {
	var items []FlatItem
	for i := range containers {
		c := &containers[i]
		items = append(items, FlatItem{IsContainer: true, Container: c})
		for j := range c.Sessions {
			items = append(items, FlatItem{
				IsContainer:     false,
				Session:         &c.Sessions[j],
				ParentContainer: c,
			})
		}
	}
	return items
}

// --- Commands ---

func refreshData() tea.Cmd {
	return func() tea.Msg {
		containers := listRunningContainers()
		// Discover sessions inside each container.
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		for i := range containers {
			containers[i].Healthy = CheckHealth(ctx, containers[i].ID)
			containers[i].Sessions = DiscoverSessions(ctx, containers[i].ID)
		}
		return refreshMsg{containers: containers}
	}
}

func tickEvery(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func stopContainer(id, name string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := docker.Stop(ctx, id, 10); err != nil {
			return statusMsg{message: "Stop failed: " + err.Error()}
		}
		displayName := name
		if displayName == "" && len(id) >= 12 {
			displayName = id[:12]
		}
		return containerStoppedMsg{name: displayName}
	}
}

func launchNewContainer(path string, args []string) tea.Cmd {
	return func() tea.Msg {
		cmdArgs := append([]string{"--attach-mode", "--path", path}, args...)
		if err := openTerminalWithCommand("ccbox", cmdArgs); err != nil {
			return statusMsg{message: "Launch failed: " + err.Error()}
		}
		return statusMsg{message: "Launching new container..."}
	}
}

func sendVoice(containers []ContainerInfo) tea.Cmd {
	return func() tea.Msg {
		if len(containers) == 0 {
			return statusMsg{message: "No containers running"}
		}
		text, err := voice.Pipeline(voice.Options{Duration: 10, Model: "base.en"})
		if err != nil {
			return statusMsg{message: "Voice: " + err.Error()}
		}
		if text == "" {
			return statusMsg{message: "No speech detected"}
		}
		return pasteToContainer(containers[0], []byte(text), "voice")
	}
}

func sendPaste(containers []ContainerInfo) tea.Cmd {
	return func() tea.Msg {
		if len(containers) == 0 {
			return statusMsg{message: "No containers running"}
		}
		// Try image first, then text
		imgData, err := readClipboardImage()
		if err == nil && len(imgData) > 0 {
			return pasteToContainer(containers[0], imgData, "image")
		}
		textData, err := readClipboardText()
		if err == nil && strings.TrimSpace(textData) != "" {
			return pasteToContainer(containers[0], []byte(textData), "text")
		}
		return statusMsg{message: "Clipboard empty"}
	}
}

func openTerminalToContainer(containerName string) tea.Cmd {
	return func() tea.Msg {
		if err := openTerminalWithCommand("docker", []string{"exec", "-it", containerName, "/bin/bash"}); err != nil {
			return statusMsg{message: "Attach failed: " + err.Error()}
		}
		return statusMsg{message: "Opening terminal to " + containerName}
	}
}

// --- Docker container listing ---

// listRunningContainers returns all running ccbox containers using the Docker SDK.
func listRunningContainers() []ContainerInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cli, err := docker.NewClient()
	if err != nil {
		return nil
	}

	sdkContainers, err := cli.ContainerList(ctx, dcontainer.ListOptions{
		Filters: dfilters.NewArgs(dfilters.Arg("label", config.CcboxPrefix)),
	})
	if err != nil {
		return nil
	}

	var containers []ContainerInfo
	for _, c := range sdkContainers {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		info := ContainerInfo{
			ID:     c.ID,
			Name:   name,
			Status: c.Status,
			Stack:  c.Labels[config.LabelStack],
		}

		if project, ok := c.Labels[config.LabelProject]; ok {
			info.Project = project
		}
		if info.Project == "" {
			info.Project = info.Name
		}

		containers = append(containers, info)
	}
	return containers
}
