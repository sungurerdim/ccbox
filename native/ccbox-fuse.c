/**
 * ccbox-fuse: FUSE filesystem for transparent cross-platform path mapping
 *
 * Provides kernel-level (VFS) path transformation for JSON/JSONL file contents.
 * Works with glibc, direct syscalls, and io_uring — required because Bun bypasses glibc.
 *
 * Content transformation (two-pass):
 *   Pass 1 (CCBOX_PATH_MAP):  C:\Users\You\.claude  ↔  /ccbox/.claude
 *   Pass 2 (CCBOX_DIR_MAP):   D--GitHub-myapp       ↔  -d-GitHub-myapp
 *
 * Filesystem path translation:
 *   get_source_path(): /-d-GitHub-myapp/ → /D--GitHub-myapp/ (disk)
 *   readdir():         D--GitHub-myapp   → -d-GitHub-myapp   (container)
 *
 * Performance: read cache (LRU), negative cache, direct_io, FH bit encoding,
 *              monotonic clock, lazy getattr, extension-only filter.
 *
 * See docs/PATH-TRANSLATION.md for full architecture documentation.
 *
 * Build: gcc -Wall -Werror -O2 -o ccbox-fuse ccbox-fuse.c $(pkg-config fuse3 --cflags --libs)
 */
#define _GNU_SOURCE
#define FUSE_USE_VERSION 31
#include <fuse3/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <dirent.h>
#include <errno.h>
#include <ctype.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/file.h>
#include <time.h>

#define MAX_MAPPINGS 32
#define MAX_DIR_MAPPINGS 32
#define MAX_PATH_LEN 4096
#define MAX_EXTENSIONS 16
#define MAX_EXT_LEN 16

/* Negative dentry cache: remember ENOENT results for a short time.
 * Prevents repeated lstat() calls for files that don't exist
 * (e.g. .config.json polled every few seconds by Claude Code). */
#define NEG_CACHE_SIZE 64
#define NEG_CACHE_TTL  2  /* seconds */

typedef struct {
    char path[MAX_PATH_LEN];
    time_t expires;
} NegCacheEntry;

static NegCacheEntry g_neg_cache[NEG_CACHE_SIZE];
static unsigned int g_neg_cache_idx = 0;

/* Monotonic seconds via vDSO (no syscall overhead) */
static time_t monotonic_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC_COARSE, &ts);
    return ts.tv_sec;
}

static int neg_cache_lookup(const char *fpath) {
    time_t now = monotonic_sec();
    for (int i = 0; i < NEG_CACHE_SIZE; i++) {
        if (g_neg_cache[i].expires > now && strcmp(g_neg_cache[i].path, fpath) == 0)
            return 1;
    }
    return 0;
}

static void neg_cache_insert(const char *fpath) {
    int idx = g_neg_cache_idx++ % NEG_CACHE_SIZE;
    size_t len = strlen(fpath);
    if (len >= MAX_PATH_LEN) len = MAX_PATH_LEN - 1;
    memcpy(g_neg_cache[idx].path, fpath, len);
    g_neg_cache[idx].path[len] = '\0';
    g_neg_cache[idx].expires = monotonic_sec() + NEG_CACHE_TTL;
}

/* Invalidate neg cache entries matching a path (on create/rename) */
static void neg_cache_invalidate(const char *fpath) {
    for (int i = 0; i < NEG_CACHE_SIZE; i++) {
        if (strcmp(g_neg_cache[i].path, fpath) == 0)
            g_neg_cache[i].expires = 0;
    }
}

/* ── Read cache: transformed content cache keyed by source path + mtime ──
 * Avoids re-reading and re-transforming the same file on repeated reads.
 * LRU eviction with fixed slot count. */
#define RCACHE_SLOTS 256
#define RCACHE_MAX_SIZE (4 * 1024 * 1024)  /* don't cache files larger than 4 MB */
#define QUICK_SCAN_SIZE    (64 * 1024)           /* bytes to scan for early exit */
#define TRANSFORM_HEADROOM (4 * 1024 * 1024)   /* max extra bytes from path expansion */

typedef struct {
    char     path[MAX_PATH_LEN];   /* source (fpath) */
    time_t   mtime_sec;            /* st_mtim.tv_sec at cache time */
    long     mtime_nsec;           /* st_mtim.tv_nsec at cache time */
    char    *data;                 /* transformed content (malloc'd) */
    size_t   len;                  /* transformed length */
    unsigned long  seq;            /* access sequence for LRU */
} RCacheEntry;

static RCacheEntry g_rcache[RCACHE_SLOTS];
static unsigned long g_rcache_seq = 0;

/* Lookup: returns entry pointer if hit (and bumps seq), else NULL */
static RCacheEntry *rcache_lookup(const char *fpath, time_t mtime_sec, long mtime_nsec) {
    for (int i = 0; i < RCACHE_SLOTS; i++) {
        if (g_rcache[i].data && g_rcache[i].mtime_sec == mtime_sec &&
            g_rcache[i].mtime_nsec == mtime_nsec &&
            strcmp(g_rcache[i].path, fpath) == 0) {
            g_rcache[i].seq = ++g_rcache_seq;
            return &g_rcache[i];
        }
    }
    return NULL;
}

/* Insert: stores transformed data, evicting LRU slot */
static void rcache_insert(const char *fpath, time_t mtime_sec, long mtime_nsec, const char *data, size_t len) {
    if (len > RCACHE_MAX_SIZE) return;  /* don't cache huge files */
    /* Find LRU slot */
    int lru = 0;
    unsigned long min_seq = g_rcache[0].seq;
    for (int i = 1; i < RCACHE_SLOTS; i++) {
        if (!g_rcache[i].data) { lru = i; break; }
        if (g_rcache[i].seq < min_seq) { min_seq = g_rcache[i].seq; lru = i; }
    }
    free(g_rcache[lru].data);
    size_t plen = strlen(fpath);
    if (plen >= MAX_PATH_LEN) plen = MAX_PATH_LEN - 1;
    memcpy(g_rcache[lru].path, fpath, plen);
    g_rcache[lru].path[plen] = '\0';
    g_rcache[lru].mtime_sec = mtime_sec;
    g_rcache[lru].mtime_nsec = mtime_nsec;
    g_rcache[lru].data = malloc(len);
    if (g_rcache[lru].data) {
        memcpy(g_rcache[lru].data, data, len);
        g_rcache[lru].len = len;
    }
    g_rcache[lru].seq = ++g_rcache_seq;
}

