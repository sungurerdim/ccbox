/**
 * fakepath.so - LD_PRELOAD library for transparent path translation
 *
 * Intercepts glibc syscall wrappers to translate Windows-format path arguments
 * to container-format paths. Complements FUSE (which handles file contents)
 * and drive symlinks (which handle Bun's direct syscalls).
 *
 * Translation:
 *   open("D:/GitHub/myapp/file")  → open("/d/GitHub/myapp/file")
 *   stat("C:\\Users\\Foo")        → stat("/c/Users/Foo")
 *   stat("/mnt/d/GitHub/myapp")   → stat("/d/GitHub/myapp")  (WSL paths)
 *
 * Multi-mapping support via CCBOX_PATH_MAP (same format as FUSE):
 *   CCBOX_PATH_MAP="C:/Users/Sungur/.claude:/ccbox/.claude;D:/GitHub/myapp:/d/GitHub/myapp"
 *
 * Legacy single-mapping via CCBOX_WIN_ORIGINAL_PATH (backwards compatible).
 *
 * Features:
 *   - Thread-safe: pthread_once init, immutable state after init
 *   - TLS path cache: 32-slot FNV-1a hash per thread, zero contention
 *   - Stack-first allocation: 4KB stack buffer, heap fallback
 *   - Fast rejection: single byte check for non-translatable paths
 *   - Macro-based code gen: ~65 interceptors in ~500 lines
 *
 * Build: gcc -shared -fPIC -Wall -Werror -O2 -s -o fakepath.so fakepath.c -ldl -lpthread -D_GNU_SOURCE
 *
 * Copyright (c) 2024 ccbox contributors
 * SPDX-License-Identifier: MIT
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <time.h>
#include <ctype.h>
#include <pthread.h>
#include <stdint.h>
#include <sys/xattr.h>
#include <ftw.h>

/* ═══════════════════════════════════════════════════════════════════════════
 * Configuration
 * ═══════════════════════════════════════════════════════════════════════════ */

#define MAX_MAPPINGS    32
#define STACK_BUF_SIZE  4096
#define TLS_CACHE_SLOTS 32

typedef struct {
    char *from;          /* Windows path prefix (normalized, forward slashes) */
    char *to;            /* Container path prefix */
    size_t from_len, to_len;
    char drive;          /* lowercase drive letter, or 0 */
    int is_unc;          /* //server/share */
    int is_wsl;          /* /mnt/d/... */
} PathMapping;

static PathMapping g_mappings[MAX_MAPPINGS];
static int g_mapping_count = 0;
static int g_initialized = 0;
static int g_has_wsl = 0;  /* optimization: skip /mnt/ check if no WSL mappings */

/* ═══════════════════════════════════════════════════════════════════════════
 * TLS Path Cache (zero-contention, per-thread)
 * ═══════════════════════════════════════════════════════════════════════════ */

typedef struct {
    uint32_t hash;
    char *input;      /* owned copy */
    char *output;     /* owned copy */
} TLSCacheEntry;

static __thread TLSCacheEntry t_cache[TLS_CACHE_SLOTS];

static uint32_t fnv1a(const char *s) {
    uint32_t h = 2166136261u;
    for (; *s; s++)
        h = (h ^ (uint8_t)*s) * 16777619u;
    return h;
}

static const char *tls_cache_lookup(const char *path, uint32_t h) {
    int slot = h % TLS_CACHE_SLOTS;
    TLSCacheEntry *e = &t_cache[slot];
    if (e->hash == h && e->input && strcmp(e->input, path) == 0)
        return e->output;
    return NULL;
}

