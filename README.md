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

- **Project isolation**: Only current directory mounted, nothing else accessible
- **Tmpfs overlays**: CCO rules/commands injected at runtime, not persisted
- **Ephemeral logs**: Debug logs use tmpfs by default (no disk residue)
- **No privilege escalation**: `--security-opt=no-new-privileges`
- **Fork bomb protection**: `--pids-limit=512`
- **Path validation**: Config paths validated to prevent directory traversal

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
