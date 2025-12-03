# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## Why ccbox?

- **Isolated**: Container only accesses current project directory - nothing else
- **Fast**: Bypass mode enabled by default (safe because container is sandboxed)
- **Simple**: Single command to start, auto-detects everything
- **Persistent**: Claude settings stay on host (`~/.claude`), survive container restarts
- **Clean**: No config files in your project directories

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
ccbox -s python        # Use specific stack
ccbox -b               # Force rebuild image

ccbox setup            # Configure git name/email (one-time, optional)
ccbox update           # Rebuild image with latest Claude Code
ccbox update -a        # Rebuild all installed images
ccbox clean            # Remove all ccbox containers and images
ccbox doctor           # Check system status and project detection
ccbox stacks           # List available stacks
```

## Stacks

ccbox auto-detects your project type. Override with `-s`:

| Stack | Contents | Size |
|-------|----------|------|
| `base` | Claude Code + git + CLI tools | ~400MB |
| `python` | + Python 3 + ruff + mypy + pytest | ~600MB |
| `go` | + Go | ~550MB |
| `rust` | + Rust + cargo | ~700MB |
| `java` | + JDK 17 + Maven | ~800MB |
| `web` | + Python + pnpm (fullstack) | ~700MB |
| `full` | Python + Go + Rust | ~1.5GB |

Detection rules:
- `pyproject.toml` or `requirements.txt` → `python`
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

## Image Naming

Images are tagged consistently: `ccbox:{stack}`

```
ccbox:base
ccbox:python
ccbox:go
ccbox:rust
ccbox:java
ccbox:web
ccbox:full
```

Containers: `ccbox-{project-name}`

Running `ccbox` in the same project reuses the same image, no duplicates.

## Requirements

- Docker (running)
- Python 3.8+
- Claude Code account

## Troubleshooting

```bash
ccbox doctor    # Shows system status and detected project type
```

### Docker not running
Start Docker Desktop (Windows/Mac) or `sudo systemctl start docker` (Linux)

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
pytest
ruff check src/ccbox
mypy src/ccbox --strict
```

## License

MIT
