# Path Translation System

ccbox runs Claude Code inside a Docker container where filesystem paths differ from the host. A multi-layer translation system ensures all tools see correct paths, file contents remain valid, and sessions stay compatible across host and container environments.

## Design Principle

**Files on disk always stay in host format.** Translation happens in-flight:
- **Read:** host paths → container paths (FUSE intercepts, transforms, serves)
- **Write:** container paths → host paths (FUSE intercepts, transforms, saves)

This allows the host Claude Code and the container Claude Code to share the same `.claude` directory without conflict.

## Architecture Overview

```
┌─ HOST (Windows) ──────────────────────────────────────────────────┐
│                                                                   │
│  C:\Users\You\.claude\           ← docker -v →  /ccbox/.claude   │
│  D:\GitHub\myapp\                ← docker -v →  /d/GitHub/myapp  │
│                                                                   │
│  Files on disk contain host-format paths:                        │
│  {"cwd":"D:\\GitHub\\myapp","config":"C:\\Users\\You\\.claude"}   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                              │
                        docker run
                              │
┌─ CONTAINER (Linux) ───────────────────────────────────────────────┐
│                                                                   │
│  Layer 1: Drive Symlinks (build-time, kernel path resolution)    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ /D: → /d  (symlink)     Bun: lstat("D:/x") resolves via   │ │
│  │ /C: → /c  (all A-Z)     kernel symlink → /d/x ✓           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Layer 2: FUSE Overlay (JSON/JSONL file content transformation)  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Mounted on: /ccbox/.claude, $PWD/.claude                   │ │
│  │                                                             │ │
│  │ Read:  D:\\GitHub\\myapp → /d/GitHub/myapp                 │ │
│  │        D--GitHub-myapp  → -d-GitHub-myapp  (dirmap)        │ │
│  │                                                             │ │
│  │ Write: /d/GitHub/myapp  → D:\\GitHub\\myapp                │ │
│  │        -d-GitHub-myapp  → D--GitHub-myapp  (dirmap)        │ │
│  │                                                             │ │
│  │ Readdir: D--GitHub-myapp ↔ -d-GitHub-myapp (filesystem)   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Layer 3: fakepath.so (LD_PRELOAD, glibc syscall interception)   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ open("D:/GitHub/myapp/f") → open("/d/GitHub/myapp/f")      │ │
│  │ stat("D:/GitHub/myapp")   → stat("/d/GitHub/myapp")        │ │
│  │ (input translation only — output translation disabled)      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Applications:                                                    │
│  ┌──────────────────────┬──────────────────────────────────────┐ │
│  │ Bun (Claude Code)    │ git, npm, etc. (glibc tools)        │ │
│  │  → direct syscalls   │  → glibc calls                      │ │
│  │  → drive symlinks    │  → fakepath.so intercepts            │ │
│  │  → FUSE for content  │  → FUSE for content                  │ │
│  └──────────────────────┴──────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

## Why Three Layers?

| Caller | Path Resolution | Content Transform |
|--------|----------------|-------------------|
| **Bun** (direct syscalls, bypasses glibc) | Drive symlinks (`/D:` → `/d`) | FUSE (kernel-level VFS) |
| **git, npm, etc.** (glibc) | fakepath.so (LD_PRELOAD) | FUSE (kernel-level VFS) |
| **Any process** reading JSON/JSONL | N/A | FUSE (kernel-level VFS) |

No single mechanism can cover all cases. Bun bypasses glibc, so fakepath can't intercept its syscalls. Drive symlinks handle path resolution but can't transform file contents. FUSE operates at kernel level and catches everything, but only covers mounted directories.

## Layer 1: Drive Symlinks

**Source:** `src/dockerfile-gen.ts`

At Docker image build time:

```dockerfile
RUN bash -c 'mkdir -p /{a..z} /Users && chown ccbox:ccbox /{a..z} /Users'
RUN bash -c 'for d in {a..z}; do
    u=$(echo "$d" | LC_ALL=C tr a-z A-Z)
    ln -sf /$d /$u:
done'
```

| Created | Purpose | Example |
|---------|---------|---------|
| `/d` (directory) | Docker volume mount point | `-v D:/GitHub/myapp:/d/GitHub/myapp` |
| `/D:` (symlink → `/d`) | Bun resolves `D:/x` as `/D:/x` → `/d/x` | `lstat("D:/GitHub/myapp")` works |

**Locale safety:** Uses `LC_ALL=C` to prevent Turkish locale issues (`i` → `İ` instead of `I`).

## Layer 2: FUSE Filesystem Overlay

**Source:** `native/ccbox-fuse.c`

FUSE operates at the Linux VFS layer — all file I/O passes through it regardless of whether the caller uses glibc, direct syscalls, or io_uring.

### Setup (In-Place Overlay)

The entrypoint script (`src/generator.ts`) sets up FUSE using a bind-mount trick:

```bash
# 1. Bind-mount original directory to temp location
mount --bind /ccbox/.claude /run/ccbox-fuse/ccbox-.claude