static void tls_cache_insert(const char *input, const char *output, uint32_t h) {
    int slot = h % TLS_CACHE_SLOTS;
    TLSCacheEntry *e = &t_cache[slot];
    free(e->input);
    free(e->output);
    e->hash = h;
    e->input = strdup(input);
    e->output = strdup(output);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Original Function Pointers (resolved via dlsym)
 * ═══════════════════════════════════════════════════════════════════════════ */

#define DECL_REAL(ret, name, ...) static ret (*real_##name)(__VA_ARGS__) = NULL

DECL_REAL(char*,    getcwd,      char*, size_t);
DECL_REAL(int,      open,        const char*, int, ...);
DECL_REAL(int,      open64,      const char*, int, ...);
DECL_REAL(int,      openat,      int, const char*, int, ...);
DECL_REAL(int,      openat64,    int, const char*, int, ...);
DECL_REAL(FILE*,    fopen,       const char*, const char*);
DECL_REAL(FILE*,    fopen64,     const char*, const char*);
DECL_REAL(FILE*,    freopen,     const char*, const char*, FILE*);
DECL_REAL(FILE*,    freopen64,   const char*, const char*, FILE*);
DECL_REAL(int,      stat,        const char*, struct stat*);
DECL_REAL(int,      lstat,       const char*, struct stat*);
DECL_REAL(int,      access,      const char*, int);
DECL_REAL(int,      faccessat,   int, const char*, int, int);
DECL_REAL(int,      eaccess,     const char*, int);
DECL_REAL(int,      chdir,       const char*);
DECL_REAL(ssize_t,  readlink,    const char*, char*, size_t);
DECL_REAL(ssize_t,  readlinkat,  int, const char*, char*, size_t);
DECL_REAL(int,      mkdir,       const char*, mode_t);
DECL_REAL(int,      mkdirat,     int, const char*, mode_t);
DECL_REAL(int,      rmdir,       const char*);
DECL_REAL(int,      unlink,      const char*);
DECL_REAL(int,      unlinkat,    int, const char*, int);
DECL_REAL(int,      rename,      const char*, const char*);
DECL_REAL(int,      renameat,    int, const char*, int, const char*);
DECL_REAL(int,      renameat2,   int, const char*, int, const char*, unsigned int);
DECL_REAL(int,      symlink,     const char*, const char*);
DECL_REAL(int,      symlinkat,   const char*, int, const char*);
DECL_REAL(int,      link,        const char*, const char*);
DECL_REAL(int,      linkat,      int, const char*, int, const char*, int);
DECL_REAL(int,      chmod,       const char*, mode_t);
DECL_REAL(int,      fchmodat,    int, const char*, mode_t, int);
DECL_REAL(int,      chown,       const char*, uid_t, gid_t);
DECL_REAL(int,      lchown,      const char*, uid_t, gid_t);
DECL_REAL(int,      fchownat,    int, const char*, uid_t, gid_t, int);
DECL_REAL(DIR*,     opendir,     const char*);
DECL_REAL(int,      scandir,     const char*, struct dirent***, int(*)(const struct dirent*), int(*)(const struct dirent**, const struct dirent**));
DECL_REAL(int,      execve,      const char*, char*const[], char*const[]);
DECL_REAL(int,      execvp,      const char*, char*const[]);
DECL_REAL(int,      execvpe,     const char*, char*const[], char*const[]);
DECL_REAL(int,      truncate,    const char*, off_t);
DECL_REAL(int,      utimensat,   int, const char*, const struct timespec[2], int);
DECL_REAL(int,      creat,       const char*, mode_t);
DECL_REAL(int,      creat64,     const char*, mode_t);
DECL_REAL(char*,    realpath,    const char*, char*);
DECL_REAL(char*,    canonicalize_file_name, const char*);
DECL_REAL(int,      __xstat,     int, const char*, struct stat*);
DECL_REAL(int,      __lxstat,    int, const char*, struct stat*);
DECL_REAL(int,      __fxstatat,  int, int, const char*, struct stat*, int);
DECL_REAL(void*,    dlopen,      const char*, int);
DECL_REAL(long,     pathconf,    const char*, int);
DECL_REAL(int,      mknod,       const char*, mode_t, dev_t);
DECL_REAL(int,      mknodat,     int, const char*, mode_t, dev_t);

/* statx - may not exist on older glibc */
struct statx;
DECL_REAL(int,      statx,       int, const char*, int, unsigned int, struct statx*);
DECL_REAL(int,      fstatat,     int, const char*, struct stat*, int);
DECL_REAL(int,      nftw,        const char*, int(*)(const char*, const struct stat*, int, struct FTW*), int, int);
DECL_REAL(int,      ftw,         const char*, int(*)(const char*, const struct stat*, int), int);

/* xattr family */
DECL_REAL(int,      setxattr,    const char*, const char*, const void*, size_t, int);
DECL_REAL(ssize_t,  getxattr,    const char*, const char*, void*, size_t);
DECL_REAL(int,      lsetxattr,   const char*, const char*, const void*, size_t, int);
DECL_REAL(ssize_t,  lgetxattr,   const char*, const char*, void*, size_t);
DECL_REAL(ssize_t,  listxattr,   const char*, char*, size_t);
DECL_REAL(ssize_t,  llistxattr,  const char*, char*, size_t);
DECL_REAL(int,      removexattr, const char*, const char*);
DECL_REAL(int,      lremovexattr,const char*, const char*);

/* ═══════════════════════════════════════════════════════════════════════════
 * Initialization (thread-safe via pthread_once)
 * ═══════════════════════════════════════════════════════════════════════════ */

static pthread_once_t g_init_once = PTHREAD_ONCE_INIT;

#define RESOLVE(name) real_##name = dlsym(RTLD_NEXT, #name)

static char *normalize_strdup(const char *path) {
    if (!path) return NULL;
    char *norm = strdup(path);
    if (!norm) return NULL;
    for (char *p = norm; *p; p++) if (*p == '\\') *p = '/';
    size_t len = strlen(norm);
    while (len > 1 && norm[len-1] == '/') norm[--len] = '\0';
    return norm;
}

static void add_mapping(const char *from, const char *to) {
    if (g_mapping_count >= MAX_MAPPINGS) return;
    PathMapping *m = &g_mappings[g_mapping_count];
    m->from = normalize_strdup(from);
    m->to = normalize_strdup(to);
    if (!m->from || !m->to) { free(m->from); free(m->to); return; }
    m->from_len = strlen(m->from);
    m->to_len = strlen(m->to);
    m->drive = (m->from_len > 1 && m->from[1] == ':') ? tolower(m->from[0]) : 0;
    m->is_unc = (m->from[0] == '/' && m->from[1] == '/');
    m->is_wsl = (strncmp(m->from, "/mnt/", 5) == 0 && isalpha(m->from[5]));
    if (m->is_wsl) { m->drive = tolower(m->from[5]); g_has_wsl = 1; }
    g_mapping_count++;
}

static void parse_pathmap(const char *env) {
    if (!env || !*env) return;
    char *copy = strdup(env);
    if (!copy) return;
    char *saveptr = NULL, *entry = strtok_r(copy, ";", &saveptr);
    while (entry) {
        char *sep = entry;
        if (sep[0] && sep[1] == ':') sep += 2;
        sep = strchr(sep, ':');
        if (sep) { *sep = '\0'; add_mapping(entry, sep + 1); }
        entry = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

static void do_init(void) {
    /* Resolve all real function pointers */
    RESOLVE(getcwd); RESOLVE(open); RESOLVE(open64);
    RESOLVE(openat); RESOLVE(openat64);
    RESOLVE(fopen); RESOLVE(fopen64); RESOLVE(freopen); RESOLVE(freopen64);
    RESOLVE(stat); RESOLVE(lstat); RESOLVE(access); RESOLVE(faccessat);
    RESOLVE(eaccess);
    RESOLVE(chdir); RESOLVE(readlink); RESOLVE(readlinkat);
    RESOLVE(mkdir); RESOLVE(mkdirat); RESOLVE(rmdir);
    RESOLVE(unlink); RESOLVE(unlinkat);
    RESOLVE(rename); RESOLVE(renameat); RESOLVE(renameat2);
    RESOLVE(symlink); RESOLVE(symlinkat);
    RESOLVE(link); RESOLVE(linkat);
    RESOLVE(chmod); RESOLVE(fchmodat);
    RESOLVE(chown); RESOLVE(lchown); RESOLVE(fchownat);
    RESOLVE(opendir); RESOLVE(scandir);
    RESOLVE(execve); RESOLVE(execvp); RESOLVE(execvpe);
    RESOLVE(truncate); RESOLVE(utimensat);
    RESOLVE(creat); RESOLVE(creat64);
    RESOLVE(realpath); RESOLVE(canonicalize_file_name);
    RESOLVE(__xstat); RESOLVE(__lxstat); RESOLVE(__fxstatat);
    RESOLVE(statx); RESOLVE(fstatat);
    RESOLVE(dlopen); RESOLVE(pathconf);
    RESOLVE(mknod); RESOLVE(mknodat);
    RESOLVE(nftw); RESOLVE(ftw);
    RESOLVE(setxattr); RESOLVE(getxattr);
    RESOLVE(lsetxattr); RESOLVE(lgetxattr);
    RESOLVE(listxattr); RESOLVE(llistxattr);
    RESOLVE(removexattr); RESOLVE(lremovexattr);

    /* Parse multi-mapping from CCBOX_PATH_MAP */
    const char *pathmap = getenv("CCBOX_PATH_MAP");
    if (pathmap && *pathmap) {
        parse_pathmap(pathmap);
    }

    /* Legacy: CCBOX_WIN_ORIGINAL_PATH (single mapping, cwd-based) */
    if (g_mapping_count == 0) {
        const char *win_path = getenv("CCBOX_WIN_ORIGINAL_PATH");
        if (win_path && *win_path && real_getcwd) {
            char cwd[PATH_MAX];
            if (real_getcwd(cwd, sizeof(cwd))) {
                add_mapping(win_path, cwd);
            }
        }
    }

    g_initialized = 1;
}

#define ENSURE_INIT() do { pthread_once(&g_init_once, do_init); } while(0)

/* ═══════════════════════════════════════════════════════════════════════════
 * Path Translation (with stack alloc + TLS cache)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Translate a path if it matches a mapping prefix.
 * Uses stack buffer first, heap fallback for long paths.
 * Returns original path if no translation needed.
 * *alloc is set to heap pointer if allocated (caller must free).
 */
static const char *translate_path(const char *path, char *buf, char **alloc) {
    *alloc = NULL;
    if (!path || !g_initialized || !g_mapping_count) return path;

    /* Fast rejection: first byte check */
    unsigned char c0 = (unsigned char)path[0];
    if (!isalpha(c0) && c0 != '/' && c0 != '\\') return path;
    if (c0 == '/' && !g_has_wsl) return path;  /* no WSL mappings → skip / paths */

    /* TLS cache lookup */
    uint32_t h = fnv1a(path);
    const char *cached = tls_cache_lookup(path, h);
    if (cached) return cached;

    for (int m = 0; m < g_mapping_count; m++) {
        PathMapping *pm = &g_mappings[m];
        const char *match_start = NULL;
        size_t match_len = 0;

        /* Drive letter: case-insensitive first char + ':' */
        if (pm->drive && !pm->is_unc && !pm->is_wsl &&
            tolower(path[0]) == pm->drive && path[1] == ':') {
            /* Normalize and check */
            size_t plen = strlen(path);
            /* Build normalized version in stack buf */
            char norm[STACK_BUF_SIZE];
            size_t ni = 0;
            for (size_t i = 0; i < plen && ni < STACK_BUF_SIZE - 1; i++) {
                norm[ni++] = (path[i] == '\\') ? '/' : path[i];
            }
            norm[ni] = '\0';
            /* Lowercase first char for matching */
            norm[0] = tolower(norm[0]);

            if (strncmp(norm, pm->from, pm->from_len) == 0) {
                char next = norm[pm->from_len];
                if (next == '\0' || next == '/' || next == '\\') {
                    match_start = norm + pm->from_len;
                    match_len = ni - pm->from_len;
                    /* Build result */
                    size_t rlen = pm->to_len + match_len;
                    char *dst = (rlen < STACK_BUF_SIZE) ? buf : malloc(rlen + 1);
                    if (!dst) return path;
                    memcpy(dst, pm->to, pm->to_len);
                    memcpy(dst + pm->to_len, match_start, match_len);
                    dst[rlen] = '\0';
                    if (dst != buf) *alloc = dst;
                    tls_cache_insert(path, dst, h);
                    return dst;
                }
            }
            continue;
        }

        /* WSL: /mnt/d/... */
        if (pm->is_wsl && strncmp(path, pm->from, pm->from_len) == 0) {
            char next = path[pm->from_len];
            if (next == '\0' || next == '/') {
                match_start = path + pm->from_len;
                match_len = strlen(match_start);
                size_t rlen = pm->to_len + match_len;
                char *dst = (rlen < STACK_BUF_SIZE) ? buf : malloc(rlen + 1);
                if (!dst) return path;
                memcpy(dst, pm->to, pm->to_len);
                memcpy(dst + pm->to_len, match_start, match_len);
                dst[rlen] = '\0';
                if (dst != buf) *alloc = dst;
                tls_cache_insert(path, dst, h);
                return dst;
            }
        }

        /* UNC: \\server\share or //server/share */
        if (pm->is_unc && (path[0] == '\\' || path[0] == '/') && (path[1] == '\\' || path[1] == '/')) {
            char norm[STACK_BUF_SIZE];
            size_t plen = strlen(path);
            size_t ni = 0;
            for (size_t i = 0; i < plen && ni < STACK_BUF_SIZE - 1; i++) {
                norm[ni++] = (path[i] == '\\') ? '/' : path[i];
            }
            norm[ni] = '\0';
            if (strncmp(norm, pm->from, pm->from_len) == 0) {
                char next = norm[pm->from_len];
                if (next == '\0' || next == '/') {
                    match_start = norm + pm->from_len;
                    match_len = ni - pm->from_len;
                    size_t rlen = pm->to_len + match_len;
                    char *dst = (rlen < STACK_BUF_SIZE) ? buf : malloc(rlen + 1);
                    if (!dst) return path;
                    memcpy(dst, pm->to, pm->to_len);
                    memcpy(dst + pm->to_len, match_start, match_len);
                    dst[rlen] = '\0';
                    if (dst != buf) *alloc = dst;
                    tls_cache_insert(path, dst, h);
                    return dst;
                }
            }
        }
    }

    return path;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Macro-Based Interceptor Code Generation
 *
 * Instead of ~600 lines of boilerplate, each interceptor is a single line.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Comma helper for macro arguments */
#define COMMA ,

/* Single-path interceptors: translate one path argument */
#define INTERCEPT_1PATH(ret, name, args, call_pre, pathvar, call_post) \
    ret name args {                                                    \
        ENSURE_INIT();                                                 \
        char _b[STACK_BUF_SIZE]; char *_a = NULL;                      \
        const char *_r = translate_path(pathvar, _b, &_a);             \
        ret _res = real_##name(call_pre _r call_post);                 \
        free(_a);                                                      \
        return _res;                                                   \
    }

/* Same but for functions returning void* (dlopen) */
#define INTERCEPT_1PATH_PTR(ret, name, args, call_pre, pathvar, call_post) \
    ret name args {                                                        \
        ENSURE_INIT();                                                     \
        char _b[STACK_BUF_SIZE]; char *_a = NULL;                          \
        const char *_r = translate_path(pathvar, _b, &_a);                 \
        ret _res = real_##name(call_pre _r call_post);                     \
        free(_a);                                                          \
        return _res;                                                       \
    }

/* Two-path interceptors: translate two path arguments */
#define INTERCEPT_2PATH(ret, name, args, pre1, p1, mid, p2, post) \
    ret name args {                                                \
        ENSURE_INIT();                                             \
        char _b1[STACK_BUF_SIZE], _b2[STACK_BUF_SIZE];            \
        char *_a1 = NULL, *_a2 = NULL;                             \
        const char *_r1 = translate_path(p1, _b1, &_a1);          \
        const char *_r2 = translate_path(p2, _b2, &_a2);          \
        ret _res = real_##name(pre1 _r1 mid _r2 post);            \
        free(_a1); free(_a2);                                      \
        return _res;                                               \
    }

/* ═══════════════════════════════════════════════════════════════════════════
 * Interceptors: File Operations
 * ═══════════════════════════════════════════════════════════════════════════ */

/* open/open64 need special handling for variadic O_CREAT + mode */
int open(const char *pathname, int flags, ...) {
    ENSURE_INIT();
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int result;
    if (flags & O_CREAT) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        result = real_open(rp, flags, mode);
    } else {
        result = real_open(rp, flags);
    }
    free(_a);
    return result;
}

int open64(const char *pathname, int flags, ...) {
    ENSURE_INIT();
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int result;
    if (flags & O_CREAT) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        result = real_open64(rp, flags, mode);
    } else {
        result = real_open64(rp, flags);
    }
    free(_a);
    return result;
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    ENSURE_INIT();
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int result;
    if (flags & O_CREAT) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        result = real_openat(dirfd, rp, flags, mode);
    } else {
        result = real_openat(dirfd, rp, flags);
    }
    free(_a);
    return result;
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    ENSURE_INIT();
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int result;
    if (flags & O_CREAT) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        result = real_openat64(dirfd, rp, flags, mode);
    } else {
        result = real_openat64(dirfd, rp, flags);
    }
    free(_a);
    return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Macro-generated interceptors
 * ═══════════════════════════════════════════════════════════════════════════ */

/* fopen family */
INTERCEPT_1PATH(FILE*, fopen,     (const char *p, const char *m),   , p, COMMA m)
INTERCEPT_1PATH(FILE*, fopen64,   (const char *p, const char *m),   , p, COMMA m)
INTERCEPT_1PATH(FILE*, freopen,   (const char *p, const char *m, FILE *s), , p, COMMA m COMMA s)
INTERCEPT_1PATH(FILE*, freopen64, (const char *p, const char *m, FILE *s), , p, COMMA m COMMA s)

/* stat family */
INTERCEPT_1PATH(int, stat,   (const char *p, struct stat *s),        , p, COMMA s)
INTERCEPT_1PATH(int, lstat,  (const char *p, struct stat *s),        , p, COMMA s)
INTERCEPT_1PATH(int, access, (const char *p, int m),                 , p, COMMA m)
INTERCEPT_1PATH(int, faccessat, (int d, const char *p, int m, int f), d COMMA, p, COMMA m COMMA f)

/* chdir, readlink */
INTERCEPT_1PATH(int,     chdir,     (const char *p),                     , p, )
INTERCEPT_1PATH(ssize_t, readlink,  (const char *p, char *b, size_t s),  , p, COMMA b COMMA s)
INTERCEPT_1PATH(ssize_t, readlinkat,(int d, const char *p, char *b, size_t s), d COMMA, p, COMMA b COMMA s)

/* mkdir, rmdir, unlink */
INTERCEPT_1PATH(int, mkdir,    (const char *p, mode_t m),       , p, COMMA m)
INTERCEPT_1PATH(int, mkdirat,  (int d, const char *p, mode_t m), d COMMA, p, COMMA m)
INTERCEPT_1PATH(int, rmdir,    (const char *p),                 , p, )
INTERCEPT_1PATH(int, unlink,   (const char *p),                 , p, )
INTERCEPT_1PATH(int, unlinkat, (int d, const char *p, int f),   d COMMA, p, COMMA f)

/* rename family */
INTERCEPT_2PATH(int, rename,   (const char *o, const char *n),                     , o, COMMA, n, )
INTERCEPT_2PATH(int, renameat, (int od, const char *o, int nd, const char *n),      od COMMA, o, COMMA nd COMMA, n, )

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
    ENSURE_INIT();
    if (!real_renameat2) { errno = ENOSYS; return -1; }
    char _b1[STACK_BUF_SIZE], _b2[STACK_BUF_SIZE];
    char *_a1 = NULL, *_a2 = NULL;
    const char *ro = translate_path(oldpath, _b1, &_a1);
    const char *rn = translate_path(newpath, _b2, &_a2);
    int r = real_renameat2(olddirfd, ro, newdirfd, rn, flags);
    free(_a1); free(_a2);
    return r;
}

