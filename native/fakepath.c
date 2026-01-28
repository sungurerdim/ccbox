/**
 * fakepath.so - LD_PRELOAD library for transparent path translation
 *
 * Uses environment variables for exact path mapping:
 *   CCBOX_WIN_ORIGINAL_PATH: Original Windows path (e.g., D:/GitHub/Workflow Manager)
 *   PWD: Container path (e.g., /d/GitHub/Workflow Manager)
 *
 * Translation:
 *   Output (getcwd): /d/GitHub/Workflow Manager → D:/GitHub/Workflow Manager
 *   Input (open):    D:/GitHub/Workflow Manager → /d/GitHub/Workflow Manager
 *
 * This ensures Claude Code sees the exact Windows path for session encoding
 * compatibility with native Windows Claude Code.
 *
 * Build:
 *   gcc -shared -fPIC -o fakepath.so fakepath.c -ldl -D_GNU_SOURCE
 *
 * Usage:
 *   CCBOX_WIN_ORIGINAL_PATH="D:/GitHub/project" LD_PRELOAD=/usr/lib/fakepath.so claude
 *
 * Copyright (c) 2024 ccbox contributors
 * SPDX-License-Identifier: MIT
 */

/* _GNU_SOURCE is defined via -D flag in gcc command */
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

/* ═══════════════════════════════════════════════════════════════════════════
 * Path Mapping Configuration
 * ═══════════════════════════════════════════════════════════════════════════ */

static char *g_windows_path = NULL;   // e.g., "D:/GitHub/Workflow Manager"
static char *g_container_path = NULL; // e.g., "/d/GitHub/Workflow Manager"
static size_t g_windows_len = 0;
static size_t g_container_len = 0;
static int g_initialized = 0;

/* ═══════════════════════════════════════════════════════════════════════════
 * Original Function Pointers
 * ═══════════════════════════════════════════════════════════════════════════ */

static char *(*real_getcwd)(char *, size_t) = NULL;
static char *(*real_get_current_dir_name)(void) = NULL;
static char *(*real_realpath)(const char *, char *) = NULL;
static int (*real_open)(const char *, int, ...) = NULL;
static int (*real_open64)(const char *, int, ...) = NULL;
static int (*real_openat)(int, const char *, int, ...) = NULL;
static int (*real_openat64)(int, const char *, int, ...) = NULL;
static FILE *(*real_fopen)(const char *, const char *) = NULL;
static FILE *(*real_fopen64)(const char *, const char *) = NULL;
static FILE *(*real_freopen)(const char *, const char *, FILE *) = NULL;
static FILE *(*real_freopen64)(const char *, const char *, FILE *) = NULL;
static int (*real_stat)(const char *, struct stat *) = NULL;
static int (*real_lstat)(const char *, struct stat *) = NULL;
static int (*real_access)(const char *, int) = NULL;
static int (*real_faccessat)(int, const char *, int, int) = NULL;
static int (*real_chdir)(const char *) = NULL;
static ssize_t (*real_readlink)(const char *, char *, size_t) = NULL;
static ssize_t (*real_readlinkat)(int, const char *, char *, size_t) = NULL;
static int (*real_mkdir)(const char *, mode_t) = NULL;
static int (*real_mkdirat)(int, const char *, mode_t) = NULL;
static int (*real_rmdir)(const char *) = NULL;
static int (*real_unlink)(const char *) = NULL;
static int (*real_unlinkat)(int, const char *, int) = NULL;
static int (*real_rename)(const char *, const char *) = NULL;
static int (*real_renameat)(int, const char *, int, const char *) = NULL;
static int (*real_symlink)(const char *, const char *) = NULL;
static int (*real_symlinkat)(const char *, int, const char *) = NULL;
static int (*real_link)(const char *, const char *) = NULL;
static int (*real_linkat)(int, const char *, int, const char *, int) = NULL;
static int (*real_chmod)(const char *, mode_t) = NULL;
static int (*real_fchmodat)(int, const char *, mode_t, int) = NULL;
static int (*real_chown)(const char *, uid_t, gid_t) = NULL;
static int (*real_lchown)(const char *, uid_t, gid_t) = NULL;
static int (*real_fchownat)(int, const char *, uid_t, gid_t, int) = NULL;
static DIR *(*real_opendir)(const char *) = NULL;
static int (*real_execve)(const char *, char *const[], char *const[]) = NULL;

