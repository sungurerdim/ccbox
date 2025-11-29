# ccbox

Secure Docker environment for Claude Code CLI. Run Claude Code in isolated containers with project-specific access.

## Features

- **Project Isolation**: Each project runs in its own container with access only to the project directory
- **Zero-Confirmation Mode**: Safe bypass mode enabled by default (container isolation makes it secure)
- **Auto-Detection**: Automatically detects project language and recommends optimal Docker image
- **Multi-Instance**: Run multiple Claude Code instances simultaneously on different projects
- **Cross-Platform**: Works on Windows, Linux, and macOS

## Installation

```bash
pip install ccbox
```

### Requirements

- Python 3.8+
- Docker (running)
- Claude Code account (for authentication)

## Quick Start

```bash
# 1. Initial setup
ccbox init

# 2. Run Claude Code in any project directory
cd ~/projects/my-app
ccbox run

# That's it! Claude Code starts in an isolated container
```

## Commands

| Command | Description |
|---------|-------------|
| `ccbox init` | Interactive setup wizard |
| `ccbox run [PATH]` | Run Claude Code in directory (default: current) |
| `ccbox update` | Update Docker images to latest Claude Code |
| `ccbox clean` | Remove containers and images |
| `ccbox config` | View/modify configuration |
| `ccbox doctor` | Check system requirements |
| `ccbox status` | Show installation status and running containers |
| `ccbox detect [PATH]` | Detect project type and recommend stack |

## Language Stacks

ccbox automatically detects your project type and builds an appropriate Docker image:

| Stack | Languages | Size |
|-------|-----------|------|
| `node` | Node.js only | ~500MB |
| `node-python` | Node.js + Python 3 | ~800MB |
| `node-go` | Node.js + Go | ~900MB |
| `node-rust` | Node.js + Rust | ~1.2GB |
| `node-java` | Node.js + OpenJDK 17 | ~1GB |
| `node-dotnet` | Node.js + .NET SDK | ~1.5GB |
| `universal` | All languages | ~2GB |

## Configuration

Configuration is stored in `~/.ccbox/config.json`:

```json
{
  "version": "1.0.0",
  "git_name": "Your Name",
  "git_email": "your@email.com",
  "ram_percent": 75,
  "cpu_percent": 100,
  "default_mode": "bypass",
  "default_stack": "node-python",
  "install_cco": false,
  "install_gh": false,
  "install_gitleaks": false,
  "claude_config_dir": "~/.claude"
}
```

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `ram_percent` | Max RAM usage (%) | 75 |
| `cpu_percent` | Max CPU usage (%) | 100 |
| `default_mode` | `bypass` or `safe` | bypass |
| `default_stack` | Default language stack | node-python |
| `install_cco` | Install ClaudeCodeOptimizer | false |
| `install_gh` | Install GitHub CLI | false |
| `install_gitleaks` | Install Gitleaks scanner | false |

## Usage Examples

### Basic Usage

```bash
# Run in current directory
ccbox run

# Run in specific directory
ccbox run ~/projects/my-app

# Force safe mode (with confirmations)
ccbox run --safe

# Use specific language stack
ccbox run --stack universal
```

### Multiple Instances

```bash
# Terminal 1
cd ~/projects/frontend
ccbox run

# Terminal 2
cd ~/projects/backend
ccbox run

# Each runs in its own isolated container
```

### Check Project Detection

```bash
ccbox detect ~/projects/my-app
# Shows detected languages and recommended stack
```

### Update Images

```bash
# Update all installed images
ccbox update

# Update specific stack
ccbox update --stack node-python
```

### Cleanup

```bash
# Remove all ccbox containers and images
ccbox clean

# Remove only containers
ccbox clean --containers

# Remove only images
ccbox clean --images
```

## How It Works

1. **Initialization**: `ccbox init` configures Git settings, performance limits, and builds the base Docker image

2. **Detection**: When you run `ccbox run`, it:
   - Detects project language(s) from config files
   - Recommends an appropriate Docker image
   - Asks for confirmation (or uses default)

3. **Isolation**: The container:
   - Mounts only the project directory (read/write)
   - Mounts Claude config directory (for auth)
   - Has no access to other parts of your filesystem

4. **Execution**: Claude Code runs with:
   - Dynamic memory limits based on your config
   - Dynamic CPU limits based on your config
   - Optional bypass mode for zero confirmations

## Security

ccbox provides security through isolation:

- **Filesystem Isolation**: Container can only access the mounted project directory
- **Network Isolation**: Optional network restrictions via Docker
- **No Host Access**: Cannot modify files outside the project
- **Safe Bypass**: The `--dangerously-skip-permissions` flag is safe because the container itself is sandboxed

## Troubleshooting

### Docker Not Found

```bash
ccbox doctor
# Shows detailed system check
```

Make sure Docker is installed and running:
- Windows: Docker Desktop
- Linux: `sudo systemctl start docker`
- macOS: Docker Desktop

### Image Build Fails

```bash
# Check Docker has enough resources
docker system df

# Clean up and rebuild
ccbox clean --images
ccbox init
```

### Permission Issues

```bash
# On Linux, you may need to add user to docker group
sudo usermod -aG docker $USER
# Then log out and back in
```

## Development

```bash
# Clone repository
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox

# Install in development mode
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy src/ccbox

# Linting
ruff check src/ccbox
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

Sungur Zahid Erdim (sungurerdim@gmail.com)

## Links

- [GitHub Repository](https://github.com/sungurerdim/ccbox)
- [Issue Tracker](https://github.com/sungurerdim/ccbox/issues)
- [Claude Code](https://claude.ai/claude-code)
