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

ccbox implements defense-in-depth:

- **Capability dropping**: `--cap-drop=ALL` removes all Linux capabilities
- **Privilege prevention**: `--security-opt=no-new-privileges`
- **Fork bomb protection**: `--pids-limit=2048`
- **Ephemeral temp**: Tmpfs for `/tmp`
- **Path validation**: Directory traversal prevention
- **Minimal mounts**: Only project directory and `.claude` settings
- **UID/GID mapping**: Container user matches host user

## Disclosure Policy

We follow coordinated disclosure:

1. Reporter notifies maintainer privately
2. Maintainer acknowledges and investigates
3. Fix developed and tested
4. Security advisory published with fix release
5. Credit given to reporter (if desired)