/* Initialize function pointers */
static void init_real_functions(void) {
    if (real_getcwd) return;  // Already initialized

    real_getcwd = dlsym(RTLD_NEXT, "getcwd");
    real_get_current_dir_name = dlsym(RTLD_NEXT, "get_current_dir_name");
    real_realpath = dlsym(RTLD_NEXT, "realpath");
    real_open = dlsym(RTLD_NEXT, "open");
    real_open64 = dlsym(RTLD_NEXT, "open64");
    real_openat = dlsym(RTLD_NEXT, "openat");
    real_openat64 = dlsym(RTLD_NEXT, "openat64");
    real_fopen = dlsym(RTLD_NEXT, "fopen");
    real_fopen64 = dlsym(RTLD_NEXT, "fopen64");
    real_freopen = dlsym(RTLD_NEXT, "freopen");
    real_freopen64 = dlsym(RTLD_NEXT, "freopen64");
    real_stat = dlsym(RTLD_NEXT, "stat");
    real_lstat = dlsym(RTLD_NEXT, "lstat");
    real_access = dlsym(RTLD_NEXT, "access");
    real_faccessat = dlsym(RTLD_NEXT, "faccessat");
    real_chdir = dlsym(RTLD_NEXT, "chdir");
    real_readlink = dlsym(RTLD_NEXT, "readlink");
    real_readlinkat = dlsym(RTLD_NEXT, "readlinkat");
    real_mkdir = dlsym(RTLD_NEXT, "mkdir");
    real_mkdirat = dlsym(RTLD_NEXT, "mkdirat");
    real_rmdir = dlsym(RTLD_NEXT, "rmdir");
    real_unlink = dlsym(RTLD_NEXT, "unlink");
    real_unlinkat = dlsym(RTLD_NEXT, "unlinkat");
    real_rename = dlsym(RTLD_NEXT, "rename");
    real_renameat = dlsym(RTLD_NEXT, "renameat");
    real_symlink = dlsym(RTLD_NEXT, "symlink");
    real_symlinkat = dlsym(RTLD_NEXT, "symlinkat");
    real_link = dlsym(RTLD_NEXT, "link");
    real_linkat = dlsym(RTLD_NEXT, "linkat");
    real_chmod = dlsym(RTLD_NEXT, "chmod");
    real_fchmodat = dlsym(RTLD_NEXT, "fchmodat");
    real_chown = dlsym(RTLD_NEXT, "chown");
    real_lchown = dlsym(RTLD_NEXT, "lchown");
    real_fchownat = dlsym(RTLD_NEXT, "fchownat");
    real_opendir = dlsym(RTLD_NEXT, "opendir");
    real_execve = dlsym(RTLD_NEXT, "execve");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Path Mapping Initialization
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Initialize path mapping from environment variables.
 * Called once on first use.
 */
static void init_path_mapping(void) {
    if (g_initialized) return;
    g_initialized = 1;

    // Ensure real functions are initialized first
    init_real_functions();

    const char *win_path = getenv("CCBOX_WIN_ORIGINAL_PATH");
    if (!win_path || !win_path[0]) {
        return;  // No mapping configured
    }

    // Get container path using real getcwd (not our intercepted version)
    // This avoids potential recursion issues
    char cwd[PATH_MAX];
    if (!real_getcwd || real_getcwd(cwd, sizeof(cwd)) == NULL) {
        return;
    }

    // Store Windows path
    g_windows_path = strdup(win_path);
    if (!g_windows_path) return;
    g_windows_len = strlen(g_windows_path);

    // Remove trailing slash from Windows path if present
    if (g_windows_len > 0 && (g_windows_path[g_windows_len-1] == '/' ||
                               g_windows_path[g_windows_len-1] == '\\')) {
        g_windows_path[--g_windows_len] = '\0';
    }

    // Store container path (current working directory)
    g_container_path = strdup(cwd);
    if (!g_container_path) {
        free(g_windows_path);
        g_windows_path = NULL;
        return;
    }
    g_container_len = strlen(g_container_path);

    // Remove trailing slash from container path if present
    if (g_container_len > 0 && g_container_path[g_container_len-1] == '/') {
        g_container_path[--g_container_len] = '\0';
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Path Translation Functions
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Convert container path to Windows path.
 * /d/GitHub/Workflow Manager/file.ts → D:/GitHub/Workflow Manager/file.ts
 *
 * Uses exact prefix matching from environment variables.
 * Returns: newly allocated string (caller must free) or NULL if no match.
 */
static char *container_to_windows(const char *path) {
    if (!g_container_path || !g_windows_path || !path) {
        return NULL;
    }

    // Check if path starts with container path prefix
    if (strncmp(path, g_container_path, g_container_len) != 0) {
        return NULL;
    }

    // Ensure it's a prefix match (not partial directory name)
    // e.g., /d/GitHub/project should not match /d/GitHub/project2
    char next_char = path[g_container_len];
    if (next_char != '\0' && next_char != '/') {
        return NULL;
    }

    // Calculate result length
    size_t suffix_len = strlen(path) - g_container_len;
    size_t result_len = g_windows_len + suffix_len;

    char *result = malloc(result_len + 1);
    if (!result) return NULL;

    // Copy Windows prefix + remaining path
    memcpy(result, g_windows_path, g_windows_len);
    strcpy(result + g_windows_len, path + g_container_len);

    return result;
}

/**
 * Convert Windows path to container path.
 * D:/GitHub/Workflow Manager/file.ts → /d/GitHub/Workflow Manager/file.ts
 *
 * Uses exact prefix matching from environment variables.
 * Returns: newly allocated string (caller must free) or NULL if no match.
 */
static char *windows_to_container(const char *path) {
    if (!g_container_path || !g_windows_path || !path) {
        return NULL;
    }

    // Check if path starts with Windows path prefix (case-insensitive for drive letter)
    if (strncasecmp(path, g_windows_path, g_windows_len) != 0) {
        return NULL;
    }

    // Ensure it's a prefix match
    char next_char = path[g_windows_len];
    if (next_char != '\0' && next_char != '/' && next_char != '\\') {
        return NULL;
    }

    // Calculate result length
    size_t suffix_len = strlen(path) - g_windows_len;
    size_t result_len = g_container_len + suffix_len;

    char *result = malloc(result_len + 1);
    if (!result) return NULL;

    // Copy container prefix
    memcpy(result, g_container_path, g_container_len);

    // Copy remaining path, converting backslashes to forward slashes
    const char *src = path + g_windows_len;
    char *dst = result + g_container_len;
    while (*src) {
        *dst++ = (*src == '\\') ? '/' : *src;
        src++;
    }
    *dst = '\0';

    return result;
}

/**
 * Translate input path for syscalls (Windows → container if needed).
 * Returns original path if no translation needed, or translated path.
 * Caller must free *allocated if it's not NULL.
 */
static const char *translate_input(const char *path, char **allocated) {
    *allocated = NULL;
    if (!path) return path;

    init_path_mapping();

    char *translated = windows_to_container(path);
    if (translated) {
        *allocated = translated;
        return translated;
    }

    return path;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Output Translation (Container → Windows)
 * These functions return paths to the application
 * ═══════════════════════════════════════════════════════════════════════════ */

char *getcwd(char *buf, size_t size) {
    init_real_functions();
    init_path_mapping();

    char *result = real_getcwd(buf, size);
    if (!result) {
        return NULL;
    }

    // Translate container path to Windows path
    char *translated = container_to_windows(result);
    if (translated) {
        size_t tlen = strlen(translated);
        if (buf) {
            if (tlen >= size) {
                free(translated);
                errno = ERANGE;
                return NULL;
            }
            strcpy(buf, translated);
            free(translated);
            return buf;
        } else {
            // getcwd allocated the buffer, we need to replace it
            free(result);
            return translated;
        }
    }

    return result;
}

char *get_current_dir_name(void) {
    init_real_functions();
    init_path_mapping();

    char *result = real_get_current_dir_name();
    if (!result) {
        return NULL;
    }

    char *translated = container_to_windows(result);
    if (translated) {
        free(result);
        return translated;
    }

    return result;
}

char *realpath(const char *path, char *resolved_path) {
    init_real_functions();
    init_path_mapping();

    // Translate input if Windows path
    char *alloc_in = NULL;
    const char *real_path = translate_input(path, &alloc_in);

    char *result = real_realpath(real_path, resolved_path);
    free(alloc_in);

    if (!result) {
        return NULL;
    }

    // Translate output
    char *translated = container_to_windows(result);
    if (translated) {
        if (resolved_path) {
            strcpy(resolved_path, translated);
            free(translated);
            return resolved_path;
        } else {
            free(result);
            return translated;
        }
    }

    return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Input Translation (Windows → Container)
 * These functions receive paths from the application
 * ═══════════════════════════════════════════════════════════════════════════ */

int open(const char *pathname, int flags, ...) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        result = real_open(real_path, flags, mode);
    } else {
        result = real_open(real_path, flags);
    }

    free(alloc);
    return result;
}

int open64(const char *pathname, int flags, ...) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        result = real_open64(real_path, flags, mode);
    } else {
        result = real_open64(real_path, flags);
    }

    free(alloc);
    return result;
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        result = real_openat(dirfd, real_path, flags, mode);
    } else {
        result = real_openat(dirfd, real_path, flags);
    }

    free(alloc);
    return result;
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        result = real_openat64(dirfd, real_path, flags, mode);
    } else {
        result = real_openat64(dirfd, real_path, flags);
    }

    free(alloc);
    return result;
}

