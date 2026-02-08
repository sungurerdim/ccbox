# Testing Guide

## Running Tests

```bash
make test      # Unit tests with race detector
make lint      # go vet + golangci-lint
```

## Critical Path Tests

Tests covering security-sensitive code paths that **must never regress**:

### Path Traversal Prevention
- Blocks `../../etc/passwd` attacks in project path validation
- Validates `../` rejection in project paths
- Blocks null byte injection

### Container Security
- Fork bomb protection (PID limits in safe range)
- Correct container user mapping (UID/GID)
- Bypass mode enabled in sandbox (`--dangerously-skip-permissions`)
- Docker-compatible image name format

### Docker Safety
- Safe image naming (sanitized special chars)
- Safe container naming
- Unique container names (prevent collision)

### Environment Variable Validation
- Custom env vars passed correctly
- Debug mode propagation
- Unrestricted mode signaling

## Test Structure

Tests are colocated with source code using Go's standard `_test.go` convention:

```
internal/
├── config/config_test.go
├── detect/detect_test.go
├── docker/docker_test.go
├── paths/paths_test.go
└── ...
```

## Quality Gates

All of these must pass before merge:

```bash
go vet ./...           # Static analysis
golangci-lint run      # Lint rules
go test -race ./...    # Tests with race detector
go build ./cmd/ccbox   # Build verification
```