/* Invalidate all cache entries for a given source path */
static void rcache_invalidate(const char *fpath) {
    for (int i = 0; i < RCACHE_SLOTS; i++) {
        if (g_rcache[i].data && strcmp(g_rcache[i].path, fpath) == 0) {
            free(g_rcache[i].data);
            g_rcache[i].data = NULL;
        }
    }
}

/* ── Skip cache: remember files where quick-scan found no mapping patterns ──
 * Avoids repeated 64KB pread on files that don't need transform.
 * Keyed by source path + mtime — invalidated on write like rcache. */
#define SCACHE_SLOTS 512

typedef struct {
    char   path[MAX_PATH_LEN];
    time_t mtime_sec;
    long   mtime_nsec;
    int    active;
} SCacheEntry;

static SCacheEntry g_scache[SCACHE_SLOTS];

static int scache_lookup(const char *fpath, time_t mtime_sec, long mtime_nsec) {
    for (int i = 0; i < SCACHE_SLOTS; i++) {
        if (g_scache[i].active && g_scache[i].mtime_sec == mtime_sec &&
            g_scache[i].mtime_nsec == mtime_nsec &&
            strcmp(g_scache[i].path, fpath) == 0)
            return 1;
    }
    return 0;
}

static void scache_insert(const char *fpath, time_t mtime_sec, long mtime_nsec) {
    /* Find empty or reuse oldest (simple round-robin) */
    static unsigned int s_idx = 0;
    int slot = -1;
    for (int i = 0; i < SCACHE_SLOTS; i++) {
        if (!g_scache[i].active) { slot = i; break; }
    }
    if (slot < 0) slot = s_idx++ % SCACHE_SLOTS;
    size_t plen = strlen(fpath);
    if (plen >= MAX_PATH_LEN) plen = MAX_PATH_LEN - 1;
    memcpy(g_scache[slot].path, fpath, plen);
    g_scache[slot].path[plen] = '\0';
    g_scache[slot].mtime_sec = mtime_sec;
    g_scache[slot].mtime_nsec = mtime_nsec;
    g_scache[slot].active = 1;
}

static void scache_invalidate(const char *fpath) {
    for (int i = 0; i < SCACHE_SLOTS; i++) {
        if (g_scache[i].active && strcmp(g_scache[i].path, fpath) == 0)
            g_scache[i].active = 0;
    }
}

/* Configurable file extension filter for content transformation.
 * Set via CCBOX_FUSE_EXTENSIONS env var (comma-separated, e.g. "json,jsonl,yaml")
 * Defaults to json,jsonl if not set. */
static char g_extensions[MAX_EXTENSIONS][MAX_EXT_LEN];
static int g_extension_count = 0;

/* Trace logging levels (CCBOX_FUSE_TRACE env var):
 *   0 = off (default)
 *   1 = only transform-relevant operations (needs_transform paths, cache hits/misses)
 *   2 = all operations (verbose, includes every getattr/readdir/open)
 * Writes to /run/ccbox-fuse-trace.log for easy monitoring:
 *   docker exec <container> tail -f /run/ccbox-fuse-trace.log
 */
static FILE *g_trace_fp = NULL;
static int g_trace = 0;
#define TRACE(fmt, ...) do { if (g_trace >= 2 && g_trace_fp) { fprintf(g_trace_fp, "[fuse] " fmt "\n", ##__VA_ARGS__); fflush(g_trace_fp); } } while(0)
#define TRACE_TX(fmt, ...) do { if (g_trace >= 1 && g_trace_fp) { fprintf(g_trace_fp, "[fuse:tx] " fmt "\n", ##__VA_ARGS__); fflush(g_trace_fp); } } while(0)

typedef struct {
    char *from, *to;
    size_t from_len, to_len;
    char drive;   /* lowercase drive letter for case-insensitive comparison */
    int is_unc, is_wsl;
} PathMapping;

/* Directory name mapping for session bridge (container encoding <-> native encoding) */
typedef struct {
    char *container_name;  /* e.g. -d-GitHub-ccbox (container sees /d/GitHub/ccbox) */
    char *native_name;     /* e.g. D--GitHub-ccbox (Windows native encoding) */
    size_t container_len, native_len;
} DirMapping;

static char *source_dir = NULL;
static PathMapping mappings[MAX_MAPPINGS];
static int mapping_count = 0;
static DirMapping dir_mappings[MAX_DIR_MAPPINGS];
static int dir_mapping_count = 0;

static char *normalize_path(const char *path) {
    if (!path) return NULL;
    char *norm = strdup(path);
    if (!norm) return NULL;
    for (char *p = norm; *p; p++) if (*p == '\\') *p = '/';
    /* Preserve original case — drive letter case kept as-is */
    size_t len = strlen(norm);
    while (len > 1 && norm[len-1] == '/') norm[--len] = '\0';
    return norm;
}

static void parse_extensions(const char *ext_env) {
    if (!ext_env || !*ext_env) {
        /* Defaults: json, jsonl */
        strcpy(g_extensions[0], ".json");
        strcpy(g_extensions[1], ".jsonl");
        g_extension_count = 2;
        return;
    }
    char *copy = strdup(ext_env);
    if (!copy) return;
    char *saveptr = NULL, *tok = strtok_r(copy, ",", &saveptr);
    while (tok && g_extension_count < MAX_EXTENSIONS) {
        /* Strip whitespace */
        while (*tok == ' ') tok++;
        size_t len = strlen(tok);
        while (len > 0 && tok[len-1] == ' ') tok[--len] = '\0';
        if (len > 0 && len < MAX_EXT_LEN - 1) {
            if (tok[0] == '.') {
                snprintf(g_extensions[g_extension_count], MAX_EXT_LEN, "%s", tok);
            } else {
                snprintf(g_extensions[g_extension_count], MAX_EXT_LEN, ".%s", tok);
            }
            g_extension_count++;
        }
        tok = strtok_r(NULL, ",", &saveptr);
    }
    free(copy);
}

