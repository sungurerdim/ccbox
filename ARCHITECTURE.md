# ccbox Architecture

This document describes the internal architecture and key workflows of ccbox.

## Overview

ccbox creates isolated Docker containers for running Claude Code. It handles:
1. Stack selection and image building
2. Dynamic user/permission management
3. Path translation between host and container
4. Credential and configuration forwarding

## Container User Management

### Design Goals

- Container user should match host user's UID/GID for proper file ownership
- All tools (npm, pip, git, FUSE, etc.) should work seamlessly with this user
- No permission issues when files are created/modified inside container
- Files created in container should have correct ownership on host

### Implementation

#### 1. Build-Time User Creation

During image build, a `ccbox` user is created with UID/GID 1000:

```dockerfile
# Handle existing UID/GID conflicts (e.g., eclipse-temurin has GID 1000)
RUN set -e; \
    existing_user=$(getent passwd 1000 | cut -d: -f1 || true); \
    if [ -n "$existing_user" ] && [ "$existing_user" != "ccbox" ]; then \
        userdel "$existing_user" 2>/dev/null || true; \
    fi; \
    existing_group=$(getent group 1000 | cut -d: -f1 || true); \
    if [ -n "$existing_group" ] && [ "$existing_group" != "ccbox" ]; then \
        groupdel "$existing_group" 2>/dev/null || true; \
    fi; \
    getent group ccbox >/dev/null || groupadd -g 1000 ccbox; \
    getent passwd ccbox >/dev/null || useradd -m -d /ccbox -s /bin/bash -u 1000 -g 1000 ccbox
```

This handles base images that may have existing users with UID/GID 1000.

#### 2. Runtime UID/GID Adjustment

When the container starts, the entrypoint adjusts the `ccbox` user's UID/GID to match the host user:

```bash
# Host UID/GID passed via environment variables
CCBOX_UID=<host_uid>
CCBOX_GID=<host_gid>

# Entrypoint adjusts ccbox user
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    # Update GID if different
    if [[ "$CCBOX_GID" != "1000" ]]; then
        # Remove any existing group with target GID
        if getent group "$CCBOX_GID" >/dev/null 2>&1; then
            groupdel "$(getent group "$CCBOX_GID" | cut -d: -f1)"
        fi
        groupmod -g "$CCBOX_GID" ccbox
    fi

    # Update UID if different
    if [[ "$CCBOX_UID" != "1000" ]]; then
        # Remove any existing user with target UID
        if getent passwd "$CCBOX_UID" >/dev/null 2>&1; then
            userdel "$(getent passwd "$CCBOX_UID" | cut -d: -f1)"
        fi
        usermod -u "$CCBOX_UID" ccbox
    fi
fi
```

#### 3. State Persistence: .claude.json Symlink

The entrypoint creates a symlink so Claude Code finds its onboarding state at the expected `$HOME/.claude.json` location, even when the host stores it inside `.claude/`:

```bash
# See: src/templates/entrypoint.sh (Onboarding state symlink section)
if [[ -f "/ccbox/.claude/.claude.json" && ! -e "/ccbox/.claude.json" ]]; then
    ln -sf /ccbox/.claude/.claude.json /ccbox/.claude.json
fi
```

#### 4. Plugin Cache Cleanup

On startup, the entrypoint removes orphaned plugin markers that can accumulate across container restarts:

```bash
# See: src/templates/entrypoint.sh (Clean orphaned plugin markers section)
find "/ccbox/.claude/plugins/cache" -name ".orphaned_at" -type f -exec rm -f {} +
```

#### 5. User Switching with gosu

After UID/GID adjustment, the entrypoint uses `gosu` to switch to the ccbox user:

```bash
# Use user name instead of UID:GID so HOME is properly set from /etc/passwd
export HOME=/ccbox
exec gosu ccbox "$@"
```

### Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          HOST                                    │
│  User: john (UID=1001, GID=1001)                                │
│  Project: /home/john/myproject                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ docker run
                              │ -e CCBOX_UID=1001
                              │ -e CCBOX_GID=1001
                              │ -v /home/john/myproject:/project
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CONTAINER                                 │
│                                                                  │
│  1. Entrypoint starts as root                                   │
│     │                                                           │
│     ▼                                                           │
│  2. Detect CCBOX_UID=1001, CCBOX_GID=1001                      │
│     │                                                           │
│     ▼                                                           │
│  3. groupmod -g 1001 ccbox                                     │
│     usermod -u 1001 ccbox                                      │
│     │                                                           │
│     ▼                                                           │
│  4. Setup FUSE mounts for .claude directories                  │
│     │                                                           │
│     ▼                                                           │
│  5. gosu ccbox claude ...                                      │
│     │                                                           │
│     ▼                                                           │
│  6. Claude Code runs as ccbox (UID=1001, GID=1001)             │
│     Files in /project have correct ownership                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Verification Criteria