# 2. FUSE mounts over original path, reading from temp location
ccbox-fuse -f -o source=/run/ccbox-fuse/ccbox-.claude /ccbox/.claude

# 3. Applications access /ccbox/.claude — FUSE intercepts transparently
```

**Mounted on:** `/ccbox/.claude` (global config) and `$PWD/.claude` (project config, if exists).

### Content Transformation (Two-Pass)

Both read and write use a two-pass architecture:

```
Pass 1: Path prefix replacement (CCBOX_PATH_MAP)
  C:\Users\You\.claude  ↔  /ccbox/.claude
  D:\GitHub\myapp       ↔  /d/GitHub/myapp

Pass 2: Directory name replacement (CCBOX_DIR_MAP)
  D--GitHub-myapp  ↔  -d-GitHub-myapp
```

**Read direction** (`transform_to_container_alloc` + `apply_dirmap`):

```
Disk:      "C:\\Users\\You\\.claude\\projects\\D--GitHub-myapp\\session.jsonl"
                                                ^^^^^^^^^^^^^^^^
Pass 1:    "/ccbox/.claude/projects/D--GitHub-myapp/session.jsonl"
                                    ^^^^^^^^^^^^^^^^
Pass 2:    "/ccbox/.claude/projects/-d-GitHub-myapp/session.jsonl"  ✓
```

**Write direction** (`transform_to_host_alloc` + `apply_dirmap`):

```
App:       "/ccbox/.claude/projects/-d-GitHub-myapp/session.jsonl"
                                    ^^^^^^^^^^^^^^^^
Pass 1:    "C:\\Users\\You\\.claude\\projects\\-d-GitHub-myapp\\session.jsonl"
                                               ^^^^^^^^^^^^^^^^
Pass 2:    "C:\\Users\\You\\.claude\\projects\\D--GitHub-myapp\\session.jsonl"  ✓
```

The `apply_dirmap` post-pass is a clean, independent string replacement that runs on the entire buffer after prefix transformation. It matches `/segment/` and `\\segment\\` boundaries, so it works regardless of separator style.

### Filesystem Path Translation (Directory Mapping)

FUSE also translates directory names at the filesystem level:

- **`get_source_path()`**: When container accesses `/projects/-d-GitHub-myapp/`, FUSE translates to disk path `/projects/D--GitHub-myapp/`
- **`readdir()`**: When listing `/projects/`, disk entry `D--GitHub-myapp` is presented as `-d-GitHub-myapp`

### Path Types Detected

| Type | Pattern | Example |
|------|---------|---------|
| Windows drive | `[A-Za-z]:` | `C:\Users\...`, `D:/GitHub/...` |
| UNC | `\\server\share` | `\\\\nas\\projects\\...` (JSON-escaped) |
| WSL | `/mnt/[a-z]/` | `/mnt/d/GitHub/...` |

### Performance Features

| Feature | Mechanism | Effect |
|---------|-----------|--------|
| **Kernel cache timeouts** | `ccbox_init`: `entry_timeout=30s`, `attr_timeout=30s`, `negative_timeout=15s` | Kernel caches stat/getattr results — avoids FUSE callbacks for 30s |
| **auto_cache** | `cfg->auto_cache = 1` in `ccbox_init` | Kernel invalidates page cache when file mtime/size changes |
| **Smart direct_io** | `ccbox_open`: cache hit → `keep_cache`, miss → `direct_io` | First read populates cache; subsequent reads served from kernel page cache (no FUSE callback) |
| **Read cache** (`g_rcache`) | LRU cache, 256 slots (max 4 MB/entry), keyed by path + mtime (sec+nsec) | Avoids re-reading and re-transforming on repeated reads |
| **Skip cache** (`g_scache`) | 512-slot ring buffer, keyed by path + mtime | Remembers files with no mapping patterns — avoids repeated quick-scan |
| **Negative cache** (`g_neg_cache`) | 64-entry ring buffer, 2s TTL, monotonic clock | Avoids repeated `lstat()` for non-existent files |
| **FH bit encoding** | Bit 63 of `fi->fh` stores transform flag | Avoids re-evaluating `needs_transform()` on every read/write |
| **Lazy getattr** | No file I/O on getattr; only rcache lookup | Eliminates expensive read-for-size on stat() calls |
| **Extension-only filter** | No path whitelist; `.json`/`.jsonl` extension check only | Simple, complete coverage — transform functions are no-ops on non-path content |
| **Monotonic clock** | `CLOCK_MONOTONIC_COARSE` via vDSO | Zero-syscall time reads for cache expiry |
| **Buffer overflow protection** | `WORK_PUT` macro + `work_append` helper | Safe bounds checking on all output buffer writes |

#### Cache Sizing

| Cache | Slots | Max entry size | Worst-case memory | Typical usage |
|-------|-------|---------------|-------------------|---------------|
| **RCACHE** | 256 | 4 MB | 1 GB (theoretical) | 20–50 MB |
| **SCACHE** | 512 | N/A (metadata only) | ~256 KB | ~256 KB |
| **Negative** | 64 | N/A (path only) | ~256 KB | ~256 KB |

#### Read Path (open → read)

```
ccbox_open(path):
  if needs_transform(path):
    fstat(fd) → get mtime
    rcache_lookup(path, mtime) OR scache_lookup(path, mtime)?
      → YES: fi->keep_cache = 1   (kernel page cache active)
      → NO:  fi->direct_io = 1    (bypass page cache, size unknown)

