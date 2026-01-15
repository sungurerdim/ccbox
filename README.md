# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## Quick Start

```bash
npm install -g ccbox             # Install
cd your-project && ccbox         # Run (interactive)
ccbox -y                         # Run (unattended)
ccbox --bare                     # Run vanilla Claude Code (no CCO)
ccbox -p "fix the tests"         # Run with prompt (non-interactive)
```

**Requirements:** Docker Desktop or Docker Engine

## Why ccbox?

- **Isolated**: Container only accesses current project directory - nothing else
- **Fast**: Bypass mode enabled by default (safe because container is sandboxed)
- **Simple**: Single command to start, auto-detects everything
- **Auto-start**: Docker Desktop starts automatically if not running (Windows/Mac)
- **Git Auto-detect**: Git credentials auto-detected from host system
- **Persistent**: Claude settings stay on host (`~/.claude`), survive container restarts
- **Clean**: No config files in your project directories
- **Cross-platform**: Windows, macOS, Linux, WSL2, and ARM64 support

## Claude Code CLI vs ccbox

| Aspect | Claude Code CLI | ccbox |
|--------|-----------------|-------|
| **Installation** | `npm install -g @anthropic-ai/claude-code` | `npm install -g ccbox` |
| **File Access** | Full system access | Only current project directory |
| **Permission Prompts** | Every tool use requires approval | Bypass mode (container is sandbox) |
| **System Impact** | Can modify any file | Isolated - nothing persists outside |
| **Other Projects** | Accessible | Completely inaccessible |
| **Home Directory** | Full access | Only `~/.claude` (settings) |
| **Startup Time** | Instant | First run: ~2 min, then instant |
| **Dependencies** | User installs manually | Pre-installed dev tools |

## Language Stacks

| Stack | Includes | Size |
|-------|----------|------|
| `minimal` | Node.js, Python, basic tools | ~400MB |
| `base` | + lint/test tools, CCO | ~450MB |
| `go` | Go + golangci-lint | ~650MB |
| `rust` | Rust + clippy + rustfmt | ~850MB |
| `java` | JDK + Maven/Gradle | ~750MB |
| `web` | Node.js + Python fullstack | ~500MB |
| `full` | All languages | ~1350MB |

## Commands

```bash
ccbox [options] [path]   # Run Claude Code in container
ccbox stacks             # List available stacks
ccbox update [-a]        # Rebuild images
ccbox clean [-f]         # Remove ccbox containers/images
ccbox prune [-f]         # Deep clean ccbox resources
```

## Options

| Option | Description |
|--------|-------------|
| `-y, --yes` | Unattended mode |
| `-s, --stack <name>` | Language stack |
| `-b, --build` | Build only, don't run |
| `-p, --prompt <text>` | Initial prompt (non-interactive) |
| `-m, --model <name>` | Model (opus/sonnet/haiku) |
| `-q, --quiet` | Quiet mode |
| `--bare` | Vanilla mode (no CCO) |
| `--deps` | Install all dependencies |
| `--deps-prod` | Install production deps only |
| `--no-deps` | Skip dependency installation |
| `-d` | Debug mode (entrypoint logs) |
| `-dd` | Verbose debug (+ stream output) |

## Security

ccbox provides strong isolation:

- Container runs as non-root user
- `--cap-drop=ALL` - all Linux capabilities dropped
- `--security-opt=no-new-privileges` - no privilege escalation
- `--pids-limit=2048` - fork bomb protection
- Tmpfs for `/tmp` - no disk residue
- Path validation - directory traversal prevention
- Project directory is the only mounted volume

## How It Works

1. Detects project type (package.json, Cargo.toml, go.mod, etc.)
2. Recommends appropriate stack
3. Builds Docker image with Claude Code
4. Mounts project directory
5. Forwards Git config and Claude credentials
6. Runs interactive Claude Code session

## License

MIT
