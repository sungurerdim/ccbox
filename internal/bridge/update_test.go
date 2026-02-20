package bridge

import (
	"testing"
)

func TestBuildFlatItems(t *testing.T) {
	tests := []struct {
		name       string
		containers []ContainerInfo
		wantLen    int
	}{
		{
			name:       "empty",
			containers: nil,
			wantLen:    0,
		},
		{
			name: "single container no sessions",
			containers: []ContainerInfo{
				{ID: "c1", Name: "test-1"},
			},
			wantLen: 1,
		},
		{
			name: "container with sessions",
			containers: []ContainerInfo{
				{
					ID:   "c1",
					Name: "test-1",
					Sessions: []Session{
						{ID: "s1", Project: "proj1"},
						{ID: "s2", Project: "proj2"},
					},
				},
			},
			wantLen: 3, // 1 container + 2 sessions
		},
		{
			name: "multi container",
			containers: []ContainerInfo{
				{ID: "c1", Name: "test-1"},
				{
					ID:   "c2",
					Name: "test-2",
					Sessions: []Session{
						{ID: "s1", Project: "proj1"},
					},
				},
			},
			wantLen: 3, // 2 containers + 1 session
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			items := buildFlatItems(tt.containers)
			if len(items) != tt.wantLen {
				t.Errorf("len(items) = %d, want %d", len(items), tt.wantLen)
			}
		})
	}
}

func TestBuildFlatItemsStructure(t *testing.T) {
	containers := []ContainerInfo{
		{
			ID:   "c1",
			Name: "test-1",
			Sessions: []Session{
				{ID: "s1", Project: "proj1"},
			},
		},
	}

	items := buildFlatItems(containers)
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}

	// First item should be container
	if !items[0].IsContainer {
		t.Error("first item should be a container")
	}
	if items[0].Container == nil {
		t.Error("container item should have Container set")
	}
	if items[0].Container.ID != "c1" {
		t.Errorf("container ID = %q, want %q", items[0].Container.ID, "c1")
	}

	// Second item should be session
	if items[1].IsContainer {
		t.Error("second item should be a session")
	}
	if items[1].Session == nil {
		t.Error("session item should have Session set")
	}
	if items[1].ParentContainer == nil {
		t.Error("session item should have ParentContainer set")
	}
	if items[1].Session.ID != "s1" {
		t.Errorf("session ID = %q, want %q", items[1].Session.ID, "s1")
	}
}

func TestFlatItemID(t *testing.T) {
	tests := []struct {
		name string
		item FlatItem
		want string
	}{
		{
			name: "container item",
			item: FlatItem{
				IsContainer: true,
				Container:   &ContainerInfo{ID: "abc123"},
			},
			want: "c:abc123",
		},
		{
			name: "session item",
			item: FlatItem{
				IsContainer:     false,
				Session:         &Session{ID: "sess1"},
				ParentContainer: &ContainerInfo{ID: "abc123"},
			},
			want: "s:abc123:sess1",
		},
		{
			name: "container with nil Container",
			item: FlatItem{IsContainer: true, Container: nil},
			want: "",
		},
		{
			name: "session with nil fields",
			item: FlatItem{IsContainer: false, Session: nil, ParentContainer: nil},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := flatItemID(tt.item)
			if got != tt.want {
				t.Errorf("flatItemID() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFlatItemIDUniqueness(t *testing.T) {
	containers := []ContainerInfo{
		{
			ID:   "c1",
			Name: "test-1",
			Sessions: []Session{
				{ID: "s1", Project: "proj1"},
				{ID: "s2", Project: "proj2"},
			},
		},
		{
			ID:   "c2",
			Name: "test-2",
			Sessions: []Session{
				{ID: "s1", Project: "proj3"},
			},
		},
	}

	items := buildFlatItems(containers)
	seen := make(map[string]bool)
	for _, item := range items {
		id := flatItemID(item)
		if id == "" {
			continue
		}
		if seen[id] {
			t.Errorf("duplicate flat item ID: %q", id)
		}
		seen[id] = true
	}
}