/* symlink, link */
INTERCEPT_2PATH(int, symlink,   (const char *t, const char *l),                         , t, COMMA, l, )
INTERCEPT_2PATH(int, symlinkat, (const char *t, int d, const char *l),                  , t, COMMA d COMMA, l, )
INTERCEPT_2PATH(int, link,      (const char *o, const char *n),                         , o, COMMA, n, )
INTERCEPT_2PATH(int, linkat,    (int od, const char *o, int nd, const char *n, int f),   od COMMA, o, COMMA nd COMMA, n, COMMA f)

/* chmod, chown */
INTERCEPT_1PATH(int, chmod,     (const char *p, mode_t m),                    , p, COMMA m)
INTERCEPT_1PATH(int, fchmodat,  (int d, const char *p, mode_t m, int f),      d COMMA, p, COMMA m COMMA f)
INTERCEPT_1PATH(int, chown,     (const char *p, uid_t u, gid_t g),           , p, COMMA u COMMA g)
INTERCEPT_1PATH(int, lchown,    (const char *p, uid_t u, gid_t g),           , p, COMMA u COMMA g)
INTERCEPT_1PATH(int, fchownat,  (int d, const char *p, uid_t u, gid_t g, int f), d COMMA, p, COMMA u COMMA g COMMA f)

