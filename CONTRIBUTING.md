# Contributing to ccbox

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Docker](https://www.docker.com/) Desktop or Engine
- Git

## Setup

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone https://github.com/sungurerdim/ccbox.git
cd ccbox
bun install
```

## Development

```bash
bun run dev              # Run from source
bun run typecheck        # TypeScript check
bun run lint             # ESLint
bun run circular         # Check circular dependencies
```

## Testing

```bash
bun run test             # Unit tests
bun run test:e2e         # End-to-end tests
bun run test:all         # All tests
```

Tests use a custom framework in `tests/verify.mjs`. Add new test cases following existing patterns.

## Building

```bash
bun run build            # Build JS bundle
bun run build:binary     # Build binary for current platform
bun run build:binary:all # Build for all platforms
```

## Project Structure

```
src/
├── cli.ts           # CLI entry (Commander.js)
├── commands/run.ts  # Main run command
├── config.ts        # Stack definitions
├── detector.ts      # Project type detection
├── build.ts         # Image building
├── generator.ts     # Dockerfile generation
├── docker.ts        # Docker operations
├── paths.ts         # Path handling
├── logger.ts        # Logging abstraction
├── errors.ts        # Error classes
└── deps.ts          # Dependency detection
```

## Architecture: Dependency Hierarchy

The codebase follows a layered architecture. Higher layers can import from lower layers, but not vice versa.

```
CLI Layer (Orchestrators)
    |
    v
Core Services
    |
    v
Utilities
```

### Layer 1: CLI Layer (Orchestrators)

**Files:** `cli.ts`, `commands/*.ts`

- Entry points for user commands
- **Intentionally allowed to import from all lower layers**
- Coordinates between services
- Handles user input/output

The CLI layer is the "fan-in" point where multiple imports converge. This is by design - orchestrators need access to all the pieces they coordinate.

### Layer 2: Core Services

**Files:** `config.ts`, `detector.ts`, `deps.ts`, `docker.ts`, `build.ts`, `generator.ts`, `dockerfile-gen.ts`, `docker-runtime.ts`, `cleanup.ts`, `prompts.ts`

- Business logic and domain operations
- Can import from utilities and peer services
- Should not import from CLI layer

### Layer 3: Utilities

**Files:** `logger.ts`, `errors.ts`, `paths.ts`, `constants.ts`, `utils.ts`

- Low-level utilities with no business logic
- Should only import from other utilities
- Must not have circular dependencies

### Import Rules

| From Layer | Can Import From |
|------------|-----------------|
| CLI | Core Services, Utilities |
| Core Services | Utilities, Peer Services |
| Utilities | Other Utilities only |

This structure ensures testability (services work without CLI), maintainability (clear boundaries), and extensibility (new commands just orchestrate existing services).

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prefer `const` over `let`
- Named exports over default
- Custom error classes for domain errors

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with clear commit messages
4. Run all checks: `bun run typecheck && bun run lint && bun run test`
5. Push and open a PR against `main`

### PR Guidelines

- Keep changes focused and atomic
- Update documentation if behavior changes
- Add tests for new functionality
- Ensure CI passes before requesting review

## Adding a New Stack

1. Add enum value to `LanguageStack` in `src/config.ts`
2. Add stack info to `STACK_INFO`
3. Add dependency to `STACK_DEPENDENCIES`
4. Add Dockerfile generator in `src/dockerfile-gen.ts`
5. Add detection patterns in `src/detector.ts`
6. Test with a sample project

## Security

For security vulnerabilities, please see [SECURITY.md](SECURITY.md). Do not open public issues for security-related bugs.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
