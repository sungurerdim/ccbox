# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Smart layer caching**: WEB and FULL stacks layer on base image for efficient rebuilds
- **Build-only mode**: `ccbox --build` to build images without starting container
- **Doctor command**: `ccbox doctor` for system status and project detection
- **Clean command**: `ccbox clean` to remove all ccbox containers and images
- **Stack listing**: `ccbox stacks` to show available language stacks
- **Path traversal protection**: Validate config paths are within home directory
- **Comprehensive CLI**: Rich console output with colors, tables, and panels
- **Benchmark CLI options**: New CLI parameters for non-interactive/scripted usage:
  - `--prompt/-p`: Pass initial prompt to Claude
  - `--yes/-y`: Skip confirmation prompts (non-interactive mode)
  - `--model/-m`: Specify model (opus, sonnet, haiku, etc.)
  - `--quiet/-q`: Quiet mode (print only Claude's responses)
- **Input validation**: Prompt length validation (max 5000 chars) and whitespace normalization

### Changed

- **BREAKING**: `-p` short option changed from `--path` to `--prompt`
  - Migration: Use `--path` (long form) instead of `-p` for project path
  - Reason: `-p` for prompt is more intuitive for benchmark/scripting use cases

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
