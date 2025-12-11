---
paths: src/ccbox/**/*.py
---
# CLI Rules

| Standard | Rule |
|----------|------|
| * Help-Examples | --help with usage for every command |
| * Exit-Codes | 0 success, non-zero with meaning |
| * Signal-Handle | SIGINT/SIGTERM graceful shutdown |
| * Output-Modes | Human default, --json for scripts |
| * Config-Precedence | env > file > args |
