# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Expanded stack system**: 20 language stacks (up from 7)
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
- **Claude Code native binary**: Updated installation to use official native binary
  - No Node.js/Bun dependency in container
  - Binary moved to `/usr/local/bin` for non-root access
- **TypeScript detection**: Added tsconfig.json to language patterns

### Changed

- **Native binary distribution**: Switched from npm to standalone binaries
  - No more Node.js dependency for end users
  - Direct download via `curl | bash` (Unix) or `irm | iex` (Windows)
  - Cross-platform binaries: Linux (x64/arm64), macOS (x64/arm64), Windows (x64)
- **Base image**: Changed from `node:lts-slim` to `debian:bookworm-slim`
- **Build system**: Migrated from TypeScript/tsc to Bun
  - `bun build --compile` for standalone executables
  - Faster development with `bun run dev`
  - TypeScript executed directly without compilation step
- **CI/CD**: GitHub Actions workflow updated for Bun builds
- **Tests**: Test suite updated to use Bun runtime

### Removed

- **`full` stack**: Replaced with use-case specific stacks (ai, mobile, game, fullstack)
- npm package distribution (now native binary only)
- `postinstall` script (path normalization now runs at startup)
- Node.js runtime dependency in base image

## [1.0.0] - 2025-01-15

### Added

- **Docker-based isolation**: Run Claude Code in secure Docker containers
- **Multi-stack support**: 7 pre-configured stacks
  - `minimal`: Node.js + Python + tools (no CCO)
  - `base`: minimal + CCO (default)
  - `go`: Go + golangci-lint + CCO
  - `rust`: Rust + clippy + rustfmt + CCO
  - `java`: JDK (Temurin LTS) + Maven + CCO
  - `web`: base + pnpm (fullstack)
  - `full`: base + Go + Rust + Java
- **Auto-detection**: 55+ package managers, automatic stack recommendation
- **Dependency installation**: Auto-detect and install project dependencies
  - Python: pip, poetry, pipenv, uv, conda
  - Node.js: npm, pnpm, yarn, bun
  - Go, Rust, Java, Ruby, PHP, .NET, Elixir, and more
  - Flags: `--deps`, `--deps-prod`, `--no-deps`
- **Cross-platform support**: Windows, macOS, Linux, WSL2, ARM64
- **Docker auto-start**: Start Docker Desktop if not running (Windows/macOS)
- **Git config auto-detection**: Detect git user.name/email from host
- **Dynamic UID/GID mapping**: Automatic user ID remapping for file permissions
- **Commands**: run, stacks, update, clean, prune
- **Prompt mode**: Non-interactive with `-p/--prompt`
- **Debug modes**: `-d` (basic) and `-dd` (verbose + stream)
- **Bare mode**: `--bare` for vanilla Claude Code without CCO
- **Unattended mode**: `-y/--yes` for automated operation

### Security

- Container isolation with project-only mounting
- `--cap-drop=ALL` drops all Linux capabilities
- `--security-opt=no-new-privileges` prevents privilege escalation
- `--pids-limit=2048` protects against fork bombs
- Tmpfs for temp directories (no disk residue)
- Path validation prevents directory traversal attacks
- Git credentials via environment variables (not mounted files)
- Non-root container user

### Performance

- File descriptor limits: `--ulimit nofile=65535:65535`
- Init process: `--init` for signal handling
- Shared memory: `--shm-size=256m` for Node.js/Chrome
- DNS optimization: `--dns-opt ndots:1`
- Node.js compile cache for faster startups
- Git optimizations (preloadindex, fscache, commitgraph)

### Notes

- TypeScript rewrite (previously Python)
- CLI framework: Commander.js
- Runtime: Bun (native binary)

[Unreleased]: https://github.com/sungurerdim/ccbox/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sungurerdim/ccbox/releases/tag/v1.0.0
