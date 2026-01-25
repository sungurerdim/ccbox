# ccbox

Run Claude Code in isolated Docker containers. One command, zero configuration.

## Install

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.ps1 | iex
```

> Installs to system PATH automatically. Or download binaries from [Releases](https://github.com/sungurerdim/ccbox/releases).

**Requirements:** Docker Desktop or Docker Engine

## Quick Start

```bash
cd your-project && ccbox     # Run (interactive)
ccbox -y                     # Run (unattended)
ccbox -p "fix the tests"     # Run with prompt (non-interactive)
```

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
| **Installation** | `claude install` | `curl ... \| bash` |
| **File Access** | Full system access | Only current project directory |
| **Permission Prompts** | Every tool use requires approval | Bypass mode (container is sandbox) |
| **System Impact** | Can modify any file | Isolated - nothing persists outside |
| **Other Projects** | Accessible | Completely inaccessible |
| **Home Directory** | Full access | Only `~/.claude` (settings) |
| **Startup Time** | Instant | First run: ~2 min, then instant |
| **Dependencies** | User installs manually | Pre-installed dev tools |

## Language Stacks

ccbox supports 20 language stacks organized in 3 categories. Stacks are built on top of each other for efficient layering.

### Core Stacks

| Stack | Includes | Size | Base |
|-------|----------|------|------|
| `base` | Claude Code only (vanilla) | ~200MB | debian:slim |
| `python` | Python + uv + ruff + pytest + mypy | ~350MB | base |
| `web` | Node.js + TypeScript + eslint + vitest | ~400MB | base |
| `go` | Go + golangci-lint | ~550MB | golang:latest |
| `rust` | Rust + clippy + rustfmt | ~700MB | rust:latest |
| `java` | JDK + Maven + Gradle | ~600MB | temurin:latest |
| `cpp` | C++ + CMake + Clang + Conan | ~450MB | base |
| `dotnet` | .NET SDK + C# + F# | ~500MB | base |
| `swift` | Swift | ~500MB | base |
| `dart` | Dart SDK | ~300MB | base |
| `lua` | Lua + LuaRocks | ~250MB | base |

### Combined Stacks

| Stack | Includes | Size | Base |
|-------|----------|------|------|
| `jvm` | Java + Scala + Clojure + Kotlin | ~900MB | java |
| `functional` | Haskell + OCaml + Elixir/Erlang | ~900MB | base |
| `scripting` | Ruby + PHP + Perl | ~450MB | base |
| `systems` | C++ + Zig + Nim | ~550MB | cpp |

### Use-Case Stacks

| Stack | Includes | Size | Base |
|-------|----------|------|------|
| `data` | Python + R + Julia (data science) | ~800MB | python |
| `ai` | Python + Jupyter + PyTorch + TensorFlow | ~2500MB | python |
| `mobile` | Dart + Flutter SDK + Android tools | ~1500MB | dart |
| `game` | C++ + SDL2 + Lua + OpenGL | ~600MB | cpp |
| `fullstack` | Node.js + Python + DB clients | ~700MB | web |

> **Auto-detection**: ccbox automatically detects your project type and recommends the appropriate stack based on configuration files (package.json, Cargo.toml, go.mod, etc.)

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
| `--fresh` | Fresh mode (auth only, clean slate) |
| `--deps` | Install all dependencies |
| `--deps-prod` | Install production deps only |
| `--no-deps` | Skip dependency installation |
| `-d` | Debug mode (entrypoint logs) |
| `-dd` | Verbose debug (+ stream output) |
| `-U, --unrestricted` | Remove CPU/priority limits |

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

1. **Detection**: Analyzes project files (package.json, Cargo.toml, go.mod, pyproject.toml, etc.)
2. **Stack Selection**: Recommends appropriate stack based on detected languages
3. **Image Building**: Builds Docker image with efficient layering (parent stacks reused)
4. **Dependency Installation**: Optionally installs project dependencies during image build
5. **Container Launch**: Mounts project directory, forwards Git config and Claude credentials
6. **Interactive Session**: Runs Claude Code with bypass permissions (safe in container)

### Image Layering

```
debian:bookworm-slim
    └── base (Claude Code)
        ├── python → data, ai
        ├── web → fullstack
        ├── cpp → systems, game
        ├── dart → mobile
        └── functional, scripting, dotnet, swift, lua

golang:latest → go
rust:latest → rust
eclipse-temurin:latest → java → jvm
```

Images are cached locally. Subsequent runs are instant.

### Path Mapping

ccbox uses FUSE (Filesystem in Userspace) to transparently translate paths between host and container. This enables seamless cross-platform compatibility - Claude Code inside the container works exactly as if running on the host.

**How it works:**

1. **FUSE overlay**: Host `.claude` directories are mounted via FUSE with on-the-fly path transformation
2. **Kernel-level interception**: FUSE intercepts ALL file operations (works with Bun, Go, Rust - any runtime)
3. **JSON path transform**: Paths inside `.json` config files are automatically converted
4. **Bidirectional**:
   - **Read**: `C:\Users\X\.claude` → `/ccbox/.claude`
   - **Write**: `/ccbox/.claude` → `C:\Users\X\.claude`

**What gets transformed:**

| Location | Path Transform | Content Transform |
|----------|---------------|-------------------|
| Global `.claude` | ✅ FUSE overlay | ✅ JSON files |
| Project `.claude` | ✅ FUSE overlay | ✅ JSON files |
| Project files | Direct mount | None needed |

**Platform behavior:**
- **Windows**: `C:\Users\X\.claude` → `/ccbox/.claude`
- **macOS**: `/Users/X/.claude` → `/ccbox/.claude`
- **Linux**: `/home/X/.claude` → `/ccbox/.claude`

All transformations happen in-memory - host files are never modified by the transform process.

## Uninstall

<details>
<summary><b>macOS / Linux / WSL</b></summary>

```bash
rm -f ~/.local/bin/ccbox
ccbox clean -f  # Remove Docker images (optional)
```

</details>

<details>
<summary><b>Windows</b></summary>

```powershell
Remove-Item "$HOME\.local\bin\ccbox.exe"
ccbox clean -f  # Remove Docker images (optional)
```

</details>

## Development

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone and setup
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox
bun install

# Development
bun run dev              # Run from source
bun run typecheck        # TypeScript check
bun run lint             # ESLint
bun run test             # Run tests

# Build
bun run build:binary     # Build for current platform
bun run build:binary:all # Build for all platforms
```

## License

MIT
