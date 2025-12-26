---
paths: "**/cli.py, **/main.py, **/commands/**/*.py"
---
# CLI Rules

- **Help-Examples**: --help with usage examples
- **Exit-Codes**: 0=success, N=specific error codes
- **Signal-Handle**: Graceful SIGINT/SIGTERM handling
- **Output-Modes**: Human-readable + --json option
- **Config-Precedence**: env > file > args > defaults
- **NO_COLOR-Respect**: Check NO_COLOR env var before ANSI output, use isatty() to detect terminal
- **Unicode-Fallback**: Use ASCII alternatives for box-drawing chars when terminal encoding uncertain
- **Help-Comprehensive**: --help with examples, subcommand help
- **Error-Messages**: Clear, actionable error messages to stderr
- **Completion-Support**: Shell completion scripts (bash/zsh/fish)
- **Progress-Feedback**: Progress bars/spinners for long operations
