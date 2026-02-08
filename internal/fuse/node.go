//go:build linux

package fuse

import (
	"context"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	gofuse "github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// CcboxRoot holds shared state for the ccbox FUSE filesystem.
type CcboxRoot struct {
	SourceDir string
	Config    *Config
	RCache    *ReadCache
	SCache    *SkipCache
	NegCache  *NegCache
	Trace     *Tracer
}

// CcboxNode is a filesystem node that applies path and content transformation.
type CcboxNode struct {
	gofuse.Inode
	root *CcboxRoot
}

var _ = (gofuse.NodeLookuper)((*CcboxNode)(nil))
var _ = (gofuse.NodeGetattrer)((*CcboxNode)(nil))
var _ = (gofuse.NodeReaddirer)((*CcboxNode)(nil))
var _ = (gofuse.NodeOpener)((*CcboxNode)(nil))
var _ = (gofuse.NodeCreater)((*CcboxNode)(nil))
var _ = (gofuse.NodeMkdirer)((*CcboxNode)(nil))
var _ = (gofuse.NodeUnlinker)((*CcboxNode)(nil))
var _ = (gofuse.NodeRmdirer)((*CcboxNode)(nil))
var _ = (gofuse.NodeRenamer)((*CcboxNode)(nil))
var _ = (gofuse.NodeSymlinker)((*CcboxNode)(nil))
var _ = (gofuse.NodeReadlinker)((*CcboxNode)(nil))
var _ = (gofuse.NodeLinker)((*CcboxNode)(nil))
var _ = (gofuse.NodeSetattrer)((*CcboxNode)(nil))
var _ = (gofuse.NodeStatfser)((*CcboxNode)(nil))
var _ = (gofuse.NodeAccesser)((*CcboxNode)(nil))

func (n *CcboxNode) sourcePath(name string) string {
	p := n.Path(n.Root())
	if name != "" {
		if p == "" {
			p = name
		} else {
			p = p + "/" + name
		}
	}
	return GetSourcePath(n.root.SourceDir, "/"+p, n.root.Config.DirMappings)
}

func (n *CcboxNode) fusePath(name string) string {
	p := n.Path(n.Root())
	if name != "" {
		if p == "" {
			return "/" + name
		}
		return "/" + p + "/" + name
	}
	return "/" + p
}

func (n *CcboxNode) newChild(ctx context.Context, st *syscall.Stat_t) *gofuse.Inode {
	child := &CcboxNode{root: n.root}
	return n.NewInode(ctx, child, gofuse.StableAttr{Mode: st.Mode & syscall.S_IFMT, Ino: st.Ino})
}

// Lookup resolves a child entry, applying container_name → native_name dir mapping.
func (n *CcboxNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*gofuse.Inode, syscall.Errno) {
	r := n.root
	fpath := n.sourcePath(name)

	if r.NegCache.Lookup(fpath) {
		r.Trace.Log("Lookup NEGCACHE name=%s", name)
		return nil, syscall.ENOENT
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(fpath, &st); err != nil {
		if err == syscall.ENOENT {
			r.NegCache.Insert(fpath)
		}
		r.Trace.Log("Lookup ENOENT name=%s fpath=%s", name, fpath)
		return nil, gofuse.ToErrno(err)
	}

	out.Attr.FromStat(&st)
	// Update st_size from read cache
	if st.Mode&syscall.S_IFREG != 0 {
		fusePath := n.fusePath(name)
		if r.Config.NeedsTransform(fusePath) && st.Size > 0 {
			if data, ok := r.RCache.Lookup(fpath, st.Mtim.Sec, st.Mtim.Nsec); ok {
				out.Attr.Size = uint64(len(data))
				r.Trace.TX("Lookup RCACHE hit name=%s len=%d", name, len(data))
			}
		}
	}

	r.Trace.Log("Lookup name=%s fpath=%s", name, fpath)
	return n.newChild(ctx, &st), 0
}

// Getattr returns file attributes, using neg cache and read cache for size.
func (n *CcboxNode) Getattr(ctx context.Context, fh gofuse.FileHandle, out *fuse.AttrOut) syscall.Errno {
	r := n.root
	fpath := n.sourcePath("")

	if r.NegCache.Lookup(fpath) {
		r.Trace.Log("Getattr NEGCACHE path=%s", fpath)
		return syscall.ENOENT
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(fpath, &st); err != nil {
		if err == syscall.ENOENT {
			r.NegCache.Insert(fpath)
		}
		return gofuse.ToErrno(err)
	}

	out.Attr.FromStat(&st)

	if st.Mode&syscall.S_IFREG != 0 && st.Size > 0 {
		fusePath := n.fusePath("")
		if r.Config.NeedsTransform(fusePath) {
			if data, ok := r.RCache.Lookup(fpath, st.Mtim.Sec, st.Mtim.Nsec); ok {
				out.Attr.Size = uint64(len(data))
				r.Trace.TX("Getattr RCACHE hit path=%s len=%d", fusePath, len(data))
			}
		}
	}

	r.Trace.Log("Getattr path=%s size=%d", fpath, out.Attr.Size)
	return 0
}

// Readdir lists directory entries, applying native_name → container_name mapping.
func (n *CcboxNode) Readdir(ctx context.Context) (gofuse.DirStream, syscall.Errno) {
	r := n.root
	fpath := n.sourcePath("")

	f, err := os.Open(fpath)
	if err != nil {
		r.Trace.Log("Readdir FAIL path=%s", fpath)
		return nil, gofuse.ToErrno(err)
	}
	defer f.Close()

	entries, err := f.Readdir(-1)
	if err != nil {
		return nil, gofuse.ToErrno(err)
	}

	r.Trace.Log("Readdir path=%s count=%d", fpath, len(entries))

	nativeExists := make(map[string]bool)
	if len(r.Config.DirMappings) > 0 {
		for _, e := range entries {
			nativeExists[e.Name()] = true
		}
	}

	var result []fuse.DirEntry
	for _, e := range entries {
		name := e.Name()

		// Hide kernel-generated .fuse_hidden files (created when open files are unlinked)
		if strings.HasPrefix(name, ".fuse_hidden") {
			continue
		}

		skip := false

		for _, dm := range r.Config.DirMappings {
			if name == dm.NativeName {
				name = dm.ContainerName
				r.Trace.Log("Readdir dirmap: %s -> %s", e.Name(), name)
				break
			}
			if name == dm.ContainerName && nativeExists[dm.NativeName] {
				r.Trace.Log("Readdir dedup: skip %s (native %s exists)", name, dm.NativeName)
				skip = true
				break
			}
		}
		if skip {
			continue
		}

		mode := uint32(syscall.S_IFREG)
		if e.IsDir() {
			mode = syscall.S_IFDIR
		} else if e.Mode()&os.ModeSymlink != 0 {
			mode = syscall.S_IFLNK
		}

		result = append(result, fuse.DirEntry{Name: name, Mode: mode})
	}

	return gofuse.NewListDirStream(result), 0
}

// CcboxFileHandle wraps an fd with transform metadata.
type CcboxFileHandle struct {
	fd             int
	needsTransform bool
	sourcePath     string
	root           *CcboxRoot
}

var _ = (gofuse.FileReader)((*CcboxFileHandle)(nil))
var _ = (gofuse.FileWriter)((*CcboxFileHandle)(nil))
var _ = (gofuse.FileReleaser)((*CcboxFileHandle)(nil))
var _ = (gofuse.FileFlusher)((*CcboxFileHandle)(nil))
var _ = (gofuse.FileFsyncer)((*CcboxFileHandle)(nil))
var _ = (gofuse.FileGetattrer)((*CcboxFileHandle)(nil))

// Open opens a file, setting direct_io for transform files on cache miss.
func (n *CcboxNode) Open(ctx context.Context, flags uint32) (gofuse.FileHandle, uint32, syscall.Errno) {
	r := n.root
	fpath := n.sourcePath("")
	fusePath := n.fusePath("")

	fd, err := syscall.Open(fpath, int(flags), 0)
	if err != nil {
		r.Trace.Log("Open FAIL path=%s", fpath)
		return nil, 0, gofuse.ToErrno(err)
	}

	fh := &CcboxFileHandle{
		fd:         fd,
		sourcePath: fpath,
		root:       r,
	}

	fuseFlags := uint32(0)
	if r.Config.NeedsTransform(fusePath) {
		fh.needsTransform = true
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) == nil {
			if _, ok := r.RCache.Lookup(fpath, st.Mtim.Sec, st.Mtim.Nsec); ok {
				fuseFlags |= fuse.FOPEN_KEEP_CACHE
				r.Trace.TX("Open TRANSFORM keep_cache path=%s", fusePath)
			} else if r.SCache.Lookup(fpath, st.Mtim.Sec, st.Mtim.Nsec) {
				fuseFlags |= fuse.FOPEN_KEEP_CACHE
				r.Trace.TX("Open TRANSFORM keep_cache(skip) path=%s", fusePath)
			} else {
				fuseFlags |= fuse.FOPEN_DIRECT_IO
				r.Trace.TX("Open TRANSFORM direct_io path=%s", fusePath)
			}
		} else {
			fuseFlags |= fuse.FOPEN_DIRECT_IO
		}
	}

	r.Trace.Log("Open path=%s fd=%d", fusePath, fd)
	return fh, fuseFlags, 0
}

// Read reads file content, applying content transformation for JSON/JSONL files.
func (fh *CcboxFileHandle) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	r := fh.root

	if fh.needsTransform {
		var st syscall.Stat_t
		if err := syscall.Fstat(fh.fd, &st); err != nil {
			return nil, gofuse.ToErrno(err)
		}
		if st.Size == 0 {
			return fuse.ReadResultData(nil), 0
		}

		// Skip cache
		if r.SCache.Lookup(fh.sourcePath, st.Mtim.Sec, st.Mtim.Nsec) {
			r.Trace.TX("Read SCACHE hit path=%s", fh.sourcePath)
			return fuse.ReadResultFd(uintptr(fh.fd), off, len(dest)), 0
		}

		// Read cache
		if data, ok := r.RCache.Lookup(fh.sourcePath, st.Mtim.Sec, st.Mtim.Nsec); ok {
			r.Trace.TX("Read RCACHE hit path=%s len=%d off=%d", fh.sourcePath, len(data), off)
			if int(off) >= len(data) {
				return fuse.ReadResultData(nil), 0
			}
			end := int(off) + len(dest)
			if end > len(data) {
				end = len(data)
			}
			return fuse.ReadResultData(data[off:end]), 0
		}

		// Quick scan
		if !QuickScanHasMappings(fh.fd, r.Config.PathMappings, r.Config.DirMappings) {
			r.Trace.TX("Read QUICK-SCAN-SKIP path=%s", fh.sourcePath)
			r.SCache.Insert(fh.sourcePath, st.Mtim.Sec, st.Mtim.Nsec)
			return fuse.ReadResultFd(uintptr(fh.fd), off, len(dest)), 0
		}

		// Full read + transform
		fileBuf := make([]byte, st.Size)
		nr, err := syscall.Pread(fh.fd, fileBuf, 0)
		if err != nil {
			return nil, gofuse.ToErrno(err)
		}
		fileBuf = fileBuf[:nr]

		transformed := TransformToContainer(fileBuf, r.Config.PathMappings, r.Config.DirMappings)
		result := fileBuf
		if transformed != nil {
			result = transformed
		}

		r.RCache.Insert(fh.sourcePath, st.Mtim.Sec, st.Mtim.Nsec, result)

		if int(off) >= len(result) {
			return fuse.ReadResultData(nil), 0
		}
		end := int(off) + len(dest)
		if end > len(result) {
			end = len(result)
		}
		return fuse.ReadResultData(result[off:end]), 0
	}

	return fuse.ReadResultFd(uintptr(fh.fd), off, len(dest)), 0
}

// Write writes content, applying reverse transform for JSON files.
func (fh *CcboxFileHandle) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	r := fh.root
	r.RCache.Invalidate(fh.sourcePath)
	r.SCache.Invalidate(fh.sourcePath)

	if fh.needsTransform {
		transformed := TransformToHost(data, r.Config.PathMappings, r.Config.DirMappings)
		if transformed != nil {
			if off == 0 {
				nw, err := syscall.Pwrite(fh.fd, transformed, 0)
				if err != nil {
					return 0, gofuse.ToErrno(err)
				}
				_ = syscall.Ftruncate(fh.fd, int64(nw))
				return uint32(len(data)), 0
			}
			// Write at offset: read-modify-write
			if err := syscall.Flock(fh.fd, syscall.LOCK_EX); err != nil {
				return 0, gofuse.ToErrno(err)
			}
			defer func() { _ = syscall.Flock(fh.fd, syscall.LOCK_UN) }()

			var st syscall.Stat_t
			if err := syscall.Fstat(fh.fd, &st); err != nil {
				return 0, gofuse.ToErrno(err)
			}
			total := off + int64(len(transformed))
			if st.Size > total {
				total = st.Size
			}
			merged := make([]byte, total)
			_, _ = syscall.Pread(fh.fd, merged[:st.Size], 0)
			copy(merged[off:], transformed)
			nw, err := syscall.Pwrite(fh.fd, merged, 0)
			if err != nil {
				return 0, gofuse.ToErrno(err)
			}
			_ = syscall.Ftruncate(fh.fd, int64(nw))
			return uint32(len(data)), 0
		}
	}

	nw, err := syscall.Pwrite(fh.fd, data, off)
	if err != nil {
		return 0, gofuse.ToErrno(err)
	}
	return uint32(nw), 0
}

