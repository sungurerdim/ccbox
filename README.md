# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## TL;DR

```bash
pip install ccbox                # Install
cd your-project && ccbox         # Run (interactive)
ccbox -y                         # Run (unattended, auto-confirm all)
ccbox --bare                     # Run vanilla Claude Code (no CCO)
ccbox -p "fix the tests"         # Run with prompt (non-interactive)
```

## Why ccbox?

- **Isolated**: Container only accesses current project directory - nothing else
- **Fast**: Bypass mode enabled by default (safe because container is sandboxed)
- **Simple**: Single command to start, auto-detects everything
- **Auto-start**: Docker Desktop starts automatically if not running (Windows/Mac)
- **Git Auto-detect**: Git credentials auto-detected from host system
- **Persistent**: Claude settings stay on host (`~/.claude`), survive container restarts
- **Clean**: No config files in your project directories
- **Cross-platform**: Windows, macOS, Linux, and ARM64 support with automatic path handling

## Claude Code CLI vs ccbox

| Aspect                 | Claude Code CLI                            | ccbox                                             |
|------------------------|--------------------------------------------|----------------------------------------------------|
| **Installation**       | `npm install -g @anthropic-ai/claude-code` | `pip install ccbox`                                |
| **File Access**        | Full system access                         | Only current project directory                     |
| **Permission Prompts** | Every tool use requires approval           | Bypass mode (container is sandbox)                 |
| **System Impact**      | Can modify any file, run any command       | Isolated - nothing persists outside mounts         |
| **Security Model**     | Trust Claude + user approval               | Trust container isolation                          |
| **Other Projects**     | Accessible if Claude navigates to them     | Completely inaccessible                            |
| **Home Directory**     | Full access                                | Only `~/.claude` (settings)                        |
| **Startup Time**       | Instant                                    | First run: ~2 min (image build), then instant      |
| **Dependencies**       | User installs manually                     | Pre-installed dev tools (ruff, mypy, eslint, etc.) |
| **Updates**            | `npm update`                               | `ccbox update` (rebuilds image)                    |
| **Cleanup**            | Manual uninstall                           | `ccbox clean` (removes all containers/images)      |

### What ccbox Adds

| Feature                  | Description                                                                      |
|--------------------------|----------------------------------------------------------------------------------|
| **Container Isolation**  | Claude runs in Docker with restricted capabilities                               |
| **Automatic Dev Tools**  | Python (ruff, mypy, pytest), Node.js (typescript, eslint, vitest) pre-installed  |
| **CCO Integration**      | Claude Code Optimizer enhances AI responses (disable with `--bare`)              |
| **Performance Tuning**   | Node.js heap, DNS, Git optimizations pre-configured                              |
| **Multi-project Safety** | Run in multiple projects simultaneously without cross-contamination              |
| **UID/GID Mapping**      | Files created have correct ownership (no permission issues)                      |

### When to Use Each

| Scenario                            | Recommendation               |
|-------------------------------------|------------------------------|
| Quick trusted project edits         | Claude Code CLI              |
| Untrusted/experimental code         | **ccbox**                    |
| Running AI on client projects       | **ccbox**                    |
| Multi-project simultaneous work     | **ccbox**                    |
| Maximum isolation required          | **ccbox**                    |
| Minimal setup, full system access OK | Claude Code CLI              |
| CI/CD pipelines                     | Either (ccbox for isolation) |

### Security Comparison

```
Claude Code CLI:
┌─────────────────────────────────────────────────────────────────┐
│ Claude has access to:                                           │
│   ✓ All files on your system                                    │
│   ✓ All environment variables                                   │
│   ✓ All running processes                                       │
│   ✓ Network (full)                                              │
│   ✓ Other projects                                              │
│                                                                 │
│ Protection: Permission prompts (user must approve each action) │
└─────────────────────────────────────────────────────────────────┘

ccbox:
┌─────────────────────────────────────────────────────────────────┐
│ Claude has access to:                                           │
│   ✓ Current project directory only                              │
│   ✓ Claude settings (~/.claude)                                 │
│   ✓ Network (API calls)                                         │
│   ✗ Other projects - BLOCKED                                    │
│   ✗ Home directory - BLOCKED                                    │
│   ✗ System files - BLOCKED                                      │
│                                                                 │
│ Protection: Container isolation (OS-level enforcement)          │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
pip install ccbox
```

