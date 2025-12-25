---
paths: "**/cli.py,**/main.py,**/__main__.py"
---
# CLI Rules

- **Help-Examples**: --help with usage examples
- **Exit-Codes**: 0=success, N=specific error codes
- **Signal-Handle**: Graceful SIGINT/SIGTERM handling
- **Output-Modes**: Human-readable + --json option
- **Config-Precedence**: env > file > args > defaults
- **NO_COLOR-Respect**: Check NO_COLOR env var before ANSI output, use isatty() to detect terminal
- **Unicode-Fallback**: Use ASCII alternatives for box-drawing chars (╔═╗ → +--+) when terminal encoding uncertain
- **Batch-UTF8**: In .bat/.cmd files, use `chcp 65001` for UTF-8 and avoid Unicode box characters