FILE *fopen(const char *pathname, const char *mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    FILE *result = real_fopen(real_path, mode);
    free(alloc);
    return result;
}

FILE *fopen64(const char *pathname, const char *mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    FILE *result = real_fopen64(real_path, mode);
    free(alloc);
    return result;
}

FILE *freopen(const char *pathname, const char *mode, FILE *stream) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    FILE *result = real_freopen(real_path, mode, stream);
    free(alloc);
    return result;
}

FILE *freopen64(const char *pathname, const char *mode, FILE *stream) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    FILE *result = real_freopen64(real_path, mode, stream);
    free(alloc);
    return result;
}

int stat(const char *pathname, struct stat *statbuf) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_stat(real_path, statbuf);
    free(alloc);
    return result;
}

int lstat(const char *pathname, struct stat *statbuf) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_lstat(real_path, statbuf);
    free(alloc);
    return result;
}

int access(const char *pathname, int mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_access(real_path, mode);
    free(alloc);
    return result;
}

int faccessat(int dirfd, const char *pathname, int mode, int flags) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_faccessat(dirfd, real_path, mode, flags);
    free(alloc);
    return result;
}

int chdir(const char *path) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(path, &alloc);

    int result = real_chdir(real_path);
    free(alloc);
    return result;
}

ssize_t readlink(const char *pathname, char *buf, size_t bufsiz) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    ssize_t result = real_readlink(real_path, buf, bufsiz);
    free(alloc);

    // Translate output if it's a path within our mapping
    if (result > 0 && result < (ssize_t)bufsiz) {
        buf[result] = '\0';  // Temporary null-terminate
        char *translated = container_to_windows(buf);
        if (translated) {
            size_t tlen = strlen(translated);
            if (tlen < bufsiz) {
                memcpy(buf, translated, tlen);
                result = tlen;
            }
            free(translated);
        }
    }

    return result;
}

