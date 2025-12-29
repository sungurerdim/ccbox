---
paths: "**/Dockerfile*,**/docker-compose*.{yml,yaml},**/compose*.{yml,yaml}"
---

# Container Rules
*Trigger: Infra:Docker*

## Security & Isolation

- **Least-Privilege**: Run as non-root user (create unprivileged UID/GID in Dockerfile)
- **No-Root**: Never set USER root in production images
- **Mount-Strict**: Mount only necessary directories, use read-only mounts where possible
- **Volume-Ownership**: Verify file ownership matches after execution, apply chown if needed
- **Capability-Drop**: Drop unnecessary capabilities (--cap-drop=ALL, grant specific only)
- **SELinux-Labels**: Use :z or :Z for volume mount labels on SELinux systems

## Image Building

- **Multi-Stage**: Use multi-stage builds to keep final image small
- **Layer-Efficiency**: Order commands from least-frequently-changed to most-frequently-changed
- **Layer-Caching**: Put stable operations early (FROM, apt-get update) before volatile ones
- **Minimize-Layers**: Combine RUN commands with && to reduce layer count
- **Base-Image-Pinned**: Use specific version tags, not latest (e.g., python:3.11-slim not python:latest)
- **Scan-Vulnerabilities**: Scan base images for known CVEs before using

## Resource Management

- **Memory-Limits**: Set memory limits in docker-compose or orchestrator
- **CPU-Limits**: Set CPU limits to prevent resource exhaustion
- **Temp-Memory**: Use tmpfs for temporary files, not persistent disk
- **PID-Limits**: Set pids_limit to prevent fork bombs
- **File-Descriptors**: Set ulimit for max file descriptors

## Networking & Secrets

- **Secrets-Environment**: Never embed secrets in Dockerfile. Use docker secrets or environment variables
- **Port-Explicit**: Publish only necessary ports, use specific port mappings
- **Network-Isolation**: Use custom networks for multi-container setups
- **Health-Checks**: Define HEALTHCHECK for services that need monitoring

## Logging & Observability

- **Stdout-Logging**: Log to stdout/stderr, not files. Container runtime captures this
- **Structured-Logging**: Use structured logging (JSON) for machine-parseable logs
- **No-Root-Logs**: Ensure non-root user can write to logs
