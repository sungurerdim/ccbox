# API Reference

Internal package documentation for ccbox development.

## Packages

### internal/config

Stack definitions and configuration management.

#### Types

```go
type LanguageStack string

const (
    StackBase    LanguageStack = "base"
    StackPython  LanguageStack = "python"
    StackWeb     LanguageStack = "web"
    StackGo      LanguageStack = "go"
    StackRust    LanguageStack = "rust"
    StackJava    LanguageStack = "java"
    // ... 15 more stacks
)

type StackInfo struct {
    Name         string
    Description  string
    Parent       LanguageStack
    BaseImage    string
}
```

#### Functions

```go
// Get Docker image name for stack
GetImageName(stack LanguageStack) string
// Returns: "ccbox_python:latest"

// Generate unique container name
GetContainerName(projectName string) string
// Returns: "ccbox_myproject_a1b2c3"

// Parse and validate stack from string
ParseStack(value string) (LanguageStack, error)
```

### internal/docker

Docker SDK operations (no shell-out).

#### Functions

```go
// Build a Docker image from build context
BuildImage(ctx context.Context, opts BuildOptions) error

// Create and start a container
RunContainer(ctx context.Context, cfg RunConfig) (int, error)

// Check if image exists locally
Exists(ctx context.Context, name string) bool

// List ccbox containers
ListCcbox(ctx context.Context) ([]container.Summary, error)

// Cleanup old images and containers
Cleanup(ctx context.Context) error
```

### internal/detect

Project type detection for automatic stack selection.

#### Types

```go
type DetectionResult struct {
    RecommendedStack  config.LanguageStack
    DetectedLanguages []string
    Details           map[string]string
}
```

#### Functions

```go
// Detect project type from directory contents
DetectProjectType(directory string, verbose bool) DetectionResult
```

**Detection patterns:**
- `pyproject.toml`, `requirements.txt` -> python
- `package.json`, `tsconfig.json` -> web
- `go.mod` -> go
- `Cargo.toml` -> rust
- `pom.xml`, `build.gradle` -> java

### internal/generate

Dockerfile and entrypoint generation.

#### Functions

```go
// Generate Dockerfile content for stack
GenerateDockerfile(stack config.LanguageStack) string

// Generate entrypoint.sh script content
GenerateEntrypoint() string

// Write build files to temp directory, returns build dir path
WriteBuildFiles(stack config.LanguageStack) (string, error)
```

### internal/run

Run orchestration — builds args, manages container lifecycle.

#### Functions

```go
// Build Docker run command arguments
BuildArgs(opts RunOptions) ([]string, error)

// Execute the full run pipeline: detect → build → run
Execute(opts RunOptions) error
```

### internal/log

Leveled logger with lipgloss styling.

#### Functions

```go
// Logger methods
log.Debug(msg string)    // dim, only at DEBUG level
log.Info(msg string)     // normal
log.Warn(msg string)     // yellow
log.Error(msg string)    // red
log.Success(msg string)  // green

// Set minimum log level
SetLevel(level Level)
```

### internal/fuse

FUSE filesystem for transparent path translation (Linux only).

#### Types

```go
type Config struct {
    SourceDir    string
    PathMappings []PathMapping
    DirMappings  []DirMapping
    Extensions   []string
    TraceLevel   int
}

type PathMapping struct {
    From, To     string
    Drive        byte
    IsUNC, IsWSL bool
}
```

#### Functions

```go
// Create and mount FUSE filesystem
NewCcboxFS(mountDir string, root *CcboxRoot, opts ...fuse.MountOption) (*fuse.Server, error)

// Transform file content: host paths → container paths
TransformToContainer(buf []byte, mappings []PathMapping, dirMappings []DirMapping) []byte

// Transform file content: container paths → host paths
TransformToHost(buf []byte, mappings []PathMapping, dirMappings []DirMapping) []byte
```