ssize_t readlinkat(int dirfd, const char *pathname, char *buf, size_t bufsiz) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    ssize_t result = real_readlinkat(dirfd, real_path, buf, bufsiz);
    free(alloc);

    if (result > 0 && result < (ssize_t)bufsiz) {
        buf[result] = '\0';
        char *translated = container_to_windows(buf);
        if (translated) {
            size_t tlen = strlen(translated);
            if (tlen < bufsiz) {
                memcpy(buf, translated, tlen);
                result = tlen;
            }
            free(translated);
        }
    }

    return result;
}

int mkdir(const char *pathname, mode_t mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_mkdir(real_path, mode);
    free(alloc);
    return result;
}

int mkdirat(int dirfd, const char *pathname, mode_t mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_mkdirat(dirfd, real_path, mode);
    free(alloc);
    return result;
}

int rmdir(const char *pathname) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_rmdir(real_path);
    free(alloc);
    return result;
}

int unlink(const char *pathname) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_unlink(real_path);
    free(alloc);
    return result;
}

int unlinkat(int dirfd, const char *pathname, int flags) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_unlinkat(dirfd, real_path, flags);
    free(alloc);
    return result;
}

int rename(const char *oldpath, const char *newpath) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_old = translate_input(oldpath, &alloc1);
    const char *real_new = translate_input(newpath, &alloc2);

    int result = real_rename(real_old, real_new);
    free(alloc1);
    free(alloc2);
    return result;
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_old = translate_input(oldpath, &alloc1);
    const char *real_new = translate_input(newpath, &alloc2);

    int result = real_renameat(olddirfd, real_old, newdirfd, real_new);
    free(alloc1);
    free(alloc2);
    return result;
}

