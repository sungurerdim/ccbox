package fuse

import (
	"strings"
	"testing"
)

// --- extractJSONPath ---

func TestExtractJSONPath(t *testing.T) {
	tests := []struct {
		name     string
		buf      string
		pos      int
		wantPath string
		wantPos  int
	}{
		{
			name:     "forward slashes",
			buf:      `/GitHub/ccbox/file.go"`,
			pos:      0,
			wantPath: "/GitHub/ccbox/file.go",
			wantPos:  21,
		},
		{
			name:     "JSON-escaped backslashes",
			buf:      `\\GitHub\\ccbox\\file.go"`,
			pos:      0,
			wantPath: "/GitHub/ccbox/file.go",
			wantPos:  24,
		},
		{
			name:     "mixed separators",
			buf:      `\\GitHub/ccbox\\file.go"`,
			pos:      0,
			wantPath: "/GitHub/ccbox/file.go",
			wantPos:  23,
		},
		{
			name:     "stops at comma",
			buf:      `/path/to/file,next`,
			pos:      0,
			wantPath: "/path/to/file",
			wantPos:  13,
		},
		{
			name:     "stops at closing brace",
			buf:      `/path/to/file}`,
			pos:      0,
			wantPath: "/path/to/file",
			wantPos:  13,
		},
		{
			name:     "stops at closing bracket",
			buf:      `/path/to/file]`,
			pos:      0,
			wantPath: "/path/to/file",
			wantPos:  13,
		},
		{
			name:     "empty at quote",
			buf:      `"rest`,
			pos:      0,
			wantPath: "",
			wantPos:  0,
		},
		{
			name:     "starts at offset",
			buf:      `xxx/path/file"`,
			pos:      3,
			wantPath: "/path/file",
			wantPos:  13,
		},
		// --- Additional extractJSONPath coverage ---
		// Note: extractJSONPath does NOT stop at whitespace.
		// Whitespace stop is handled by TransformToContainer/TransformToHost callers.
		{
			name:     "whitespace included in path (not a terminator)",
			buf:      "/path/to/file rest",
			pos:      0,
			wantPath: "/path/to/file rest",
			wantPos:  18,
		},
		{
			name:     "path at end of buffer no terminator",
			buf:      "/path/to/file",
			pos:      0,
			wantPath: "/path/to/file",
			wantPos:  13,
		},
		{
			name:     "single backslash becomes slash",
			buf:      `\file\data"`,
			pos:      0,
			wantPath: "/file/data",
			wantPos:  10,
		},
		{
			name:     "dots dashes underscores preserved",
			buf:      `/path/my-file_v2.3.json"`,
			pos:      0,
			wantPath: "/path/my-file_v2.3.json",
			wantPos:  23,
		},
		{
			name:     "empty path at comma",
			buf:      `,rest`,
			pos:      0,
			wantPath: "",
			wantPos:  0,
		},
		{
			name:     "deeply nested path",
			buf:      `/a/b/c/d/e/f/g/h/i/j/file.go"`,
			pos:      0,
			wantPath: "/a/b/c/d/e/f/g/h/i/j/file.go",
			wantPos:  28,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotPath, gotPos := extractJSONPath([]byte(tt.buf), tt.pos)
			if gotPath != tt.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tt.wantPath)
			}
			if gotPos != tt.wantPos {
				t.Errorf("pos = %d, want %d", gotPos, tt.wantPos)
			}
		})
	}
}

// --- TransformToContainer ---

