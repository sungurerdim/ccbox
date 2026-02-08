# ccbox

**Isolated Docker sandbox for Claude Code.** Your project stays safe, Claude runs at full power.

> Claude Code runs in a container where it can only see your current project and `~/.claude` settings — nothing else on your system is accessible. Bypass mode is enabled by default because the sandbox itself is the safety boundary.

## Installation

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.sh | bash
```

**Windows (PowerShell as Admin):**
```powershell
irm https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.ps1 | iex
```

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (ccbox starts it automatically if not running)

## Quick Start

```bash
cd your-project
ccbox
```

That's it. ccbox detects your project type, builds an image with the right tools, installs dependencies, and launches Claude Code.

**First run:** ~2 min (builds image) | **After:** Instant (cached)

## Usage

```bash
ccbox                        # Interactive session
ccbox -y                     # Skip all prompts (CI/CD, scripts)
ccbox -p "fix the tests"     # Start with a prompt (passthrough to Claude)
ccbox -c                     # Continue most recent session
ccbox -r                     # Resume a previous session
ccbox -s python              # Force specific stack
ccbox -e MY_API_KEY=secret   # Pass env variable to container
ccbox --allowedTools bash    # Any Claude CLI flag works
```

### Dependencies

ccbox detects dependencies (package.json, requirements.txt, go.mod, etc.) and installs them automatically.

```bash
ccbox                   # All deps including dev tools (default)
ccbox --deps-prod       # Production only
ccbox --no-deps         # Skip installation
```

## How It Works

1. Detects project type (package.json? Cargo.toml?)
2. Builds or reuses a Docker image with the right language tools
3. Installs project dependencies
4. Auto-detects Git credentials and SSH keys from host
5. Mounts project directory + `~/.claude`
6. Launches Claude Code with bypass mode

**What's inside the container:**

| Accessible | Not accessible |
|------------|----------------|
| Your project directory (read/write) | Everything else on your system |
| `~/.claude` settings and credentials | Other projects |
| Git credentials (auto-detected) | Host shell, processes |
| SSH agent (if running on host) | Other network services |
| Pre-installed language tools + deps | |

## Options

**ccbox options** (container management):

| Option | Default | Description |
|--------|---------|-------------|
| `-y, --yes` | off | Skip all prompts |
| `-s, --stack <name>` | auto | Language stack |
| `-b, --build` | off | Build image only, don't start |
| `--path <path>` | `.` | Project path |
| `-C, --chdir <dir>` | - | Change to directory before running |
| `--deps` | **on** | Install all dependencies |
| `--deps-prod` | off | Production deps only |
| `--no-deps` | off | Skip dependency installation |
| `--fresh` | off | Clean slate (auth only, no rules/settings/commands) |
| `-d` / `-dd` | off | Debug (`-d` entrypoint logs, `-dd` + stream output) |
| `--headless` | off | Non-interactive mode (adds `--print --output-format stream-json`) |
| `-v, --verbose` | off | Show detection details |
| `-U, --unrestricted` | off | Remove CPU/priority limits |
| `-e, --env <K=V>` | - | Pass environment variable (can override defaults) |
| `--memory <limit>` | 4g | Container memory limit |
| `--cpus <limit>` | 2.0 | Container CPU limit |
| `--network <policy>` | full | Network policy (full/isolated) |
| `--zero-residue` | off | Zero-trace mode (no cache/logs left behind) |
| `--no-prune` | off | Skip automatic cleanup of stale Docker resources |
| `--no-cache` | off | Disable Docker build cache |
| `--progress <mode>` | auto | Docker build progress mode (auto/plain/tty) |
| `--no-debug-logs` | off | Don't persist debug logs |

**Claude CLI flags** are passed through automatically — any flag not listed above goes directly to Claude Code:

```bash
ccbox -p "fix tests"                    # --prompt
ccbox -c                                # --continue
ccbox -r                                # --resume
ccbox -m opus                           # --model
ccbox --allowedTools bash edit          # --allowedTools
ccbox --append-system-prompt "Be brief" # --append-system-prompt
```

**Other commands:** `ccbox update`, `ccbox rebuild`, `ccbox clean`, `ccbox stacks`, `ccbox voice`, `ccbox paste`, `ccbox uninstall`, `ccbox version`

### Git & SSH (Zero-Config)

ccbox auto-detects your Git credentials and SSH agent — no manual setup needed.

```bash
$ ccbox
Git: Your Name + token      # ← Auto-detected from gh CLI or credential helper
SSH: agent forwarded        # ← If ssh-agent is running on host
```

| Source | Token | Identity | SSH |
|--------|-------|----------|-----|
| `gh` CLI (authenticated) | ✅ | ✅ (from GitHub API) | - |
| Git credential helper | ✅ | ✅ (from git config) | - |
| SSH agent | - | - | ✅ |

Inside the container, `git push`, `gh pr create`, and `ssh` commands work automatically.

**Security:**
- SSH private keys never enter the container — only the agent socket is forwarded (read-only)
- GitHub tokens are passed as environment variables, not stored on disk
- Credentials are only forwarded if already configured on host

## Language Stacks

ccbox auto-detects your project type. Use `-s <stack>` to override.

<!-- Source of truth for stack definitions: internal/config/stacks.go -->
<details>
<summary><b>View all 20 stacks</b></summary>

**Core Stacks:**
| Stack | Includes |
|-------|----------|
| `base` | Claude Code + make, tree, zip, file, patch, wget, vim-tiny |
| `python` | Python 3, uv, ruff, pytest, mypy |
| `web` | Node.js, Bun, TypeScript, pnpm, eslint, prettier, vitest |
| `go` | Go, golangci-lint |
| `rust` | Rust, cargo, clippy, rustfmt |
| `java` | JDK (Temurin), Maven |
| `cpp` | GCC, Clang, CMake, Conan |
| `dotnet` | .NET SDK, C#, F# |
| `swift` | Swift toolchain |
| `dart` | Dart SDK |
| `lua` | Lua, LuaRocks |

**Combined:** `jvm`, `functional`, `scripting`, `systems`

> **Auto-promotion:** Projects with both a web language (TypeScript, Node, Bun, Deno) and Python are automatically promoted to `fullstack`.

**Use-Case:** `data`, `ai`, `fullstack`, `mobile`, `game`

</details>

## Security & Performance

<details>
<summary><b>Container security</b></summary>

| Protection | Description |
|------------|-------------|
| Non-root user | Runs as your UID/GID |
| Capabilities dropped | `CAP_DROP=ALL`, only SETUID/SETGID/CHOWN/SYS_ADMIN added back |
| Process limits | Max 2048 (fork bomb protection) |
| Restricted mounts | Only project + `~/.claude` + tmpfs |

</details>

<details>
<summary><b>Performance optimizations</b></summary>

| Optimization | Benefit |
|--------------|---------|
| RAM-based `/tmp` | Zero SSD wear, faster I/O |
| Git optimizations | Preload index, fscache, commit graph |
| I/O priority (`ionice`) | Doesn't starve other processes |
| CPU priority (`nice`) | System stays responsive |

</details>

<details>
<summary><b>Pre-configured Claude Code settings</b></summary>

| Variable | Value | Effect |
|----------|-------|--------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `85` | Auto-compacts at 85% capacity |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | `1` | Bash stays in project dir |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Fewer network calls |
| `CLAUDE_CODE_HIDE_ACCOUNT_INFO` | `1` | Hides account in output |
| `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` | `1` | Skip IDE auto-install |
| `FORCE_AUTOUPDATE_PLUGINS` | `true` | Plugins auto-update |
| `DISABLE_AUTOUPDATER` | `0` | Allow Claude Code self-updates |
| `FORCE_COLOR` | `1` | Colored output |
| `DO_NOT_TRACK` | `1` | No telemetry |
| `CHECKPOINT_DISABLE` | `1` | Disable Terraform checkpoint |
| `PYTHONUNBUFFERED` | `1` | Unbuffered Python output |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH` | `0` | Disable Bun transpiler cache |
| `TZ` | *(auto)* | Your host timezone |