/* Quick-scan: read first 64KB of a file and check if any mapping patterns exist.
 * Returns 1 if patterns found (transform needed), 0 if not (passthrough).
 * This avoids malloc+transform on large files that contain no relevant paths. */
static int quick_scan_has_mappings(int fd) {
    char sbuf[QUICK_SCAN_SIZE];
    ssize_t n = pread(fd, sbuf, QUICK_SCAN_SIZE, 0);
    if (n <= 0) return 0;

    /* Check path mappings: drive letters, /ccbox/ (to pattern), /mnt/ (WSL) */
    for (int m = 0; m < mapping_count; m++) {
        /* Search for drive letter pattern (e.g. "C:" or "c:") */
        if (mappings[m].drive && !mappings[m].is_unc && !mappings[m].is_wsl) {
            char upper = toupper(mappings[m].drive), lower = mappings[m].drive;
            for (ssize_t i = 0; i < n - 1; i++) {
                if ((sbuf[i] == upper || sbuf[i] == lower) && sbuf[i+1] == ':')
                    return 1;
            }
        }
        /* Search for "to" pattern (container path like /ccbox/) */
        if (mappings[m].to && mappings[m].to_len > 0 && mappings[m].to_len <= (size_t)n) {
            if (memmem(sbuf, n, mappings[m].to, mappings[m].to_len))
                return 1;
        }
        /* Search for WSL /mnt/ prefix */
        if (mappings[m].is_wsl && n >= 5) {
            if (memmem(sbuf, n, "/mnt/", 5))
                return 1;
        }
        /* Search for UNC \\\\ prefix */
        if (mappings[m].is_unc && n >= 2) {
            if (memmem(sbuf, n, "\\\\", 2))
                return 1;
        }
    }
    /* Check dir mappings */
    for (int m = 0; m < dir_mapping_count; m++) {
        if (memmem(sbuf, n, dir_mappings[m].native_name, dir_mappings[m].native_len))
            return 1;
        if (memmem(sbuf, n, dir_mappings[m].container_name, dir_mappings[m].container_len))
            return 1;
    }
    return 0;
}

/* Determine if a file needs content transformation.
 * Any file with a matching extension (.json, .jsonl, etc.) gets transformed.
 * The transform functions themselves only modify absolute paths (drive letters,
 * UNC, WSL) — relative paths and non-path content pass through unchanged.
 * No whitelist needed: extension match is the sole filter. */
static int needs_transform(const char *path) {
    if (!path || mapping_count == 0 || g_extension_count == 0) return 0;
    const char *dot = strrchr(path, '.');
    if (!dot) return 0;
    for (int i = 0; i < g_extension_count; i++) {
        if (strcasecmp(dot, g_extensions[i]) == 0) return 1;
    }
    return 0;
}

static int get_source_path(char *dest, const char *path, size_t destsize) {
    int n;
    if (dir_mapping_count > 0 && path && path[0] == '/') {
        /* Check each path segment for container_name -> native_name translation.
         * Session paths use encoded dir names at various depths
         * (e.g. /projects/-d-GitHub-ccbox/session.jsonl). */
        char translated[MAX_PATH_LEN];
        size_t ti = 0;
        const char *p = path;

        while (*p && ti < MAX_PATH_LEN - 1) {
            if (*p == '/') {
                translated[ti++] = *p++;
                /* Check if the segment after '/' matches a container_name */
                int matched = 0;
                for (int m = 0; m < dir_mapping_count && !matched; m++) {
                    size_t clen = dir_mappings[m].container_len;
                    if (strncmp(p, dir_mappings[m].container_name, clen) == 0 &&
                        (p[clen] == '/' || p[clen] == '\0')) {
                        /* Replace container_name with native_name */
                        size_t nlen = dir_mappings[m].native_len;
                        if (ti + nlen < MAX_PATH_LEN) {
                            memcpy(translated + ti, dir_mappings[m].native_name, nlen);
                            ti += nlen;
                            p += clen;
                            matched = 1;
                        }
                    }
                }
            } else {
                translated[ti++] = *p++;
            }
        }
        translated[ti] = '\0';
        n = snprintf(dest, destsize, "%s%s", source_dir, translated);
    } else {
        n = snprintf(dest, destsize, "%s%s", source_dir, path);
    }
    if (n < 0 || (size_t)n >= destsize) return -ENAMETOOLONG;
    return 0;
}

/* Extract a path from JSON content at position ti, normalizing separators.
 * Reads until JSON delimiter (", comma, }, ]) or end of buffer.
 * Handles JSON-escaped backslashes (\\) and forward slashes. */
static size_t extract_json_path(const char *buf, size_t len, size_t ti, char *pathbuf, size_t pathbuf_size) {
    size_t pi = 0;
    while (ti < len && buf[ti] != '"' && buf[ti] != ',' && buf[ti] != '}' && buf[ti] != ']' && pi < pathbuf_size - 1) {
        if (buf[ti] == '\\') {
            pathbuf[pi++] = '/'; ti++;
            if (ti < len && buf[ti] == '\\') ti++; /* skip second backslash in JSON escape */
        } else {
            pathbuf[pi++] = buf[ti++];
        }
    }
    pathbuf[pi] = '\0';
    return ti;  /* return updated position */
}

/* Buffer overflow helpers for transform functions */
#define WORK_PUT(c) do { if (wi >= alloc - 1) goto overflow; work[wi++] = (c); } while(0)

static inline int work_append(char *work, size_t *wi, size_t alloc, const char *src, size_t n) {
    if (*wi + n >= alloc) return -1;
    memcpy(work + *wi, src, n);
    *wi += n;
    return 0;
}

/* Post-pass: apply dir_mapping string replacements to an already-transformed buffer.
 * Replaces "/find/" or "/find\0" occurrences with "/repl/" or "/repl\0".
 * to_container=1: native_name → container_name (read direction)
 * to_container=0: container_name → native_name (write direction)
 * Returns new malloc'd buffer (caller frees), or NULL if no changes made. */