```bash
cd your-project
ccbox
```

That's it. First run builds the image (~2 min), then Claude Code starts.

## How It Works

```
Host                              Container
────────────────────────────────────────────────────
~/.claude/                   →    /home/node/.claude/     (Claude settings)
~/projects/my-app/           →    /home/node/my-app/      (Project - ONLY this)
~/projects/other-project/    →    (not accessible)
~/Documents/                 →    (not accessible)
```

ccbox mounts only your current directory. Claude Code can freely modify project files but cannot touch anything else on your system.

## Commands

```bash
# Basic usage
ccbox                    # Run Claude Code (interactive prompts)
ccbox -y                 # Unattended mode: auto-confirm all prompts
ccbox -s base            # Use specific stack
ccbox -b                 # Build image only (no start)
ccbox -C /path/to/dir    # Run in different directory (like git -C)

# Prompt mode (non-interactive)
ccbox -p "fix the bug"   # Send prompt, show verbose output, exit
ccbox -p "explain" -q    # Quiet mode: show only Claude's response
ccbox -p "test" -m haiku # Use specific model

# Debug mode
ccbox -d                 # Show entrypoint debug logs
ccbox -dd                # + Stream all Claude output (tool calls, progress)
ccbox --debug-logs       # Persist debug logs (default: ephemeral tmpfs)

# Dependencies (auto-detected, prompts if found)
ccbox --deps             # Install all dependencies (including dev)
ccbox --deps-prod        # Install production dependencies only
ccbox --no-deps          # Skip dependency installation

# Isolation modes
ccbox --bare             # Vanilla Claude Code: no CCO, no host settings

# Management
ccbox update             # Rebuild base image with latest Claude Code
ccbox update -s go       # Rebuild specific stack
ccbox update -a          # Rebuild all installed images
ccbox clean              # Remove all ccbox containers and images
ccbox prune              # Deep clean: reset ccbox to fresh state
ccbox prune --system     # Full Docker cleanup (all unused resources)
ccbox doctor             # Check system status and project detection
ccbox stacks             # List available stacks
```

## CLI Options

