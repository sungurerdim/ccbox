package fuse

import (
	"testing"
)

func TestTranslatePathSegments(t *testing.T) {
	dm := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	tests := []struct {
		name string
		path string
		want string
	}{
		{
			name: "replace container segment",
			path: "/projects/-D-GitHub-ccbox/session.jsonl",
			want: "/projects/D--GitHub-ccbox/session.jsonl",
		},
		{
			name: "segment at end",
			path: "/projects/-D-GitHub-ccbox",
			want: "/projects/D--GitHub-ccbox",
		},
		{
			name: "no match",
			path: "/projects/other-project/session.jsonl",
			want: "/projects/other-project/session.jsonl",
		},
		{
			name: "root only",
			path: "/",
			want: "/",
		},
		{
			name: "empty path",
			path: "",
			want: "",
		},
		{
			name: "partial match not replaced",
			path: "/projects/-D-GitHub-ccbox-extra/file",
			want: "/projects/-D-GitHub-ccbox-extra/file",
		},
		{
			name: "multiple segments",
			path: "/a/-D-GitHub-ccbox/b/-D-GitHub-ccbox/c",
			want: "/a/D--GitHub-ccbox/b/D--GitHub-ccbox/c",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := translatePathSegments(tt.path, dm)
			if got != tt.want {
				t.Errorf("translatePathSegments(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}

	t.Run("empty dir mappings passthrough", func(t *testing.T) {
		got := translatePathSegments("/some/path", nil)
		if got != "/some/path" {
			t.Errorf("expected passthrough, got %q", got)
		}
	})
}

func TestGetSourcePath(t *testing.T) {
	dm := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	tests := []struct {
		name      string
		sourceDir string
		path      string
		want      string
	}{
		{
			name:      "with dir mapping",
			sourceDir: "/run/ccbox-fuse/ccbox-.claude",
			path:      "/projects/-D-GitHub-ccbox/session.jsonl",
			want:      "/run/ccbox-fuse/ccbox-.claude/projects/D--GitHub-ccbox/session.jsonl",
		},
		{
			name:      "no dir mapping match",
			sourceDir: "/run/ccbox-fuse/ccbox-.claude",
			path:      "/settings.json",
			want:      "/run/ccbox-fuse/ccbox-.claude/settings.json",
		},
		{
			name:      "root path",
			sourceDir: "/source",
			path:      "/",
			want:      "/source/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetSourcePath(tt.sourceDir, tt.path, dm)
			if got != tt.want {
				t.Errorf("GetSourcePath(%q, %q) = %q, want %q", tt.sourceDir, tt.path, got, tt.want)
			}
		})
	}

	t.Run("no dir mappings", func(t *testing.T) {
		got := GetSourcePath("/source", "/file.json", nil)
		if got != "/source/file.json" {
			t.Errorf("expected /source/file.json, got %q", got)
		}
	})

	t.Run("non-absolute path without mappings", func(t *testing.T) {
		got := GetSourcePath("/source", "relative/path", nil)
		if got != "/sourcerelative/path" {
			t.Errorf("got %q", got)
		}
	})
}
