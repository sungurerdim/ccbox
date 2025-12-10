# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## Why ccbox?

- **Isolated**: Container only accesses current project directory - nothing else
- **Fast**: Bypass mode enabled by default (safe because container is sandboxed)
- **Simple**: Single command to start, auto-detects everything
- **Auto-start**: Docker Desktop starts automatically if not running (Windows/Mac)
- **Persistent**: Claude settings stay on host (`~/.claude`), survive container restarts
- **Clean**: No config files in your project directories
- **Up-to-date**: Automatic update checks for ccbox and CCO
- **Safe Logging**: Debug mode disabled (`DEBUG=False`) to prevent log file explosion

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
ccbox                  # Run Claude Code (auto-detect stack, auto-build)
ccbox -s base          # Use specific stack
ccbox -b               # Force rebuild image
ccbox --no-update-check # Skip update check

ccbox setup            # Configure git name/email (one-time, optional)
ccbox update           # Rebuild base image with latest Claude Code
ccbox update -s go     # Rebuild specific stack
ccbox update -a        # Rebuild all installed images
ccbox clean            # Remove all ccbox containers and images
ccbox doctor           # Check system status and project detection
ccbox stacks           # List available stacks
```

## Stacks

ccbox auto-detects your project type and shows an interactive menu:

| Stack | Contents | Size |
|-------|----------|------|
| `base` | Node.js + Python + CCO + eslint/prettier/ruff/pytest | ~600MB |
| `go` | + Go + golangci-lint | ~750MB |
| `rust` | + Rust + clippy + rustfmt | ~900MB |
| `java` | + JDK (Temurin LTS) + Maven | ~1000MB |
| `web` | + pnpm (fullstack) | ~650MB |
| `full` | All: Go + Rust + Java + pnpm | ~1500MB |

Detection rules:
- `pyproject.toml` or `requirements.txt` → `base` (includes Python)
- `go.mod` → `go`
- `Cargo.toml` → `rust`
- `pom.xml` or `build.gradle` → `java`
- `package.json` + `pyproject.toml` → `web`
- Only `package.json` or nothing → `base`

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

Git config is auto-detected from your system. Run `ccbox setup` only if you need to override.

## Auto-Update Check

On startup, ccbox checks for updates to:
- **ccbox** itself (PyPI)
- **Claude Code** (npm, version inside Docker image)
- **CCO** (ClaudeCodeOptimizer, GitHub, version inside Docker image)

If updates are available, you'll be prompted to update. Use `--no-update-check` to skip.

## Image Naming

Images are tagged consistently: `ccbox:{stack}`

```
ccbox:base
ccbox:go
ccbox:rust
ccbox:java
ccbox:web
ccbox:full
```

Containers: `ccbox-{project-name}`

Running `ccbox` in the same project reuses the same image, no duplicates.

## Requirements

- Docker (running - auto-starts on Windows/Mac if not)
- Python 3.8+
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

## Development

```bash
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox
pip install -e ".[dev]"
pytest --cov=src/ccbox   # 100% coverage, 121 tests
ruff check src/ccbox
mypy src/ccbox --strict
```

## License

MIT
