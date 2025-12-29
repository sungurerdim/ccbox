# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2025-12-29

### Added

- **Docker-based isolation**: Run Claude Code in secure Docker containers with project directory mounting
- **Multi-stack support**: Pre-configured stacks for different development needs:
  - `minimal`: Node.js + Python + tools (no CCO) - baseline for testing
  - `base`: minimal + CCO (default)
  - `go`: Go + golangci-lint + CCO
  - `rust`: Rust + clippy + rustfmt + CCO
  - `java`: JDK (Temurin LTS) + Maven + CCO
  - `web`: base + pnpm (fullstack)
  - `full`: base + Go + Rust + Java
- **Auto-detection**: Automatically detect project type and recommend appropriate stack
- **Docker auto-start**: Attempt to start Docker Desktop if not running (Windows/macOS)
- **Git config auto-detection**: Detect and prompt for git user.name/email configuration
- **Smart layer caching**: WEB and FULL stacks layer on base image for efficient rebuilds
- **Build-only mode**: `ccbox --build` to build images without starting container
- **Doctor command**: `ccbox doctor` for system status and project detection
- **Clean command**: `ccbox clean` to remove all ccbox containers and images
- **Stack listing**: `ccbox stacks` to show available language stacks
- **Path traversal protection**: Validate config paths are within home directory
- **Comprehensive CLI**: Rich console output with colors, tables, and panels
- **Cross-platform support**: Windows, macOS, Linux, and ARM64 architectures
- **Dynamic UID/GID mapping**: Automatic user ID remapping for cross-platform file permissions
- **Unattended mode**: `-y/--yes` flag for fully automated operation without prompts
- **Prompt mode**: Non-interactive usage with `--prompt/-p` flag
  - Enables `--print` mode automatically
  - Enables `--verbose` automatically (unless `--quiet`)
  - Supports `--model/-m` for model selection
  - Supports `--quiet/-q` for minimal output
- **Debug modes**: Entrypoint debugging with `-d` (basic) and `-dd` (verbose + stream)
  - `-d`: Show entrypoint progress logs
  - `-dd`: + Stream all Claude output (tool calls, progress) in real-time
- **Bare mode**: `--bare` flag for vanilla Claude Code without CCO or host settings
- **Debug log persistence**: `--debug-logs` to persist logs (default: ephemeral tmpfs)
- **Directory override**: `--chdir/-C` option to run in different directory (like `git -C`)
- **System prompt customization**: `--append-system-prompt` for custom Claude instructions
- **Input validation**: Prompt length validation (max 5000 chars) and whitespace normalization
- **TTY detection**: Automatic TTY allocation based on terminal capabilities
- **Unbuffered output**: Proper streaming in non-TTY mode with `stdbuf`
- **Dependency installation**: Auto-detect and install project dependencies
  - Supports 25+ package managers across all major languages
  - Python: pip, poetry, pipenv, uv, conda
  - Node.js: npm, pnpm, yarn, bun
  - Go, Rust, Java, Ruby, PHP, .NET, Elixir, Haskell, Swift, Dart, and more
  - Interactive prompt: all deps (dev+prod) / prod only / skip
  - Flags: `--deps`, `--deps-prod`, `--no-deps`
  - Project-specific images with deps pre-installed

### Changed

- **BREAKING**: `-p` short option changed from `--path` to `--prompt`
  - Migration: Use `--path` (long form) for project path
  - Reason: `-p` for prompt is more intuitive for scripting
- **BREAKING**: `--verbose/-v` and `--stream` flags removed
  - `--prompt` now implies `--verbose` automatically (unless `--quiet`)
  - `-dd` now implies stream mode automatically
  - Simplifies CLI by deriving flags from context
- **BREAKING**: Update check functionality removed
  - Use `ccbox update` to manually rebuild images
  - Reduces startup latency and network dependencies
- **BREAKING**: Python 3.8 support dropped (now requires 3.9+)
- CCO files now injected at runtime via tmpfs overlay (not persisted to host)
- Container naming changed to `ccbox-{project}-{uuid}` for uniqueness
- Improved entrypoint with comprehensive error handling and debug logging

### Security

- Container isolation with project-only mounting (no full host access)
- `--cap-drop=ALL` drops all Linux capabilities (minimal attack surface)
- `--security-opt=no-new-privileges` prevents privilege escalation
- `--pids-limit=512` protects against fork bombs
- Tmpfs for temp directories (`/tmp`, `/var/tmp`) - no disk residue
- Tmpfs overlays for CCO directories (rules, commands, agents, skills)
- Path validation to prevent directory traversal attacks
- Git credentials passed via environment variables (not mounted files)
- Debug logs ephemeral by default (tmpfs)
- Host CLAUDE.md overridden with empty file for isolation

### Fixed

- Windows path handling with automatic backslash normalization
- WSL path conversion for Docker mounts
- Bash conditionals compatibility with `set -e`
- Permission errors in bare mode with proper tmpfs setup
- UID/GID mismatch on Linux with dynamic remapping

### Developer Experience

- Zero-config startup: Just run `ccbox` in any project directory
- Interactive stack selection with detection hints
- Clear error messages with actionable suggestions
- Version display: `ccbox --version`
