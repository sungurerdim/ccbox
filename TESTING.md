# Testing Guide

## Critical Path Tests

Tests marked with `@critical` and `[critical]` prefix cover security-sensitive code paths that **must never regress**. These tests validate the security boundary of the Docker sandbox.

### Path Traversal Prevention (3 tests)
- `[critical] resolveForDocker rejects path traversal` - Blocks `../../etc/passwd` attacks
- `[critical] PathError for path traversal attempt` - Validates `../` rejection in project paths
- `[critical] resolveForDocker rejects null bytes` - Blocks null byte injection

### Container Security (4 tests)
- `[critical] PIDS limit is in safe range (256-8192)` - Fork bomb protection
- `[critical] getHostUserIds returns valid uid/gid pair` - Correct container user mapping
- `[critical] buildClaudeArgs always includes --dangerously-skip-permissions` - Bypass mode in sandbox
- `[critical] getImageName format is docker-compatible` - Prevents image name injection

### Docker Safety (4 tests)
- `[critical] getProjectImageName produces docker-compatible format` - Safe image naming
- `[critical] getProjectImageName sanitizes special chars` - Input sanitization
- `[critical] getContainerName sanitizes special chars` - Container name safety
- `getContainerName generates unique names` - Prevents container collision

### Environment Variable Validation (3 tests)
- `getDockerRunCmd custom envVars included` - Env vars passed correctly
- `getDockerRunCmd debug mode sets CCBOX_DEBUG` - Debug state propagation
- `getDockerRunCmd unrestricted mode sets CCBOX_UNRESTRICTED` - Mode signaling

## Running Tests

```bash
bun run test              # Unit tests
bun run test:coverage     # Unit tests with coverage report
bun run test:e2e          # End-to-end (requires Docker)
bun run test:all          # All tests
```

## Coverage

Coverage is tracked with c8. Minimum thresholds: 70% branches, lines, functions, statements.

Configuration: `.c8rc.json`

## Test Retry (E2E)

Docker-based E2E tests use retry logic for transient failures (network timeouts, daemon restarts). In CI environments (`CI=true`), timeouts are doubled automatically.
