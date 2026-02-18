package fuse

import (
	"testing"
)

//nolint:gocyclo // table-driven test with many sub-cases
func TestApplyDirMap(t *testing.T) {
	dm := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	t.Run("toContainer: native to container name", func(t *testing.T) {
		// Read direction: replace native name with container name in file content
		input := []byte(`/projects/D--GitHub-ccbox/session.jsonl`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/-D-GitHub-ccbox/session.jsonl`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("toHost: container to native name", func(t *testing.T) {
		// Write direction: replace container name with native name
		input := []byte(`/projects/-D-GitHub-ccbox/session.jsonl`)
		got := ApplyDirMap(input, dm, false)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/D--GitHub-ccbox/session.jsonl`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("JSON-escaped backslash separator", func(t *testing.T) {
		// In JSON content, paths might have \\projects\\ separators
		input := []byte(`\\projects\\D--GitHub-ccbox\\session.jsonl`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `\\projects\\-D-GitHub-ccbox\\session.jsonl`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("no match returns nil", func(t *testing.T) {
		input := []byte(`/projects/other-project/session.jsonl`)
		got := ApplyDirMap(input, dm, true)
		if got != nil {
			t.Errorf("expected nil, got %q", string(got))
		}
	})

	t.Run("empty mappings returns nil", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox/session.jsonl`)
		got := ApplyDirMap(input, nil, true)
		if got != nil {
			t.Errorf("expected nil, got %q", string(got))
		}
	})

	t.Run("empty buffer returns nil", func(t *testing.T) {
		got := ApplyDirMap(nil, dm, true)
		if got != nil {
			t.Errorf("expected nil, got %q", string(got))
		}
	})

	t.Run("boundary check: partial match not replaced", func(t *testing.T) {
		// "D--GitHub-ccbox-extra" should NOT match "D--GitHub-ccbox"
		input := []byte(`/projects/D--GitHub-ccbox-extra/session.jsonl`)
		got := ApplyDirMap(input, dm, true)
		if got != nil {
			t.Errorf("partial match should not transform, got %q", string(got))
		}
	})

	t.Run("boundary: name at end of string", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/-D-GitHub-ccbox`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("multiple dir mappings", func(t *testing.T) {
		multiDm := []DirMapping{
			{ContainerName: "-C-project-a", NativeName: "C--project-a"},
			{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
		}
		input := []byte(`/projects/D--GitHub-ccbox/session.jsonl`)
		got := ApplyDirMap(input, multiDm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		if string(got) != `/projects/-D-GitHub-ccbox/session.jsonl` {
			t.Errorf("got %q", string(got))
		}
	})

	t.Run("multiple occurrences of same name", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox/a.json /projects/D--GitHub-ccbox/b.json`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/-D-GitHub-ccbox/a.json /projects/-D-GitHub-ccbox/b.json`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("both forward slash and backslash in same buffer", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox/a.json \\projects\\D--GitHub-ccbox\\b.json`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/-D-GitHub-ccbox/a.json \\projects\\-D-GitHub-ccbox\\b.json`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("name is substring of another mapping", func(t *testing.T) {
		subDm := []DirMapping{
			{ContainerName: "-D-GitHub-cc", NativeName: "D--GitHub-cc"},
			{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
		}
		input := []byte(`/projects/D--GitHub-ccbox/session.jsonl`)
		got := ApplyDirMap(input, subDm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		// Should match -D-GitHub-ccbox (longer), NOT -D-GitHub-cc (shorter substring)
		// Because boundary check requires / or end-of-string after the match
		want := `/projects/-D-GitHub-ccbox/session.jsonl`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("DirMap round-trip: toContainer then toHost", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox/session.jsonl`)
		containerView := ApplyDirMap(input, dm, true)
		if containerView == nil {
			t.Fatal("toContainer returned nil")
		}
		hostView := ApplyDirMap(containerView, dm, false)
		if hostView == nil {
			t.Fatal("toHost returned nil")
		}
		if string(hostView) != string(input) {
			t.Errorf("round-trip mismatch:\n  got  %q\n  want %q", string(hostView), string(input))
		}
	})

	t.Run("DirMap in JSON string context", func(t *testing.T) {
		input := []byte(`{"path":"/ccbox/.claude/projects/D--GitHub-ccbox/session.jsonl"}`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `{"path":"/ccbox/.claude/projects/-D-GitHub-ccbox/session.jsonl"}`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("DirMap in JSON-escaped backslash context", func(t *testing.T) {
		input := []byte(`{"path":"\\\\ccbox\\.claude\\\\projects\\\\D--GitHub-ccbox\\\\session.jsonl"}`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `{"path":"\\\\ccbox\\.claude\\\\projects\\\\-D-GitHub-ccbox\\\\session.jsonl"}`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("name at boundary with quote terminator", func(t *testing.T) {
		input := []byte(`"/projects/D--GitHub-ccbox"`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `"/projects/-D-GitHub-ccbox"`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("name at boundary with comma terminator", func(t *testing.T) {
		input := []byte(`/projects/D--GitHub-ccbox,other`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `/projects/-D-GitHub-ccbox,other`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("name at boundary with bracket terminator", func(t *testing.T) {
		input := []byte(`["/projects/D--GitHub-ccbox"]`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `["/projects/-D-GitHub-ccbox"]`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})

	t.Run("name at boundary with brace terminator", func(t *testing.T) {
		input := []byte(`{"/projects/D--GitHub-ccbox}`)
		got := ApplyDirMap(input, dm, true)
		if got == nil {
			t.Fatal("expected transform, got nil")
		}
		want := `{"/projects/-D-GitHub-ccbox}`
		if string(got) != want {
			t.Errorf("got  %q\nwant %q", string(got), want)
		}
	})
}