| Option                   | Short | Description                                       |
|--------------------------|-------|---------------------------------------------------|
| `--yes`                  | `-y`  | Unattended mode: auto-confirm all prompts         |
| `--stack`                | `-s`  | Select language stack (auto=detect from project)  |
| `--build`                | `-b`  | Build image only (no start)                       |
| `--path`                 |       | Project path (default: current dir)               |
| `--chdir`                | `-C`  | Change to directory before running                |
| `--bare`                 |       | Vanilla mode: auth only, no CCO/settings          |
| `--deps`                 |       | Install all dependencies (including dev)          |
| `--deps-prod`            |       | Install production dependencies only              |
| `--no-deps`              |       | Skip dependency installation                      |
| `--debug`                | `-d`  | Debug mode (`-d` logs, `-dd` + stream)            |
| `--debug-logs`           |       | Persist debug logs (default: ephemeral)           |
| `--prompt`               | `-p`  | Initial prompt (enables `--print` + `--verbose`)  |
| `--model`                | `-m`  | Model name (opus, sonnet, haiku, etc.)            |
| `--quiet`                | `-q`  | Quiet mode (only Claude's response)               |
| `--append-system-prompt` |       | Custom instructions for Claude                    |
| `--no-prune`             |       | Skip automatic cleanup of stale resources         |

## Dependencies

ccbox auto-detects project dependencies and can install them in the container:

### Default Behavior

| Mode                      | Deps Prompt      | Stack Prompt        |
|---------------------------|------------------|---------------------|
| Interactive (`ccbox`)     | Yes, asks        | Yes, shows menu     |
| Unattended (`ccbox -y`)   | Auto: install all | Auto: detected stack |
| Explicit flag (`--deps`)  | Uses specified   | Still prompts       |

### Flags

```bash
ccbox                    # Prompts: "Install dependencies? [1-All, 2-Prod, 3-Skip]"
ccbox -y                 # Auto: installs all deps (including dev)
ccbox -y --no-deps       # Auto: skips deps
ccbox -y --deps-prod     # Auto: installs production only
ccbox --deps             # Installs all, still prompts for stack
```

### Supported Package Managers

| Language          | Package Managers                               |
|-------------------|------------------------------------------------|
| Python            | pip, poetry, pipenv, uv, conda                 |
| Node.js           | npm, pnpm, yarn, bun                           |
| Go                | go mod                                         |
| Rust              | cargo                                          |
| Java/Kotlin/Scala | maven, gradle, sbt                             |
| Ruby              | bundler                                        |
| PHP               | composer                                       |
| .NET              | dotnet, nuget                                  |
| Elixir            | mix                                            |
| Haskell           | stack, cabal                                   |
| Swift             | swift pm                                       |
| Dart/Flutter      | pub                                            |
| And more...       | R, Julia, Clojure, Zig, Nim, OCaml, Perl, C/C++ |

### How It Works

1. Dependencies detected from lockfiles/manifests
2. Project-specific Docker image built with deps
3. Container starts with all deps pre-installed

## Stacks

ccbox auto-detects your project type and shows an interactive menu:

| Stack     | Contents                          | Size     |
|-----------|-----------------------------------|----------|
| `minimal` | Node.js + Python + tools (no CCO) | ~400MB   |
| `base`    | minimal + CCO (default)           | ~450MB   |
| `go`      | Go + Node.js + Python + CCO       | ~750MB   |
| `rust`    | Rust + Node.js + Python + CCO     | ~900MB   |
| `java`    | JDK (Temurin LTS) + Maven + CCO   | ~1000MB  |
| `web`     | base + pnpm (fullstack)           | ~500MB   |
| `full`    | base + Go + Rust + Java           | ~1350MB  |

Detection rules:
- `pyproject.toml` or `requirements.txt` → `base` (includes Python)
- `go.mod` → `go`
- `Cargo.toml` → `rust`
- `pom.xml` or `build.gradle` → `java`
- `package.json` + `pyproject.toml` → `web`
- Only `package.json` or nothing → `base`

## Mount Strategy

ccbox has two modes with different behaviors:

### Normal Mode (default)

Full access to host settings with CCO enhancements:

| What                | Host Path          | Container Path               | Access     | Persistent?  |
|---------------------|--------------------|------------------------------|------------|--------------|
| **Project**         | `./` (current dir) | `/home/node/{project}/`      | Read/Write | Yes          |
| **Claude Settings** | `~/.claude/`       | `/home/node/.claude/`        | Read/Write | Yes          |
| **Temp Files**      | (memory)           | `/tmp`, `/var/tmp`           | tmpfs      | No           |
| **Debug Logs**      | (memory)           | `/home/node/.claude/debug/`  | tmpfs      | No (default) |

**How it works:**
1. Host `~/.claude/` mounted directly (read/write)
2. CCO files from image (`/opt/cco/`) copied to `~/.claude/` (merges with your files)
3. All changes persist on host

### Bare Mode (`--bare`)

Vanilla Claude Code without any customizations:

| What               | Host Path          | Container Path          | Access     | Persistent? |
|--------------------|--------------------|-------------------------|------------|-------------|
| **Project**        | `./` (current dir) | `/home/node/{project}/` | Read/Write | Yes         |
| **Credentials**    | `~/.claude/`       | `/home/node/.claude/`   | Read/Write | Yes         |
| **Rules/Commands** | (hidden)           | tmpfs overlay           | tmpfs      | No          |
| **CLAUDE.md**      | (hidden)           | `/dev/null`             | -          | No          |

**How it works:**
1. Host `~/.claude/` mounted (read/write for credentials)
2. tmpfs overlays hide: `rules/`, `commands/`, `agents/`, `skills/`
3. `/dev/null` mount hides `CLAUDE.md`
4. No CCO injection - stock Claude Code behavior

**Use bare mode when:**
- Testing vanilla Claude Code behavior
- Debugging issues caused by custom rules
- Running without any customizations

## Data Persistence

### What's Saved (Persistent)

| Data                   | Location                      | Description              |
|------------------------|-------------------------------|--------------------------|
| **Claude Credentials** | `~/.claude/.credentials.json` | Authentication tokens    |
| **Claude Settings**    | `~/.claude/settings.json`     | User preferences         |
| **Claude Memory**      | `~/.claude/memory/`           | Conversation context     |
| **Project Files**      | Your project directory        | All code changes         |
| **Project .claude**    | `./project/.claude/`          | Project-specific settings |

### What's Ephemeral (Lost on Exit)

| Data                | Location                      | Why                                               |
|---------------------|-------------------------------|---------------------------------------------------|
| **Temp Files**      | `/tmp`, `/var/tmp`            | tmpfs - memory only                               |
| **Debug Logs**      | `/home/node/.claude/debug/`   | tmpfs by default (use `--debug-logs` to persist)  |
| **Container State** | Container itself              | `--rm` flag removes on exit                       |

> **Note:** Use `ccbox update` to refresh ccbox to latest version.

## Security

### Threat Model

**What ccbox protects:**
- Host filesystem outside project directory
- Other projects on your machine
- System files and configurations

**What ccbox does NOT protect:**
- Secrets inside your project directory (e.g., `.env` files)
- Content of prompts sent to Claude API (goes to Anthropic)
- `~/.claude` contents (credentials, settings, memory)

**Design assumption:** The project directory you mount is trusted. Claude can read/write anything in it.

### Container Isolation

| Protection                 | How It Works                                                    |
|----------------------------|-----------------------------------------------------------------|
| **Project isolation**      | Only current directory mounted, nothing else accessible         |
| **Capability drop**        | `--cap-drop=ALL` removes all Linux capabilities                 |
| **No privilege escalation** | `--security-opt=no-new-privileges` prevents gaining root        |
| **Memory-only temp**       | `/tmp` and `/var/tmp` use tmpfs (no disk writes)                |
| **Ephemeral logs**         | Debug logs use tmpfs by default (no disk residue)               |
| **Path validation**        | Config paths validated to prevent directory traversal           |

### Resource Limits

ccbox applies carefully tuned resource limits to balance security, performance, and host responsiveness.

#### Process & File Limits

| Limit             | Value         | Purpose                                                                                                  |
|-------------------|---------------|----------------------------------------------------------------------------------------------------------|
| `--pids-limit`    | 2048          | Fork bomb protection. Allows heavy parallel agent use (CCO commands spawn 300-400 processes at peak)    |
| `--ulimit nofile` | 65535:65535   | File descriptor limit for parallel subprocess spawning. Node.js needs headroom for concurrent operations |
| `--init`          | enabled       | Runs [tini](https://github.com/krallin/tini) as PID 1 for proper signal handling and zombie process reaping |
| `--shm-size`      | 256MB         | Shared memory for Node.js/Chrome. Default 64MB causes issues with large operations                       |

#### Memory Management

| Setting                | Value          | Purpose                                                                  |
|------------------------|----------------|--------------------------------------------------------------------------|
| `--memory`             | **No limit**   | Allows large project builds (webpack, tsc, next build can use 4-8GB)     |
| `--memory-swappiness`  | 0              | Minimizes swap usage for better performance (kernel hint, not guarantee) |
| Node.js heap           | 75% of RAM     | Dynamic `--max-old-space-size` calculated at runtime                     |
| Young generation       | 64MB           | `--max-semi-space-size=64` reduces GC pauses                             |

**Why no memory limit?**
- Large TypeScript/webpack builds can exceed 4GB
- Security is via capability drops, not resource limits
- Users can restart container if memory issues occur
- Matches Docker Desktop and VS Code Dev Container defaults

#### CPU Management

| Setting        | Value            | Purpose                                                                              |
|----------------|------------------|--------------------------------------------------------------------------------------|
| `--cpu-shares` | 512              | Soft limit (default: 1024). Lower priority during CPU contention, full speed when idle |
| `nice`         | +10              | Lower CPU scheduling priority (entrypoint)                                           |
| `ionice`       | class 2, level 7 | Lower I/O priority for disk operations (entrypoint)                                  |

**Soft vs Hard limits:**
- CPU limits are **soft** - only activate when competing for resources
- When host is idle, container gets full CPU performance
- When host is busy, container yields to keep system responsive

#### Unrestricted Mode (`-U`)

Removes performance limits for benchmarking or CPU-intensive builds:

```bash
ccbox -U  # or --unrestricted
```

| Setting        | Normal           | Unrestricted |
|----------------|------------------|--------------|
| `--cpu-shares` | 512              | Removed      |
| `nice`         | +10              | Removed      |
| `ionice`       | class 2, level 7 | Removed      |

**Security limits remain active** in unrestricted mode (pids-limit, capabilities, etc.)

### Network Access

Claude Code requires internet access to communicate with the Anthropic API. ccbox does **not** restrict network access (`--network=none` would break Claude).

**What this means:**
- Claude can make API calls to Anthropic
- Claude can fetch from URLs if instructed
- Network isolation is NOT a security boundary in ccbox

**The security model relies on:**
- Filesystem isolation (only project dir accessible)
- Capability restrictions (no system-level access)
- Process limits (no resource exhaustion)

### Permission Model

ccbox runs Claude Code with `--dangerously-skip-permissions` because the container itself provides isolation:

```
What Claude CAN do inside container:
✓ Read/write project files (your mounted directory)
✓ Read/write Claude settings (~/.claude)
✓ Run any command (npm, git, etc.)
✓ Install packages (npm install, pip install)
✓ Create/delete files in project
✓ Make network requests (API calls, fetches)

What Claude CANNOT do:
✗ Access files outside mounted directories
✗ Access other projects on your machine
✗ Access your home directory (except ~/.claude)
✗ Persist changes outside mounts (lost on exit)
✗ Escalate privileges (no-new-privileges)
✗ Spawn unlimited processes (pids-limit=2048)
✗ Use Linux capabilities (cap-drop=ALL)
```

### UID/GID Remapping

ccbox automatically detects your host user's UID/GID and remaps the container user to match. This ensures:
- Files created by Claude have correct ownership
- No permission issues when editing files
- Works seamlessly across Linux, macOS, and WSL

### CCO Injection

CCO (Claude Code Optimizer) is installed inside the container image, not on your host:

**Normal mode:**
1. Host `~/.claude/` mounted directly (read/write)
2. CCO files from `/opt/cco/` copied to `~/.claude/` (merges with your files)
3. CCO's `CLAUDE.md` copied to project's `.claude/`
4. CCO files persist on host between runs

**Bare mode:**
1. Host `~/.claude/` mounted (read/write for credentials)
2. tmpfs overlays hide customization dirs
3. No CCO injection
4. Result: Vanilla Claude Code

**Updating CCO:** Run `ccbox update` to rebuild images with latest CCO version.

### Image Optimizations

ccbox images include performance optimizations at the OS and runtime level.

#### Environment Variables (Build-time)

| Variable                   | Value      | Purpose                                          |
|----------------------------|------------|--------------------------------------------------|
| `NODE_ENV`                 | production | Disables dev warnings, enables optimizations     |
| `NPM_CONFIG_FUND`          | false      | Disables npm funding messages                    |
| `NPM_CONFIG_UPDATE_NOTIFIER` | false      | Disables npm update notifications                |
| `GIT_ADVICE`               | 0          | Disables git advice messages for cleaner output  |
| `GIT_INDEX_THREADS`        | 0          | Auto-detect optimal thread count for git index   |

#### Runtime Optimizations (Entrypoint)

| Setting              | Value                              | Purpose                                                   |
|----------------------|------------------------------------|-----------------------------------------------------------|
| `NODE_OPTIONS`       | `--max-old-space-size=<75% RAM>`   | Dynamic heap limit prevents OOM before container limit    |
| `NODE_OPTIONS`       | `--max-semi-space-size=64`         | Larger young generation reduces GC pause frequency        |
| `UV_THREADPOOL_SIZE` | `$(nproc)`                         | Matches libuv thread pool to available CPU cores          |
| `NODE_COMPILE_CACHE` | `/home/node/.cache/node-compile`   | **40% faster** subsequent Node.js startups (v22+)         |

#### DNS Optimization (Docker)

| Setting               | Purpose                                                        |
|-----------------------|----------------------------------------------------------------|
| `--dns-opt ndots:1`   | Reduces DNS lookup attempts (default ndots:5 causes 5+ queries) |
| `--dns-opt timeout:1` | Faster DNS timeout                                             |
| `--dns-opt attempts:1` | Single attempt per query                                       |

**Impact:** DNS resolution reduced from 40-800ms to 1-40ms per lookup.

#### Git Performance (Entrypoint)

| Setting                     | Purpose                                        |
|-----------------------------|------------------------------------------------|
| `core.preloadindex=true`    | Parallel index loading for faster status/diff  |
| `core.fscache=true`         | File system cache for repeated operations      |
| `core.untrackedcache=true`  | Cache untracked file list (faster staging)     |
| `core.commitgraph=true`     | Use commit-graph for faster log/blame          |
| `fetch.writeCommitGraph=true` | Auto-update commit-graph on fetch              |
| `gc.auto=0`                 | Disable auto-gc (prevents random pauses)       |
| `credential.helper=cache`   | Cache credentials for 24 hours                 |

**Impact:** `git status` up to 75% faster, `git log` traversal significantly improved.

#### Terminal Optimization

| Feature                         | Purpose                                           |
|---------------------------------|---------------------------------------------------|
| Synchronized output (mode 2026) | Reduces flickering by batching terminal updates   |
| `stdbuf -oL -eL`                | Unbuffered output for non-TTY mode (pipes)        |
| `FORCE_COLOR=1`                 | Ensures ANSI colors in all modes                  |

### Host Recommendations

For optimal performance with large codebases, configure your **host system**:

```bash
# Increase inotify watch limit (required for npm/webpack/VSCode)
echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Verify
cat /proc/sys/fs/inotify/max_user_watches  # Should show 524288
```

**Why:** Default 8192 watches causes "ENOSPC: no space left on device" errors with large node_modules.

## Multiple Projects

Run Claude Code in multiple projects simultaneously:

```bash
# Terminal 1
cd ~/projects/frontend && ccbox

# Terminal 2
cd ~/projects/backend && ccbox

# Each has its own isolated container
```

## Configuration

Git credentials are auto-detected from your system (`git config --global user.name/email`).

## Image Naming

Images are tagged consistently: `ccbox:{stack}`

```
ccbox:minimal
ccbox:base
ccbox:go
ccbox:rust
ccbox:java
ccbox:web
ccbox:full
```

Containers: `ccbox-{project-name}-{uuid}`

Running `ccbox` in the same project reuses the same image, no duplicates.

## Cleanup & Maintenance

### Automatic Cleanup (Pre-run)

By default, ccbox automatically cleans up stale resources before each run:
- Stopped ccbox containers (from crashed sessions or ungraceful terminations)
- Dangling images from ccbox rebuilds (checked via parent chain)
- Only targets ccbox-prefixed resources - other Docker projects are never affected

Use `--no-prune` to skip automatic cleanup. This is useful if you want to inspect crashed containers for debugging (e.g., to check logs or state from a failed session).

### Manual Cleanup

```bash
# Remove all ccbox resources (containers, images, temp files)
ccbox clean              # Interactive, asks confirmation
ccbox clean -f           # Force, no confirmation

# Deep clean: reset ccbox to fresh state
ccbox prune              # Interactive, asks confirmation
ccbox prune -f           # Force, no confirmation

# Full Docker cleanup (affects ALL Docker projects!)
ccbox prune --system     # Shows detailed breakdown, asks confirmation
ccbox prune --system -f  # Force, no confirmation
```

### What Each Command Removes

| Command               | Targets                                                              | Safe for Multi-Project? |
|-----------------------|----------------------------------------------------------------------|-------------------------|
| `ccbox clean`         | ccbox containers + images                                            | ✅ Yes                   |
| `ccbox prune`         | ccbox containers + images + temp files                               | ✅ Yes                   |
| `ccbox prune --system` | ALL stopped containers, dangling images, unused volumes, build cache | ⚠️ Affects all Docker   |

### Docker Disk Usage

The `ccbox prune --system` command shows a detailed breakdown of what will be cleaned:

```
Resource      What gets removed                         Reclaimable
Containers    All stopped containers                    0B
Images        Dangling images (<none>:<none>)          1.2GB (50%)
Volumes       Unused volumes (not attached)             500MB
Build Cache   All cached build layers                   3.5GB

⚠ WARNING: This affects ALL Docker projects, not just ccbox!
```

## Requirements

- Docker (running - auto-starts on Windows/Mac if not)
- Python 3.9+
- Claude Code account

## Troubleshooting

```bash
ccbox doctor    # Shows system status and detected project type
```

### Docker not running
ccbox will attempt to auto-start Docker Desktop on Windows and macOS. On Linux, start manually:
```bash
sudo systemctl start docker
```

### Permission denied (Linux)
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

### Rebuild from scratch
```bash
ccbox prune -f   # Remove all ccbox resources
ccbox            # Fresh start
```

### Windows/WSL path issues
ccbox automatically converts Windows paths for Docker. If issues persist, run from within WSL.

## Development

```bash
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox
pip install -e ".[dev]"
pytest
ruff check src/ccbox
mypy src/ccbox --strict
```

## License

MIT
