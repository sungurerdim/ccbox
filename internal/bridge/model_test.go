package bridge

import (
	"testing"
)

func TestNewBridgeModel(t *testing.T) {
	tests := []struct {
		name string
		opts BridgeOptions
	}{
		{
			name: "basic initialization",
			opts: BridgeOptions{
				Path:      "/home/user/project",
				CcboxArgs: []string{"--debug"},
			},
		},
		{
			name: "empty options",
			opts: BridgeOptions{},
		},
		{
			name: "multiple args",
			opts: BridgeOptions{
				Path:      "/tmp/test",
				CcboxArgs: []string{"--stack", "go", "--fresh"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewBridgeModel(tt.opts)

			if m.projectPath != tt.opts.Path {
				t.Errorf("projectPath = %q, want %q", m.projectPath, tt.opts.Path)
			}

			if len(m.ccboxArgs) != len(tt.opts.CcboxArgs) {
				t.Errorf("ccboxArgs len = %d, want %d", len(m.ccboxArgs), len(tt.opts.CcboxArgs))
			}

			for i, arg := range tt.opts.CcboxArgs {
				if m.ccboxArgs[i] != arg {
					t.Errorf("ccboxArgs[%d] = %q, want %q", i, m.ccboxArgs[i], arg)
				}
			}

			// Verify zero-value defaults
			if m.currentIndex != 0 {
				t.Errorf("currentIndex = %d, want 0", m.currentIndex)
			}
			if m.quitting {
				t.Error("quitting should be false")
			}
			if len(m.containers) != 0 {
				t.Errorf("containers should be empty, got %d", len(m.containers))
			}
			if len(m.flatItems) != 0 {
				t.Errorf("flatItems should be empty, got %d", len(m.flatItems))
			}
		})
	}
}
