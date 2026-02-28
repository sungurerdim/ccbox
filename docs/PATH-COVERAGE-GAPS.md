# Path Coverage Gap Analysis

Current state analysis for achieving 100% path translation coverage.

## Architecture Summary

```
Layer 1: Drive Symlinks    — kernel path resolution (/D: → /d)     — %100 coverage
Layer 2: FUSE Overlay       — VFS content transform (JSON paths)    — %100 I/O coverage on mounted dirs
Layer 3: fakepath.so        — glibc path argument interception      — defence-in-depth (~30% caller coverage)
```

**Key insight:** FUSE operates at VFS level — io_uring, direct syscalls, static binaries all pass through it. No process can bypass a FUSE mount. This makes FUSE the primary mechanism for 100% content transformation.

## Current FUSE Mount Points

| Mount | Content | Status |
|-------|---------|--------|
| `/ccbox/.claude` | Session JSONs, plans, history, file-history, projects | ✅ FUSE overlay |
| `$PWD/.claude` | Project-local config | ✅ FUSE overlay (if exists) |
| `/d/GitHub/myapp` | Project source code | ❌ Normal bind mount |

**Assessment:** All JSON/JSONL files with Windows paths live under `.claude/`. Project source code doesn't contain Windows paths. Current mount coverage is sufficient.

## Gap Analysis

### GAP-1: ext4 casefold (Case Sensitivity)

**Status:** DEFERRED (symlink workaround sufficient, requires --privileged)
**Severity:** LOW
**Impact:** Windows paths are case-insensitive (`D:\GitHub` = `D:\github`). Linux is case-sensitive. If Claude Code writes a path with different casing than what's on disk, FUSE transforms it correctly but filesystem lookup may fail.

**Solution:** Enable ext4 casefold on the container filesystem. Requires:
- Linux kernel 5.2+ (Docker Desktop uses 5.15+, OK)
- `tune2fs -O casefold /dev/sdX` + `chattr +F /target/dir`
- Must be done at image build time or container init

**Effort:** Small — entrypoint.sh change
**Risk:** Requires `--privileged` or `SYS_ADMIN` capability for tune2fs

### GAP-2: Session Index Directory Names

**Status:** FIXED (DirMap now handles bare names in JSON values)
**Severity:** HIGH → RESOLVED
**Impact:** `sessions-index.json` contains `"directory":"D--GitHub-myapp"` (bare name, no path separator prefix). Previously, `ApplyDirMap` only matched directory names after `/` or `\\`, so this bare name was not transformed. Inside the container, `Readdir` shows `-D-GitHub-myapp` (container format), creating a mismatch that would cause Claude Code session lookup to fail.

**Resolution:** `ApplyDirMap` now also matches directory names after `"` (JSON string value boundary). This ensures bare names in JSON values like `"directory":"D--GitHub-myapp"` are correctly transformed to `"directory":"-D-GitHub-myapp"` when read in the container, and reversed on write-back. Both `"path"` fields (full paths) and `"directory"` labels (bare names) are now transformed. Verified with strict E2E tests and `TestTransformSessionsIndex` unit test.

### GAP-3: Shadow Directory Merging

**Status:** ELIMINATED (FUSE handles at VFS level)
**Severity:** HIGH → RESOLVED
**Impact:** When CC creates sessions in container (using `-D-GitHub-myapp` directory name), then user runs native CC on Windows (expecting `D--GitHub-myapp`), sessions created in container must be in the native directory.

**Resolution:** FUSE already handles directory name mapping at the VFS level:
- `Lookup("-D-GitHub-myapp")` → `translatePathSegments()` → resolves to `D--GitHub-myapp` on disk
- `Readdir(projects/)` → native `D--GitHub-myapp` shown as `-D-GitHub-myapp` to container
- `Mkdir("-D-GitHub-myapp")` → creates `D--GitHub-myapp` on disk

Shadow directories cannot be created when FUSE is active, so merge logic is unnecessary. Symlink creation (which wrote to host filesystem) has been removed entirely from `entrypoint.sh`.

### GAP-4: Transform Edge Cases

**Status:** FIXED (escaped quote handling corrected)
**Severity:** MEDIUM → RESOLVED
**Impact:** `internal/fuse/transform.go` handles most patterns but has complexity warnings.

**Fixed:**
- [x] JSON strings with escaped quotes (`\"`) — `extractJSONPath` now correctly distinguishes `\\` (path separator) from `\"` (escaped quote, not a string terminator)

**Remaining (non-issues):**
- UNC path segment boundary detection — already correct with boundary checks
- Very long paths — no buffer size limit in `strings.Builder`

**Mitigation:** Two `//nolint:gocyclo` directives indicate inherent complexity. The 2-pass architecture (prefix + dirmap) is correct by design.