/* dir operations */
INTERCEPT_1PATH(DIR*, opendir, (const char *p), , p, )
INTERCEPT_1PATH(int,  scandir, (const char *p, struct dirent ***n, int(*fi)(const struct dirent*), int(*co)(const struct dirent**, const struct dirent**)), , p, COMMA n COMMA fi COMMA co)

/* exec family */
INTERCEPT_1PATH(int, execve,  (const char *p, char *const a[], char *const e[]), , p, COMMA a COMMA e)
INTERCEPT_1PATH(int, execvp,  (const char *p, char *const a[]),                  , p, COMMA a)
INTERCEPT_1PATH(int, execvpe, (const char *p, char *const a[], char *const e[]), , p, COMMA a COMMA e)

/* truncate, utimensat, creat */
INTERCEPT_1PATH(int, truncate,  (const char *p, off_t l),                    , p, COMMA l)
INTERCEPT_1PATH(int, utimensat, (int d, const char *p, const struct timespec t[2], int f), d COMMA, p, COMMA t COMMA f)
INTERCEPT_1PATH(int, creat,     (const char *p, mode_t m),                   , p, COMMA m)
INTERCEPT_1PATH(int, creat64,   (const char *p, mode_t m),                   , p, COMMA m)

/* realpath, canonicalize_file_name */
INTERCEPT_1PATH(char*, realpath, (const char *p, char *r), , p, COMMA r)