ccbox_read(path, offset, size):
  if transform file:
    1. scache hit?    → pread() passthrough (no transform needed)
    2. rcache hit?    → memcpy from cache
    3. quick_scan?    → no patterns found → scache insert + pread()
    4. full transform → rcache insert + return transformed data
```

On second open, the file is in rcache/scache → `keep_cache` is set → kernel page cache serves subsequent reads without any FUSE callback.

### Concurrency

Offset writes use `flock(LOCK_EX/LOCK_UN)` to prevent read-modify-write races.

### Trace Logging

Set `CCBOX_FUSE_TRACE` environment variable:

| Level | Shows | Use case |
|-------|-------|----------|
| `1` | Transform operations only (`[fuse:tx]` prefix) | Production debugging — which files are transformed, cache hits |
| `2` | All operations (`[fuse]` + `[fuse:tx]`) | Detailed debugging — every getattr, readdir, open, read |

```bash
# Inside container:
tail -f /run/ccbox-fuse-trace.log
```

## Layer 3: fakepath.so (LD_PRELOAD)

**Source:** `native/fakepath.c`

fakepath intercepts glibc function calls to translate **syscall path arguments** (not file contents). Active only on Windows hosts where `CCBOX_WIN_ORIGINAL_PATH` is set.

### Translation Direction

**Input only** (Windows → container). Output translation (getcwd → Windows) is disabled because Bun caches `getcwd()` at startup and then calls `lstat()` via direct syscalls. If `getcwd()` returned `D:/GitHub/x`, Bun's `lstat("D:/GitHub/x")` would fail (relative path on Linux, and direct syscalls bypass fakepath).

### Intercepted Functions

| Category | Functions |
|----------|-----------|
| **File open** | `open`, `open64`, `openat`, `openat64`, `fopen`, `fopen64`, `freopen`, `freopen64`, `creat`, `creat64` |
| **File info** | `stat`, `lstat`, `__xstat`, `__lxstat`, `access`, `faccessat`, `statx` |
| **Directory** | `chdir`, `mkdir`, `mkdirat`, `rmdir`, `opendir`, `scandir` |
| **File ops** | `unlink`, `unlinkat`, `rename`, `renameat`, `renameat2`, `truncate`, `utimensat` |
| **Links** | `readlink`, `readlinkat`, `symlink`, `symlinkat`, `link`, `linkat` |
| **Permissions** | `chmod`, `fchmodat`, `chown`, `lchown`, `fchownat` |
| **Execute** | `execve`, `execvp`, `execvpe` |
| **Path resolve** | `realpath` |

### Limitations

- **Bun bypass:** Bun uses direct syscalls — fakepath cannot intercept. Drive symlinks handle this.
- **Static binaries:** Statically linked or musl-based programs bypass LD_PRELOAD.
- **`/proc/self/cwd`:** Reading this procfs symlink is not intercepted.

## Session Bridge (Directory Name Encoding)

Claude Code encodes project paths as directory names for session storage, replacing `[:/\\.` `]` with `-`:

```
Host (Windows):    D:\GitHub\myapp  →  D--GitHub-myapp
Container (Linux): /d/GitHub/myapp  →  -d-GitHub-myapp
```

Two mechanisms keep these in sync:

| Mechanism | Layer | What it does |
|-----------|-------|-------------|
| `CCBOX_DIR_MAP` filesystem | FUSE `get_source_path` + `readdir` | Translates directory names at filesystem level |
| `CCBOX_DIR_MAP` content | FUSE `apply_dirmap` post-pass | Translates encoded names inside JSON file contents |

## Docker Mount Structure

```
docker run \
  -v D:/GitHub/myapp:/d/GitHub/myapp:rw         # Project directory
  -v C:/Users/You/.claude:/ccbox/.claude:rw      # Global Claude config
  -v C:/Users/You/.claude.json:/ccbox/.claude.json:rw  # Onboarding state (if exists)
  -w /d/GitHub/myapp                              # Working directory
  --tmpfs /tmp:rw,size=512m,noexec,nosuid,nodev   # Ephemeral temp
  --tmpfs /var/tmp:rw,size=256m,noexec,nosuid,nodev
  --tmpfs /run:rw,size=64m,mode=755               # Runtime (FUSE trace log, PID files)
  --device /dev/fuse                               # FUSE device (Linux/macOS)
  # OR --privileged                                # Windows (Docker Desktop requires it)
