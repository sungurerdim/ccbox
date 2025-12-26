---
paths: "**/test_*.py, **/tests/**/*.py, **/*_test.py"
---
# Testing Rules

## Coverage Target: 100%

- **Unit-Isolated**: Fast, deterministic unit tests
- **Mocking**: Isolate tests from external dependencies
- **Integration**: Test component interactions
- **Fixtures-Scoped**: Appropriate fixture scope (function/class/module/session)
- **Mocks-Minimal**: Mock at boundaries, not internals
- **Assertions-Clear**: One assertion concept per test
- **Names-Descriptive**: Test names describe behavior (test_X_when_Y_should_Z)
- **Parametrize-Similar**: Parametrize similar test cases
- **Cleanup-Always**: Cleanup in fixtures, not tests

## Edge Cases [MANDATORY]

- **Empty/None**: empty string, None, empty list/dict
- **Whitespace**: spaces, tabs, newlines, whitespace-only strings
- **Boundaries**: 0, 1, max, max+1, negative (if applicable)
- **Type Variations**: string vs int representations, case variations
- **State Combinations**: all valid state pairs where multiple states interact
- **Unicode**: emojis, RTL text, special characters (if string handling)
- **Property-Based**: Use hypothesis for input fuzzing on validators
- **Regression-Pattern**: Every bug fix gets a regression test