int symlink(const char *target, const char *linkpath) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_target = translate_input(target, &alloc1);
    const char *real_link = translate_input(linkpath, &alloc2);

    int result = real_symlink(real_target, real_link);
    free(alloc1);
    free(alloc2);
    return result;
}

int symlinkat(const char *target, int newdirfd, const char *linkpath) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_target = translate_input(target, &alloc1);
    const char *real_link = translate_input(linkpath, &alloc2);

    int result = real_symlinkat(real_target, newdirfd, real_link);
    free(alloc1);
    free(alloc2);
    return result;
}

int link(const char *oldpath, const char *newpath) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_old = translate_input(oldpath, &alloc1);
    const char *real_new = translate_input(newpath, &alloc2);

    int result = real_link(real_old, real_new);
    free(alloc1);
    free(alloc2);
    return result;
}

int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) {
    init_real_functions();
    init_path_mapping();

    char *alloc1 = NULL, *alloc2 = NULL;
    const char *real_old = translate_input(oldpath, &alloc1);
    const char *real_new = translate_input(newpath, &alloc2);

    int result = real_linkat(olddirfd, real_old, newdirfd, real_new, flags);
    free(alloc1);
    free(alloc2);
    return result;
}

int chmod(const char *pathname, mode_t mode) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_chmod(real_path, mode);
    free(alloc);
    return result;
}

int fchmodat(int dirfd, const char *pathname, mode_t mode, int flags) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_fchmodat(dirfd, real_path, mode, flags);
    free(alloc);
    return result;
}

int chown(const char *pathname, uid_t owner, gid_t group) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_chown(real_path, owner, group);
    free(alloc);
    return result;
}

int lchown(const char *pathname, uid_t owner, gid_t group) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_lchown(real_path, owner, group);
    free(alloc);
    return result;
}

int fchownat(int dirfd, const char *pathname, uid_t owner, gid_t group, int flags) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_fchownat(dirfd, real_path, owner, group, flags);
    free(alloc);
    return result;
}

DIR *opendir(const char *name) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(name, &alloc);

    DIR *result = real_opendir(real_path);
    free(alloc);
    return result;
}

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    init_real_functions();
    init_path_mapping();

    char *alloc = NULL;
    const char *real_path = translate_input(pathname, &alloc);

    int result = real_execve(real_path, argv, envp);
    free(alloc);
    return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Constructor - Initialize on library load
 * ═══════════════════════════════════════════════════════════════════════════ */

__attribute__((constructor))
static void fakepath_init(void) {
    init_real_functions();
    // Don't init_path_mapping here - it needs getcwd which we override
    // It will be initialized on first use
}
