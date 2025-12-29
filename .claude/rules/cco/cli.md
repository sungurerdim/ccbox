---
paths: "**/*.py"
---

# CLI Rules
*Trigger: T:CLI*

## Click Framework

- **Command-Structure**: Use command groups for organization, not nested subcommands
- **Option-Validation**: Validate options in callback or early in command logic
- **Argument-Types**: Use click.Choice, click.IntRange, click.Path for type safety
- **Output-Formatting**: Use Rich for formatted output (tables, syntax highlighting)
- **Error-Messages**: Use click.ClickException for user-facing errors, propagate with context
- **Progress-Indication**: Use Rich progress bars for long operations
- **Exit-Codes**: Use sys.exit(0) for success, sys.exit(1) for errors, meaningful codes for different failures

## Input Handling

- **Whitespace-Normalize**: Strip/normalize string inputs. Whitespace-only is usually invalid
- **Path-Validation**: Validate paths with click.Path, resolve to absolute, check access
- **Confirmation**: Require explicit confirmation (--yes flag or interactive) for destructive ops
- **Defaults-Sensible**: Provide sensible defaults for options, document all required inputs

## User Experience

- **Minimum-Friction**: Fewest steps to goal, auto-detect when safe
- **Maximum-Clarity**: Unambiguous output, progress signals for multi-step operations
- **Fast-Feedback**: Real-time output, no silent delays
- **Help-Complete**: --help shows all options with descriptions, examples for complex commands
- **Summary-Final**: End with summary showing what was done: "Changed 3 files, deployed to 2 regions"
