package bridge

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
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
			}

		case "down", "j":
			if m.currentIndex < len(m.flatItems)-1 {
				m.currentIndex++
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
			return m, sendVoice(m.containers)

		case "p":
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
		if m.currentIndex >= len(m.flatItems) {
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
	}

	// Clear expired status.
	if !m.statusExpiry.IsZero() && time.Now().After(m.statusExpiry) {
		m.statusMessage = ""
	}

	return m, nil
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
		cmd := exec.Command("docker", "stop", "--time", "10", id)
		if err := cmd.Run(); err != nil {
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
		// TODO: Implement voice pipeline.
		return statusMsg{message: "Voice recording... (not yet implemented)"}
	}
}

func sendPaste(containers []ContainerInfo) tea.Cmd {
	return func() tea.Msg {
		if len(containers) == 0 {
			return statusMsg{message: "No containers running"}
		}
		// TODO: Implement clipboard paste pipeline.
		return statusMsg{message: "Pasting clipboard... (not yet implemented)"}
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

// dockerPSEntry maps the JSON output of `docker ps --format '{{json .}}'`.
type dockerPSEntry struct {
	ID     string `json:"ID"`
	Names  string `json:"Names"`
	Status string `json:"Status"`
	State  string `json:"State"`
	Labels string `json:"Labels"`
}

// listRunningContainers returns all running ccbox containers by querying
// the Docker CLI. We use `docker ps` with a label filter and JSON output
// rather than the Docker SDK to avoid version-specific type mismatches.
func listRunningContainers() []ContainerInfo {
	cmd := exec.Command(
		"docker", "ps",
		"--filter", "label=ccbox",
		"--format", "{{json .}}",
		"--no-trunc",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var containers []ContainerInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var entry dockerPSEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		info := ContainerInfo{
			ID:     entry.ID,
			Name:   entry.Names,
			Status: entry.Status,
		}

		// Parse labels to extract ccbox metadata.
		// Labels string looks like: "ccbox=true,ccbox.stack=node,ccbox.project=myapp"
		for _, pair := range strings.Split(entry.Labels, ",") {
			kv := strings.SplitN(pair, "=", 2)
			if len(kv) != 2 {
				continue
			}
			switch kv[0] {
			case "ccbox.stack":
				info.Stack = kv[1]
			case "ccbox.project":
				info.Project = kv[1]
			}
		}

		// Fall back to container name for project if label is missing.
		if info.Project == "" {
			info.Project = info.Name
		}

		containers = append(containers, info)
	}
	return containers
}