// Getattr returns file attributes from the file handle.
func (fh *CcboxFileHandle) Getattr(ctx context.Context, out *fuse.AttrOut) syscall.Errno {
	var st syscall.Stat_t
	if err := syscall.Fstat(fh.fd, &st); err != nil {
		return gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)
	if fh.needsTransform && st.Size > 0 {
		if data, ok := fh.root.RCache.Lookup(fh.sourcePath, st.Mtim.Sec, st.Mtim.Nsec); ok {
			out.Attr.Size = uint64(len(data))
		}
	}
	return 0
}

// Release closes the file descriptor.
func (fh *CcboxFileHandle) Release(ctx context.Context) syscall.Errno {
	syscall.Close(fh.fd)
	return 0
}

// Flush duplicates and closes the fd.
func (fh *CcboxFileHandle) Flush(ctx context.Context) syscall.Errno {
	newFd, err := syscall.Dup(fh.fd)
	if err != nil {
		return gofuse.ToErrno(err)
	}
	syscall.Close(newFd)
	return 0
}

// Fsync syncs file data to disk.
func (fh *CcboxFileHandle) Fsync(ctx context.Context, flags uint32) syscall.Errno {
	var err error
	if flags&1 != 0 {
		err = syscall.Fdatasync(fh.fd)
	} else {
		err = syscall.Fsync(fh.fd)
	}
	if err != nil {
		return gofuse.ToErrno(err)
	}
	return 0
}