</details>

## Persistence

| Location | Persists? | Notes |
|----------|-----------|-------|
| Project files | ✅ | Mounted from host |
| `~/.claude` settings | ✅ | Forwarded from host (`--fresh` makes this ephemeral) |
| Installed dependencies | ✅ | Baked into Docker image |
| `/tmp` contents | ❌ | RAM-based, ephemeral |
| Anything outside project | N/A | Not accessible |

## Limitations

Docker container restrictions (not ccbox-specific):

| Limitation | Workaround |
|------------|------------|
| No Docker-in-Docker | Use host Docker if needed |
| No GUI apps | Use CLI alternatives |

> **Clipboard:** Use `ccbox paste` to send clipboard images into a running container.

<details>
<summary><b>Cross-platform path translation</b></summary>

ccbox uses a dual-layer path translation system (FUSE + fakepath) so Claude Code sees host paths as if running natively.

```
Host                           Container
C:\Users\You\.claude      ↔    /ccbox/.claude
D:\Projects\myapp         ↔    /d/Projects/myapp
```

Sessions created in ccbox work seamlessly with native Claude Code and vice versa.

> **Details:** [docs/PATH-TRANSLATION.md](docs/PATH-TRANSLATION.md)

</details>

## Troubleshooting

<details>
<summary><b>Docker not running</b></summary>

```bash
# macOS
open -a Docker

# Windows
Start-Process "Docker Desktop"

# Linux
sudo systemctl start docker
```

</details>

<details>
<summary><b>Out of memory (exit code 137)</b></summary>

```bash
ccbox -U   # Remove memory limits
```

</details>

<details>
<summary><b>Permission denied</b></summary>

```bash
sudo chown -R $(id -u):$(id -g) .
```

</details>

<details>
<summary><b>Wrong stack detected</b></summary>

```bash
ccbox -v        # See detection details
ccbox -s web    # Force stack
```

</details>

> More: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Uninstall

```bash
ccbox uninstall               # Remove ccbox from system
# or manually:
ccbox clean -f                # Remove Docker images
rm -f ~/.local/bin/ccbox      # Remove binary (Linux/Mac)
```

## Development

```bash
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox

make dev       # Run from source
make test      # Run tests
make build     # Build binary
```

> [CONTRIBUTING.md](CONTRIBUTING.md) | [ARCHITECTURE.md](ARCHITECTURE.md)

## License

MIT
