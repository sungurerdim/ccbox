# Architecture

ccbox is a secure Docker sandbox for Claude Code CLI.

## Module Structure

```
src/ccbox/
├── cli/                    # CLI Layer (entry points)
│   ├── __init__.py         # Click command group, exports
│   ├── build.py            # Build commands
│   ├── cleanup.py          # Prune/clean commands
│   ├── prompts.py          # User prompts
│   ├── run.py              # Main run command
│   └── utils.py            # CLI utilities
├── config.py               # Configuration, LanguageStack enum
├── constants.py            # SSOT for all constants
├── deps.py                 # Dependency detection (55+ managers)
├── detector.py             # Language/stack detection
├── docker.py               # Docker operations
├── errors.py               # Exception hierarchy (leaf)
├── generator.py            # Dockerfile generation
├── logging.py              # Logging configuration
├── paths.py                # Path conversion (leaf)
├── run_config.py           # RunConfig dataclass
└── sleepctl.py             # Sleep inhibition
```

## Dependency Hierarchy

```
CLI Layer (cli/)
    │
    ▼
Business Logic (config, docker, generator, deps, detector)
    │
    ▼
Utilities (paths, logging, errors, constants) ← Leaf modules, no internal imports
```

**Rule:** Imports flow upward only. CLI imports from core, core imports from leaf. No reverse imports.

## Data Flow

```
User Input → CLI → Config/RunConfig → Generator → Docker → Container
                        │
                        ▼
                    Detector → DepsInfo → Install Commands
```

## Key Patterns

### Configuration
- `Config`: Project-level settings (dataclass)
- `RunConfig`: Runtime parameters (dataclass with 14 fields)
- `LanguageStack`: Enum of supported stacks (MINIMAL, BASE, WEB, GO, RUST, JAVA)

### Error Handling
- All exceptions inherit from `CCBoxError`
- Specialized: `ConfigError`, `DockerError`, `DependencyError`, `ValidationError`
- CLI catches at top level, prints user-friendly message, exits with code

### Dependency Detection
- `PackageManager`: Defines detection logic per package manager
- `DepsInfo`: Result of detection (frozen dataclass)
- 55+ package managers supported across Python, Node, Go, Rust, Java

## Adding a New Language Stack

1. Add variant to `LanguageStack` enum in `config.py`
2. Add detection logic in `detector.py::_determine_stack()`
3. Add Dockerfile template in `generator.py::generate_dockerfile()`
4. Add dependency detection in `deps.py` if new package managers needed
5. Add tests in `tests/test_*.py`

## Constants (SSOT)

All magic numbers and paths are centralized in `constants.py`:

- `DOCKER_COMMAND_TIMEOUT`: 30s
- `DOCKER_BUILD_TIMEOUT`: 600s
- `CONTAINER_HOME`: /home/node
- `CONTAINER_PROJECT_DIR`: /home/node/project

## Testing Strategy

- Unit tests mock Docker/subprocess
- Test isolation via fixtures (tmp_path, monkeypatch)
- Target: 70%+ coverage per module
- Critical paths: CLI → build → run flow
