# Project Instructions

This is the ccbox project - a secure Docker sandbox for Claude Code.

## Key Files

- `src/cli.ts` - Main CLI entry point (passthrough args to Claude CLI)
- `src/config.ts` - Stack definitions and configuration
- `src/generator.ts` - Dockerfile generation
- `src/docker-runtime.ts` - Docker run command and Claude args building
- `src/detector.ts` - Project type detection
- `src/build.ts` - Image building logic

## Development

```bash
bun run dev        # Run from source
bun run build      # Build binary
bun run test       # Run tests
```

@.claude/cco.md