static char *apply_dirmap(const char *buf, size_t len, size_t *newlen, int to_container) {
    if (dir_mapping_count == 0 || !buf || len == 0) { *newlen = len; return NULL; }

    size_t alloc = len + 256;
    for (int m = 0; m < dir_mapping_count; m++) {
        size_t diff = to_container ?
            (dir_mappings[m].container_len > dir_mappings[m].native_len ?
             dir_mappings[m].container_len - dir_mappings[m].native_len : 0) :
            (dir_mappings[m].native_len > dir_mappings[m].container_len ?
             dir_mappings[m].native_len - dir_mappings[m].container_len : 0);
        alloc += diff * 8; /* generous margin for multiple occurrences */
    }

    char *out = malloc(alloc);
    if (!out) { *newlen = len; return NULL; }
    size_t oi = 0, i = 0;
    int any = 0;

    while (i < len) {
        /* Look for "/segment" boundary (also match "\\segment" for JSON-escaped backslashes) */
        int is_sep = (buf[i] == '/') ||
                     (buf[i] == '\\' && i + 1 < len && buf[i+1] == '\\');
        if (is_sep) {
            size_t sep_len = (buf[i] == '/') ? 1 : 2;
            /* Try each dir_mapping */
            int matched = 0;
            for (int m = 0; m < dir_mapping_count && !matched; m++) {
                const char *find = to_container ? dir_mappings[m].native_name : dir_mappings[m].container_name;
                size_t find_len  = to_container ? dir_mappings[m].native_len  : dir_mappings[m].container_len;
                const char *repl = to_container ? dir_mappings[m].container_name : dir_mappings[m].native_name;
                size_t repl_len  = to_container ? dir_mappings[m].container_len  : dir_mappings[m].native_len;

                size_t after = i + sep_len;
                if (after + find_len <= len &&
                    strncmp(buf + after, find, find_len) == 0) {
                    /* Check boundary: next char must be separator, quote, or end */
                    char next = (after + find_len < len) ? buf[after + find_len] : '\0';
                    if (next == '\0' || next == '/' || next == '\\' || next == '"' ||
                        next == ',' || next == '}' || next == ']') {
                        /* Copy separator as-is */
                        if (oi + sep_len + repl_len >= alloc) { free(out); *newlen = len; return NULL; }
                        memcpy(out + oi, buf + i, sep_len);
                        oi += sep_len;
                        memcpy(out + oi, repl, repl_len);
                        oi += repl_len;
                        i = after + find_len;
                        matched = 1;
                        any = 1;
                    }
                }
            }
            if (!matched) {
                if (oi >= alloc - 1) { free(out); *newlen = len; return NULL; }
                out[oi++] = buf[i++];
            }
        } else {
            if (oi >= alloc - 1) { free(out); *newlen = len; return NULL; }
            out[oi++] = buf[i++];
        }
    }
    out[oi] = '\0';
    if (!any) { free(out); *newlen = len; return NULL; }
    *newlen = oi;
    return out;
}

/* Transform Windows/WSL/UNC paths in JSON content to Linux paths.
 * Only absolute paths are matched (drive letter C:, UNC \\, WSL /mnt/).
 * Relative paths (./foo, ../bar, node_modules/x) pass through unchanged. */
static char *transform_to_container_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocation: each byte can expand by max_growth (to_len - from_len) at most,
     * but only at mapping boundaries. Use conservative formula. */
    size_t max_growth = 0;
    for (int m = 0; m < mapping_count; m++) {
        size_t g = mappings[m].to_len > mappings[m].from_len ?
                   mappings[m].to_len - mappings[m].from_len : 0;
        if (g > max_growth) max_growth = g;
    }
    size_t alloc = len + TRANSFORM_HEADROOM;
    char *work = malloc(alloc);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;
    while (i < len && buf[i]) {
        int matched = 0;

        /* === Case 1: Drive letter pattern (C: or D:) === */
        if (i + 2 < len && isalpha(buf[i]) && buf[i+1] == ':') {
            char drive = tolower(buf[i]);
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].drive == drive && !mappings[m].is_unc && !mappings[m].is_wsl) {
                    char pathbuf[MAX_PATH_LEN];
                    size_t ti = extract_json_path(buf, len, i + 2, pathbuf, MAX_PATH_LEN);
                    /* from is like "c:/Users/Sungur/.claude", skip drive prefix "c:" */
                    const char *from_path = mappings[m].from + 2;
                    size_t from_path_len = mappings[m].from_len - 2;
                    if (strncmp(pathbuf, from_path, from_path_len) == 0) {
                        if (work_append(work, &wi, alloc, mappings[m].to, mappings[m].to_len)) goto overflow;
                        const char *remainder = pathbuf + from_path_len;
                        size_t rem_len = strlen(remainder);
                        if (work_append(work, &wi, alloc, remainder, rem_len)) goto overflow;
                        i = ti;
                        matched = 1;
                        any_transform = 1;
                    }
                }
            }
        }

        /* === Case 2: UNC path (\\server\share or \\\\server\\share in JSON) === */
        if (!matched && i + 1 < len && buf[i] == '\\' && buf[i+1] == '\\') {
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].is_unc) {
                    char pathbuf[MAX_PATH_LEN];
                    /* UNC: from is "//server/share/...", content has \\server\share or \\\\server\\share */
                    size_t ti = extract_json_path(buf, len, i, pathbuf, MAX_PATH_LEN);
                    /* pathbuf now has //server/share/... (normalized) */
                    if (strncmp(pathbuf, mappings[m].from, mappings[m].from_len) == 0) {
                        if (work_append(work, &wi, alloc, mappings[m].to, mappings[m].to_len)) goto overflow;
                        const char *remainder = pathbuf + mappings[m].from_len;
                        size_t rem_len = strlen(remainder);
                        if (work_append(work, &wi, alloc, remainder, rem_len)) goto overflow;
                        i = ti;
                        matched = 1;
                        any_transform = 1;
                    }
                }
            }
        }

        /* === Case 3: WSL path (/mnt/d/...) === */
        if (!matched && i + 6 < len && buf[i] == '/' && buf[i+1] == 'm' &&
            buf[i+2] == 'n' && buf[i+3] == 't' && buf[i+4] == '/' && isalpha(buf[i+5])) {
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].is_wsl) {
                    /* Check if the WSL path prefix matches */
                    if (i + mappings[m].from_len <= len &&
                        strncmp(buf + i, mappings[m].from, mappings[m].from_len) == 0) {
                        char next = (i + mappings[m].from_len < len) ? buf[i + mappings[m].from_len] : '\0';
                        if (next == '\0' || next == '/' || next == '"' || next == ',' || next == '}') {
                            if (work_append(work, &wi, alloc, mappings[m].to, mappings[m].to_len)) goto overflow;
                            i += mappings[m].from_len;
                            /* Copy remainder */
                            while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isspace(buf[i])) {
                                WORK_PUT(buf[i++]);
                            }
                            matched = 1;
                            any_transform = 1;
                        }
                    }
                }
            }
        }

        if (!matched) { WORK_PUT(buf[i++]); }
    }
    work[wi] = '\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }

    /* Post-pass: apply dir_mapping (native_name → container_name) */
    size_t dm_len;
    char *dm_result = apply_dirmap(work, wi, &dm_len, 1);
    if (dm_result) { free(work); *newlen = dm_len; return dm_result; }

    *newlen = wi;
    return work;

