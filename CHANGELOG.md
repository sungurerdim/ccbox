# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-01-26

Initial public release of ccbox - secure Docker sandbox for Claude Code.

### Added

- **Docker-based isolation**: Run Claude Code in secure Docker containers
- **20 language stacks**: Comprehensive stack support
  - Core stacks (11): base, python, web, go, rust, java, cpp, dotnet, swift, dart, lua
  - Combined stacks (4): jvm, functional, scripting, systems
  - Use-case stacks (5): data, ai, mobile, game, fullstack
- **Efficient image layering**: Stacks build on parent images for disk efficiency
  - `base` → python, web, cpp, dotnet, swift, dart, lua, functional, scripting
  - `python` → data, ai
  - `web` → fullstack
  - `cpp` → systems, game
  - `dart` → mobile
  - `java` → jvm
- **FUSE path mapping**: Cross-platform path translation via FUSE filesystem
  - Pre-compiled binaries (no gcc dependency)
  - Supports project .claude directory
  - Prevents host filesystem modification
- **Auto-detection**: 55+ package managers, automatic stack recommendation
- **Dependency installation**: Auto-detect and install project dependencies
  - Python: pip, poetry, pipenv, uv, pdm, conda
  - Node.js: npm, pnpm, yarn, bun, deno
  - Go, Rust, Java, Ruby, PHP, .NET, Elixir, Gleam, and more
  - Flags: `--deps`, `--deps-prod`, `--no-deps`
- **Cross-platform support**: Windows, macOS, Linux, WSL2, ARM64
- **Docker auto-start**: Start Docker Desktop if not running (Windows/macOS)
- **Git config auto-detection**: Detect git user.name/email from host
- **Dynamic UID/GID mapping**: Automatic user ID remapping for file permissions
- **Commands**: run (default), stacks, update, clean, prune
- **Prompt mode**: Non-interactive with `-p/--prompt`
- **Debug modes**: `-d` (basic) and `-dd` (verbose + stream)
- **Fresh mode**: `--fresh` for clean slate (auth only)
- **Unattended mode**: `-y/--yes` for automated operation
- **Progress control**: `--progress` flag for Docker build output
- **Unrestricted mode**: `-U/--unrestricted` for full system resources
- **Unified logging**: Logger abstraction with levels (debug, info, warn, error)
- **Error handling**: Unified error handler with exit code diagnostics and retry logic

### Security

- Container isolation with project-only mounting
- `--cap-drop=ALL` drops all Linux capabilities
- `--security-opt=no-new-privileges` prevents privilege escalation
- `--pids-limit=2048` protects against fork bombs
- Tmpfs for temp directories (no disk residue)
- Path validation prevents directory traversal attacks
- Git credentials via environment variables (not mounted files)
- Non-root container user (ccbox)
- Read-only FUSE mount for path translation

### Performance

- File descriptor limits: `--ulimit nofile=65535:65535`
- Init process: `--init` for signal handling
- Shared memory: `--shm-size=256m` for Node.js/Chrome
- DNS optimization: `--dns-opt ndots:1`
- Node.js compile cache for faster startups
- Git optimizations (preloadindex, fscache, commitgraph)
- Pre-compiled FUSE binaries (amd64/arm64)

### Technical

- TypeScript codebase with strict mode
- CLI framework: Commander.js
- Runtime: Bun (native binary)
- Test suite: 167 tests covering all modules
- Modular architecture: dockerfile-gen, docker-runtime, error-handler, logger

[Unreleased]: https://github.com/sungurerdim/ccbox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sungurerdim/ccbox/releases/tag/v0.1.0
