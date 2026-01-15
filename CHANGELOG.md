# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Package manager: npm

[1.0.0]: https://github.com/sungurerdim/ccbox/releases/tag/v1.0.0
