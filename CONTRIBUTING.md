# Contributing to ccbox

## Prerequisites

- [Go](https://go.dev/) 1.23+
- [Docker](https://www.docker.com/) Desktop or Engine
- Git

## Setup

```bash
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox
go mod tidy
```

## Development

```bash
make dev       # Run from source
make build     # Build binary
make lint      # go vet + golangci-lint
make fmt       # Format code
make tidy      # go mod tidy
```

## Testing

```bash
make test      # Unit tests (with race detector)
```

## Building

```bash
make build                    # Build for current platform
# Cross-compile:
GOOS=linux GOARCH=amd64 go build -o ccbox-linux ./cmd/ccbox
```

### Native Components

FUSE and fakepath binaries are pre-compiled and embedded via `//go:embed`. To rebuild them:

```bash
bash native/build.sh          # Requires Docker (for fakepath.so cross-compile)
```

This produces:
- `embedded/ccbox-fuse-linux-{amd64,arm64}` — Go FUSE binary (native cross-compile)
- `embedded/fakepath-linux-{amd64,arm64}.so` — C LD_PRELOAD library (Docker cross-compile)

## Project Structure

```
cmd/
├── ccbox/               # Main CLI entry point
└── ccbox-fuse/          # FUSE filesystem binary (Linux only)

internal/
├── cli/                 # Cobra commands + global flags
├── config/              # Stack definitions, configuration
├── detect/              # Project type detection
├── docker/              # Docker SDK operations (client, container, image)
├── fuse/                # FUSE filesystem (path transform, caching)
├── generate/            # Dockerfile + entrypoint generation
├── run/                 # Run orchestration (args builder, phases)
├── bridge/              # Bridge mode TUI (bubbletea)
├── platform/            # Platform detection (Windows, macOS, Linux, WSL)
├── paths/               # Path utilities
└── log/                 # Leveled logger with lipgloss

embedded/                # go:embed assets (FUSE, fakepath.so, entrypoint)
native/                  # C source for fakepath + build scripts
```

## Architecture: Package Hierarchy

```
CLI Layer (cmd/ + internal/cli/)
    |
    v
Orchestration (internal/run/)
    |
    v
Core Services (internal/config, detect, docker, generate, fuse)
    |
    v
Utilities (internal/platform, paths, log)
```

### Import Rules

| From Layer | Can Import From |
|------------|-----------------|
| CLI | Orchestration, Core Services, Utilities |
| Orchestration | Core Services, Utilities |
| Core Services | Utilities, Peer Services |
| Utilities | Other Utilities only |

## Code Style

- `go vet` + `golangci-lint` must pass
- Prefer simple, readable code
- Named returns only when they improve clarity
- Error wrapping with `fmt.Errorf("context: %w", err)`

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with clear commit messages
4. Run all checks: `make lint && make test`
5. Push and open a PR against `main`

### PR Guidelines

- Keep changes focused and atomic
- Update documentation if behavior changes
- Add tests for new functionality
- Ensure CI passes before requesting review

## Adding a New Stack

1. Add stack constant to `internal/config/stacks.go`
2. Add stack info to `StackInfo` map
3. Add dependency detection in `internal/detect/`
4. Add Dockerfile generation in `internal/generate/dockerfile.go`
5. Test with a sample project

## Security

For security vulnerabilities, please see [SECURITY.md](SECURITY.md). Do not open public issues for security-related bugs.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
