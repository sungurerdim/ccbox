# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/sungurerdim/ccbox/compare/v0.2.0...v0.3.0) (2026-02-08)


### ⚠ BREAKING CHANGES

* rewrite codebase from TypeScript/Bun to Go ([#6](https://github.com/sungurerdim/ccbox/issues/6))
* Complete rewrite of ccbox from TypeScript/Bun to Go.

### Features

* bridge overhaul, cross-platform, voice & clipboard ([f28e449](https://github.com/sungurerdim/ccbox/commit/f28e4497c9a2895b566fe2dccaadf4141b7075e9))
* bridge voice/paste, container labels, Docker SDK migration ([#11](https://github.com/sungurerdim/ccbox/issues/11)) ([130cb51](https://github.com/sungurerdim/ccbox/commit/130cb5165572436d1307d098f7bea2d685ba5bea))
* **cli:** add uninstall command ([#8](https://github.com/sungurerdim/ccbox/issues/8)) ([2f08dbb](https://github.com/sungurerdim/ccbox/commit/2f08dbbe353cfd1e8c3855c6e856e8cbb37cfa1a))
* rewrite codebase from TypeScript/Bun to Go ([b55b287](https://github.com/sungurerdim/ccbox/commit/b55b28739c7d61287bc5733b2b4a463a9ea749fa))
* rewrite codebase from TypeScript/Bun to Go ([#6](https://github.com/sungurerdim/ccbox/issues/6)) ([719a705](https://github.com/sungurerdim/ccbox/commit/719a7052a04f80e0e343998402e7386e2511b906))


### Bug Fixes

* resolve golangci-lint errors in fuse package ([b478503](https://github.com/sungurerdim/ccbox/commit/b4785030b2a5654926ab586337de18f4b6befbfa))
* resolve golangci-lint errors in fuse package ([#7](https://github.com/sungurerdim/ccbox/issues/7)) ([32c329e](https://github.com/sungurerdim/ccbox/commit/32c329eb03a53e08c9dbfec4db00088051e1e8d7))

## [0.3.0](https://github.com/sungurerdim/ccbox/compare/v0.2.0...v0.3.0) (2026-02-07)


### Features

* bridge overhaul, cross-platform, voice & clipboard ([f28e449](https://github.com/sungurerdim/ccbox/commit/f28e4497c9a2895b566fe2dccaadf4141b7075e9))

## [0.2.0](https://github.com/sungurerdim/ccbox/compare/v0.1.0...v0.2.0) (2026-02-02)


### Features

* **ci:** add categorized changelog to release workflow ([288c835](https://github.com/sungurerdim/ccbox/commit/288c835193a70eb34b7fee3fdbb27ccfba78cb0a))

### Added

- **Git worktree support**: Automatically detects and mounts main `.git` directory when running inside a git worktree, enabling full git operations in container

### Changed

- `removeCcboxImages` uses single `listImages()` call with in-memory prefix filtering (was 5 separate Docker calls)
- Worktree detection failure now logs at `warn` level instead of `debug` for better visibility
- Stack validation in `run-phases.ts` uses `parseStack()` instead of unsafe type cast

### Removed

- **`--timeout` / `--build-timeout` CLI flags**: Removed misleading flags that were accepted but not wired to any Docker operations
- **`src/error-handler.ts`**: Removed unused module (239 lines); exit code diagnostics handled inline in `commands/run.ts`
- **`src/utils/retry-with-backoff.ts`**: Removed unused retry utility (46 lines); `upgrade.ts` has its own implementation
- **`docker/executor.ts` `buildImage` and `runContainer`**: Removed unused functions; only `safeDockerRun` and `checkDockerStatus` are used
- **`config.ts` `validateSafePath` and `getClaudeConfigDir`**: Removed duplicate functions; `docker-runtime.ts` now uses `paths.ts` version
- **`pruneSystem` export from `index.ts`**: Removed unreachable public API export
- ~1,500 lines of dead code from modular architecture refactor (unused service classes, command builders, strategies, type files)

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

[0.1.0]: https://github.com/sungurerdim/ccbox/releases/tag/v0.1.0