char *canonicalize_file_name(const char *path) {
    ENSURE_INIT();
    if (!real_canonicalize_file_name) return real_realpath ? real_realpath(path, NULL) : NULL;
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(path, _b, &_a);
    char *res = real_canonicalize_file_name(rp);
    free(_a);
    return res;
}

/* glibc internal stat wrappers */
int __xstat(int ver, const char *pathname, struct stat *statbuf) {
    ENSURE_INIT();
    if (!real___xstat) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real___xstat(ver, rp, statbuf);
    free(_a);
    return res;
}

int __lxstat(int ver, const char *pathname, struct stat *statbuf) {
    ENSURE_INIT();
    if (!real___lxstat) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real___lxstat(ver, rp, statbuf);
    free(_a);
    return res;
}

int __fxstatat(int ver, int dirfd, const char *pathname, struct stat *statbuf, int flags) {
    ENSURE_INIT();
    if (!real___fxstatat) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real___fxstatat(ver, dirfd, rp, statbuf, flags);
    free(_a);
    return res;
}

/* statx, fstatat (Tier 2) */
int statx(int dirfd, const char *pathname, int flags, unsigned int mask, struct statx *statxbuf) {
    ENSURE_INIT();
    if (!real_statx) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real_statx(dirfd, rp, flags, mask, statxbuf);
    free(_a);
    return res;
}