func TestTransformToContainer(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		mappings    []PathMapping
		dirMappings []DirMapping
		want        string // empty means nil (no transform)
	}{
		{
			name:  "drive letter JSON-escaped backslashes",
			input: `{"path":"D:\\GitHub\\ccbox\\src\\main.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"path":"/D/GitHub/ccbox/src/main.go"}`,
		},
		{
			name:  "drive letter forward slashes",
			input: `{"path":"D:/GitHub/ccbox/src/main.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"path":"/D/GitHub/ccbox/src/main.go"}`,
		},
		{
			name:  "case-insensitive drive letter",
			input: `{"path":"d:\\GitHub\\ccbox\\file.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"path":"/D/GitHub/ccbox/file.go"}`,
		},
		{
			name:  "WSL path",
			input: `{"cwd":"/mnt/d/GitHub/ccbox"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			want: `{"cwd":"/D/GitHub/ccbox"}`,
		},
		{
			name:  "WSL path with subpath",
			input: `{"cwd":"/mnt/d/GitHub/ccbox/src/main.go"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			want: `{"cwd":"/D/GitHub/ccbox/src/main.go"}`,
		},
		{
			name:  "multiple mappings in one buffer",
			input: `{"project":"D:\\GitHub\\ccbox","config":"C:\\Users\\Sungur\\.claude"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: `{"project":"/D/GitHub/ccbox","config":"/ccbox/.claude"}`,
		},
		{
			name:  "no matching mapping returns nil",
			input: `{"path":"/usr/local/bin"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: "",
		},
		{
			name:     "empty buffer returns nil",
			input:    "",
			mappings: []PathMapping{{From: "D:/GitHub", To: "/D/GitHub", Drive: 'd'}},
			want:     "",
		},
		{
			name:  "empty mappings returns nil",
			input: `{"path":"D:\\GitHub\\ccbox"}`,
			want:  "",
		},
		{
			name:  "drive letter exact match no subpath",
			input: `{"cwd":"D:\\GitHub\\ccbox"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"cwd":"/D/GitHub/ccbox"}`,
		},
		{
			name:  "with dirmap post-pass",
			input: `{"dir":"D:\\GitHub\\ccbox","session":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\session.jsonl"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			dirMappings: []DirMapping{
				{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
			},
			want: `{"dir":"/D/GitHub/ccbox","session":"/ccbox/.claude/projects/-D-GitHub-ccbox/session.jsonl"}`,
		},
		// --- Boundary check tests (prefix attack prevention) ---
		{
			name:  "drive letter prefix attack: sibling dir not matched",
			input: `{"path":"D:\\GitHub\\ccbox-web\\index.html"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: "", // must NOT match: ccbox-web != ccbox
		},
		{
			name:  "drive letter prefix attack: claude config suffix not matched",
			input: `{"path":"C:\\Users\\Sungur\\.claude-backup\\data.json"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: "", // must NOT match: .claude-backup != .claude
		},
		{
			name:  "drive letter prefix attack: forward slash variant not matched",
			input: `{"path":"D:/GitHub/ccbox-web/main.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: "", // must NOT match
		},
		{
			name:  "UNC prefix attack: share suffix not matched",
			input: `\\\\server\\share-extra\\file.txt`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: "", // must NOT match: share-extra != share
		},
		{
			name:  "drive letter boundary: subpath with slash is matched",
			input: `{"path":"D:\\GitHub\\ccbox\\deep\\file.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"path":"/D/GitHub/ccbox/deep/file.go"}`,
		},
		{
			name:  "UNC boundary: subpath with slash is matched",
			input: `\\\\server\\share\\subdir\\file.txt`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `/mnt/share/subdir/file.txt`,
		},
		// --- WSL boundary tests ---
		{
			name:  "WSL prefix attack: sibling dir not matched",
			input: `{"path":"/mnt/d/GitHub/ccbox-web/index.html"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			want: "", // must NOT match
		},
		{
			name:  "WSL exact match at terminator",
			input: `{"cwd":"/mnt/d/GitHub/ccbox"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			want: `{"cwd":"/D/GitHub/ccbox"}`,
		},
		// --- Multiple occurrences ---
		{
			name:  "same path appears multiple times",
			input: `{"a":"D:\\GitHub\\ccbox\\x","b":"D:\\GitHub\\ccbox\\y","c":"D:\\GitHub\\ccbox\\z"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"a":"/D/GitHub/ccbox/x","b":"/D/GitHub/ccbox/y","c":"/D/GitHub/ccbox/z"}`,
		},
		// --- JSON array context ---
		{
			name:  "paths inside JSON array",
			input: `["D:\\GitHub\\ccbox\\a.go","D:\\GitHub\\ccbox\\b.go"]`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `["/D/GitHub/ccbox/a.go","/D/GitHub/ccbox/b.go"]`,
		},
		// --- Mixed mapping types in one buffer ---
		{
			name:  "drive + WSL + UNC all in one buffer",
			input: `{"win":"D:\\GitHub\\ccbox\\f","wsl":"/mnt/c/Users/x","unc":"\\\\server\\share\\doc"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "/mnt/c/Users/x", To: "/C/Users/x", Drive: 'c', IsWSL: true},
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `{"win":"/D/GitHub/ccbox/f","wsl":"/C/Users/x","unc":"/mnt/share/doc"}`,
		},
		// --- UNC in JSON context ---
		{
			name:  "UNC exact match no subpath in JSON",
			input: `{"share":"\\\\server\\share"}`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `{"share":"/mnt/share"}`,
		},
		{
			name:  "UNC with subpath in JSON",
			input: `{"file":"\\\\server\\share\\docs\\readme.md"}`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `{"file":"/mnt/share/docs/readme.md"}`,
		},
		// --- Overlapping mappings (more specific wins by order) ---
		{
			name:  "overlapping mappings: more specific first",
			input: `{"a":"D:\\GitHub\\ccbox\\internal\\f","b":"D:\\GitHub\\other\\g"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "D:/GitHub", To: "/D/GitHub", Drive: 'd'},
			},
			want: `{"a":"/D/GitHub/ccbox/internal/f","b":"/D/GitHub/other/g"}`,
		},
		// --- False positive drive letter not a path ---
		{
			name:  "drive letter in non-path context not matched",
			input: `{"msg":"Status: OK, Code: 200"}`,
			mappings: []PathMapping{
				{From: "C:/Users", To: "/C/Users", Drive: 'c'},
			},
			want: "", // ": OK" doesn't match "/Users"
		},
		// --- Deeply nested path ---
		{
			name:  "deeply nested subpath",
			input: `{"f":"D:\\GitHub\\ccbox\\a\\b\\c\\d\\e\\f\\g.json"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"f":"/D/GitHub/ccbox/a/b/c/d/e/f/g.json"}`,
		},
		// --- Upper vs lower drive letter ---
		{
			name:  "uppercase drive letter D: matched",
			input: `{"p":"D:\\GitHub\\ccbox\\f.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"p":"/D/GitHub/ccbox/f.go"}`,
		},
		{
			name:  "lowercase drive letter d: matched",
			input: `{"p":"d:\\GitHub\\ccbox\\f.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"p":"/D/GitHub/ccbox/f.go"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := TransformToContainer([]byte(tt.input), tt.mappings, tt.dirMappings)
			if tt.want == "" {
				if got != nil {
					t.Errorf("expected nil, got %q", string(got))
				}
			} else {
				if got == nil {
					t.Fatalf("expected %q, got nil", tt.want)
				}
				if string(got) != tt.want {
					t.Errorf("got  %q\nwant %q", string(got), tt.want)
				}
			}
		})
	}
}

// --- TransformToHost ---

func TestTransformToHost(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		mappings    []PathMapping
		dirMappings []DirMapping
		want        string // empty means nil
	}{
		{
			name:  "container path to Windows JSON-escaped backslashes",
			input: `{"path":"/D/GitHub/ccbox/src/main.go"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"path":"D:\\GitHub\\ccbox\\src\\main.go"}`,
		},
		{
			name:  "ccbox claude config path",
			input: `{"config":"/ccbox/.claude/settings.json"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: `{"config":"C:\\Users\\Sungur\\.claude\\settings.json"}`,
		},
		{
			name:  "multiple paths in buffer",
			input: `{"a":"/D/GitHub/ccbox/x","b":"/ccbox/.claude/y"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: `{"a":"D:\\GitHub\\ccbox\\x","b":"C:\\Users\\Sungur\\.claude\\y"}`,
		},
		{
			name:  "exact match without subpath",
			input: `{"cwd":"/D/GitHub/ccbox"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"cwd":"D:\\GitHub\\ccbox"}`,
		},
		{
			name:  "no matching mapping returns nil",
			input: `{"path":"/usr/local/bin"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: "",
		},
		{
			name:     "empty buffer returns nil",
			input:    "",
			mappings: []PathMapping{{From: "D:/GitHub", To: "/D/GitHub", Drive: 'd'}},
			want:     "",
		},
		{
			name:  "with dirmap post-pass",
			input: `{"session":"/ccbox/.claude/projects/-D-GitHub-ccbox/s.jsonl"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			dirMappings: []DirMapping{
				{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
			},
			want: `{"session":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\s.jsonl"}`,
		},
		{
			name:  "WSL-origin path restored to WSL format",
			input: `{"path":"/D/GitHub/ccbox/file.go"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			// WSL paths use forward slashes, no backslash conversion
			want: `{"path":"/mnt/d/GitHub/ccbox/file.go"}`,
		},
		// --- Boundary check tests ---
		{
			name:  "host boundary: container prefix not matched for longer path",
			input: `{"path":"/D/GitHub/ccbox-web/index.html"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: "", // /D/GitHub/ccbox-web should NOT match /D/GitHub/ccbox
		},
		{
			name:  "host boundary: claude config suffix not matched",
			input: `{"path":"/ccbox/.claude-backup/data.json"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: "", // /ccbox/.claude-backup should NOT match /ccbox/.claude
		},
		// --- UNC restoration ---
		{
			name:  "UNC path restored with JSON-escaped backslashes",
			input: `{"share":"/mnt/share/docs/file.txt"}`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `{"share":"\\\\server\\share\\docs\\file.txt"}`,
		},
		{
			name:  "UNC exact match no subpath",
			input: `{"share":"/mnt/share"}`,
			mappings: []PathMapping{
				{From: "//server/share", To: "/mnt/share", IsUNC: true},
			},
			want: `{"share":"\\\\server\\share"}`,
		},
		// --- Multiple occurrences ---
		{
			name:  "same container path appears multiple times",
			input: `{"a":"/D/GitHub/ccbox/x","b":"/D/GitHub/ccbox/y"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"a":"D:\\GitHub\\ccbox\\x","b":"D:\\GitHub\\ccbox\\y"}`,
		},
		// --- JSON array ---
		{
			name:  "paths inside JSON array",
			input: `["/D/GitHub/ccbox/a.go","/D/GitHub/ccbox/b.go"]`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `["D:\\GitHub\\ccbox\\a.go","D:\\GitHub\\ccbox\\b.go"]`,
		},
		// --- Overlapping To prefix: more specific mapping first ---
		{
			name:  "overlapping To prefix: /ccbox/.claude matched before /ccbox",
			input: `{"cfg":"/ccbox/.claude/settings.json","proj":"/D/GitHub/ccbox/main.go"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			want: `{"cfg":"C:\\Users\\Sungur\\.claude\\settings.json","proj":"D:\\GitHub\\ccbox\\main.go"}`,
		},
		// --- WSL with subpath restoration ---
		{
			name:  "WSL path with subpath restored",
			input: `{"f":"/D/GitHub/ccbox/internal/run/phases.go"}`,
			mappings: []PathMapping{
				{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
			},
			want: `{"f":"/mnt/d/GitHub/ccbox/internal/run/phases.go"}`,
		},
		// --- Mixed drive + WSL in same buffer ---
		{
			name:  "mixed drive and config paths restored",
			input: `{"proj":"/D/GitHub/ccbox/f","cfg":"/ccbox/.claude/s.json"}`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			want: `{"proj":"D:\\GitHub\\ccbox\\f","cfg":"C:\\Users\\Sungur\\.claude\\s.json"}`,
		},
		// --- DirMap round-trip in host direction ---
		{
			name:  "dirmap with multiple paths in host direction",
			input: `{"session":"/ccbox/.claude/projects/-D-GitHub-ccbox/session.jsonl","alt":"/ccbox/.claude/projects/-D-GitHub-ccbox/mcp.json"}`,
			mappings: []PathMapping{
				{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
			},
			dirMappings: []DirMapping{
				{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
			},
			want: `{"session":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\session.jsonl","alt":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\mcp.json"}`,
		},
		// --- Path at end of buffer ---
		{
			name:  "path at very end of buffer no trailing chars",
			input: `/D/GitHub/ccbox/file.go`,
			mappings: []PathMapping{
				{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
			},
			// TransformToHost always produces JSON-escaped backslashes for drive paths
			want: `D:\\GitHub\\ccbox\\file.go`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := TransformToHost([]byte(tt.input), tt.mappings, tt.dirMappings)
			if tt.want == "" {
				if got != nil {
					t.Errorf("expected nil, got %q", string(got))
				}
			} else {
				if got == nil {
					t.Fatalf("expected %q, got nil", tt.want)
				}
				if string(got) != tt.want {
					t.Errorf("got  %q\nwant %q", string(got), tt.want)
				}
			}
		})
	}
}

// --- Round-trip tests ---

func TestTransformRoundTrip(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
	}
	dirMappings := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	// Host content (Windows paths in JSON)
	hostContent := `{"files":[{"path":"D:\\GitHub\\ccbox\\main.go"},{"path":"D:\\GitHub\\ccbox\\go.mod"}],"config":"C:\\Users\\Sungur\\.claude\\settings.json"}`

	// Transform to container
	containerContent := TransformToContainer([]byte(hostContent), mappings, dirMappings)
	if containerContent == nil {
		t.Fatal("TransformToContainer returned nil")
	}

	// Verify container paths
	containerStr := string(containerContent)
	if !strings.Contains(containerStr, "/D/GitHub/ccbox/main.go") {
		t.Errorf("container content should contain /D/GitHub/ccbox/main.go, got %s", containerStr)
	}
	if !strings.Contains(containerStr, "/ccbox/.claude/settings.json") {
		t.Errorf("container content should contain /ccbox/.claude/settings.json, got %s", containerStr)
	}

	// Transform back to host
	restored := TransformToHost(containerContent, mappings, dirMappings)
	if restored == nil {
		t.Fatal("TransformToHost returned nil")
	}

	// Verify Windows paths restored
	restoredStr := string(restored)
	if !strings.Contains(restoredStr, `D:\\GitHub\\ccbox\\main.go`) {
		t.Errorf("restored content should contain D:\\\\GitHub\\\\ccbox\\\\main.go, got %s", restoredStr)
	}
	if !strings.Contains(restoredStr, `C:\\Users\\Sungur\\.claude\\settings.json`) {
		t.Errorf("restored content should contain C:\\\\Users\\\\Sungur\\\\.claude\\\\settings.json, got %s", restoredStr)
	}
}

// --- Session file simulation ---

func TestTransformSessionFile(t *testing.T) {
	// Simulate a Claude Code session JSONL file written on Windows
	hostSession := `{"type":"assistant","content":"I'll edit the file at D:\\GitHub\\ccbox\\internal\\run\\phases.go"}
{"type":"tool_use","path":"D:\\GitHub\\ccbox\\internal\\run\\phases.go","content":"..."}
{"type":"result","cwd":"D:\\GitHub\\ccbox"}
`

	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
	}

	// When container reads this file, FUSE transforms to container paths
	containerView := TransformToContainer([]byte(hostSession), mappings, nil)
	if containerView == nil {
		t.Fatal("session transform returned nil")
	}

	containerStr := string(containerView)
	lines := strings.Split(containerStr, "\n")

	// Each line should have container paths
	for i, line := range lines {
		if line == "" {
			continue
		}
		if strings.Contains(line, `D:\`) || strings.Contains(line, `D:/`) {
			t.Errorf("line %d still contains Windows path: %s", i, line)
		}
		if !strings.Contains(line, "/D/GitHub/ccbox") {
			t.Errorf("line %d should contain container path /D/GitHub/ccbox: %s", i, line)
		}
	}
}

// --- Comprehensive round-trip tests ---

func TestRoundTripWithDirMap(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
	}
	dirMappings := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	// Host-side content: native Windows paths with native dir encoding
	host := `{"session":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\session.jsonl","cwd":"D:\\GitHub\\ccbox"}`

	// Host → Container
	container := TransformToContainer([]byte(host), mappings, dirMappings)
	if container == nil {
		t.Fatal("ToContainer returned nil")
	}
	containerStr := string(container)

	// Verify container view
	if !strings.Contains(containerStr, "/ccbox/.claude/projects/-D-GitHub-ccbox/session.jsonl") {
		t.Errorf("container should have container-encoded dir name, got: %s", containerStr)
	}
	if !strings.Contains(containerStr, "/D/GitHub/ccbox") {
		t.Errorf("container should have container project path, got: %s", containerStr)
	}

	// Container → Host
	restored := TransformToHost(container, mappings, dirMappings)
	if restored == nil {
		t.Fatal("ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

func TestRoundTripWSL(t *testing.T) {
	mappings := []PathMapping{
		{From: "/mnt/d/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd', IsWSL: true},
	}

	host := `{"cwd":"/mnt/d/GitHub/ccbox/src","file":"/mnt/d/GitHub/ccbox/main.go"}`

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("ToContainer returned nil")
	}

	containerStr := string(container)
	if !strings.Contains(containerStr, "/D/GitHub/ccbox/src") {
		t.Errorf("expected container path, got: %s", containerStr)
	}

	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("WSL round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

func TestRoundTripUNC(t *testing.T) {
	mappings := []PathMapping{
		{From: "//server/share", To: "/mnt/share", IsUNC: true},
	}

	host := `{"doc":"\\\\server\\share\\docs\\readme.md"}`

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("ToContainer returned nil")
	}

	containerStr := string(container)
	if !strings.Contains(containerStr, "/mnt/share/docs/readme.md") {
		t.Errorf("expected container UNC path, got: %s", containerStr)
	}

	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("UNC round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

func TestRoundTripMultipleDrives(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
		{From: "E:/data", To: "/E/data", Drive: 'e'},
	}

	host := `{"a":"D:\\GitHub\\ccbox\\main.go","b":"C:\\Users\\Sungur\\.claude\\settings.json","c":"E:\\data\\log.jsonl"}`

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("ToContainer returned nil")
	}

	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("multi-drive round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

func TestRoundTripNoPathsReturnsNil(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
	}

	content := `{"msg":"hello world","count":42,"flag":true}`

	if got := TransformToContainer([]byte(content), mappings, nil); got != nil {
		t.Errorf("no-path content should return nil from ToContainer, got %q", string(got))
	}
	if got := TransformToHost([]byte(content), mappings, nil); got != nil {
		t.Errorf("no-path content should return nil from ToHost, got %q", string(got))
	}
}

func TestRoundTripSettingsJSON(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
	}

	// Realistic settings.json content with various path references
	host := `{"projectPath":"D:\\GitHub\\ccbox","claudeDir":"C:\\Users\\Sungur\\.claude","tools":[{"path":"D:\\GitHub\\ccbox\\scripts\\lint.sh"},{"path":"D:\\GitHub\\ccbox\\scripts\\test.sh"}]}`

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("settings.json ToContainer returned nil")
	}

	containerStr := string(container)
	if strings.Contains(containerStr, `D:\`) || strings.Contains(containerStr, `C:\`) {
		t.Errorf("container view should not contain Windows backslash paths: %s", containerStr)
	}

	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("settings.json ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("settings.json round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

func TestSessionJSONLWithDirMap(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "C:/Users/Sungur/.claude", To: "/ccbox/.claude", Drive: 'c'},
	}
	dirMappings := []DirMapping{
		{ContainerName: "-D-GitHub-ccbox", NativeName: "D--GitHub-ccbox"},
	}

	// Multi-line JSONL - a realistic session file with project and config refs
	hostJSONL := `{"type":"init","cwd":"D:\\GitHub\\ccbox","session":"C:\\Users\\Sungur\\.claude\\projects\\D--GitHub-ccbox\\session.jsonl"}
{"type":"tool","path":"D:\\GitHub\\ccbox\\internal\\fuse\\transform.go"}
{"type":"result","modified":["D:\\GitHub\\ccbox\\internal\\fuse\\transform.go","D:\\GitHub\\ccbox\\internal\\fuse\\config.go"]}
`

	container := TransformToContainer([]byte(hostJSONL), mappings, dirMappings)
	if container == nil {
		t.Fatal("session JSONL ToContainer returned nil")
	}

	containerStr := string(container)

	// Verify no Windows paths remain
	if strings.Contains(containerStr, `D:\`) || strings.Contains(containerStr, `C:\`) {
		t.Errorf("container view still has Windows paths: %s", containerStr)
	}

	// Verify DirMap applied
	if !strings.Contains(containerStr, "-D-GitHub-ccbox") {
		t.Errorf("container view should have container dir encoding: %s", containerStr)
	}
	if strings.Contains(containerStr, "D--GitHub-ccbox") {
		t.Errorf("container view should NOT have native dir encoding: %s", containerStr)
	}

	// Round-trip back
	restored := TransformToHost(container, mappings, dirMappings)
	if restored == nil {
		t.Fatal("session JSONL ToHost returned nil")
	}

	if string(restored) != hostJSONL {
		t.Errorf("session JSONL round-trip mismatch:\n  got  %q\n  want %q", string(restored), hostJSONL)
	}
}

func TestRoundTripMixedAllTypes(t *testing.T) {
	// Simultaneously uses drive, WSL, and UNC mappings
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
		{From: "/mnt/c/Users/x", To: "/C/Users/x", Drive: 'c', IsWSL: true},
		{From: "//server/share", To: "/mnt/share", IsUNC: true},
	}

	// Host content: drive uses backslash, WSL uses forward, UNC uses escaped backslash
	host := `{"win":"D:\\GitHub\\ccbox\\main.go","wsl":"/mnt/c/Users/x/config","unc":"\\\\server\\share\\doc.json"}`

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("mixed types ToContainer returned nil")
	}

	containerStr := string(container)
	// All should be Linux-style paths now
	if !strings.Contains(containerStr, "/D/GitHub/ccbox/main.go") {
		t.Errorf("drive path not transformed: %s", containerStr)
	}
	if !strings.Contains(containerStr, "/C/Users/x/config") {
		t.Errorf("WSL path not transformed: %s", containerStr)
	}
	if !strings.Contains(containerStr, "/mnt/share/doc.json") {
		t.Errorf("UNC path not transformed: %s", containerStr)
	}

	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("mixed types ToHost returned nil")
	}

	if string(restored) != host {
		t.Errorf("mixed types round-trip mismatch:\n  got  %q\n  want %q", string(restored), host)
	}
}

// --- Edge cases ---

func TestTransformEmptyJSON(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
	}

	cases := []string{
		`{}`,
		`{"key":"value"}`,
		`[]`,
		`[1,2,3]`,
		`{"nested":{"deep":true}}`,
	}

	for _, c := range cases {
		if got := TransformToContainer([]byte(c), mappings, nil); got != nil {
			t.Errorf("TransformToContainer(%q) should be nil, got %q", c, string(got))
		}
		if got := TransformToHost([]byte(c), mappings, nil); got != nil {
			t.Errorf("TransformToHost(%q) should be nil, got %q", c, string(got))
		}
	}
}

func TestTransformLargeBuffer(t *testing.T) {
	mappings := []PathMapping{
		{From: "D:/GitHub/ccbox", To: "/D/GitHub/ccbox", Drive: 'd'},
	}

	// Build a large JSONL buffer with many path entries
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString(`{"path":"D:\\GitHub\\ccbox\\file_`)
		b.WriteString(strings.Repeat("x", i%50))
		b.WriteString(`.go"}`)
		b.WriteByte('\n')
	}
	host := b.String()

	container := TransformToContainer([]byte(host), mappings, nil)
	if container == nil {
		t.Fatal("large buffer ToContainer returned nil")
	}

	// All paths should be transformed
	containerStr := string(container)
	if strings.Contains(containerStr, `D:\`) {
		t.Error("large buffer still contains Windows paths")
	}

	// Count occurrences
	count := strings.Count(containerStr, "/D/GitHub/ccbox/file_")
	if count != 100 {
		t.Errorf("expected 100 transformed paths, got %d", count)
	}

	// Round-trip
	restored := TransformToHost(container, mappings, nil)
	if restored == nil {
		t.Fatal("large buffer ToHost returned nil")
	}
	if string(restored) != host {
		t.Error("large buffer round-trip mismatch (content differs)")
	}
}
