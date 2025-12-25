---
paths: "**/*.py"
---
# Python Rules

- **Modern-Types**: Use `str | None` (3.10+), `list[str]` (3.9+). Avoid `Optional`, `List`, `Dict` from typing
- **Async-Await**: async/await for I/O operations, avoid blocking in async context
- **Context-Managers**: Use `with` statement for resource management (files, connections)
- **Import-Order**: stdlib > third-party > local (isort compatible)
- **Exception-Chain**: Use `raise X from Y` for exception chaining
- **F-Strings**: Prefer f-strings over .format() or % formatting
- **Dataclasses**: Use dataclasses, attrs, or Pydantic for data containers. Use slots=True for memory efficiency
- **Comprehensions**: Prefer list/dict comprehensions for simple transformations
- **Pydantic-Validators**: Use `@field_validator` for custom validation, `BeforeValidator` for normalization
- **Pydantic-Bounds**: Always set Field(min_length=1, max_length=N) for strings
- **Pydantic-Strict**: Use strict=True on models for no implicit coercion where appropriate
- **Enum-StrEnum**: Use StrEnum for string enums with auto case handling
- **Match-Case**: Use match-case for complex conditionals (3.10+)
- **Walrus-Operator**: Use := for assignment expressions where it improves readability
- **Subprocess-Encoding**: Always use `encoding='utf-8', errors='replace'` in subprocess.run() for cross-platform output handling