```

| Mount | Path | Purpose |
|-------|------|---------|
| Project | `/d/GitHub/myapp` | Source code, host-like path for session compatibility |
| Claude config | `/ccbox/.claude` | Settings, sessions, plugins — FUSE overlay applied |
| Onboarding | `/ccbox/.claude.json` | `hasCompletedOnboarding` flag |
| Temp | `/tmp` | Package manager caches (noexec tmpfs) |
| Runtime | `/run` | FUSE bind mounts, trace log, PID files |

## Environment Variables

| Variable | Set by | Used by | Example |
|----------|--------|---------|---------|
| `HOME` | docker-runtime.ts | All tools | `/ccbox` |
| `CLAUDE_CONFIG_DIR` | docker-runtime.ts | Claude Code | `/ccbox/.claude` |
| `CCBOX_PATH_MAP` | docker-runtime.ts | ccbox-fuse | `D:/GitHub/myapp:/d/GitHub/myapp;C:/Users/You/.claude:/ccbox/.claude` |
| `CCBOX_DIR_MAP` | docker-runtime.ts | ccbox-fuse | `-d-GitHub-myapp:D--GitHub-myapp` |
| `CCBOX_WIN_ORIGINAL_PATH` | docker-runtime.ts | fakepath.so | `D:/GitHub/myapp` |
| `CCBOX_FUSE_TRACE` | User | ccbox-fuse | `1` (transform only) or `2` (all) |
| `CCBOX_FUSE_EXTENSIONS` | User (optional) | ccbox-fuse | `json,jsonl,yaml` (default: `json,jsonl`) |

## Complete Round-Trip Example

Host Claude Code saves a session file:

```
Disk: C:\Users\You\.claude\projects\D--GitHub-myapp\session.jsonl
Content: {"path":"C:\\Users\\You\\.claude\\projects\\D--GitHub-myapp\\todo.json","cwd":"D:\\GitHub\\myapp"}
```

Container Claude Code reads the same file:

```
Step 1 — Filesystem path (get_source_path + dirmap):
  App requests:     /projects/-d-GitHub-myapp/session.jsonl
  FUSE translates:  /run/.../projects/D--GitHub-myapp/session.jsonl  (disk)

Step 2 — File content (transform_to_container_alloc):
  Pass 1 (prefix):  C:\\...  → /ccbox/.claude    D:\\...  → /d/GitHub/myapp
  Pass 2 (dirmap):  D--GitHub-myapp → -d-GitHub-myapp

  App receives:     {"path":"/ccbox/.claude/projects/-d-GitHub-myapp/todo.json","cwd":"/d/GitHub/myapp"}
```

Container writes back — exact reverse:

```
Step 1 — File content (transform_to_host_alloc):
  Pass 1 (prefix):  /ccbox/.claude → C:\\...    /d/GitHub/myapp → D:\\...
  Pass 2 (dirmap):  -d-GitHub-myapp → D--GitHub-myapp

Step 2 — Filesystem path (get_source_path + dirmap):
  /-d-GitHub-myapp/ → /D--GitHub-myapp/  (disk)

  Disk:             {"path":"C:\\Users\\You\\.claude\\projects\\D--GitHub-myapp\\todo.json","cwd":"D:\\GitHub\\myapp"}
```

Host format preserved. Both clients work correctly.

## Building Native Binaries

```bash
# Build both platforms (amd64 + arm64):
bash native/build.sh
```

This builds `ccbox-fuse` and `fakepath.so` for both architectures using Docker buildx. Output:

```
native/ccbox-fuse-linux-amd64
native/ccbox-fuse-linux-arm64
native/fakepath-linux-amd64.so
native/fakepath-linux-arm64.so
```

Build uses `-Wall -Werror` — zero warnings policy.