### GAP-5: Test Coverage

**Status:** COMPREHENSIVE (unit + integration + E2E verified)
**Severity:** CRITICAL → RESOLVED
**Impact:** Full test coverage across all layers.

**Unit/Integration tests:**
- [x] `TestTransformSessionsIndex` — sessions-index.json with strict `directory` field assertion
- [x] `TestTransformRealisticSessionBundle` — multi-file session bundle (session JSONL, plan, file-history)
- [x] `extractJSONPath` escaped quote edge case tests
- [x] `TestApplyDirMap` bare name in JSON value context (6 new sub-tests)
- [x] Round-trip tests for all path types (drive, WSL, UNC, mixed)

**E2E tests (21 tests, all passing with strict assertions):**
- [x] Container startup + FUSE mount verification
- [x] Readdir container-format names + Lookup resolution
- [x] File CRUD through FUSE (create, read, mkdir, delete, rename)
- [x] JSON path transform bidirectional (host↔container)
- [x] DirMap transform on `sessions-index.json` directory field
- [x] Multi-path JSONL with DirMap (project + config paths)
- [x] No symlinks on host filesystem
- [x] No backslash accumulation (read + write + round-trip)
- [x] Container-written JSONL correct on host (reverse transform)

**Remaining:**
- [ ] Stress: Concurrent read/write on FUSE-mounted files
- [ ] E2E: fakepath.so with real git/npm operations

### GAP-6: Missing FUSE Operations

**Status:** DEFERRED (add on-demand when specific tool fails)
**Severity:** LOW
**Impact:** Some VFS operations not implemented in FUSE handler.

| Operation | Needed for .claude/? | Risk |
|-----------|---------------------|------|
| `Mknod` | No (no device files) | None |
| `Fallocate` | No (small JSON files) | None |
| `Lseek` | Unlikely (CC reads sequentially) | Very low |
| `CopyFileRange` | Unlikely | Very low |
| `Ioctl` | No | None |

**Recommendation:** Add only if a specific tool fails due to missing operation. go-fuse v2 makes pass-through implementation trivial.

### GAP-7: Cross-Platform Session ID

**Status:** DEFERRED (non-issue: random UUIDs have negligible collision probability)
**Severity:** MEDIUM → LOW
**Impact:** Session UUIDs are generated independently by host CC and container CC. No mechanism ensures they don't collide or that they're recognized cross-platform.

**Resolution:** UUIDs are random (v4); collision probability is ~1 in 2^122. Not a practical concern.

## Priority Matrix

| Gap | Status | Resolution |
|-----|--------|------------|
| GAP-2: Session Index | RESOLVED | DirMap matches bare names in JSON values; E2E verified |
| GAP-3: Shadow Merge | RESOLVED | FUSE handles at VFS level; symlinks removed from entrypoint |
| GAP-4: Transform Edge | RESOLVED | Escaped quote fix in `extractJSONPath` |
| GAP-5: Test Coverage | IMPROVED | Integration tests added; E2E deferred (needs Docker) |
| GAP-1: ext4 casefold | DEFERRED | Requires --privileged; symlink workaround sufficient |
| GAP-6: FUSE Ops | DEFERRED | Add on-demand when specific tool fails |
| GAP-7: Session ID | DEFERRED | Non-issue (random UUIDs) |

## Answered Questions

### Q: FUSE'u tüm mount'lara genişletsek?

**Gereksiz.** Proje kaynak kodunda Windows path yok — sadece `.claude/` altındaki session JSON'larında var. Proje dizinine FUSE eklemek her `open()`/`read()`/`stat()` için kernel→userspace context switch ekler. `npm install` sırasında binlerce dosya erişimi olur — overhead fark edilir. Mevcut coverage yeterli.

### Q: fakepath tüm mount'ları kapsıyor mu?

**Evet, zaten kapsıyor.** `CCBOX_PATH_MAP` birden fazla mapping içerir:
```
D:/GitHub/myapp:/d/GitHub/myapp;C:/Users/You/.claude:/ccbox/.claude
```
Her glibc çağrısında tüm mapping'ler kontrol edilir.

### Q: FUSE her türlü işlemi yakalıyor mu?

**Evet.** FUSE VFS seviyesinde çalışır — io_uring, direct syscall, glibc, static binary fark etmez. Kernel'ın kendisi zorlar. Eksik birkaç VFS operation var (Mknod, Fallocate, Lseek, CopyFileRange, Ioctl) ama `.claude/` dizini için gerekli değil.

### Q: eBPF fakepath yerine kullanılabilir mi?

**Hayır.** 4 engel: (1) deneysel API, (2) unprivileged container'da CAP_BPF yok, (3) io_uring'i yakalayamaz, (4) production tool yok. FUSE zaten %100 I/O kapsam sağlıyor.
