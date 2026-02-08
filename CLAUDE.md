# Project Instructions

This is the ccbox project - a secure Docker sandbox for Claude Code.

## Stack

- **Language**: Go 1.23+
- **CLI**: cobra + viper
- **Docker**: Docker SDK (native API, no shell-out)
- **TUI**: bubbletea + lipgloss (bridge mode)
- **Build**: GoReleaser + GitHub Actions
- **Embedded**: `//go:embed` for FUSE + fakepath.so native binaries

## Key Files

- `cmd/ccbox/main.go` - Entry point
- `cmd/ccbox-fuse/main.go` - FUSE filesystem binary (Linux only)
- `internal/cli/root.go` - Cobra root command + global flags
- `internal/cli/run.go` - Default action (detect → build → run)
- `internal/config/` - Configuration, stacks, config file loading
- `internal/docker/` - Docker SDK operations (client, container, image, cleanup)
- `internal/detect/` - Project type detection + dependency detection
- `internal/generate/` - Dockerfile generation + entrypoint + build files
- `internal/run/` - Run orchestration (args builder + phases pipeline)
- `internal/fuse/` - FUSE filesystem (hanwen/go-fuse v2, path transform, caching)
- `internal/bridge/` - Bridge mode TUI (bubbletea)
- `internal/platform/` - Platform detection (Windows, macOS, Linux, WSL)
- `internal/paths/` - Path utilities (Docker mount compatibility)
- `internal/log/` - Leveled logger with lipgloss styling
- `embedded/` - go:embed assets (FUSE binary, fakepath.so, entrypoint.sh)
- `native/` - C source for fakepath.so + build scripts

## Development

```bash
make dev       # Run from source
make build     # Build binary
make test      # Run tests
make lint      # Run go vet + golangci-lint
make fmt       # Format code
make tidy      # go mod tidy
```

## Quality Gates

- `go vet ./...`
- `golangci-lint run`
- `go test ./...`
- `go build ./cmd/ccbox`

## Native Components

- **ccbox-fuse** (Go): FUSE filesystem for JSON/JSONL path translation. Built via `GOOS=linux CGO_ENABLED=0 go build`.
- **fakepath.so** (C): LD_PRELOAD library for glibc syscall path translation. Built via Docker buildx.
- Rebuild both: `bash native/build.sh`

## CI/CD Guidelines

- Use specific action versions in GitHub Actions
- Run lint before tests (faster feedback)
- Only build artifacts after tests pass
- Tag releases with semantic versions (GoReleaser handles this)
- Use concurrency groups to cancel outdated CI runs

## Docker / Container Guidelines

- Use multi-stage builds, pin base image versions
- Drop all capabilities, add only required ones
- Set resource limits (memory, CPU, PIDs)
- Use environment variables for configuration
- Clean up package manager caches in same layer

<!-- cco-blueprint-start -->
## CCO Blueprint Profile

**Project:** ccbox | **Type:** Developer Tool (CLI) | **Stack:** Go 1.24 + cobra + Docker SDK + bubbletea | **Target:** Production

### Config
- **Priorities:** Security, Code Quality, Architecture, Documentation
- **Constraints:** No restrictions
- **Data:** Auth credentials (GitHub tokens, git identity) | **Regulations:** N/A
- **Audience:** Public users | **Deploy:** Container (GoReleaser + GitHub Actions)

### Project Map
```
Entry: cmd/ccbox/main.go → cobra CLI
Modules:
  cmd/ccbox/        → CLI entry point
  cmd/ccbox-fuse/   → FUSE binary entry (Linux)
  internal/cli/     → Command definitions (root, run, clean, stacks, update, uninstall, paste, rebuild, voice)
  internal/config/  → Configuration + stacks + file loading
  internal/docker/  → Docker SDK ops (client, container, image, cleanup)
  internal/detect/  → Project type + dependency detection
  internal/generate/→ Dockerfile + entrypoint generation
  internal/run/     → Run orchestration (args + phases)
  internal/fuse/    → FUSE filesystem (path transform, caching, dirmap)
  internal/bridge/  → Bridge mode TUI (bubbletea)
  internal/platform/→ Platform detection (Win/Mac/Linux/WSL)
  internal/paths/   → Path utilities
  internal/git/     → Git credential resolution
  internal/log/     → Leveled logger + lipgloss
  internal/upgrade/ → Self-update
  internal/voice/   → Voice input
  internal/clipboard/→ Clipboard ops
  embedded/         → go:embed assets (FUSE binary, fakepath.so, entrypoint.sh)
  native/           → C source (fakepath.so) + build scripts
External: Docker SDK, bubbletea, lipgloss, cobra, go-selfupdate, go-fuse v2
Toolchain: gofmt + golangci-lint + go vet | GitHub Actions CI | GoReleaser | Docker
```

### Ideal Metrics
| Metric | Target |
|--------|--------|
| Coupling | <40% |
| Cohesion | >75% |
| Complexity | <10 |
| Coverage | 70%+ |

### Current Scores
| Dimension | Score | Status |
|-----------|-------|--------|
| Security | 62 | WARN |
| Code Quality | 55 | WARN |
| Architecture | 72 | OK |
| Stack Health | 80 | OK |
| DX | 65 | WARN |
| Documentation | 50 | WARN |
| Overall | 63 | WARN |

### Run History
- 2026-02-08: Preview scan | Findings: 41 (0 CRITICAL, 2 HIGH, 23 MEDIUM, 16 LOW) | Overall: 63/100

### Decisions
<!-- cco-blueprint-end -->
