# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-12-13

### Added

- **Docker-based isolation**: Run Claude Code in secure Docker containers with project directory mounting
- **Multi-stack support**: Pre-configured stacks for different development needs:
  - `base`: Node.js + Python + CCO + lint/test tools
  - `go`: + Go + golangci-lint
  - `rust`: + Rust + clippy
  - `java`: + JDK (Temurin LTS) + Maven
  - `web`: + pnpm (fullstack)
  - `full`: All languages combined
- **Auto-detection**: Automatically detect project type and recommend appropriate stack
- **Docker auto-start**: Attempt to start Docker Desktop if not running (Windows/macOS)
- **Git config auto-detection**: Detect and prompt for git user.name/email configuration
- **Update checking**: Check for updates to ccbox, Claude Code, and CCO with changelog display
- **Smart layer caching**: WEB and FULL stacks layer on base image for efficient rebuilds
- **Build-only mode**: `ccbox --build` to build images without starting container
- **Doctor command**: `ccbox doctor` for system status and project detection
- **Clean command**: `ccbox clean` to remove all ccbox containers and images
- **Stack listing**: `ccbox stacks` to show available language stacks
- **Path traversal protection**: Validate config paths are within home directory
- **Comprehensive CLI**: Rich console output with colors, tables, and panels

### Security

- Container isolation with project-only mounting (no full host access)
- Tmpfs for temp directories (no disk residue)
- Path validation to prevent directory traversal attacks
- Git credentials passed via environment variables (not mounted files)

### Developer Experience

- Zero-config startup: Just run `ccbox` in any project directory
- Interactive stack selection with detection hints
- Clear error messages with actionable suggestions
- Version display: `ccbox --version`

[1.0.0]: https://github.com/sungurerdim/ccbox/releases/tag/v1.0.0
