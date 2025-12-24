---
paths: "**/*.py"
---
# Python Rules

| Standard | Rule |
|----------|------|
| * Modern-Types | `str \| None` (3.10+), `list[str]` (3.9+). Avoid `Optional`, `List`, `Dict` |
| * Async-Await | async/await for I/O, avoid blocking in async context |
| * Context-Managers | `with` for resources (files, connections) |
| * F-Strings | Prefer f-strings over .format() or % |
| * Dataclasses | dataclasses/Pydantic for data containers, slots=True |
| * Exception-Chain | `raise X from Y` for chaining |
| * Pydantic-Bounds | Field(min_length=1, max_length=N) for strings |
| * Subprocess-Encoding | `encoding='utf-8', errors='replace'` in subprocess.run() |