int fstatat(int dirfd, const char *pathname, struct stat *statbuf, int flags) {
    ENSURE_INIT();
    if (!real_fstatat) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real_fstatat(dirfd, rp, statbuf, flags);
    free(_a);
    return res;
}

/* eaccess */
int eaccess(const char *pathname, int mode) {
    ENSURE_INIT();
    if (!real_eaccess) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real_eaccess(rp, mode);
    free(_a);
    return res;
}

/* dlopen */
void *dlopen(const char *filename, int flags) {
    ENSURE_INIT();
    if (!filename) return real_dlopen(NULL, flags);
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(filename, _b, &_a);
    void *res = real_dlopen(rp, flags);
    free(_a);
    return res;
}

/* pathconf, mknod */
INTERCEPT_1PATH(long, pathconf, (const char *p, int n), , p, COMMA n)

int mknod(const char *pathname, mode_t mode, dev_t dev) {
    ENSURE_INIT();
    if (!real_mknod) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real_mknod(rp, mode, dev);
    free(_a);
    return res;
}

int mknodat(int dirfd, const char *pathname, mode_t mode, dev_t dev) {
    ENSURE_INIT();
    if (!real_mknodat) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(pathname, _b, &_a);
    int res = real_mknodat(dirfd, rp, mode, dev);
    free(_a);
    return res;
}

