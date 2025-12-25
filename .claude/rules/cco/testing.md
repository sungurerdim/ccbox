---
paths: "**/test_*.py,**/*_test.py,**/tests/**/*.py,**/conftest.py"
---
# Testing Rules

## Unit Testing
- **Isolation**: No shared state between tests
- **Fast-Feedback**: Tests complete in seconds
- **Mock-Boundaries**: Mock at system boundaries
- **Assertions-Clear**: One concept per test

## Coverage (100% target)
- **Threshold-Set**: Minimum coverage threshold
- **Branch-Cover**: Branch coverage, not just line
- **Exclude-Generated**: Exclude generated code
- **Trend-Track**: Track coverage trends

## Edge Case Checklist [MANDATORY]
When writing tests, always include:
- **Empty/None**: empty string, None, empty list/dict
- **Whitespace**: spaces, tabs, newlines, whitespace-only strings
- **Boundaries**: 0, 1, max, max+1, negative (if applicable)
- **Type Variations**: string vs int representations, case variations for strings
- **State Combinations**: all valid state pairs where multiple states interact
- **Unicode**: emojis, RTL text, special characters (if string handling)