overflow:
    free(work);
    *newlen = len;
    return NULL;
}

/* Transform Linux paths in JSON content back to original host paths (reverse transform for writes) */
/* Uses from_original to preserve exact original case (e.g. C: not c:) */
static char *transform_to_host_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocation: path expansion adds at most TRANSFORM_HEADROOM bytes
     * (each match expands by ~2x of mapping length, but matches are sparse) */
    size_t alloc = len + TRANSFORM_HEADROOM;
    char *work = malloc(alloc);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;

    while (i < len) {
        int matched = 0;
        /* Check for Linux path that matches a mapping's "to" path */
        for (int m = 0; m < mapping_count && !matched; m++) {
            size_t to_len = mappings[m].to_len;
            if (i + to_len <= len && strncmp(buf + i, mappings[m].to, to_len) == 0) {
                /* Check it's a proper path boundary */
                char next = (i + to_len < len) ? buf[i + to_len] : '\0';
                if (next == '\0' || next == '/' || next == '"' || next == ',' || next == '}' || next == ']') {
                    /* from preserves original case (normalize_path doesn't change case) */
                    const char *from = mappings[m].from;
                    size_t from_len = mappings[m].from_len;
                    int use_backslash = (from_len >= 2 && from[1] == ':'); /* Windows drive path */
                    int is_unc_orig = (from_len >= 2 && from[0] == '/' && from[1] == '/');

                    /* Write the original host path with JSON-escaped backslashes (for Windows/UNC) */
                    for (size_t j = 0; j < from_len; j++) {
                        if (from[j] == '/' && (use_backslash || is_unc_orig)) {
                            WORK_PUT('\\');
                            WORK_PUT('\\');
                        } else {
                            WORK_PUT(from[j]);
                        }
                    }
                    i += to_len;
                    matched = 1;
                    any_transform = 1;

                    /* Copy remainder path with same separator style */
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isspace(buf[i])) {
                        if (buf[i] == '/' && (use_backslash || is_unc_orig)) {
                            WORK_PUT('\\');
                            WORK_PUT('\\');
                        } else {
                            WORK_PUT(buf[i]);
                        }
                        i++;
                    }
                }
            }
        }
        if (!matched) { WORK_PUT(buf[i++]); }
    }
    work[wi] = '\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }

    /* Post-pass: apply dir_mapping (container_name → native_name) */
    size_t dm_len;
    char *dm_result = apply_dirmap(work, wi, &dm_len, 0);
    if (dm_result) { free(work); *newlen = dm_len; return dm_result; }

    *newlen = wi;
    return work;

overflow:
    free(work);
    *newlen = len;
    return NULL;
}

static int ccbox_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void)fi;
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) { TRACE("getattr FAIL path=%s rc=%d", path, rc); return rc; }
    /* Check negative cache before hitting filesystem */
    if (neg_cache_lookup(fpath)) { TRACE("getattr NEGCACHE path=%s", path); return -ENOENT; }
    if (lstat(fpath, stbuf) == -1) {
        int e = errno;
        if (e == ENOENT) neg_cache_insert(fpath);
        TRACE("getattr ENOENT path=%s fpath=%s", path, fpath);
        return -e;
    }
    TRACE("getattr path=%s fpath=%s size=%ld", path, fpath, (long)stbuf->st_size);
    /* With direct_io enabled for transform files, kernel doesn't rely on st_size
     * for read operations. Only update st_size if we already have the result cached
     * (zero cost). No file I/O on getattr — transform happens lazily on read(). */
    if (S_ISREG(stbuf->st_mode) && needs_transform(path) && stbuf->st_size > 0) {
        RCacheEntry *ce = rcache_lookup(fpath, stbuf->st_mtim.tv_sec, stbuf->st_mtim.tv_nsec);
        if (ce) {
            stbuf->st_size = ce->len;
            TRACE_TX("getattr RCACHE hit path=%s len=%zu", path, ce->len);
        }
    }
    return 0;
}

static int ccbox_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    DIR *dp = opendir(fpath);
    if (!dp) { TRACE("readdir FAIL path=%s fpath=%s", path, fpath); return -errno; }
    TRACE("readdir path=%s fpath=%s", path, fpath);
    struct dirent *de;
    while ((de = readdir(dp))) {
        struct stat st = {0};
        st.st_ino = de->d_ino;
        st.st_mode = de->d_type << 12;
        /* Reverse translate: native_name -> container_name for readdir */
        const char *name = de->d_name;
        int skip = 0;
        for (int m = 0; m < dir_mapping_count; m++) {
            if (strcmp(de->d_name, dir_mappings[m].native_name) == 0) {
                name = dir_mappings[m].container_name;
                TRACE("readdir dirmap: %s -> %s", de->d_name, name);
                break;
            }
            /* Skip literal container_name entries that would duplicate a translated native entry */
            if (strcmp(de->d_name, dir_mappings[m].container_name) == 0) {
                /* Check if the native_name dir also exists on disk */
                char native_path[MAX_PATH_LEN];
                snprintf(native_path, sizeof(native_path), "%s/%s", fpath, dir_mappings[m].native_name);
                struct stat ns;
                if (lstat(native_path, &ns) == 0 && S_ISDIR(ns.st_mode)) {
                    TRACE("readdir dedup: skipping literal %s (native %s exists)", de->d_name, dir_mappings[m].native_name);
                    skip = 1;
                }
                break;
            }
        }
        if (skip) continue;
        if (filler(buf, name, &st, 0, 0)) break;
    }
    closedir(dp);
    return 0;
}

