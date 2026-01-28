/**
 * ccbox-fuse: FUSE filesystem for transparent cross-platform path mapping
 * Provides kernel-level path transformation that works with io_uring and direct syscalls
 * This is REQUIRED for Bun-based Claude Code which bypasses glibc
 * Compile: gcc -Wall -O2 -o ccbox-fuse ccbox-fuse.c $(pkg-config fuse3 --cflags --libs)
 */
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
#include <sys/file.h>

#define MAX_MAPPINGS 32
#define MAX_DIR_MAPPINGS 32
#define MAX_PATH_LEN 4096

typedef struct {
    char *from, *to;
    size_t from_len, to_len;
    char drive;
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
    if (norm[0] && norm[1] == ':') norm[0] = tolower(norm[0]);
    size_t len = strlen(norm);
    while (len > 1 && norm[len-1] == '/') norm[--len] = '\0';
    return norm;
}

static int needs_transform(const char *path) {
    if (!path || mapping_count == 0) return 0;
    const char *dot = strrchr(path, '.');
    return dot && (strcasecmp(dot, ".json") == 0 || strcasecmp(dot, ".jsonl") == 0);
}

static int get_source_path(char *dest, const char *path, size_t destsize) {
    int n;
    if (dir_mapping_count > 0 && path && path[0] == '/') {
        /* Check each path segment for container_name -> native_name translation */
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

/* Transform Windows paths in JSON content to Linux paths */
/* Returns new buffer that caller must free, or NULL if no transform needed */
static char *transform_to_container_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocation based on max expansion ratio of mappings */
    size_t max_to = 0;
    for (int m = 0; m < mapping_count; m++)
        if (mappings[m].to_len > max_to) max_to = mappings[m].to_len;
    size_t alloc = len * (max_to > 2 ? max_to : 2) + 1;
    char *work = malloc(alloc);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;
    while (i < len && buf[i]) {
        int matched = 0;
        /* Check for drive letter pattern like C: or D: */
        if (i + 2 < len && isalpha(buf[i]) && buf[i+1] == ':') {
            char drive = tolower(buf[i]);
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].drive == drive) {
                    /* Extract the full path after drive letter for comparison */
                    char pathbuf[MAX_PATH_LEN];
                    size_t pi = 0, ti = i + 2;
                    while (ti < len && buf[ti] != '"' && buf[ti] != ',' && buf[ti] != '}' && pi < MAX_PATH_LEN - 1) {
                        if (buf[ti] == '\\') { pathbuf[pi++] = '/'; ti++; if (ti < len && buf[ti] == '\\') ti++; }
                        else pathbuf[pi++] = buf[ti++];
                    }
                    pathbuf[pi] = '\0';

                    /* Check if path starts with the mapped from-path (after drive letter) */
                    /* from is like "c:/Users/Sungur/.claude", so skip first 2 chars (c:) */
                    const char *from_path = mappings[m].from + 2;
                    size_t from_path_len = mappings[m].from_len - 2;

                    if (strncmp(pathbuf, from_path, from_path_len) == 0) {
                        /* Full prefix match - replace with to path */
                        memcpy(work + wi, mappings[m].to, mappings[m].to_len);
                        wi += mappings[m].to_len;
                        /* Copy remainder after the matched prefix */
                        const char *remainder = pathbuf + from_path_len;
                        size_t rem_len = strlen(remainder);
                        memcpy(work + wi, remainder, rem_len);
                        wi += rem_len;
                        i = ti;
                        matched = 1;
                        any_transform = 1;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

/* Transform Linux paths in JSON content to Windows paths (reverse transform for writes) */
/* Converts /ccbox/... paths back to C:\\Users\\... format for host filesystem */
static char *transform_to_host_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocation: each mapping replacement can expand to from_len*2 (backslash-escaped) */
    size_t max_expand = 0;
    for (int m = 0; m < mapping_count; m++) {
        size_t e = mappings[m].from_len * 2;
        if (e > max_expand) max_expand = e;
    }
    size_t alloc = len * 2 + (max_expand + 1) * mapping_count + 1;
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
                    /* Write the Windows path with JSON-escaped backslashes */
                    const char *from = mappings[m].from;
                    for (size_t j = 0; j < mappings[m].from_len; j++) {
                        if (from[j] == '/') {
                            work[wi++] = '\\';
                            work[wi++] = '\\';
                        } else {
                            work[wi++] = from[j];
                        }
                    }
                    i += to_len;
                    matched = 1;
                    any_transform = 1;

                    /* Copy remainder path with JSON-escaped backslashes */
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isspace(buf[i])) {
                        if (buf[i] == '/') {
                            work[wi++] = '\\';
                            work[wi++] = '\\';
                        } else {
                            work[wi++] = buf[i];
                        }
                        i++;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

static int ccbox_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void)fi;
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    return lstat(fpath, stbuf) == -1 ? -errno : 0;
}

static int ccbox_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    DIR *dp = opendir(fpath);
    if (!dp) return -errno;
    struct dirent *de;
    while ((de = readdir(dp))) {
        struct stat st = {0};
        st.st_ino = de->d_ino;
        st.st_mode = de->d_type << 12;
        /* Reverse translate: native_name -> container_name for readdir */
        const char *name = de->d_name;
        for (int m = 0; m < dir_mapping_count; m++) {
            if (strcmp(de->d_name, dir_mappings[m].native_name) == 0) {
                name = dir_mappings[m].container_name;
                break;
            }
        }
        if (filler(buf, name, &st, 0, 0)) break;
    }
    closedir(dp);
    return 0;
}

static int ccbox_open(const char *path, struct fuse_file_info *fi) {
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    int fd = open(fpath, fi->flags);
    if (fd == -1) return -errno;
    fi->fh = fd;
    return 0;
}

static int ccbox_read(const char *path, char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    int fd = fi->fh;
    if (needs_transform(path)) {
        struct stat st;
        if (fstat(fd, &st) == -1) return -errno;
        size_t filesize = st.st_size;
        if (filesize == 0) return 0;
        char *filebuf = malloc(filesize + 1);
        if (!filebuf) return -ENOMEM;
        ssize_t nread = pread(fd, filebuf, filesize, 0);
        if (nread == -1) { free(filebuf); return -errno; }
        filebuf[nread] = '\0';

        /* Transform paths - may return new buffer if transform happened */
        size_t newlen;
        char *transformed = transform_to_container_alloc(filebuf, nread, &newlen);
        char *result = transformed ? transformed : filebuf;

        if ((size_t)offset >= newlen) {
            if (transformed) free(transformed);
            free(filebuf);
            return 0;
        }
        size_t tocopy = newlen - offset;
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
    if (needs_transform(path)) {
        /* For JSON files, transform Linux paths back to Windows paths */
        size_t newlen;
        char *transformed = transform_to_host_alloc(buf, size, &newlen);
        if (transformed) {
            /* Write transformed content - handle offset by reading existing, merging, writing */
            if (offset == 0) {
                /* Simple case: writing from beginning */
                ssize_t res = pwrite(fi->fh, transformed, newlen, 0);
                /* Truncate file to new size in case new content is shorter */
                if (res >= 0) ftruncate(fi->fh, newlen);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            } else {
                /* Complex case: writing at offset - need to merge with existing content */
                /* Lock to prevent read-modify-write race */
                flock(fi->fh, LOCK_EX);
                struct stat st;
                if (fstat(fi->fh, &st) == -1) { flock(fi->fh, LOCK_UN); free(transformed); return -errno; }
                size_t filesize = st.st_size;
                size_t total = (offset + newlen > filesize) ? offset + newlen : filesize;
                char *merged = malloc(total);
                if (!merged) { flock(fi->fh, LOCK_UN); free(transformed); return -ENOMEM; }
                /* Read existing content */
                ssize_t rd = pread(fi->fh, merged, filesize, 0);
                if (rd < 0) { flock(fi->fh, LOCK_UN); free(merged); free(transformed); return -errno; }
                if ((size_t)rd < filesize) memset(merged + rd, 0, filesize - rd);
                /* Overlay transformed content at offset */
                memcpy(merged + offset, transformed, newlen);
                /* Write back */
                ssize_t res = pwrite(fi->fh, merged, total, 0);
                if (res >= 0) ftruncate(fi->fh, total);
                flock(fi->fh, LOCK_UN);
                free(merged);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            }
        }
    }
    ssize_t res = pwrite(fi->fh, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_release(const char *path, struct fuse_file_info *fi) { (void)path; close(fi->fh); return 0; }
static int ccbox_flush(const char *path, struct fuse_file_info *fi) { (void)path; return close(dup(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_fsync(const char *path, int isdatasync, struct fuse_file_info *fi) { (void)path; return (isdatasync ? fdatasync(fi->fh) : fsync(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_statfs(const char *path, struct statvfs *stbuf) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return statvfs(fpath, stbuf) == -1 ? -errno : 0; }
static int ccbox_access(const char *path, int mask) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return access(fpath, mask) == -1 ? -errno : 0; }
static int ccbox_mkdir(const char *path, mode_t mode) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    if (mkdir(fpath, mode) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    chown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_unlink(const char *path) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return unlink(fpath) == -1 ? -errno : 0; }
static int ccbox_rmdir(const char *path) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return rmdir(fpath) == -1 ? -errno : 0; }
static int ccbox_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    int rc = get_source_path(fpath, path, sizeof(fpath));
    if (rc) return rc;
    int fd = open(fpath, fi->flags, mode);
    if (fd == -1) return -errno;
    fi->fh = fd;
    // Set ownership to calling process (not FUSE daemon)
    fchown(fd, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_truncate(const char *path, off_t size, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return (fi ? ftruncate(fi->fh, size) : truncate(fpath, size)) == -1 ? -errno : 0; }
static int ccbox_utimens(const char *path, const struct timespec ts[2], struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return utimensat(AT_FDCWD, fpath, ts, AT_SYMLINK_NOFOLLOW) == -1 ? -errno : 0; }
static int ccbox_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return chmod(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; int rc = get_source_path(fpath, path, sizeof(fpath)); if (rc) return rc; return lchown(fpath, uid, gid) == -1 ? -errno : 0; }
static int ccbox_rename(const char *from, const char *to, unsigned int flags) { if (flags) return -EINVAL; char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; int rc = get_source_path(ff, from, sizeof(ff)); if (rc) return rc; rc = get_source_path(ft, to, sizeof(ft)); if (rc) return rc; return rename(ff, ft) == -1 ? -errno : 0; }
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

static const struct fuse_operations ccbox_oper = {
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
    fuse_opt_add_arg(&args, "-o");
    fuse_opt_add_arg(&args, "default_permissions");
    if (getuid() == 0) { fuse_opt_add_arg(&args, "-o"); fuse_opt_add_arg(&args, "allow_other"); }
    int ret = fuse_main(args.argc, args.argv, &ccbox_oper, NULL);
    fuse_opt_free_args(&args);
    return ret;
}
