# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Add entries here as changes are merged. Categories: Added, Changed, Fixed, Removed, Security. -->

## [0.1.0] - 2026-01-28

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
- **Self-update**: Single binary with built-in update, uninstall, and version check
  - `ccbox update`: Self-update binary from GitHub releases
  - `ccbox uninstall`: Complete removal
  - `ccbox version --check`: Check for available updates
- **Commands**: run (default), rebuild, clean, stacks, update, uninstall, version
- **Prompt mode**: Non-interactive with `-p/--prompt`
- **Debug modes**: `-d` (basic) and `-dd` (verbose + stream)
- **Fresh mode**: `--fresh` for clean slate (auth only)
- **Unattended mode**: `-y/--yes` for automated operation
- **Progress control**: `--progress` flag for Docker build output
- **Unrestricted mode**: `-U/--unrestricted` for full system resources
- **Build cache**: `--cache` flag to use Docker build cache for faster rebuilds
- **Unified logging**: Logger abstraction with levels (debug, info, warn, error)
- **Error handling**: Unified error handler with exit code diagnostics and retry logic

### Fixed

- **FUSE buffer overflow**: `transform_to_container_alloc` and `transform_to_host_alloc` allocation
  now based on actual mapping expansion ratio instead of fixed multipliers
- **FUSE data integrity**: `ccbox_write` merge path checks `pread` return value; zeroes
  uninitialized bytes on short reads
- **FUSE race condition**: Offset writes protected with `flock(LOCK_EX/LOCK_UN)` to prevent
  concurrent read-modify-write corruption
- **FUSE path truncation**: `get_source_path` returns `-ENAMETOOLONG` on `snprintf` overflow
  instead of silently truncating (all ~15 call sites updated)
- **FUSE utimensat**: Replaced `utimensat(0, ...)` (stdin fd) with `utimensat(AT_FDCWD, ...)`
- **FUSE .jsonl support**: `needs_transform` now matches `.jsonl` files (session logs)
- **FUSE mount timeout**: Replaced fixed `sleep 0.5` with poll loop (100ms intervals, 5s timeout)
- **FUSE comma in paths**: `pathmap`/`dirmap` passed via `CCBOX_PATH_MAP`/`CCBOX_DIR_MAP`
  environment variables instead of FUSE `-o` options to avoid comma parsing issues
- **Env var injection**: User-provided `--env` values validated (POSIX key names, newline/null removal)
- **Symlink traversal**: `validateProjectPath` rejects symlinks via `lstatSync`
- **N+1 image queries**: `removeCcboxImages` calls `listImages()` once instead of per-image
- **Build failure cleanup**: `buildProjectImage` removes partial images on failure
- **Type safety**: `docker.ts` error handling uses `instanceof Error` guard instead of bare cast
- **Bounds check**: `getDockerDiskUsage` uses safe optional chaining instead of `!` assertions
- **Dead code**: Removed unused `generateCcboxFuseC()` (~450 lines of embedded C copy)
- **Unused parameter**: Removed `depsList` from `getDockerRunCmd` options type

### Security

- Container isolation with project-only mounting
- `--cap-drop=ALL` drops all Linux capabilities
- `--cap-add=SYS_ADMIN` for FUSE (replaces `--privileged` on all platforms including Windows)
- `--security-opt=no-new-privileges` prevents privilege escalation
- `--pids-limit=2048` protects against fork bombs
- Tmpfs for temp directories (no disk residue)
- Path validation prevents directory traversal and symlink attacks
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
- Directory listing cached for glob-based language detection (single `readdirSync`)
- Path normalization uses single regex instead of iterative replacement
- Rebuild `--all` uses single Docker call instead of per-stack `execSync`
- Tmpfs sizes extracted to named constants (`CONTAINER_CONSTRAINTS.tmpfs`)

### Technical

- TypeScript codebase with strict mode
- CLI framework: Commander.js
- Runtime: Bun (native binary)
- Test suite: 194 tests covering all modules
- Modular architecture: dockerfile-gen, docker-runtime, error-handler, logger

[Unreleased]: https://github.com/sungurerdim/ccbox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sungurerdim/ccbox/releases/tag/v0.1.0
