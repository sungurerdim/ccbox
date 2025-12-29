# Project Context

## Project Critical

**Purpose:** Secure Docker sandbox for Claude Code CLI - isolated sandbox per project

**Constraints:**
- Container isolation
- No privilege escalation
- Memory-only temp files
- Process limits
- Path validation required
- UID/GID remapping

**Invariants:**
- Project isolation fundamental
- Docker daemon must be running
- Git credentials auto-detected
- Claude settings persist on host
- File ownership match after execution

**Non-negotiables:**
- Container security isolation is non-negotiable
- No access to files outside mounted directories
- No cross-project access
- Isolation boundary cannot be relaxed

## Strategic Context

Team: Solo | Scale: Small | Data: Public | Compliance: None
Stack: Python (Click, Rich) + Docker | Type: CLI | DB: None | Rollback: Git
Maturity: Beta | Breaking: Allowed | Priority: Speed

## AI Performance

Thinking: 8K | MCP: 25K | Caching: Enabled

## Guidelines

- Self-review sufficient (solo developer)
- Simple solutions, optimize for clarity (<100 scale)
- Basic validation sufficient (public data)
- Aggressive refactors OK, establish patterns early (greenfield)
- Clean API over compatibility (breaking allowed)
- MVP mindset, ship fast (speed priority)

## Operational

Tools: ruff check --fix, ruff check + mypy src/ccbox --strict, pytest
Conventions: test_<description> snake_case, absolute imports, Google docstrings
Applicable: CLI, testing, containers

## Auto-Detected

Structure: single-repo | Hooks: none | Coverage: 100%

- [x] Linting configured (ruff + mypy)
- [ ] Pre-commit hooks
- [ ] API endpoints
- [x] Container templates (generates Dockerfiles)
- [ ] i18n setup

License: MIT
Secrets detected: no
Outdated deps: 3
