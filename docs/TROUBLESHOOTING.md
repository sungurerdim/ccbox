# Troubleshooting

## Docker Issues

### Docker not running

**Symptom:** `Error: Docker is not running`

**Fix:**
- macOS/Windows: Start Docker Desktop
- Linux: `sudo systemctl start docker`

ccbox auto-starts Docker Desktop on Windows/macOS if installed.

### Permission denied

**Symptom:** `permission denied while trying to connect to the Docker daemon`

**Fix (Linux):**
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

### Build fails with "no space left"

**Symptom:** Build errors mentioning disk space

**Fix:**
```bash
ccbox prune --system  # Clean all Docker resources
# Or manually:
docker system prune -a
```

## File Permission Issues

### Files created with wrong owner

**Symptom:** Files in project have root ownership after container exits

**Cause:** UID/GID mismatch between host and container

**Fix:** ccbox automatically matches container user to host UID/GID. If issues persist:
```bash
# Check host UID/GID
id

# Verify container uses same values (in debug mode)
ccbox -d
```

### Cannot write to project directory

**Symptom:** Permission denied when Claude tries to create/modify files

**Fix:**
1. Ensure project directory is owned by your user
2. Check directory isn't on a read-only filesystem
3. Verify SELinux/AppArmor isn't blocking (Linux)

## FUSE Issues

### Path mapping not working

**Symptom:** Claude Code shows wrong paths in output (host paths instead of container paths)

**Cause:** FUSE mount failed

**Debug:**
```bash
ccbox -dd  # Verbose debug mode
# Look for "FUSE mounted" or "FUSE mount failed" messages
```

**Fix:**
1. Ensure container runs privileged (default for ccbox)
2. Check `/dev/fuse` exists in container
3. Verify `fuse3` package is installed in image

### Session not found

**Symptom:** Previous Claude session not visible in container

**Cause:** Path encoding mismatch (especially WSL)

**Fix:** ccbox creates symlink bridges for WSL paths automatically. If sessions still missing:
```bash
# Check .claude directory structure
ls -la ~/.claude/projects/
```

## Stack Issues

### Wrong stack detected

**Symptom:** ccbox selects wrong language stack for project

**Fix:** Specify stack explicitly:
```bash
ccbox --stack=python
ccbox --stack=web
```

Use `ccbox stacks` to list all available stacks.

### Stack image not found

**Symptom:** `Error: Image ccbox_<stack>:latest not found`

**Fix:**
```bash
ccbox --stack=<stack>  # Auto-builds if missing
# Or rebuild explicitly:
ccbox update --stack=<stack>
```

## Performance Issues

### Container starts slowly

**Cause:** First run builds image (2-5 minutes depending on stack)

**Fix:** Subsequent runs are instant (cached image). To rebuild:
```bash
ccbox update  # Rebuild with latest Claude Code
```

### High CPU/memory usage

**Symptom:** System becomes unresponsive during container operation

**Fix:** ccbox applies soft resource limits by default. To remove:
```bash
ccbox --unrestricted  # Remove CPU/IO limits
```

## Authentication Issues

### Claude not authenticated

**Symptom:** Claude prompts for login inside container

**Fix:** ccbox mounts `~/.claude` from host. Ensure you're logged in on host:
```bash
claude auth login
```

### Git operations fail

**Symptom:** `fatal: detected dubious ownership` or auth failures

**Fix:** ccbox configures safe.directory automatically. For auth:
- SSH: Ensure SSH agent is running on host
- HTTPS: Configure credential helper on host

## Getting Help

1. Run with debug: `ccbox -dd`
2. Check image build: `docker logs <container_id>`
3. Open issue: [GitHub Issues](https://github.com/sungurerdim/ccbox/issues)

Include in bug reports:
- OS and version
- Docker version: `docker --version`
- ccbox version: `ccbox --version`
- Debug output: `ccbox -dd 2>&1 | head -100`
