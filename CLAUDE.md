<!-- CCO_ADAPTIVE_START -->
## Strategic Context
Purpose: Secure Docker sandbox for running Claude Code CLI in isolated containers
Team: Solo | Scale: <100 | Data: Public | Compliance: None
Stack: Python (Click, Rich, Pydantic) + Docker | Type: CLI | DB: None | Rollback: Git
Maturity: Greenfield | Breaking: Allowed | Priority: Speed

## AI Performance
Thinking: 5K | MCP: 25K | Caching: Enabled

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

## Conditional Rules (auto-applied)

### Apps > CLI - T:CLI detected

| Standard | Rule |
|----------|------|
| * Help-Examples | --help with usage for every command |
| * Exit-Codes | 0 success, non-zero with meaning |
| * Signal-Handle | SIGINT/SIGTERM graceful shutdown |
| * Output-Modes | Human default, --json for scripts |
| * Config-Precedence | env > file > args |

### Testing > Standard - pytest detected

| Standard | Rule |
|----------|------|
| * Integration | Test component interactions |
| * Fixtures | Reusable, maintainable setup |
| * Coverage-80 | >80% line coverage target |
| * CI-on-PR | Tests run on every PR |
<!-- CCO_ADAPTIVE_END -->
