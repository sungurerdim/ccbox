# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## Why ccbox?

- **Isolated**: Container only accesses current project directory - nothing else
- **Fast**: Bypass mode enabled by default (safe because container is sandboxed)
- **Simple**: Single command to start, auto-detects everything
- **Auto-start**: Docker Desktop starts automatically if not running (Windows/Mac)
- **Git Auto-detect**: Git credentials auto-detected from host system
- **Persistent**: Claude settings stay on host (`~/.claude`), survive container restarts
- **Clean**: No config files in your project directories
- **Cross-platform**: Windows, macOS, Linux, and ARM64 support with automatic path handling

## Quick Start

```bash
pip install git+https://github.com/sungurerdim/ccbox.git
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

## Mount Strategy

ccbox has two modes with different behaviors:

### Normal Mode (default)

Full access to host settings with CCO enhancements:

| What | Host Path | Container Path | Access | Persistent? |
|------|-----------|----------------|--------|-------------|
| **Project** | `./` (current dir) | `/home/node/{project}/` | Read/Write | Yes |
| **Claude Settings** | `~/.claude/` | `/home/node/.claude/` | Read/Write | Yes |
| **Package Cache** | `~/.ccbox/cache/` | Various paths | Read/Write | Yes |
| **Temp Files** | (memory) | `/tmp`, `/var/tmp` | tmpfs | No |
| **Debug Logs** | (memory) | `/home/node/.claude/debug/` | tmpfs | No (default) |

**How it works:**
1. Host `~/.claude/` mounted directly (read/write)
2. CCO files from image (`/opt/cco/`) copied to `~/.claude/` (merges with your files)
3. CCO's `CLAUDE.md` copied to project's `.claude/` directory
4. All changes persist on host

### Bare Mode (`--bare`)

Vanilla Claude Code without any customizations:

| What | Host Path | Container Path | Access | Persistent? |
|------|-----------|----------------|--------|-------------|
| **Project** | `./` (current dir) | `/home/node/{project}/` | Read/Write | Yes |
| **Credentials** | `~/.claude/` | `/home/node/.claude/` | Read/Write | Yes |
| **Rules/Commands** | (hidden) | tmpfs overlay | tmpfs | No |
| **CLAUDE.md** | (hidden) | `/dev/null` | - | No |

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

| Data | Location | Description |
|------|----------|-------------|
| **Claude Credentials** | `~/.claude/.credentials.json` | Authentication tokens |
| **Claude Settings** | `~/.claude/settings.json` | User preferences |
| **Claude Memory** | `~/.claude/memory/` | Conversation context |
| **CCO Files** | `~/.claude/rules/`, `commands/`, etc. | Copied from container on first run |
| **Project Files** | Your project directory | All code changes |
| **Project .claude** | `./project/.claude/` | Project-specific settings |
| **ccbox Config** | `~/.ccbox/config.json` | Git name/email settings |
| **Package Caches** | `~/.ccbox/cache/` | npm, pip, cargo, etc. caches |

### What's Ephemeral (Lost on Exit)

| Data | Location | Why |
|------|----------|-----|
| **Temp Files** | `/tmp`, `/var/tmp` | tmpfs - memory only |
| **Debug Logs** | `/home/node/.claude/debug/` | tmpfs by default (use `--debug-logs` to persist) |
| **Container State** | Container itself | `--rm` flag removes on exit |

> **Note:** CCO files are copied to host's `~/.claude/` on container start and persist between runs. Use `ccbox update` to refresh CCO to latest version.

### Package Manager Caches

ccbox persists package manager caches to speed up dependency installation:

```
~/.ccbox/cache/
├── npm/          # npm packages
├── pip/          # Python packages
├── cargo/        # Rust crates
├── go/           # Go modules
└── ...           # Other package managers
```

These caches are mounted into containers automatically when dependencies are detected.

## Commands

```bash
# Basic usage
ccbox                    # Run Claude Code (auto-detect stack, auto-build)
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
ccbox setup              # Configure git name/email (one-time, optional)
ccbox update             # Rebuild base image with latest Claude Code
ccbox update -s go       # Rebuild specific stack
ccbox update -a          # Rebuild all installed images
ccbox clean              # Remove all ccbox containers and images
ccbox doctor             # Check system status and project detection
ccbox stacks             # List available stacks
```

## CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--stack` | `-s` | Select language stack |
| `--build` | `-b` | Build image only (no start) |
| `--path` | | Project path (default: current dir) |
| `--chdir` | `-C` | Change to directory before running |
| `--bare` | | Vanilla mode: auth only, no CCO/settings |
| `--deps` | | Install all dependencies (including dev) |
| `--deps-prod` | | Install production dependencies only |
| `--no-deps` | | Skip dependency installation |
| `--debug` | `-d` | Debug mode (`-d` logs, `-dd` + stream) |
| `--debug-logs` | | Persist debug logs (default: ephemeral) |
| `--prompt` | `-p` | Initial prompt (enables `--print` + `--verbose`) |
| `--model` | `-m` | Model name (opus, sonnet, haiku, etc.) |
| `--quiet` | `-q` | Quiet mode (only Claude's response) |
| `--append-system-prompt` | | Custom instructions for Claude |

## Stacks

ccbox auto-detects your project type and shows an interactive menu:

| Stack | Contents | Size |
|-------|----------|------|
| `minimal` | Node.js + Python + tools (no CCO) | ~400MB |
| `base` | minimal + CCO (default) | ~450MB |
| `go` | Go + Node.js + Python + CCO | ~750MB |
| `rust` | Rust + Node.js + Python + CCO | ~900MB |
| `java` | JDK (Temurin LTS) + Maven + CCO | ~1000MB |
| `web` | base + pnpm (fullstack) | ~500MB |
| `full` | base + Go + Rust + Java | ~1350MB |

Detection rules:
- `pyproject.toml` or `requirements.txt` → `base` (includes Python)
- `go.mod` → `go`
- `Cargo.toml` → `rust`
- `pom.xml` or `build.gradle` → `java`
- `package.json` + `pyproject.toml` → `web`
- Only `package.json` or nothing → `base`

## Dependencies

ccbox auto-detects project dependencies and prompts to install them:

```bash
ccbox
# Detected: pip (pyproject.toml), npm (package.json)
# Install dependencies? [1-All, 2-Prod, 3-Skip]
```

**Supported package managers:**

| Language | Package Managers |
|----------|-----------------|
| Python | pip, poetry, pipenv, uv, conda |
| Node.js | npm, pnpm, yarn, bun |
| Go | go mod |
| Rust | cargo |
| Java/Kotlin/Scala | maven, gradle, sbt |
| Ruby | bundler |
| PHP | composer |
| .NET | dotnet, nuget |
| Elixir | mix |
| Haskell | stack, cabal |
| Swift | swift pm |
| Dart/Flutter | pub |
| And more... | R, Julia, Clojure, Zig, Nim, OCaml, Perl, C/C++ |

**How it works:**
1. Dependencies detected from lockfiles/manifests
2. Project-specific Docker image built with deps
3. Package caches persisted in `~/.ccbox/cache/` for fast rebuilds
4. Container starts with all deps pre-installed

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

Minimal config stored in `~/.ccbox/config.json`:

```json
{
  "git_name": "Your Name",
  "git_email": "your@email.com",
  "claude_config_dir": "~/.claude"
}
```

Git credentials are auto-detected from your system (`git config --global user.name/email`). Run `ccbox setup` only if you need to override.

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

## Security

### Container Isolation

| Protection | How It Works |
|------------|--------------|
| **Project isolation** | Only current directory mounted, nothing else accessible |
| **No privilege escalation** | `--security-opt=no-new-privileges` prevents gaining root |
| **Fork bomb protection** | `--pids-limit=512` limits process count |
| **Memory-only temp** | `/tmp` and `/var/tmp` use tmpfs (no disk writes) |
| **Ephemeral logs** | Debug logs use tmpfs by default (no disk residue) |
| **Path validation** | Config paths validated to prevent directory traversal |

### Permission Model

ccbox runs Claude Code with bypass mode (`--dangerously-skip-permissions`) because the container itself provides isolation:

```
What Claude CAN do inside container:
✓ Read/write project files (your mounted directory)
✓ Read/write Claude settings (~/.claude)
✓ Run any command (npm, git, etc.)
✓ Install packages (npm install, pip install)
✓ Create/delete files in project

What Claude CANNOT do:
✗ Access files outside mounted directories
✗ Access other projects on your machine
✗ Access your home directory (except ~/.claude)
✗ Persist changes outside mounts (lost on exit)
✗ Escalate privileges (no-new-privileges)
✗ Spawn unlimited processes (pids-limit)
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
ccbox clean -f
ccbox
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