/* nftw, ftw */
int nftw(const char *dirpath, int (*fn)(const char *, const struct stat *, int, struct FTW *), int nopenfd, int flags) {
    ENSURE_INIT();
    if (!real_nftw) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(dirpath, _b, &_a);
    int res = real_nftw(rp, fn, nopenfd, flags);
    free(_a);
    return res;
}

int ftw(const char *dirpath, int (*fn)(const char *, const struct stat *, int), int nopenfd) {
    ENSURE_INIT();
    if (!real_ftw) { errno = ENOSYS; return -1; }
    char _b[STACK_BUF_SIZE]; char *_a = NULL;
    const char *rp = translate_path(dirpath, _b, &_a);
    int res = real_ftw(rp, fn, nopenfd);
    free(_a);
    return res;
}

/* xattr family */
INTERCEPT_1PATH(int,     setxattr,     (const char *p, const char *n, const void *v, size_t s, int f), , p, COMMA n COMMA v COMMA s COMMA f)
INTERCEPT_1PATH(ssize_t, getxattr,     (const char *p, const char *n, void *v, size_t s),             , p, COMMA n COMMA v COMMA s)
INTERCEPT_1PATH(int,     lsetxattr,    (const char *p, const char *n, const void *v, size_t s, int f), , p, COMMA n COMMA v COMMA s COMMA f)
INTERCEPT_1PATH(ssize_t, lgetxattr,    (const char *p, const char *n, void *v, size_t s),             , p, COMMA n COMMA v COMMA s)
INTERCEPT_1PATH(ssize_t, listxattr,    (const char *p, char *l, size_t s),                            , p, COMMA l COMMA s)
INTERCEPT_1PATH(ssize_t, llistxattr,   (const char *p, char *l, size_t s),                            , p, COMMA l COMMA s)
INTERCEPT_1PATH(int,     removexattr,  (const char *p, const char *n),                                , p, COMMA n)
INTERCEPT_1PATH(int,     lremovexattr, (const char *p, const char *n),                                , p, COMMA n)

/* ═══════════════════════════════════════════════════════════════════════════
 * Constructor - Initialize on library load
 * ═══════════════════════════════════════════════════════════════════════════ */

__attribute__((constructor))
static void fakepath_init(void) {
    pthread_once(&g_init_once, do_init);
}
