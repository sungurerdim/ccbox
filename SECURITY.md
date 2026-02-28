# Security Policy

## Reporting Vulnerabilities

Report security issues via GitHub private vulnerability reporting:

1. Go to [Security Advisories](https://github.com/sungurerdim/ccbox/security/advisories)
2. Click "Report a vulnerability"
3. Provide detailed description and reproduction steps

**Do not** open public issues for security vulnerabilities.

## Scope

Security issues in scope:

- Container escape vulnerabilities
- Path traversal in volume mounts
- Privilege escalation in containers
- Credential exposure (API keys, tokens)
- FUSE filesystem vulnerabilities
- Supply chain attacks (dependencies, install scripts)

Out of scope:

- Docker daemon vulnerabilities (report to Docker)
- Claude Code vulnerabilities (report to Anthropic)
- Issues requiring physical access

## Response Timeline

| Stage | Target |
|-------|--------|
| Initial response | 48 hours |
| Triage | 7 days |
| Fix development | 30 days |
| Public disclosure | 90 days or after fix |

## Security Architecture

ccbox implements defense-in-depth through container isolation, filesystem restrictions, user separation, and credential handling.

### Container Isolation

All flags are applied in `internal/run/args.go`.

| Flag | Purpose |
|------|---------|
| `--cap-drop=ALL` | Drop all Linux capabilities |
| `--cap-add=SETUID` | gosu: switch user ID |
| `--cap-add=SETGID` | gosu: switch group ID |
| `--cap-add=CHOWN` | Entrypoint: fix file ownership |
| `--cap-add=SYS_ADMIN` | FUSE: mount filesystem in userspace |
| `--pids-limit=2048` | Fork bomb protection |
| `--init` | Proper signal handling (zombie reaping) |
| `--memory=4g` | Memory limit (configurable) |
| `--cpus=2.0` | CPU limit (configurable) |
| `--cpu-shares=512` | Lower CPU priority vs host processes |
| `--memory-swappiness=0` | Prevent swap usage |
| `--ulimit nofile=65535:65535` | File descriptor limit |
| `--log-driver=json-file` | Log rotation (10MB × 3, compressed) |
| `--dns-opt ndots:1` | Faster DNS resolution |

### Filesystem Isolation

| Mount | Path | Mode | Purpose |
|-------|------|------|---------|
| Project directory | Host path mapped | `rw` | Working directory |
| `~/.claude` | `/ccbox/.claude` | `rw` | Claude settings + sessions |
| `~/.claude.json` | `/ccbox/.claude.json` | `rw` | Onboarding state |
| `/tmp` | tmpfs 512MB | `rw,noexec,nosuid,nodev` | Ephemeral temp (RAM) |
| `/var/tmp` | tmpfs 256MB | `rw,noexec,nosuid,nodev` | Ephemeral temp (RAM) |
| `/run` | tmpfs 64MB | `rw` | Runtime data (RAM) |
| SSH agent socket | Varies | `ro` | Key-based auth (socket only) |

Nothing else from the host filesystem is mounted. The container has no access to other projects, home directory contents, or system files.

### User Isolation

1. Container starts as root for setup only
2. Entrypoint adjusts `ccbox` user UID/GID to match host user
3. `gosu ccbox` drops to non-root — root is never used after setup
4. Files created in project have correct host ownership

### Credential Handling

| Credential | Method | Stored on disk? |
|------------|--------|-----------------|
| GitHub token | Environment variable (`GITHUB_TOKEN`) | No |
| Git identity | Environment variables (`GIT_AUTHOR_NAME`, etc.) | No |
| SSH keys | Agent socket forwarded read-only | No (keys stay on host) |
| API keys | Environment variables (passthrough) | No |

## Isolation Comparison

### ccbox vs Claude Code Sandbox

| Aspect | ccbox | Claude Code Sandbox |
|--------|-------|---------------------|
| Isolation level | Full container (different kernel namespace) | Process-level sandbox |
| Host filesystem | Absent — doesn't exist in container | Present but restricted |
| Bypass model | `--dangerously-skip-permissions` (container is boundary) | Permissions enforced per-tool |
| Network | Full access (configurable) | Full access |
| Custom tools | Any Linux tool pre-installed | Host tools only |
| Reproducibility | Deterministic image per stack | Depends on host environment |

### ccbox vs --worktree

| Aspect | ccbox | `--worktree` |
|--------|-------|--------------|
| Filesystem access | Only project + `.claude` | Full host filesystem |
| System tools | Isolated (container tools) | Host tools (can modify system) |
| Side effects | Confined to container | Can affect host |
| Environment | Clean, reproducible | Inherits host state |

**Core principle:** ccbox follows "can't access what doesn't exist." The host filesystem isn't restricted — it's absent from the container entirely. There's no policy to bypass, no permission to escalate, and no path to traverse — because the target doesn't exist.

## Threat Model

### Protected Threats

| Threat | Mitigation |
|--------|------------|
| Host filesystem access | Only project + `.claude` mounted |
| Privilege escalation | `--cap-drop=ALL`, non-root user |
| Fork bombs | `--pids-limit=2048` |
| Memory exhaustion | `--memory=4g` (configurable) |
| Disk fill via temp | Tmpfs with size limits |
| Credential leakage to disk | Env vars only, no disk storage |
| SSH key theft | Agent socket forwarded read-only |
| Stale resource accumulation | Automatic Docker prune on startup |

### Not Protected

| Threat | Reason |
|--------|--------|
| Docker daemon exploits | Host kernel boundary — report to Docker |
| Network-based attacks | Container has network access (use `--network isolated` to restrict) |
| Malicious project files | Project directory is mounted read-write |
| Supply chain (base images) | Pinned images mitigate, but not eliminated |
| Host Docker socket access | Not mounted into container |

## Environment Safety

| Concern | How ccbox handles it |
|---------|---------------------|
| Version mismatch | Each stack has its own image with pinned tool versions |
| Host pollution | No global installs escape the container |
| Reproducibility | Same image = same environment across machines |
| Dependency conflicts | Isolated per-project containers |
| Leftover state | `--zero-residue` mode for zero-trace sessions |

## Disclosure Policy

We follow coordinated disclosure:

1. Reporter notifies maintainer privately
2. Maintainer acknowledges and investigates
3. Fix developed and tested
4. Security advisory published with fix release
5. Credit given to reporter (if desired)