To verify the user management is working correctly:

1. **UID/GID Match**: `id` inside container should show host user's UID/GID
2. **File Ownership**: New files created in project directory should have host user ownership
3. **Tool Access**: All development tools (npm, pip, git) should work without permission errors
4. **FUSE**: Path translation should work with the dynamic user

## FUSE Path Translation

ccbox uses FUSE (Filesystem in Userspace) to transparently translate paths between host and container.

### Purpose

Claude Code stores configurations and state in `~/.claude` directory. These paths are stored in JSON files as absolute paths. Without translation:
- Host path: `C:\Users\John\.claude`
- Container path: `/ccbox/.claude`

FUSE intercepts file operations and translates paths on-the-fly.

### Implementation

A custom FUSE binary (`ccbox-fuse`) is compiled and included in the image. It:

1. Mounts as an overlay on `.claude` directories
2. Intercepts all file read/write operations
3. For JSON files, transforms paths in content:
   - Read: Host paths → Container paths
   - Write: Container paths → Host paths

### Transformed Locations

| Location | Host Example | Container Path |
|----------|--------------|----------------|
| Global `.claude` | `C:\Users\John\.claude` | `/ccbox/.claude` |
| Project `.claude` | `/home/john/myproject/.claude` | `/project/.claude` |

## Image Layering

ccbox uses efficient Docker image layering to minimize disk usage and build time:

```
debian:bookworm-slim
    └── ccbox/base (Claude Code + common tools)
        ├── ccbox/python → ccbox/data, ccbox/ai
        ├── ccbox/web → ccbox/fullstack
        ├── ccbox/cpp → ccbox/systems, ccbox/game
        ├── ccbox/dart → ccbox/mobile
        └── ccbox/functional, ccbox/scripting, etc.

golang:latest → ccbox/go
rust:latest → ccbox/rust
eclipse-temurin:latest → ccbox/java → ccbox/jvm
```

## Security Model

### Container Isolation

- `--cap-drop=ALL`: Drop all Linux capabilities
- `--security-opt=no-new-privileges`: Prevent privilege escalation
- `--pids-limit=2048`: Fork bomb protection
- Tmpfs for `/tmp`: No disk residue

### Volume Mounts

Only specific directories are mounted:
- Project directory (read-write)
- Host `.claude` for settings (via FUSE)
- SSH agent socket (if available)

## Tool Versioning

All external tools are installed with dynamic "latest" versioning:

| Tool | Version Source |
|------|----------------|
| Claude Code | `curl install.sh \| bash -s latest` |
| git-delta | GitHub API `/releases/latest` |
| Julia | julialang.org versions.json (stable) |
| Maven | GitHub API `/releases/latest` |
| Kotlin | GitHub API `/releases/latest` |
| SwiftLint | GitHub API `/releases/latest` |

This ensures images always have the latest stable versions when rebuilt.

## Modular Architecture

ccbox uses a modular TypeScript architecture:

```
src/
├── cli.ts              # CLI entry point (Commander.js)
├── commands/
│   └── run.ts          # Main run command logic
├── config.ts           # Stack definitions, validation
├── constants.ts        # Shared constants (SSOT)
├── detector.ts         # Project type detection
├── deps.ts             # Dependency detection (55+ package managers)
├── generator.ts        # Dockerfile generation (re-exports)
│   ├── dockerfile-gen.ts   # Dockerfile content generation
│   └── docker-runtime.ts   # Runtime args & entrypoint
├── build.ts            # Image building logic
├── docker.ts           # Docker operations
├── paths.ts            # Path validation & translation
├── logger.ts           # Unified logging abstraction
├── error-handler.ts    # Exit code diagnostics & retry
├── errors.ts           # Custom error classes
├── cleanup.ts          # Container/image cleanup
└── utils.ts            # Shared utilities
```

### Logger Module

Centralized logging with level control:

```typescript
import { log, style, setLogLevel, LogLevel } from "./logger.js";

setLogLevel(LogLevel.DEBUG);  // DEBUG, INFO, WARN, ERROR, SILENT
log.info("Building image...");
log.success("Build complete");
log.dim("Skipped optional step");
console.log(style.cyan("Colored output"));
```

### Error Handler Module

Exit code diagnostics and retry logic:

```typescript
import { getExitCodeInfo, isRetryable, withRetry } from "./error-handler.js";

const info = getExitCodeInfo(137);  // { name: "OOM", suggestion: "Increase memory" }

if (isRetryable(exitCode)) {
  await withRetry(operation, shouldRetry, { maxRetries: 3 });
}