/* Encode transform flag in fi->fh bit 63 to avoid repeated needs_transform() calls */
#define FH_TRANSFORM_BIT  ((uint64_t)1 << 63)
#define FH_FD(fh)         ((int)((fh) & ~FH_TRANSFORM_BIT))
#define FH_NEEDS_TRANSFORM(fh) (!!((fh) & FH_TRANSFORM_BIT))

static int ccbox_open(const char *path, struct fuse_file_info *fi) {
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) { TRACE("open FAIL path=%s rc=%d", path, rc); return rc; }
    int fd = open(fpath, fi->flags);
    if (fd == -1) { TRACE("open ENOENT path=%s fpath=%s", path, fpath); return -errno; }
    TRACE("open path=%s fpath=%s fd=%d", path, fpath, fd);
    fi->fh = (uint64_t)fd;
    if (needs_transform(path)) {
        fi->fh |= FH_TRANSFORM_BIT;
        /* Smart direct_io: if content is already cached (rcache/scache), enable
         * kernel page cache via keep_cache for fast repeated reads. Otherwise
         * use direct_io to avoid st_size mismatch truncating transformed content. */
        struct stat st;
        if (fstat(fd, &st) == 0) {
            char fp[MAX_PATH_LEN];
            if (get_source_path(fp, path, sizeof(fp)) == 0 &&
                (rcache_lookup(fp, st.st_mtim.tv_sec, st.st_mtim.tv_nsec) ||
                 scache_lookup(fp, st.st_mtim.tv_sec, st.st_mtim.tv_nsec))) {
                fi->keep_cache = 1;
                TRACE_TX("open TRANSFORM keep_cache path=%s fd=%d", path, fd);
            } else {
                fi->direct_io = 1;
                TRACE_TX("open TRANSFORM direct_io path=%s fd=%d", path, fd);
            }
        } else {
            fi->direct_io = 1;
            TRACE_TX("open TRANSFORM direct_io(fallback) path=%s fd=%d", path, fd);
        }
    }
    return 0;
}

