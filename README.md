# ccbox

**Use Claude Code with confidence: it can't escape your project, can't touch your system, but works at full power.**

```bash
cd your-project
ccbox
```

With ccbox, Claude Code runs in an isolated Docker container where it can only see and modify your current project - nothing else on your system is accessible.

## Why ccbox?

| Problem | How ccbox solves it |
|---------|---------------------|
| Claude has access to your entire filesystem | Container only mounts current project directory |
| Every file edit/command needs approval | Bypass mode enabled - safe because container is isolated |
| A mistake could affect other projects or system files | Container can't access anything outside your project |
| Need to install project dependencies manually | Dependencies detected and installed automatically |
| Need to set up Git and Claude auth in each environment | Your host's Git config and Claude credentials are forwarded |

**Also:** Auto-detects project type (Python, Node, Go, etc.) and works on Windows, macOS, Linux, and WSL2.

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

## Usage

```bash
ccbox                        # Interactive session
ccbox -y                     # Skip all prompts (CI/CD, scripts)
ccbox -p "fix the tests"     # Start with a prompt
ccbox -s python              # Force specific stack
ccbox stacks                 # List all 20 stacks
```

### Dependency Installation

ccbox detects dependencies (package.json, requirements.txt, go.mod, etc.) and installs them automatically.

```bash
ccbox                   # All deps including dev tools (default)
ccbox --deps-prod       # Production only
ccbox --no-deps         # Skip installation
```

### Environment Variables

```bash
ccbox -e MY_API_KEY=secret                    # Pass to container
ccbox -e CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70   # Override ccbox defaults
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-y, --yes` | off | Skip all prompts |
| `-s, --stack <name>` | auto | Language stack |
| `-p, --prompt <text>` | - | Initial prompt |
| `-m, --model <name>` | - | Model (opus/sonnet/haiku) |
| `-q, --quiet` | off | Only show Claude's output |
| `--deps` | **on** | Install all dependencies |
| `--deps-prod` | off | Production deps only |
| `--no-deps` | off | Skip dependency installation |
| `--fresh` | off | Clean slate (auth preserved) |
| `-d` / `-dd` | off | Debug / verbose debug |
| `-U, --unrestricted` | off | Remove CPU/memory limits |
| `-e, --env <K=V>` | - | Pass environment variable |

**Other commands:** `ccbox update`, `ccbox clean`, `ccbox prune`

## Language Stacks

ccbox auto-detects your project type. Use `-s <stack>` to override.

<details>
<summary><b>View all 20 stacks</b></summary>

**Core Stacks:**
| Stack | Includes |
|-------|----------|
| `base` | Claude Code only |
| `python` | Python 3, uv, ruff, pytest, mypy |
| `web` | Node.js, TypeScript, pnpm, eslint, vitest |
| `go` | Go, golangci-lint |
| `rust` | Rust, cargo, clippy, rustfmt |
| `java` | JDK 21, Maven, Gradle |
| `cpp` | GCC, Clang, CMake, Conan |
| `dotnet` | .NET SDK, C#, F# |
| `swift` | Swift toolchain |
| `dart` | Dart SDK |
| `lua` | Lua, LuaRocks |

**Combined:** `jvm`, `functional`, `scripting`, `systems`

**Use-Case:** `data`, `ai`, `fullstack`, `mobile`, `game`

</details>

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  $ ccbox                                                 │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  1. Detect project type (package.json? Cargo.toml?)      │
│  2. Build/reuse Docker image with language tools         │
│  3. Install project dependencies                         │
│  4. Mount project + forward Git/Claude config            │
│  5. Launch Claude Code with bypass mode                  │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Docker Container                                        │
│                                                          │
│  ✓ Your project directory (read/write)                  │
│  ✓ Git config and Claude credentials from host          │
│  ✓ Pre-installed language tools + your dependencies     │
│                                                          │
│  ✗ No access to anything else on your system            │
└──────────────────────────────────────────────────────────┘
```

**First run:** ~2 min (builds image) | **After:** Instant (cached)

## What Persists

| Location | Persists? | Notes |
|----------|-----------|-------|
| Project files | ✅ Yes | Mounted from host |
| Claude settings (`~/.claude`) | ✅ Yes | Forwarded from host |
| Installed dependencies | ✅ Yes | Baked into Docker image |
| `/tmp` contents | ❌ No | RAM-based, ephemeral |
| Anything outside project | ❌ N/A | Not accessible |

## Security

| Protection | Description |
|------------|-------------|
| Non-root user | Runs as your UID/GID |
| Capabilities dropped | Minimal Linux capabilities |
| Process limits | Max 2048 (fork bomb protection) |
| Restricted mounts | Only project + `~/.claude` + tmpfs |

## Performance

| Optimization | Benefit |
|--------------|---------|
| RAM-based `/tmp` | Zero SSD wear, 15-20x faster |
| Git optimizations | Preload index, fscache, commit graph |
| I/O priority (`ionice`) | Doesn't starve other processes |
| CPU priority (`nice`) | System stays responsive |

<details>
<summary><b>Pre-configured Claude Code settings</b></summary>

| Variable | Value | Effect |
|----------|-------|--------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `85` | Auto-compacts at 85% capacity |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | `1` (on) | Bash stays in project dir |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` (on) | Fewer network calls |
| `CLAUDE_CODE_HIDE_ACCOUNT_INFO` | `1` (on) | Hides account in output |
| `FORCE_AUTOUPDATE_PLUGINS` | `true` | Plugins auto-update |
| `FORCE_COLOR` | `1` (on) | Colored output |
| `DO_NOT_TRACK` | `1` (on) | No telemetry |
| `TZ` | *(auto)* | Your host timezone |

</details>

## Limitations

Docker container restrictions (not ccbox-specific):

| Limitation | Workaround |
|------------|------------|
| No image paste (no clipboard) | Save image to project, reference by path |
| No Docker-in-Docker | Use host Docker if needed |
| No GUI apps | Use CLI alternatives |

<details>
<summary><b>Cross-platform path translation</b></summary>

ccbox uses a dual-layer path translation system (FUSE + fakepath) to make the container transparent — tools and Claude Code see host paths as if running natively.

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
ccbox clean -f                # Remove Docker images
rm -f ~/.local/bin/ccbox      # Remove binary (Linux/Mac)
```

## Development

```bash
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox && bun install

bun run dev          # Run from source
bun run test         # 194 tests
bun run build:binary # Build binary
```

> [CONTRIBUTING.md](CONTRIBUTING.md) | [ARCHITECTURE.md](ARCHITECTURE.md)

## License

MIT