// Create creates a new file node.
func (n *CcboxNode) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*gofuse.Inode, gofuse.FileHandle, uint32, syscall.Errno) {
	r := n.root
	fpath := n.sourcePath(name)
	r.NegCache.Invalidate(fpath)

	fd, err := syscall.Open(fpath, int(flags)|syscall.O_CREAT, mode)
	if err != nil {
		return nil, nil, 0, gofuse.ToErrno(err)
	}

	caller, _ := fuse.FromContext(ctx)
	if caller != nil {
		_ = syscall.Fchown(fd, int(caller.Uid), int(caller.Gid))
	}

	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return nil, nil, 0, gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)

	fusePath := n.fusePath(name)
	fh := &CcboxFileHandle{
		fd:             fd,
		needsTransform: r.Config.NeedsTransform(fusePath),
		sourcePath:     fpath,
		root:           r,
	}

	fuseFlags := uint32(0)
	if fh.needsTransform {
		fuseFlags |= fuse.FOPEN_DIRECT_IO
	}

	return n.newChild(ctx, &st), fh, fuseFlags, 0
}

// Mkdir creates a directory with caller ownership.
func (n *CcboxNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*gofuse.Inode, syscall.Errno) {
	r := n.root
	fpath := n.sourcePath(name)
	r.NegCache.Invalidate(fpath)

	if err := syscall.Mkdir(fpath, mode); err != nil {
		return nil, gofuse.ToErrno(err)
	}

	caller, _ := fuse.FromContext(ctx)
	if caller != nil {
		_ = syscall.Chown(fpath, int(caller.Uid), int(caller.Gid))
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(fpath, &st); err != nil {
		return nil, gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)

	return n.newChild(ctx, &st), 0
}

// Unlink removes a file, invalidating read cache.
func (n *CcboxNode) Unlink(ctx context.Context, name string) syscall.Errno {
	fpath := n.sourcePath(name)
	n.root.RCache.Invalidate(fpath)
	if err := syscall.Unlink(fpath); err != nil {
		return gofuse.ToErrno(err)
	}
	return 0
}

// Rmdir removes a directory.
func (n *CcboxNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	fpath := n.sourcePath(name)
	if err := syscall.Rmdir(fpath); err != nil {
		return gofuse.ToErrno(err)
	}
	return 0
}

// Rename moves a file, handling post-rename content transform for atomic writes.
func (n *CcboxNode) Rename(ctx context.Context, name string, newParent gofuse.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	if flags != 0 {
		return syscall.EINVAL
	}
	r := n.root
	oldPath := n.sourcePath(name)
	np := newParent.(*CcboxNode)
	newPath := np.sourcePath(newName)

	r.NegCache.Invalidate(newPath)
	r.RCache.Invalidate(oldPath)
	r.RCache.Invalidate(newPath)
	r.SCache.Invalidate(oldPath)
	r.SCache.Invalidate(newPath)

	if err := syscall.Rename(oldPath, newPath); err != nil {
		return gofuse.ToErrno(err)
	}

	oldFuse := n.fusePath(name)
	newFuse := np.fusePath(newName)
	if len(r.Config.PathMappings) > 0 && r.Config.NeedsTransform(newFuse) && !r.Config.NeedsTransform(oldFuse) {
		postRenameTransform(newPath, r)
	}

	return 0
}

func postRenameTransform(path string, r *CcboxRoot) {
	var st syscall.Stat_t
	if syscall.Stat(path, &st) != nil || st.Mode&syscall.S_IFREG == 0 || st.Size == 0 || st.Size > RCacheMaxSize {
		return
	}
	fd, err := syscall.Open(path, syscall.O_RDWR, 0)
	if err != nil {
		return
	}
	defer syscall.Close(fd)

	buf := make([]byte, st.Size)
	nr, err := syscall.Pread(fd, buf, 0)
	if err != nil || nr <= 0 {
		return
	}
	buf = buf[:nr]

	transformed := TransformToHost(buf, r.Config.PathMappings, r.Config.DirMappings)
	if transformed != nil {
		nw, err := syscall.Pwrite(fd, transformed, 0)
		if err == nil {
			_ = syscall.Ftruncate(fd, int64(nw))
		}
		r.Trace.TX("rename transform: %s (%d -> %d bytes)", path, nr, len(transformed))
	}
}

// Symlink creates a symbolic link with caller ownership.
func (n *CcboxNode) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*gofuse.Inode, syscall.Errno) {
	fpath := n.sourcePath(name)

	if err := syscall.Symlink(target, fpath); err != nil {
		return nil, gofuse.ToErrno(err)
	}

	caller, _ := fuse.FromContext(ctx)
	if caller != nil {
		_ = syscall.Lchown(fpath, int(caller.Uid), int(caller.Gid))
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(fpath, &st); err != nil {
		return nil, gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)

	return n.newChild(ctx, &st), 0
}

// Readlink reads a symbolic link target.
func (n *CcboxNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	fpath := n.sourcePath("")
	buf := make([]byte, MaxPathLen)
	nr, err := syscall.Readlink(fpath, buf)
	if err != nil {
		return nil, gofuse.ToErrno(err)
	}
	return buf[:nr], 0
}

// Link creates a hard link.
func (n *CcboxNode) Link(ctx context.Context, target gofuse.InodeEmbedder, name string, out *fuse.EntryOut) (*gofuse.Inode, syscall.Errno) {
	targetNode := target.(*CcboxNode)
	targetPath := targetNode.sourcePath("")
	linkPath := n.sourcePath(name)

	if err := syscall.Link(targetPath, linkPath); err != nil {
		return nil, gofuse.ToErrno(err)
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(linkPath, &st); err != nil {
		return nil, gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)

	return n.newChild(ctx, &st), 0
}

// Setattr sets file attributes (chmod, chown, truncate, utimens).
func (n *CcboxNode) Setattr(ctx context.Context, fh gofuse.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	r := n.root
	fpath := n.sourcePath("")

	if mode, ok := in.GetMode(); ok {
		if err := syscall.Chmod(fpath, mode); err != nil {
			return gofuse.ToErrno(err)
		}
	}
	if uid, ok := in.GetUID(); ok {
		gid := uint32(0xFFFFFFFF)
		if g, gok := in.GetGID(); gok {
			gid = g
		}
		if err := syscall.Lchown(fpath, int(uid), int(gid)); err != nil {
			return gofuse.ToErrno(err)
		}
	} else if gid, ok := in.GetGID(); ok {
		if err := syscall.Lchown(fpath, -1, int(gid)); err != nil {
			return gofuse.ToErrno(err)
		}
	}
	if size, ok := in.GetSize(); ok {
		r.RCache.Invalidate(fpath)
		if cfh, ok := fh.(*CcboxFileHandle); ok {
			if err := syscall.Ftruncate(cfh.fd, int64(size)); err != nil {
				return gofuse.ToErrno(err)
			}
		} else {
			if err := syscall.Truncate(fpath, int64(size)); err != nil {
				return gofuse.ToErrno(err)
			}
		}
	}
	if atime, ok := in.GetATime(); ok {
		mtime := atime
		if mt, mok := in.GetMTime(); mok {
			mtime = mt
		}
		ts := []syscall.Timespec{
			{Sec: atime.Unix(), Nsec: int64(atime.Nanosecond())},
			{Sec: mtime.Unix(), Nsec: int64(mtime.Nanosecond())},
		}
		pathBytes, err := syscall.BytePtrFromString(fpath)
		if err != nil {
			return gofuse.ToErrno(err)
		}
		_, _, errno := syscall.Syscall6(
			syscall.SYS_UTIMENSAT,
			uintptr(0xffffffffffffff9c), // AT_FDCWD
			uintptr(unsafe.Pointer(pathBytes)),
			uintptr(unsafe.Pointer(&ts[0])),
			0x100, // AT_SYMLINK_NOFOLLOW
			0, 0)
		if errno != 0 {
			return errno
		}
	}

	var st syscall.Stat_t
	if err := syscall.Lstat(fpath, &st); err != nil {
		return gofuse.ToErrno(err)
	}
	out.Attr.FromStat(&st)
	return 0
}

// Statfs returns filesystem statistics.
func (n *CcboxNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	fpath := n.sourcePath("")
	var st syscall.Statfs_t
	if err := syscall.Statfs(fpath, &st); err != nil {
		return gofuse.ToErrno(err)
	}
	out.FromStatfsT(&st)
	return 0
}

// Access checks file permissions.
func (n *CcboxNode) Access(ctx context.Context, mask uint32) syscall.Errno {
	fpath := n.sourcePath("")
	if err := syscall.Access(fpath, mask); err != nil {
		return gofuse.ToErrno(err)
	}
	return 0
}

// NewCcboxFS creates and mounts the ccbox FUSE filesystem.
func NewCcboxFS(cfg *Config, mountPoint string, trace *Tracer) (*fuse.Server, error) {
	root := &CcboxRoot{
		SourceDir: cfg.SourceDir,
		Config:    cfg,
		RCache:    &ReadCache{},
		SCache:    &SkipCache{},
		NegCache:  &NegCache{},
		Trace:     trace,
	}

	rootNode := &CcboxNode{root: root}

	opts := &gofuse.Options{
		MountOptions: fuse.MountOptions{
			FsName:      "ccbox-fuse",
			DirectMount: true,
		},
		EntryTimeout:    ptrDuration(30),
		AttrTimeout:     ptrDuration(30),
		NegativeTimeout: ptrDuration(15),
	}

	if os.Getuid() == 0 {
		opts.MountOptions.AllowOther = true
	}
	opts.MountOptions.Options = append(opts.MountOptions.Options, "default_permissions")

	return gofuse.Mount(mountPoint, rootNode, opts)
}

func ptrDuration(seconds float64) *time.Duration {
	d := time.Duration(seconds * float64(time.Second))
	return &d
}
