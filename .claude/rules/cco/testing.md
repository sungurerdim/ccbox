---
paths: "**/*.{test,spec}.*,**/test_*.*,**/*_test.*,**/tests/**/*"
---

# Testing Rules
*Trigger: Testing*

## Test Structure (Standard: 80%)

- **Unit-Isolated**: Fast, deterministic unit tests. Mock external dependencies
- **Integration**: Test component interactions with real (or nearly-real) dependencies
- **Coverage-80**: Minimum 80% line coverage
- **CI-on-PR**: Tests run on every PR, failures block merge

## Edge Cases [MANDATORY]

- **Empty/None**: empty string, None, empty list/dict
- **Whitespace**: spaces, tabs, newlines, whitespace-only strings
- **Boundaries**: 0, 1, max, max+1, negative (if applicable)
- **Type-Variations**: string vs int representations, case variations for strings
- **State-Combinations**: all valid state pairs where multiple states interact
- **Unicode**: emojis, RTL text, special characters (if string handling)

## Test Patterns

- **Fixtures**: Reusable, maintainable test data via pytest fixtures
- **Naming**: test_<description> snake_case format
- **Isolation**: Independent tests, reproducible results, no shared state between tests
- **Mocking**: Use pytest-mock or unittest.mock for external dependencies
- **Parametrization**: Use @pytest.mark.parametrize for multiple inputs to same test

## Assertions & Clarity

- **Specific-Assertions**: Assert exact behavior, not just "no error"
- **Message-Context**: Include assertion messages for clarity: `assert x == y, f"Expected {y}, got {x}"`
- **One-Behavior-Per-Test**: Each test validates one specific behavior
- **Arrange-Act-Assert**: Clear separation of setup, action, verification

## Critical Path E2E [For MVP]

- **End-to-End**: At least E2E test for main user workflow (create sandbox, run Claude Code, cleanup)
- **Integration**: Test Docker isolation, file mounting, permission handling