static int ccbox_read(const char *path, char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    TRACE("read path=%s size=%zu offset=%ld", path, size, (long)offset);
    int fd = FH_FD(fi->fh);
    if (FH_NEEDS_TRANSFORM(fi->fh)) {
        struct stat st;
        if (fstat(fd, &st) == -1) return -errno;
        size_t filesize = st.st_size;
        if (filesize == 0) return 0;

        /* Check read cache and skip cache */
        char fpath[MAX_PATH_LEN];
        int rc = get_source_path(fpath, path, sizeof(fpath));
        if (rc == 0) {
            /* Skip cache: file previously found to have no mapping patterns */
            if (scache_lookup(fpath, st.st_mtim.tv_sec, st.st_mtim.tv_nsec)) {
                TRACE_TX("read SCACHE hit path=%s size=%zu", path, filesize);
                ssize_t res = pread(fd, buf, size, offset);
                return res == -1 ? -errno : res;
            }
            RCacheEntry *ce = rcache_lookup(fpath, st.st_mtim.tv_sec, st.st_mtim.tv_nsec);
            if (ce) {
                TRACE_TX("read RCACHE hit path=%s len=%zu offset=%ld", path, ce->len, (long)offset);
                if ((size_t)offset >= ce->len) return 0;
                size_t tocopy = ce->len - offset;
                if (tocopy > size) tocopy = size;
                memcpy(buf, ce->data + offset, tocopy);
                return tocopy;
            }
        }

        /* Quick-scan: check if file contains any mapping patterns before allocating */
        if (!quick_scan_has_mappings(fd)) {
            TRACE_TX("read QUICK-SCAN-SKIP path=%s size=%zu", path, filesize);
            if (rc == 0) scache_insert(fpath, st.st_mtim.tv_sec, st.st_mtim.tv_nsec);
            ssize_t res = pread(fd, buf, size, offset);
            return res == -1 ? -errno : res;
        }

        char *filebuf = malloc(filesize + 1);
        if (!filebuf) return -ENOMEM;
        ssize_t nread = pread(fd, filebuf, filesize, 0);
        if (nread == -1) { free(filebuf); return -errno; }
        filebuf[nread] = '\0';

        /* Transform paths - may return new buffer if transform happened */
        size_t newlen;
        char *transformed = transform_to_container_alloc(filebuf, nread, &newlen);
        char *result = transformed ? transformed : filebuf;
        size_t resultlen = transformed ? newlen : (size_t)nread;

        /* Cache the result */
        if (rc == 0) rcache_insert(fpath, st.st_mtim.tv_sec, st.st_mtim.tv_nsec, result, resultlen);

        if ((size_t)offset >= resultlen) {
            if (transformed) free(transformed);
            free(filebuf);
            return 0;
        }
        size_t tocopy = resultlen - offset;
        if (tocopy > size) tocopy = size;
        memcpy(buf, result + offset, tocopy);
        if (transformed) free(transformed);
        free(filebuf);
        return tocopy;
    }
    ssize_t res = pread(fd, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_write(const char *path, const char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    int fd = FH_FD(fi->fh);
    /* Invalidate read cache and skip cache on write */
    { char fp[MAX_PATH_LEN]; if (get_source_path(fp, path, sizeof(fp)) == 0) { rcache_invalidate(fp); scache_invalidate(fp); } }
    if (FH_NEEDS_TRANSFORM(fi->fh)) {
        /* For JSON files, transform Linux paths back to Windows paths */
        size_t newlen;
        char *transformed = transform_to_host_alloc(buf, size, &newlen);
        if (transformed) {
            /* Write transformed content - handle offset by reading existing, merging, writing */
            if (offset == 0) {
                /* Simple case: writing from beginning */
                ssize_t res = pwrite(fd, transformed, newlen, 0);
                /* Truncate file to new size in case new content is shorter */
                if (res >= 0) ftruncate(fd, newlen);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            } else {
                /* Complex case: writing at offset - need to merge with existing content */
                /* Lock to prevent read-modify-write race */
                flock(fd, LOCK_EX);
                struct stat st;
                if (fstat(fd, &st) == -1) { flock(fd, LOCK_UN); free(transformed); return -errno; }
                size_t filesize = st.st_size;
                size_t total = (offset + newlen > filesize) ? offset + newlen : filesize;
                char *merged = malloc(total);
                if (!merged) { flock(fd, LOCK_UN); free(transformed); return -ENOMEM; }
                /* Read existing content */
                ssize_t rd = pread(fd, merged, filesize, 0);
                if (rd < 0) { flock(fd, LOCK_UN); free(merged); free(transformed); return -errno; }
                if ((size_t)rd < filesize) memset(merged + rd, 0, filesize - rd);
                /* Overlay transformed content at offset */
                memcpy(merged + offset, transformed, newlen);
                /* Write back */
                ssize_t res = pwrite(fd, merged, total, 0);
                if (res >= 0) ftruncate(fd, total);
                flock(fd, LOCK_UN);
                free(merged);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            }
        }
    }
    ssize_t res = pwrite(fd, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_release(const char *path, struct fuse_file_info *fi) { (void)path; close(FH_FD(fi->fh)); return 0; }
static int ccbox_flush(const char *path, struct fuse_file_info *fi) { (void)path; return close(dup(FH_FD(fi->fh))) == -1 ? -errno : 0; }
static int ccbox_fsync(const char *path, int isdatasync, struct fuse_file_info *fi) { (void)path; int fd = FH_FD(fi->fh); return (isdatasync ? fdatasync(fd) : fsync(fd)) == -1 ? -errno : 0; }
static int ccbox_statfs(const char *path, struct statvfs *stbuf) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return statvfs(fpath, stbuf) == -1 ? -errno : 0; }
static int ccbox_access(const char *path, int mask) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return access(fpath, mask) == -1 ? -errno : 0; }
static int ccbox_mkdir(const char *path, mode_t mode) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    neg_cache_invalidate(fpath);
    if (mkdir(fpath, mode) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    chown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_unlink(const char *path) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; rcache_invalidate(fpath); return unlink(fpath) == -1 ? -errno : 0; }
static int ccbox_rmdir(const char *path) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return rmdir(fpath) == -1 ? -errno : 0; }
static int ccbox_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    neg_cache_invalidate(fpath);
    int fd = open(fpath, fi->flags, mode);
    if (fd == -1) return -errno;
    fi->fh = (uint64_t)fd;
    if (needs_transform(path)) {
        fi->fh |= FH_TRANSFORM_BIT;
        fi->direct_io = 1;
    }
    // Set ownership to calling process (not FUSE daemon)
    fchown(fd, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_truncate(const char *path, off_t size, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; rcache_invalidate(fpath); return (fi ? ftruncate(FH_FD(fi->fh), size) : truncate(fpath, size)) == -1 ? -errno : 0; }
static int ccbox_utimens(const char *path, const struct timespec ts[2], struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return utimensat(AT_FDCWD, fpath, ts, AT_SYMLINK_NOFOLLOW) == -1 ? -errno : 0; }
static int ccbox_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return chmod(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return lchown(fpath, uid, gid) == -1 ? -errno : 0; }
static int ccbox_rename(const char *from, const char *to, unsigned int flags) {
    if (flags) return -EINVAL;
    char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN];
    int rc = get_source_path(ff, from, sizeof(ff));
    if (rc) return rc;
    rc = get_source_path(ft, to, sizeof(ft));
    if (rc) return rc;
    neg_cache_invalidate(ft);
    rcache_invalidate(ff);
    rcache_invalidate(ft);
    scache_invalidate(ff);
    scache_invalidate(ft);
    int r = rename(ff, ft);
    if (r == -1) return -errno;

    /* Post-rename content transform: if the target has a transformable extension
     * but the source did not, the file was written without FUSE write transform
     * (e.g. atomic rename: write to tmp file, rename to .json). Apply to_host
     * transform now so the on-disk content has host paths. */
    if (mapping_count > 0 && needs_transform(to) && !needs_transform(from)) {
        struct stat st;
        if (stat(ft, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0 &&
            (size_t)st.st_size <= RCACHE_MAX_SIZE) {
            int fd = open(ft, O_RDWR);
            if (fd >= 0) {
                char *buf = malloc(st.st_size + 1);
                if (buf) {
                    ssize_t n = pread(fd, buf, st.st_size, 0);
                    if (n > 0) {
                        buf[n] = '\0';
                        size_t newlen;
                        char *transformed = transform_to_host_alloc(buf, n, &newlen);
                        if (transformed) {
                            pwrite(fd, transformed, newlen, 0);
                            ftruncate(fd, newlen);
                            TRACE_TX("rename transform: %s -> %s (%zd -> %zu bytes)", from, to, n, newlen);
                            free(transformed);
                        }
                    }
                    free(buf);
                }
                close(fd);
            }
        }
    }
    return 0;
}
static int ccbox_symlink(const char *target, const char *linkpath) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, linkpath, sizeof(fpath));
    if (rc) return rc;
    if (symlink(target, fpath) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    lchown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_readlink(const char *path, char *buf, size_t size) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; ssize_t res = readlink(fpath, buf, size - 1); if (res == -1) return -errno; buf[res] = '\0'; return 0; }
static int ccbox_link(const char *from, const char *to) { char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; int rc = get_source_path(ff, from, sizeof(ff)); if (rc) return rc; rc = get_source_path(ft, to, sizeof(ft)); if (rc) return rc; return link(ff, ft) == -1 ? -errno : 0; }

/* Kernel cache timeouts: avoid repeated FUSE callbacks for stat/getattr.
 * auto_cache: invalidate page cache when file mtime/size changes. */
static void *ccbox_init(struct fuse_conn_info *conn, struct fuse_config *cfg) {
    (void)conn;
    cfg->entry_timeout = 30.0;
    cfg->attr_timeout = 30.0;
    cfg->negative_timeout = 15.0;
    cfg->auto_cache = 1;
    cfg->hard_remove = 1;
    return NULL;
}

static const struct fuse_operations ccbox_oper = {
    .init = ccbox_init,
    .getattr = ccbox_getattr, .readdir = ccbox_readdir, .open = ccbox_open, .read = ccbox_read,
    .write = ccbox_write, .release = ccbox_release, .flush = ccbox_flush, .fsync = ccbox_fsync,
    .statfs = ccbox_statfs, .access = ccbox_access, .mkdir = ccbox_mkdir, .unlink = ccbox_unlink,
    .rmdir = ccbox_rmdir, .create = ccbox_create, .truncate = ccbox_truncate, .utimens = ccbox_utimens,
    .chmod = ccbox_chmod, .chown = ccbox_chown, .rename = ccbox_rename, .symlink = ccbox_symlink,
    .readlink = ccbox_readlink, .link = ccbox_link,
};

static void add_mapping(const char *from, const char *to) {
    if (mapping_count >= MAX_MAPPINGS) return;
    PathMapping *m = &mappings[mapping_count];
    m->from = normalize_path(from);
    m->to = normalize_path(to);
    if (!m->from || !m->to) { free(m->from); free(m->to); return; }
    m->from_len = strlen(m->from);
    m->to_len = strlen(m->to);
    /* Store lowercase drive for case-insensitive matching (C: and c: both match) */
    m->drive = (m->from[0] && m->from[1] == ':') ? tolower(m->from[0]) : 0;
    m->is_unc = m->from[0] == '/' && m->from[1] == '/';
    m->is_wsl = strncmp(m->from, "/mnt/", 5) == 0 && isalpha(m->from[5]);
    if (m->is_wsl) m->drive = tolower(m->from[5]);
    mapping_count++;
}

static void parse_pathmap(const char *pathmap) {
    if (!pathmap || !*pathmap) return;
    char *copy = strdup(pathmap);
    if (!copy) return;
    char *saveptr = NULL, *mapping = strtok_r(copy, ";", &saveptr);
    while (mapping) {
        char *sep = mapping;
        /* Skip drive letter in Windows path (e.g., C:/...) */
        if (sep[0] && sep[1] == ':') sep += 2;
        sep = strchr(sep, ':');
        if (sep) { *sep = '\0'; add_mapping(mapping, sep + 1); }
        mapping = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

struct ccbox_config { char *source; char *pathmap; char *dirmap; };

static void parse_dirmap(const char *dirmap) {
    if (!dirmap || !*dirmap) return;
    char *copy = strdup(dirmap);
    if (!copy) return;
    char *saveptr = NULL, *entry = strtok_r(copy, ";", &saveptr);
    while (entry && dir_mapping_count < MAX_DIR_MAPPINGS) {
        char *sep = strchr(entry, ':');
        if (sep) {
            *sep = '\0';
            DirMapping *dm = &dir_mappings[dir_mapping_count];
            dm->container_name = strdup(entry);
            dm->native_name = strdup(sep + 1);
            if (dm->container_name && dm->native_name) {
                dm->container_len = strlen(dm->container_name);
                dm->native_len = strlen(dm->native_name);
                dir_mapping_count++;
            } else {
                free(dm->container_name);
                free(dm->native_name);
            }
        }
        entry = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

static struct fuse_opt ccbox_opts[] = {
    {"source=%s", offsetof(struct ccbox_config, source), 0},
    {"pathmap=%s", offsetof(struct ccbox_config, pathmap), 0},
    {"dirmap=%s", offsetof(struct ccbox_config, dirmap), 0},
    FUSE_OPT_END
};

int main(int argc, char *argv[]) {
    struct fuse_args args = FUSE_ARGS_INIT(argc, argv);
    struct ccbox_config conf = {0};
    if (fuse_opt_parse(&args, &conf, ccbox_opts, NULL) == -1) return 1;
    if (!conf.source) { fprintf(stderr, "Error: source not specified\n"); return 1; }
    source_dir = conf.source;
    size_t slen = strlen(source_dir);
    while (slen > 1 && source_dir[slen-1] == '/') source_dir[--slen] = '\0';
    const char *pathmap = conf.pathmap ? conf.pathmap : getenv("CCBOX_PATH_MAP");
    const char *dirmap = conf.dirmap ? conf.dirmap : getenv("CCBOX_DIR_MAP");
    if (pathmap) parse_pathmap(pathmap);
    if (dirmap) parse_dirmap(dirmap);
    parse_extensions(getenv("CCBOX_FUSE_EXTENSIONS"));
    const char *trace_env = getenv("CCBOX_FUSE_TRACE");
    if (trace_env && trace_env[0] >= '1' && trace_env[0] <= '2') {
        g_trace = trace_env[0] - '0';
        g_trace_fp = fopen("/run/ccbox-fuse-trace.log", "a");
        if (g_trace_fp) {
            fprintf(g_trace_fp, "[fuse] Trace level=%d source=%s pathmap=%s dirmap=%s extensions=", g_trace, source_dir, pathmap ? pathmap : "(none)", dirmap ? dirmap : "(none)");
            for (int i = 0; i < g_extension_count; i++) fprintf(g_trace_fp, "%s%s", i ? "," : "", g_extensions[i]);
            fprintf(g_trace_fp, "\n");
        }
    }
    fuse_opt_add_arg(&args, "-o");
    fuse_opt_add_arg(&args, "default_permissions");
    if (getuid() == 0) { fuse_opt_add_arg(&args, "-o"); fuse_opt_add_arg(&args, "allow_other"); }
    int ret = fuse_main(args.argc, args.argv, &ccbox_oper, NULL);
    fuse_opt_free_args(&args);
    return ret;
}
